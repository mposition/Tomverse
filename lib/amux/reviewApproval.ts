import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  AMUX_REVIEW_DISPLAY_MAX_BYTES,
  amuxReviewTextExceedsDisplay,
  amuxReviewRequestDigest,
  amuxReviewSubjectDigest,
  amuxReviewTargetStatus,
  sha256Hex,
  type AmuxReviewOutcome,
  type AmuxReviewSubject,
} from "@/lib/amux/reviewApprovalCore";
import { AMUX_MAX_EXECUTION_ATTEMPTS, decideAmuxAttemptBudget } from "@/lib/amux/executionBudgetCore";
import { normalizeAmuxUntrustedReason, openAmuxHumanEscalation, publicAmuxEscalationReasonCode } from "@/lib/amux/escalation";
import { readAmuxReviewPullRequest, type AmuxReviewPullRequest } from "@/lib/amux/reviewGitHub";
import { evaluateLockedAmuxCostAdmission, lockAmuxResourcePolicies } from "@/lib/amux/resourcePolicy";
import { amuxResourceRefs } from "@/lib/amux/resourcePolicyCore";
import { prisma } from "@/lib/prisma";

export class AmuxReviewRefusal extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "AmuxReviewRefusal";
  }
}

type Client = Prisma.TransactionClient;

const refuse = (code: string, status = 409): never => {
  throw new AmuxReviewRefusal(code, status);
};

/** Privileged display only. Keep task prose apart from immutable PR identity. */
const safeReviewDisplayText = (value: string | null) => {
  if (value === null) return null;
  const cleaned = value.normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/\r\n?/gu, "\n");
  let text = "";
  let bytes = 0;
  for (const character of cleaned) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > AMUX_REVIEW_DISPLAY_MAX_BYTES) break;
    text += character;
    bytes += size;
  }
  return text;
};

const dbNow = async (tx: Client) => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!rows[0]) return refuse("AMUX_REVIEW_CLOCK_UNAVAILABLE", 503);
  return rows[0].now;
};

async function lockTaskAndEscalation(tx: Client, escalationId: string) {
  const identity = await tx.amuxHumanEscalation.findUnique({
    where: { id: escalationId },
    select: { taskId: true },
  });
  if (!identity) return refuse("AMUX_REVIEW_NOT_FOUND", 404);
  const taskLocks = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${identity.taskId} FOR UPDATE
  `;
  if (!taskLocks[0]) return refuse("AMUX_REVIEW_NOT_FOUND", 404);
  const escalationLocks = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxHumanEscalation"
    WHERE "id" = ${escalationId} AND "taskId" = ${identity.taskId} FOR UPDATE
  `;
  if (!escalationLocks[0]) return refuse("AMUX_REVIEW_NOT_FOUND", 404);
  return identity.taskId;
}

/** Read-only GitHub I/O is deliberately outside every database transaction. */
async function artifactForEscalation(
  escalationId: string,
  requiredForApprove = false,
): Promise<AmuxReviewPullRequest | null> {
  const escalation = await prisma.amuxHumanEscalation.findUnique({
    where: { id: escalationId },
    select: { task: { select: { status: true, reviewPrNumber: true } } },
  });
  if (!escalation) return refuse("AMUX_REVIEW_NOT_FOUND", 404);
  if (escalation.task.status !== "review" || escalation.task.reviewPrNumber === null) return null;
  try {
    return await readAmuxReviewPullRequest(escalation.task.reviewPrNumber);
  } catch {
    if (requiredForApprove) return refuse("AMUX_REVIEW_SOURCE_UNAVAILABLE", 503);
    // GitHub is a prerequisite for approve, not for a human block/retry.
    // A previously fetched approval proposal will fail its digest recheck;
    // the operator can refresh and still use the safe non-approve outcomes.
    return null;
  }
}

async function snapshot(
  tx: Client,
  escalationId: string,
  fetchedArtifact: AmuxReviewPullRequest | null,
) {
  const escalation = await tx.amuxHumanEscalation.findUnique({
    where: { id: escalationId },
    include: { task: true },
  });
  if (!escalation) return refuse("AMUX_REVIEW_NOT_FOUND", 404);
  const task = escalation.task;
  const artifact = task.status === "review" &&
    task.reviewPrNumber === fetchedArtifact?.prNumber ? fetchedArtifact : null;
  const [lastAttempt, attemptCount, activeDelivery] = await Promise.all([
    tx.amuxExecutionAttempt.findFirst({
      where: { taskId: task.id },
      orderBy: [{ taskRevision: "desc" }, { startedAt: "desc" }, { id: "desc" }],
    }),
    tx.amuxExecutionAttempt.aggregate({
      where: { taskId: task.id },
      _count: { _all: true },
      _max: { attemptNumber: true },
    }),
    tx.amuxWorkDelivery.findFirst({
      where: { taskId: task.id, status: { in: ["queued", "leased"] } },
      select: { attemptId: true },
    }),
  ]);
  const budget = decideAmuxAttemptBudget({
    historical_rows: attemptCount._count._all,
    greatest_attempt_number: attemptCount._max.attemptNumber,
  });
  const used = budget.allowed ? budget.next_attempt_number - 1 : budget.attempts_used;
  const lastTerminal = !lastAttempt ||
    (lastAttempt.endedAt !== null && lastAttempt.outcome !== null && lastAttempt.toStatus !== null);
  const reviewAttempt = task.status === "review" && lastAttempt !== null &&
    lastTerminal && lastAttempt.outcome === "succeeded" &&
    lastAttempt.toStatus === "review" && lastAttempt.taskRevision < task.revision;
  const dueCorrected = escalation.specialty === "planning-review"
    ? escalation.openedTaskRevision !== null &&
      task.revision > escalation.openedTaskRevision && task.dueParseState === "valid"
    : task.dueParseState === "valid" || task.dueParseState === "none";
  const description = task.description;
  // Ingress allows 50,000 Unicode characters, not 50,000 UTF-8 bytes. The
  // normal case fits within 200 kB; a legacy oversized row cannot be silently
  // approved or retried while the administrator sees only a prefix.
  const displayTruncated = amuxReviewTextExceedsDisplay(description);
  const safe = escalation.status === "open" || escalation.status === "acknowledged";
  const baseEligible = safe && task.archivedAt === null &&
    (task.status === "review" || task.status === "blocked") &&
    lastTerminal && activeDelivery === null;
  const outcomes: AmuxReviewOutcome[] = [];
  if (baseEligible && task.status === "review" && reviewAttempt) {
    if (artifact && !displayTruncated) outcomes.push("approve");
    outcomes.push("block");
  }
  if (baseEligible && task.status === "blocked") {
    outcomes.push("block");
    if (!displayTruncated && budget.allowed && dueCorrected &&
        (lastAttempt !== null || escalation.specialty === "planning-review")) {
      outcomes.push("retry");
    }
  }
  const reason = normalizeAmuxUntrustedReason(escalation.reason) ?? "(unavailable)";
  const attemptReason = normalizeAmuxUntrustedReason(lastAttempt?.reason);
  // The digest covers the entire stored value; a truncated legacy value can
  // be blocked, but never approved or requeued from a partial review.
  const subject: AmuxReviewSubject = {
    escalation_id: escalation.id,
    task_id: task.id,
    task_revision: task.revision,
    task_status: task.status === "review" ? "review" : "blocked",
    title: task.title,
    description,
    due_parse_state: task.dueParseState,
    due_at: task.dueAt?.toISOString() ?? null,
    escalation_specialty: escalation.specialty,
    escalation_reason: reason,
    last_attempt_id: lastAttempt?.id ?? null,
    last_attempt_revision: lastAttempt?.taskRevision ?? null,
    last_attempt_outcome: lastAttempt?.outcome ?? null,
    last_attempt_to_status: lastAttempt?.toStatus ?? null,
    last_attempt_reason: attemptReason,
    review_pr_number: artifact?.prNumber ?? null,
    review_base_sha: artifact?.baseSha ?? null,
    review_head_sha: artifact?.headSha ?? null,
    review_diff_digest: artifact?.diffDigest ?? null,
  };
  const digest = amuxReviewSubjectDigest(subject);
  const text = `Task ID: ${task.id}\nRevision: ${task.revision}\nEscalation ID: ${escalation.id}`;
  const context = {
    title: safeReviewDisplayText(task.title),
    description: safeReviewDisplayText(description),
    escalation_reason: reason,
    last_attempt_reason: attemptReason,
  };
  return { escalation, task, lastAttempt, budget, used, subject, digest, text, context, displayTruncated, outcomes, artifact };
}

export async function getAmuxReviewDetail(escalationId: string) {
  const fetchedArtifact = await artifactForEscalation(escalationId);
  const state = await prisma.$transaction((tx) => snapshot(tx, escalationId, fetchedArtifact));
  const { escalation, task, lastAttempt, used, digest, text, context, displayTruncated, outcomes, artifact } = state;
  return {
    available: true,
    escalation: {
      id: escalation.id,
      status: escalation.status,
      specialty: escalation.specialty,
      reason_code: publicAmuxEscalationReasonCode(task.status),
      created_at: escalation.createdAt.toISOString(),
    },
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      revision: task.revision,
      due_parse_state: task.dueParseState,
    },
    last_attempt: lastAttempt ? {
      id: lastAttempt.id,
      outcome: lastAttempt.outcome,
      to_status: lastAttempt.toStatus,
      ended_at: lastAttempt.endedAt?.toISOString() ?? null,
    } : null,
    review_content: { text, digest, truncated: displayTruncated },
    review_context: context,
    review_artifact: artifact ? {
      pr_number: artifact.prNumber,
      base_sha: artifact.baseSha,
      head_sha: artifact.headSha,
      diff_digest: artifact.diffDigest,
      diff_text: artifact.diffText,
      html_url: artifact.htmlUrl,
    } : null,
    allowed_outcomes: outcomes,
    retry: { used, limit: AMUX_MAX_EXECUTION_ATTEMPTS, remaining: Math.max(0, AMUX_MAX_EXECUTION_ATTEMPTS - used) },
    proposed_transitions: {
      approve: outcomes.includes("approve") ? "done" : null,
      retry: outcomes.includes("retry") ? "todo" : null,
      block: outcomes.includes("block") ? "blocked" : null,
    },
  };
}

export async function createAmuxReviewProposal(input: {
  escalationId: string;
  outcome: AmuxReviewOutcome;
  expectedSubjectDigest: string;
  session: Session;
  request: Request;
}) {
  const artifact = await artifactForEscalation(input.escalationId, input.outcome === "approve");
  return prisma.$transaction(async (tx) => {
    await lockTaskAndEscalation(tx, input.escalationId);
    const state = await snapshot(tx, input.escalationId, artifact);
    if (!state.outcomes.includes(input.outcome)) return refuse("AMUX_REVIEW_OUTCOME_UNAVAILABLE");
    if (state.digest !== input.expectedSubjectDigest) return refuse("AMUX_REVIEW_SUBJECT_CHANGED");
    const target = amuxReviewTargetStatus(
      state.task.status as "review" | "blocked",
      input.outcome,
    );
    if (!target) return refuse("AMUX_REVIEW_OUTCOME_UNAVAILABLE");
    const decisionId = randomUUID();
    // The database trigger replaces these timestamps with one DB-clock read.
    const proposed = await tx.amuxReviewProposal.create({
      data: {
        decisionId,
        escalationId: state.escalation.id,
        taskId: state.task.id,
        taskRevision: state.task.revision,
        outcome: input.outcome,
        sourceStatus: state.task.status,
        targetStatus: target,
        subjectDigest: state.digest,
        attemptId: state.lastAttempt?.id ?? null,
        reviewPrNumber: input.outcome === "approve" ? state.artifact?.prNumber ?? null : null,
        reviewBaseSha: input.outcome === "approve" ? state.artifact?.baseSha ?? null : null,
        reviewHeadSha: input.outcome === "approve" ? state.artifact?.headSha ?? null : null,
        reviewDiffDigest: input.outcome === "approve" ? state.artifact?.diffDigest ?? null : null,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "amux.human_escalation.proposed",
      targetType: "AmuxWorkItem",
      targetId: state.task.id,
      summary: "Prepared an AMUX human review decision.",
      metadata: {
        proposal_id: proposed.id,
        decision_id: proposed.decisionId,
        escalation_id: state.escalation.id,
        outcome: input.outcome,
        subject_digest: state.digest,
        task_revision: state.task.revision,
      },
      tx,
    });
    return {
      proposal: {
        id: proposed.id,
        decision_id: proposed.decisionId,
        outcome: input.outcome,
        task_revision: proposed.taskRevision,
        subject_digest: proposed.subjectDigest,
        source_status: proposed.sourceStatus,
        target_status: proposed.targetStatus,
        expires_at: proposed.expiresAt.toISOString(),
      },
    };
  });
}

/** A read-only reconciliation surface: absence is never proof of a failed write. */
export async function getAmuxReviewDecisionStatus(decisionId: string, subjectDigest: string) {
  const proposal = await prisma.amuxReviewProposal.findUnique({
    where: { decisionId },
    select: {
      id: true,
      decisionId: true,
      subjectDigest: true,
      outcome: true,
      targetStatus: true,
      taskRevision: true,
      decision: { select: { id: true, outcome: true } },
    },
  });
  const identity = { decision_id: decisionId, subject_digest: subjectDigest };
  if (!proposal || proposal.subjectDigest !== subjectDigest ||
      !proposal.decision || proposal.decision.id !== decisionId ||
      proposal.decision.outcome !== proposal.outcome) {
    return { status: "unconfirmed" as const, ...identity };
  }
  return {
    status: "committed" as const,
    ...identity,
    outcome: proposal.decision.outcome,
    task_status: proposal.targetStatus,
    task_revision: proposal.taskRevision + 1,
  };
}

export async function resolveAmuxReview(input: {
  escalationId: string;
  proposalId: string;
  idempotencyKey: string;
  resolution: string;
  session: Session;
  request: Request;
}) {
  const actorId = input.session.user?.id;
  if (!actorId) return refuse("AMUX_REVIEW_ACTOR_REQUIRED", 403);
  const keyHash = sha256Hex(input.idempotencyKey);
  const requestDigest = amuxReviewRequestDigest({
    proposal_id: input.proposalId,
    idempotency_key: input.idempotencyKey,
    resolution: input.resolution,
  });
  // A committed replay is independent of later GitHub availability and later
  // task revisions. The locked transaction below repeats this check for races.
  const committed = await prisma.amuxReviewDecision.findUnique({
    where: { proposalId: input.proposalId },
    include: { proposal: true },
  });
  if (committed) {
    if (committed.escalationId !== input.escalationId ||
        committed.idempotencyKeyHash !== keyHash ||
        committed.requestDigest !== requestDigest) {
      return refuse("AMUX_REVIEW_IDEMPOTENCY_CONFLICT");
    }
    return {
      success: true, outcome: committed.outcome,
      decision_id: committed.id,
      task_status: committed.proposal.targetStatus,
      task_revision: committed.proposal.taskRevision + 1,
    };
  }
  // Match execution admission's resource-before-task lock order. A later
  // planning edit invalidates the proposal under the task lock below. This
  // check is a requeue gate; execution still performs its own cost admission
  // and reservation immediately before any spend.
  const retryPlanning = await prisma.amuxReviewProposal.findUnique({
    where: { id: input.proposalId },
    select: {
      outcome: true,
      task: { select: {
        projectKey: true,
        teamKey: true,
        estimatedCostMicrousd: true,
      } },
    },
  });
  const artifact = await artifactForEscalation(input.escalationId, retryPlanning?.outcome === "approve");
  return prisma.$transaction(async (tx) => {
    const costPolicies = retryPlanning?.outcome === "retry"
      ? await lockAmuxResourcePolicies(tx, amuxResourceRefs(retryPlanning.task))
      : null;
    const taskId = await lockTaskAndEscalation(tx, input.escalationId);
    const proposalLocks = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AmuxReviewProposal"
      WHERE "id" = ${input.proposalId} AND "escalationId" = ${input.escalationId}
      FOR UPDATE
    `;
    if (!proposalLocks[0]) return refuse("AMUX_REVIEW_PROPOSAL_NOT_FOUND", 404);
    const proposal = await tx.amuxReviewProposal.findUniqueOrThrow({ where: { id: input.proposalId } });
    const existing = await tx.amuxReviewDecision.findUnique({ where: { proposalId: proposal.id } });
    if (existing) {
      if (existing.idempotencyKeyHash !== keyHash || existing.requestDigest !== requestDigest)
        return refuse("AMUX_REVIEW_IDEMPOTENCY_CONFLICT");
      return {
        success: true, outcome: existing.outcome,
        decision_id: existing.id,
        task_status: proposal.targetStatus,
        task_revision: proposal.taskRevision + 1,
      };
    }
    const state = await snapshot(tx, input.escalationId, artifact);
    const now = await dbNow(tx);
    if (proposal.outcome === "retry") {
      if (!retryPlanning || !costPolicies ||
          state.task.projectKey !== retryPlanning.task.projectKey ||
          state.task.teamKey !== retryPlanning.task.teamKey ||
          state.task.estimatedCostMicrousd !== retryPlanning.task.estimatedCostMicrousd) {
        return refuse("AMUX_REVIEW_PROPOSAL_CHANGED");
      }
      const costAdmission = await evaluateLockedAmuxCostAdmission(
        tx, costPolicies, state.task.estimatedCostMicrousd, now,
      );
      if (!costAdmission.allowed) return refuse("AMUX_REVIEW_COST_GUARD_BLOCKED");
    }
    if (proposal.expiresAt.getTime() <= now.getTime()) return refuse("AMUX_REVIEW_PROPOSAL_EXPIRED");
    if (proposal.taskId !== taskId || proposal.taskRevision !== state.task.revision ||
        proposal.sourceStatus !== state.task.status ||
        proposal.subjectDigest !== state.digest ||
        proposal.attemptId !== (state.lastAttempt?.id ?? null) ||
        !state.outcomes.includes(proposal.outcome as AmuxReviewOutcome)) {
      return refuse("AMUX_REVIEW_PROPOSAL_CHANGED");
    }
    if (proposal.outcome === "approve" &&
        (proposal.reviewPrNumber !== state.artifact?.prNumber ||
         proposal.reviewBaseSha !== state.artifact?.baseSha ||
         proposal.reviewHeadSha !== state.artifact?.headSha ||
         proposal.reviewDiffDigest !== state.artifact?.diffDigest)) {
      return refuse("AMUX_REVIEW_SOURCE_CHANGED");
    }
    const target = amuxReviewTargetStatus(
      state.task.status as "review" | "blocked", proposal.outcome as AmuxReviewOutcome,
    );
    if (!target || target !== proposal.targetStatus) return refuse("AMUX_REVIEW_PROPOSAL_CHANGED");
    const changed = await tx.amuxWorkItem.updateMany({
      where: { id: taskId, revision: proposal.taskRevision, status: proposal.sourceStatus },
      data: {
        status: target,
        revision: { increment: 1 },
        ...(proposal.outcome === "retry" ? { owner: null, claimedAt: null } : {}),
      },
    });
    if (changed.count !== 1) return refuse("AMUX_REVIEW_TASK_CONFLICT");
    const closed = await tx.amuxHumanEscalation.updateMany({
      where: { id: input.escalationId, status: { in: ["open", "acknowledged"] } },
      data: {
        status: "resolved",
        resolutionOutcome: proposal.outcome,
        resolution: input.resolution,
        resolvedById: actorId,
        resolvedByEmail: input.session.user?.email ?? null,
        resolvedAt: now,
      },
    });
    if (closed.count !== 1) return refuse("AMUX_REVIEW_ESCALATION_CONFLICT");
    const decisionId = proposal.decisionId;
    const auditLogId = await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "amux.human_escalation.resolved",
      targetType: "AmuxWorkItem",
      targetId: taskId,
      summary: "Resolved an AMUX human review escalation.",
      metadata: {
        decision_id: decisionId,
        proposal_id: proposal.id,
        escalation_id: input.escalationId,
        outcome: proposal.outcome,
        subject_digest: proposal.subjectDigest,
        review_base_sha: proposal.reviewBaseSha,
        previous_revision: proposal.taskRevision,
        next_revision: proposal.taskRevision + 1,
      },
      tx,
    });
    await tx.amuxReviewDecision.create({
      data: {
        id: decisionId,
        proposalId: proposal.id,
        escalationId: input.escalationId,
        outcome: proposal.outcome,
        requestDigest,
        idempotencyKeyHash: keyHash,
        actorUserId: actorId,
        auditLogId,
      },
    });
    if (proposal.outcome === "block" && state.budget.allowed) {
      // A block records the current reason without making a recoverable task
      // impossible to revisit. The old escalation/decision remain immutable;
      // a fresh unresolved escalation carries the next reason or retry.
      await openAmuxHumanEscalation(tx, {
        taskId,
        specialty: state.escalation.specialty,
        reason: "human_review_required",
        openedBy: "system:amux-review-block",
      });
    }
    return {
      success: true,
      outcome: proposal.outcome,
      decision_id: decisionId,
      task_status: target,
      task_revision: proposal.taskRevision + 1,
    };
  }, { timeout: 10_000 });
}

export async function acknowledgeAmuxReview(input: {
  escalationId: string;
  session: Session;
  request: Request;
}) {
  return prisma.$transaction(async (tx) => {
    const taskId = await lockTaskAndEscalation(tx, input.escalationId);
    const changed = await tx.amuxHumanEscalation.updateMany({
      where: { id: input.escalationId, status: "open" },
      data: {
        status: "acknowledged",
        acknowledgedById: input.session.user.id,
        acknowledgedByEmail: input.session.user.email ?? null,
        acknowledgedAt: await dbNow(tx),
      },
    });
    if (changed.count !== 1) return refuse("AMUX_REVIEW_ESCALATION_CONFLICT");
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "amux.human_escalation.acknowledged",
      targetType: "AmuxWorkItem",
      targetId: taskId,
      summary: "Acknowledged an AMUX human escalation.",
      metadata: { escalation_id: input.escalationId },
      tx,
    });
    return { success: true };
  });
}
