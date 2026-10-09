import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  amuxReviewApprovalHasEvidence,
  amuxReviewDisplayIsExact,
  amuxReviewTextExceedsDisplay,
  amuxReviewRequestDigest,
  amuxReviewSubjectDigest,
  amuxReviewTargetStatus,
  amuxV22ReviewRetryHasVerifiedOutcome,
  amuxV4ReviewEvidenceMatches,
  sha256Hex,
  safeReviewDisplayText,
  type AmuxReviewOutcome,
  type AmuxReviewSubject,
} from "@/lib/amux/reviewApprovalCore";
import { AMUX_MAX_EXECUTION_ATTEMPTS, decideAmuxAttemptBudget } from "@/lib/amux/executionBudgetCore";
import { normalizeAmuxUntrustedReason, openAmuxHumanEscalation, publicAmuxEscalationReasonCode } from "@/lib/amux/escalation";
import { readAmuxReviewPullRequest, type AmuxReviewPullRequest } from "@/lib/amux/reviewGitHub";
import { readAmuxExecutionTaskDetail } from "@/lib/amux/adminExecutionRead";
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
type V4ReviewEvidence = {
  taskId: string; revision: number; title: string; description: string;
  titleDigest: string | null; bodyDigest: string | null;
  briefDigest: string | null; resultAttemptId: string | null;
  resultSha256: string | null;
};

/** Verified private content is read outside the row-lock transaction. The
 * transaction checks its revision, keyed digests and result SHA again. */
async function v4EvidenceForEscalation(escalationId: string):
  Promise<V4ReviewEvidence | null> {
  const escalation = await prisma.amuxHumanEscalation.findUnique({
    where: { id: escalationId },
    select: { task: { select: { id: true, sourceSystem: true,
      reviewPrNumber: true } } },
  });
  if (!escalation || escalation.task.sourceSystem !== "admin-idea-v4") return null;
  try {
    const detail = await readAmuxExecutionTaskDetail(escalation.task.id);
    if (!detail?.title || !detail.body || !detail.brief ||
        !detail.v4EvidenceDigests?.title || !detail.v4EvidenceDigests.body ||
        !detail.v4EvidenceDigests.brief) return null;
    const retainedResult = detail.result?.state === "available" &&
      detail.result.text ? detail.result : null;
    const retainedResultText = retainedResult?.text ?? null;
    return {
      taskId: escalation.task.id, revision: detail.revision,
      title: detail.title,
      description: `Scope and completion criteria:\n${detail.body}\n\nApproved brief:\n${detail.brief}` +
        (escalation.task.reviewPrNumber === null && retainedResultText ?
          `\n\nVerified worker result:\n${retainedResultText}` : ""),
      titleDigest: detail.v4EvidenceDigests.title,
      bodyDigest: detail.v4EvidenceDigests.body,
      briefDigest: detail.v4EvidenceDigests.brief,
      resultAttemptId: retainedResult?.attemptId ?? null,
      resultSha256: retainedResultText ?
        retainedResult?.sha256 ?? sha256Hex(retainedResultText) : null,
    };
  } catch { return null; }
}

const refuse = (code: string, status = 409): never => {
  throw new AmuxReviewRefusal(code, status);
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
  fetchedV4: V4ReviewEvidence | null,
) {
  const escalation = await tx.amuxHumanEscalation.findUnique({
    where: { id: escalationId },
    include: { task: true },
  });
  if (!escalation) return refuse("AMUX_REVIEW_NOT_FOUND", 404);
  const task = escalation.task;
  const artifact = task.status === "review" &&
    task.reviewPrNumber === fetchedArtifact?.prNumber ? fetchedArtifact : null;
  const [lastAttempt, attemptCount, activeDelivery, previousBlock, latestV4Result] = await Promise.all([
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
    tx.amuxHumanEscalation.findFirst({
      where: { taskId: task.id, status: "resolved", resolutionOutcome: "block" },
      orderBy: [{ resolvedAt: "desc" }, { id: "desc" }],
      select: { resolution: true },
    }),
    task.sourceSystem === "admin-idea-v4" ?
      tx.amuxV22TaskResult.findFirst({ where: { taskId: task.id },
        orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
        select: { attemptId: true, sourceSha256: true, bodyPurgedAt: true } }) :
      Promise.resolve(null),
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
  const v4ContentValid = task.sourceSystem === "admin-idea-v4" &&
    fetchedV4?.taskId === task.id && fetchedV4.revision === task.revision &&
    fetchedV4.titleDigest === task.v4TitleDigest &&
    fetchedV4.bodyDigest === task.v4BodyDigest &&
    fetchedV4.briefDigest === task.v4BriefDigest;
  const v4Valid = amuxV4ReviewEvidenceMatches({
    task: { id: task.id, sourceSystem: task.sourceSystem,
      revision: task.revision, titleDigest: task.v4TitleDigest,
      bodyDigest: task.v4BodyDigest, briefDigest: task.v4BriefDigest },
    evidence: fetchedV4, result: latestV4Result, attempt: lastAttempt,
  });
  const description = v4ContentValid && fetchedV4 ? fetchedV4.description : task.description;
  const reviewTitle = v4ContentValid && fetchedV4 ? fetchedV4.title : task.title;
  // Ingress allows 50,000 Unicode characters, not 50,000 UTF-8 bytes. The
  // normal case fits within 200 kB; a legacy oversized row cannot be silently
  // approved or retried while the administrator sees only a prefix.
  const displayTruncated = amuxReviewTextExceedsDisplay(reviewTitle) ||
    amuxReviewTextExceedsDisplay(description);
  // Every approval must bind exactly the text the owner can inspect. A control
  // character, bidi override, or normalization change is not silently hidden.
  const displayExact = amuxReviewDisplayIsExact(reviewTitle) &&
    amuxReviewDisplayIsExact(description);
  const safe = escalation.status === "open" || escalation.status === "acknowledged";
  const baseEligible = safe && task.archivedAt === null &&
    (task.status === "review" || task.status === "blocked") &&
    lastTerminal && activeDelivery === null;
  const outcomes: AmuxReviewOutcome[] = [];
  if (baseEligible && task.status === "review" && reviewAttempt) {
    if (amuxReviewApprovalHasEvidence({ sourceSystem: task.sourceSystem,
      cardType: task.cardType, taskRole: task.taskRole,
      reviewPrNumber: task.reviewPrNumber,
      artifactAvailable: artifact !== null,
      v4EvidenceVerified: v4Valid, displayTruncated,
      displayExact })) outcomes.push("approve");
    outcomes.push("block");
  }
  if (baseEligible && task.status === "blocked") {
    outcomes.push("block");
    if (!displayTruncated && displayExact && budget.allowed && dueCorrected &&
        amuxV22ReviewRetryHasVerifiedOutcome({
          sourceSystem: task.sourceSystem, attempt: lastAttempt,
        }) &&
        (lastAttempt !== null || escalation.specialty === "planning-review")) {
      outcomes.push("retry");
    }
  }
  const reason = normalizeAmuxUntrustedReason(escalation.reason) ?? "(unavailable)";
  const attemptReason = normalizeAmuxUntrustedReason(lastAttempt?.reason);
  const previousBlockReason = normalizeAmuxUntrustedReason(previousBlock?.resolution);
  // The digest covers the entire stored value; a truncated legacy value can
  // be blocked, but never approved or requeued from a partial review.
  const subject: AmuxReviewSubject = {
    escalation_id: escalation.id,
    task_id: task.id,
    task_revision: task.revision,
    task_status: task.status === "review" ? "review" : "blocked",
    title: reviewTitle,
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
    previous_block_reason: previousBlockReason,
    review_pr_number: artifact?.prNumber ?? null,
    review_base_sha: artifact?.baseSha ?? null,
    review_head_sha: artifact?.headSha ?? null,
    review_diff_digest: artifact?.diffDigest ?? null,
    ...(task.sourceSystem === "admin-idea-v4" ? { v4_evidence: {
      title_digest: task.v4TitleDigest,
      body_digest: task.v4BodyDigest,
      brief_digest: task.v4BriefDigest,
      result_attempt_id: task.reviewPrNumber === null && v4Valid && fetchedV4 ?
        fetchedV4.resultAttemptId : null,
      result_sha256: task.reviewPrNumber === null && v4Valid && fetchedV4 ?
        fetchedV4.resultSha256 : null,
    } } : {}),
  };
  const digest = amuxReviewSubjectDigest(subject);
  const text = `Task ID: ${task.id}\nRevision: ${task.revision}\nEscalation ID: ${escalation.id}`;
  const context = {
    title: safeReviewDisplayText(reviewTitle),
    description: safeReviewDisplayText(description),
    result_sha256: task.reviewPrNumber === null && v4Valid && fetchedV4 ?
      fetchedV4.resultSha256 : null,
    escalation_reason: reason,
    last_attempt_reason: attemptReason,
    previous_block_reason: previousBlockReason,
  };
  return { escalation, task, lastAttempt, budget, used, subject, digest, text,
    context, displayTruncated, displayExact, outcomes, artifact };
}

export async function getAmuxReviewDetail(escalationId: string) {
  const [fetchedArtifact, fetchedV4] = await Promise.all([
    artifactForEscalation(escalationId), v4EvidenceForEscalation(escalationId),
  ]);
  const state = await prisma.$transaction((tx) => snapshot(tx, escalationId, fetchedArtifact, fetchedV4));
  const { escalation, task, lastAttempt, used, digest, text, context,
    displayTruncated, displayExact, outcomes, artifact } = state;
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
      title: context.title ?? task.title,
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
    review_content: { text, digest, truncated: displayTruncated,
      display_mismatch: !displayExact },
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
  const [artifact, v4Evidence] = await Promise.all([
    artifactForEscalation(input.escalationId, input.outcome === "approve"),
    v4EvidenceForEscalation(input.escalationId),
  ]);
  return prisma.$transaction(async (tx) => {
    await lockTaskAndEscalation(tx, input.escalationId);
    const state = await snapshot(tx, input.escalationId, artifact, v4Evidence);
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
  const [artifact, v4Evidence] = await Promise.all([
    artifactForEscalation(input.escalationId, retryPlanning?.outcome === "approve"),
    v4EvidenceForEscalation(input.escalationId),
  ]);
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
    const state = await snapshot(tx, input.escalationId, artifact, v4Evidence);
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
        (proposal.reviewPrNumber !== (state.artifact?.prNumber ?? null) ||
         proposal.reviewBaseSha !== (state.artifact?.baseSha ?? null) ||
         proposal.reviewHeadSha !== (state.artifact?.headSha ?? null) ||
         proposal.reviewDiffDigest !== (state.artifact?.diffDigest ?? null))) {
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
        // A retried card starts a new attempt; the previous attempt's review
        // PR must not be approved as the new attempt's work.
        ...(proposal.outcome === "retry"
          ? { owner: null, claimedAt: null, reviewPrNumber: null }
          : {}),
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
