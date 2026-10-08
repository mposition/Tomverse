import "server-only";

import { randomInt, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_MAX_EXPECTED_REVISION } from "@/lib/amux/claimContract";
import { lockAmuxAdmissionAndReadIncident } from "@/lib/amux/incident";
import { findOpenAmuxOrchestratorHalt } from "@/lib/amux/orchestratorHaltStore";
import { cancelPendingAmuxWorkDelivery } from "@/lib/amux/delivery";
import {
  AMUX_DB_BOUNDARIES,
  AmuxDbBoundaryError,
  amuxBoundaryWithAttachment,
  amuxRouteOrchestratorReceiptsMayHaveCommitted,
  withAmuxDbBoundary,
  type AmuxAttachment,
} from "@/lib/amux/dbBoundary";
import {
  decideAmuxAttemptBudget,
  settlementDestinationForBudget,
} from "@/lib/amux/executionBudgetCore";
import { openAmuxHumanEscalation } from "@/lib/amux/escalation";
import {
  AMUX_DEFAULT_REVIEW_SPECIALTY,
  amuxBridgeSettleReason,
  amuxHumanReviewRequired,
  amuxReviewPrNumberAccepted,
} from "@/lib/amux/humanReviewCore";
import {
  evaluateLockedAmuxCostAdmission,
  lockAmuxResourcePolicies,
} from "@/lib/amux/resourcePolicy";
import { amuxResourceRefs } from "@/lib/amux/resourcePolicyCore";
import {
  buildAmuxDeliveryPrompt,
  classifyApprovedExecutionBrief,
} from "@/lib/amux/deliveryPrompt";
import { calculateCurrentApprovedAmuxV4TaskCost } from
  "@/lib/amux/v4TaskCostCatalogApprovalService";
import { checkV4TaskApprovedCeiling } from "@/lib/amux/v4TaskCostCeilingCore";
import { ENGINEERING_AGENT_POLICY_VERSION,
  v22RunOutcomeForProduct } from "@/lib/engineeringAgentCore";
import {
  EngineeringAgentStoreRefusedError,
  endEngineeringAgentRun,
  engineeringAgentTransactionInAmux,
  heartbeatEngineeringAgentRun,
  lockEngineeringAgentV22Run,
  readEngineeringAgentSwitches,
  recordEngineeringAgentRunStart,
  requireEngineeringAgentRunAdmission,
} from "@/lib/engineeringAgentStore";
import { AMUX_V22_SEALED_DELIVERY_MARKER,
  AMUX_V22_ENGINEERING_PUBLICATION_ENV,
  AMUX_V22_TASK_EXECUTION_ENV, amuxV22EngineeringPublicationEnabled,
  amuxV22TaskExecutionEnabled,
  v22ExecutionCostWithinAssignment,
  v22ExecutionReceiptVerified,
  v22SettlementPatchMatches } from "@/lib/amux/v22TaskExecutionCore";
import { loadEngineeringAgentV22SettlementPatch } from
  "@/lib/engineeringAgentV22SettlementPatch";
import { loadEngineeringAgentV22StoredCandidate } from
  "@/lib/engineeringAgentV22StoredCandidate";
import { v22PublishCandidateMatches, v22PublishPreflightEligible } from
  "@/lib/engineeringAgentV22PublicationDecision";
import { openEngineeringAgentV22Product } from
  "@/lib/engineeringAgentV22ProductStore";
import { currentEngineeringAgentV22ImageProofDigest } from
  "@/lib/engineeringAgentV22ImageEvidence";
import { readAmuxV22PublicPrConsent } from
  "@/lib/amux/v22PublicPrConsent";

export const AMUX_EXECUTION_LEASE_MS = 90_000;

/**
 * Ownership claim is a routing reservation, not an execution lease.
 * If no Todo -> Doing execution start wins within this window, recovery may
 * release the owner so Global Priority can route the task again.
 */
export const AMUX_CLAIM_RESERVATION_MS = 180_000;

export type AmuxExecutionOutcome = "succeeded" | "failed" | "blocked";

export type AmuxExecutionToStatus = "todo" | "review" | "done" | "blocked";

/**
 * The agents whose own model spend a settlement may record, under the
 * ledger's `agent` scope (orchestration policy, Authority, version 12). It is
 * never part of the attempt's reservation, its settlement delta or admission.
 */
export const AMUX_AGENT_USAGE_AGENTS = ["engineering-agent"] as const;
export type AmuxAgentUsage = { agentId: (typeof AMUX_AGENT_USAGE_AGENTS)[number]; amountMicrousd: bigint };

/** The UTC calendar month an agent usage row is charged to. */
export const amuxAgentUsageWindow = (at: Date): { startsAt: Date; endsAt: Date } => ({
  startsAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
  endsAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
});

/** What an attachment to execution start sees: the attempt that now exists. */
export type AmuxExecutionStartedFact = {
  attemptId: string;
  taskId: string;
  taskRevision: number;
  leaseExpiresAt: Date;
};

/** What an attachment to an execution heartbeat sees: the renewed lease. */
export type AmuxExecutionRenewedFact = {
  attemptId: string;
  taskId: string;
  leaseExpiresAt: Date;
};

/** What an attachment to settlement sees: where the task actually went. */
export type AmuxExecutionSettledFact = {
  attemptId: string;
  taskId: string;
  outcome: AmuxExecutionOutcome;
  toStatus: AmuxExecutionToStatus;
  taskRevision: number;
};

type RuntimeLockRow = {
  workerName: string;
  instanceId: string;
  generation: number;
  status: string;
  dispatchReady: boolean;
  leaseExpiresAt: Date;
};

type AttemptLockRow = {
  id: string;
  taskId: string;
  worker: string;
  workerInstanceId: string;
  workerGeneration: number;
  taskRevision: number;
  attemptNumber: number | null;
  reservedCostMicrousd: bigint;
  v22AssignmentId: string | null;
  leaseExpiresAt: Date | null;
  endedAt: Date | null;
};

type TaskLockRow = {
  id: string;
  sourceSystem: string | null;
  v22AssignmentId: string | null;
  owner: string | null;
  status: string;
  revision: number;
  claimedAt: Date | null;
  archivedAt: Date | null;
  projectKey: string | null;
  teamKey: string | null;
  estimatedCostMicrousd: bigint | null;
  requiresHumanReview: boolean;
  reviewSpecialty: string | null;
  executionBrief: string | null;
  executionBriefDigest: string | null;
};

const executionLeaseExpiry = (now: Date) =>
  new Date(now.getTime() + AMUX_EXECUTION_LEASE_MS);

const lockRuntime = async (
  tx: Prisma.TransactionClient,
  worker: string,
): Promise<RuntimeLockRow | null> => {
  const rows = await tx.$queryRaw<RuntimeLockRow[]>`
    SELECT
      "workerName",
      "instanceId",
      "generation",
      "status",
      "dispatchReady",
      "leaseExpiresAt"
    FROM "AmuxWorkerRuntime"
    WHERE "workerName" = ${worker}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const lockAttempt = async (
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<AttemptLockRow | null> => {
  const rows = await tx.$queryRaw<AttemptLockRow[]>`
    SELECT
      "id",
      "taskId",
      "worker",
      "workerInstanceId",
      "workerGeneration",
      "taskRevision",
      "attemptNumber",
      "reservedCostMicrousd",
      "v22AssignmentId",
      "leaseExpiresAt",
      "endedAt"
    FROM "AmuxExecutionAttempt"
    WHERE "id" = ${attemptId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const lockTask = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<TaskLockRow | null> => {
  const rows = await tx.$queryRaw<TaskLockRow[]>`
    SELECT
      "id",
      "sourceSystem",
      "v22AssignmentId",
      "owner",
      "status",
      "revision",
      "claimedAt",
      "archivedAt"
      ,"projectKey"
      ,"teamKey"
      ,"estimatedCostMicrousd"
      ,"requiresHumanReview"
      ,"reviewSpecialty"
      ,"executionBrief"
      ,"executionBriefDigest"
    FROM "AmuxWorkItem"
    WHERE "id" = ${taskId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const runtimeGenerationMatches = (
  runtime: RuntimeLockRow | null,
  input: {
    worker: string;
    instanceId: string;
    generation: number;
  },
  now: Date,
) =>
  runtime !== null &&
  runtime.workerName === input.worker &&
  runtime.instanceId === input.instanceId &&
  runtime.generation === input.generation &&
  runtime.leaseExpiresAt.getTime() > now.getTime();

const validSettlement = (
  outcome: AmuxExecutionOutcome,
  toStatus: AmuxExecutionToStatus,
) =>
  (outcome === "succeeded" && (toStatus === "review" || toStatus === "done")) ||
  (outcome === "failed" && toStatus === "todo") ||
  (outcome === "blocked" && toStatus === "blocked");

/** Consume exactly the A13 assignment, without reusing legacy ownership as
 * execution authority. No CLI call occurs here; the A14 usage receipt must
 * follow the delivery before settlement can be accepted. */
export async function startAmuxV22TaskExecution(input: {
  taskId: string;
  assignmentId: string;
  worker: string;
  instanceId: string;
  generation: number;
  expectedRevision: number;
  /** App-read develop head, supplied only after exact owner disclosure check. */
  publicationBaseSha?: string | null;
}) {
  if (!amuxV22TaskExecutionEnabled(process.env[AMUX_V22_TASK_EXECUTION_ENV]))
    return { started: false as const, reason: "v22_execution_disabled" as const };
  const publicationBaseSha = amuxV22EngineeringPublicationEnabled(
    process.env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]) &&
    input.publicationBaseSha &&
    /^[0-9a-f]{40}$/.test(input.publicationBaseSha)
    ? input.publicationBaseSha : null;
  return withAmuxDbBoundary({ ...AMUX_DB_BOUNDARIES.executionStart,
    prismaCallCeiling: AMUX_DB_BOUNDARIES.executionStart.prismaCallCeiling +
      (publicationBaseSha ? 24 : 0) },
    async (tx, context) => {
      const now = context.dbNow;
      const incident = await lockAmuxAdmissionAndReadIncident(tx, now);
      if (incident.blocks_admission) return { started: false as const,
        reason: "incident_frozen" as const };
      const halt = await findOpenAmuxOrchestratorHalt(tx);
      if (halt) return { started: false as const,
        reason: "orchestrator_halted" as const };
      const runtime = await lockRuntime(tx, input.worker);
      if (!runtimeGenerationMatches(runtime, input, now) ||
          runtime?.status !== "idle" || !runtime.dispatchReady) {
        return { started: false as const, reason: "runtime_not_ready" as const };
      }
      const task = await lockTask(tx, input.taskId);
      const card = task && await tx.amuxWorkItem.findUnique({
        where: { id: input.taskId },
        select: { kind: true, cardType: true, taskRole: true, executionGrade: true,
          v22AssignmentId: true, v4SourceApprovalId: true,
          v4BriefDigest: true, v22ReceiptId: true,
          reviewPrNumber: true },
      });
      if (!task || !card || task.sourceSystem !== "admin-idea-v4" ||
          card.cardType !== "task" || task.status !== "todo" ||
          task.owner !== input.worker || task.archivedAt !== null ||
          task.revision !== input.expectedRevision ||
          card.v22AssignmentId !== input.assignmentId ||
          !card.v22ReceiptId || !card.v4SourceApprovalId ||
          !card.taskRole || !card.executionGrade || !card.v4BriefDigest ||
          card.reviewPrNumber !== null ||
          !task.claimedAt) {
        return { started: false as const, reason: "assignment_mismatch" as const };
      }
      const assignment = await tx.amuxV22WorkerAssignment.findUnique({
        where: { id: input.assignmentId },
      });
      const promotion = await tx.amuxV22PromotionReceipt.findUnique({
        where: { id: card.v22ReceiptId },
        select: { workItemId: true, sourceApprovalId: true,
          briefDigest: true },
      });
      if (!assignment || assignment.workItemId !== input.taskId ||
          assignment.taskRevision + 1 !== task.revision ||
          assignment.workerName !== input.worker ||
          assignment.workerInstanceId !== input.instanceId ||
          assignment.workerGeneration !== input.generation ||
          assignment.role !== card.taskRole ||
          assignment.grade !== card.executionGrade ||
          promotion?.workItemId !== input.taskId ||
          promotion.sourceApprovalId !== card.v4SourceApprovalId ||
          promotion.briefDigest !== card.v4BriefDigest) {
        return { started: false as const, reason: "assignment_mismatch" as const };
      }
      const source = await tx.amuxIdeaUnitDecision.findUnique({
        where: { id: card.v4SourceApprovalId },
        select: { confirmationSnapshot: true },
      });
      const snapshot = source?.confirmationSnapshot;
      const approved = snapshot && typeof snapshot === "object" &&
        !Array.isArray(snapshot) && "card" in snapshot && snapshot.card &&
        typeof snapshot.card === "object" && !Array.isArray(snapshot.card) &&
        "task" in snapshot.card && snapshot.card.task &&
        typeof snapshot.card.task === "object" &&
        !Array.isArray(snapshot.card.task) &&
        "costReceipt" in snapshot.card.task ? snapshot.card.task.costReceipt : null;
      let cost;
      try { cost = await calculateCurrentApprovedAmuxV4TaskCost(tx,
        card.taskRole, card.executionGrade); }
      catch { return { started: false as const,
        reason: "cost_unverified" as const }; }
      if (checkV4TaskApprovedCeiling(approved,
        { ok: true, receipt: cost.receipt }).decision !== "allow") {
        return { started: false as const,
          reason: "cost_reconfirmation_required" as const };
      }
      const route = cost.receipt.routes.find((candidate) =>
        candidate.routeId === assignment.routeId &&
        candidate.workerName === assignment.workerName &&
        candidate.provider === assignment.provider &&
        candidate.modelId === assignment.modelId &&
        candidate.routePolicyDigest === assignment.routePolicyDigest);
      const prior = await tx.amuxExecutionAttempt.aggregate({
        where: { taskId: input.taskId },
        _count: { _all: true }, _max: { attemptNumber: true },
        _sum: { reservedCostMicrousd: true },
      });
      const budget = decideAmuxAttemptBudget({
        historical_rows: prior._count._all,
        greatest_attempt_number: prior._max.attemptNumber,
      });
      if (!budget.allowed) return { started: false as const,
        reason: "attempt_budget_exhausted" as const };
      if (!route || !approved || typeof approved !== "object" ||
          !("ceilingMicroUsd" in approved) ||
          typeof approved.ceilingMicroUsd !== "string" ||
          !v22ExecutionCostWithinAssignment({
            assignedMicroUsd: assignment.perAttemptMicroUsd,
            currentMicroUsd: BigInt(route.perAttemptMicroUsd),
            approvedCeilingMicroUsd: BigInt(approved.ceilingMicroUsd),
            priorReservedMicroUsd: prior._sum.reservedCostMicrousd ?? BigInt(0),
          })) {
        return { started: false as const, reason: "cost_unverified" as const };
      }
      let publicationRunId: string | null = null;
      if (publicationBaseSha && card.taskRole === "implement" &&
          (await readEngineeringAgentSwitches(tx)).publishAllowed) {
        try {
          // The engineering row is optional for Task execution. A full owner
          // queue or halted Publisher leaves the Task's result private.
          await requireEngineeringAgentRunAdmission(
            engineeringAgentTransactionInAmux(context.attachedTransaction));
          publicationRunId = String(randomInt(100_000_000_000,
            1_000_000_000_000));
        } catch (error) {
          if (!(error instanceof EngineeringAgentStoreRefusedError)) throw error;
        }
      }
      const changed = await tx.amuxWorkItem.updateMany({ where: {
        id: input.taskId, status: "todo", owner: input.worker,
        v22AssignmentId: input.assignmentId, revision: input.expectedRevision,
      }, data: { status: "doing", revision: { increment: 1 } } });
      if (changed.count !== 1) return { started: false as const,
        reason: "assignment_mismatch" as const };
      const busy = await tx.amuxWorkerRuntime.updateMany({ where: {
        workerName: input.worker, instanceId: input.instanceId,
        generation: input.generation, status: "idle", dispatchReady: true,
        leaseExpiresAt: { gt: now },
      }, data: { status: "busy", dispatchReady: false } });
      if (busy.count !== 1) throw new Error("v22 runtime changed during start");
      const attemptId = randomUUID();
      const leaseExpiresAt = executionLeaseExpiry(now);
      await tx.amuxExecutionAttempt.create({ data: {
        id: attemptId, taskId: input.taskId, worker: input.worker,
        workerInstanceId: input.instanceId,
        workerGeneration: input.generation,
        taskRevision: input.expectedRevision + 1,
        attemptNumber: budget.next_attempt_number,
        reservedCostMicrousd: assignment.perAttemptMicroUsd,
        heartbeatAt: now, leaseExpiresAt, startedAt: now,
        v22AssignmentId: input.assignmentId,
      } });
      if (publicationRunId && publicationBaseSha) {
        await recordEngineeringAgentRunStart(
          engineeringAgentTransactionInAmux(context.attachedTransaction), {
            runId: publicationRunId, amuxAttemptId: attemptId,
            cardId: task.id, cardKind: card.kind,
            baseSha: publicationBaseSha,
            leaseMs: leaseExpiresAt.getTime() - now.getTime(),
          });
      }
      await tx.amuxWorkDelivery.create({ data: {
        attemptId, taskId: input.taskId, worker: input.worker,
        workerInstanceId: input.instanceId,
        workerGeneration: input.generation,
        taskRevision: input.expectedRevision + 1,
        prompt: AMUX_V22_SEALED_DELIVERY_MARKER,
      } });
      await writeSystemAuditLog({ tx,
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.v22.execution.started",
        targetType: "AmuxExecutionAttempt", targetId: attemptId,
        summary: "Started one assignment-bound AMUX v22 Task attempt.",
        metadata: { taskId: input.taskId, assignmentId: input.assignmentId,
          worker: input.worker, taskRevision: input.expectedRevision + 1,
          reservedCostMicrousd: assignment.perAttemptMicroUsd.toString() },
      });
      context.requireLeaseAt(runtime.leaseExpiresAt);
      context.requireLeaseAt(leaseExpiresAt);
      return { started: true as const, attemptId,
        taskRevision: input.expectedRevision + 1, leaseExpiresAt };
    });
}

/** A lost start response must be read back by assignment, never retried blind. */
export async function readAmuxV22TaskExecution(input: {
  assignmentId: string; worker: string; instanceId: string; generation: number;
}) {
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.executionRecoveryRead,
    async (tx) => {
      const assignment = await tx.amuxV22WorkerAssignment.findUnique({
        where: { id: input.assignmentId },
        select: { workerName: true, workerInstanceId: true,
          workerGeneration: true, executionAttempt: { select: {
            id: true, taskRevision: true, leaseExpiresAt: true,
            endedAt: true, outcome: true, toStatus: true,
          } } },
      });
      if (!assignment || assignment.workerName !== input.worker ||
          assignment.workerInstanceId !== input.instanceId ||
          assignment.workerGeneration !== input.generation)
        return { found: false as const };
      const attempt = assignment.executionAttempt;
      if (!attempt) return { found: true as const,
        state: "not_started" as const };
      return { found: true as const,
        state: attempt.endedAt ? "ended" as const : "started" as const,
        attemptId: attempt.id, taskRevision: attempt.taskRevision,
        leaseExpiresAt: attempt.leaseExpiresAt,
        outcome: attempt.outcome, toStatus: attempt.toStatus };
    });
}

/**
 * Starts execution only for the currently-owned Todo and the currently-live
 * worker runtime generation.
 *
 * Incident lock -> resource locks -> runtime row lock -> task CAS -> attempt
 * creation are one transaction.
 * Failure at any later write rolls the todo->doing transition back.
 */
export async function startAmuxExecution(
  input: {
    taskId: string;
    worker: string;
    instanceId: string;
    generation: number;
    expectedRevision: number;
    now?: Date;
  },
  attachment?: AmuxAttachment<AmuxExecutionStartedFact>,
): Promise<
  | {
      started: true;
      attemptId: string;
      taskRevision: number;
      leaseExpiresAt: Date;
    }
  | {
      started: false;
      reason:
        | "runtime_not_ready"
        | "task_not_startable"
        | "attempt_budget_exhausted"
        | "incident_frozen"
        | "cost_estimate_missing"
        | "cost_budget_exhausted"
        | "cost_budget_window_inactive"
        | "execution_brief_unverified";
    }
> {
  if (input.expectedRevision > AMUX_MAX_EXPECTED_REVISION) {
    return { started: false, reason: "task_not_startable" };
  }

  return withAmuxDbBoundary(
    amuxBoundaryWithAttachment(AMUX_DB_BOUNDARIES.executionStart, attachment),
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      const incident = await lockAmuxAdmissionAndReadIncident(tx, now);
      if (incident.blocks_admission) {
        // main recorded this refusal (#1595) and a develop merge had dropped
        // it; tests/integration/amux-orchestration.db.test.ts pins it.
        await writeSystemAuditLog({
          systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.execution.start_refused",
          targetType: "AmuxWorkItem",
          targetId: input.taskId,
          summary: `Refused AMUX execution start for ${input.taskId} during incident mode.`,
          metadata: {
            reason: "incident_frozen",
            worker: input.worker,
            expected_revision: input.expectedRevision,
            incident_state: incident.state.state,
            incident_transition_id: incident.state.transition_id,
            incident_valid: incident.valid,
            measured: true,
            verdict: "refused",
          },
          tx,
        });
        return {
          started: false as const,
          reason: "incident_frozen" as const,
        };
      }

      const planning = await tx.amuxWorkItem.findUnique({
        where: { id: input.taskId },
        select: {
          sourceSystem: true,
          projectKey: true,
          teamKey: true,
          effortPoints: true,
          estimatedCostMicrousd: true,
        },
      });
      if (!planning || planning.sourceSystem === "admin-idea-v4") {
        return {
          started: false as const,
          reason: "task_not_startable" as const,
        };
      }

      const resourcePolicies = await lockAmuxResourcePolicies(
        tx,
        amuxResourceRefs(planning),
      );

      const runtime = await lockRuntime(tx, input.worker);

      if (
        !runtimeGenerationMatches(runtime, input, now) ||
        runtime?.status !== "idle" ||
        !runtime.dispatchReady
      ) {
        return {
          started: false as const,
          reason: "runtime_not_ready" as const,
        };
      }

      const lockedTask = await lockTask(tx, input.taskId);
      if (
        !lockedTask ||
        lockedTask.sourceSystem === "admin-idea-v4" ||
        lockedTask.owner !== input.worker ||
        lockedTask.status !== "todo" ||
        lockedTask.archivedAt !== null ||
        lockedTask.revision !== input.expectedRevision ||
        lockedTask.projectKey !== planning.projectKey ||
        lockedTask.teamKey !== planning.teamKey ||
        lockedTask.estimatedCostMicrousd !== planning.estimatedCostMicrousd
      ) {
        return {
          started: false as const,
          reason: "task_not_startable" as const,
        };
      }

      // Every row this start locks is locked; nothing is written yet.
      if (attachment?.beforeWrite) {
        await attachment.beforeWrite(context.attachedTransaction, { taskId: input.taskId });
      }

      const costAdmission = await evaluateLockedAmuxCostAdmission(
        tx,
        resourcePolicies,
        lockedTask.estimatedCostMicrousd,
        now,
      );
      if (!costAdmission.allowed) {
        const blocked = await tx.amuxWorkItem.updateMany({
          where: {
            id: input.taskId,
            owner: input.worker,
            status: "todo",
            archivedAt: null,
            revision: input.expectedRevision,
          },
          data: { status: "blocked", revision: { increment: 1 } },
        });
        if (blocked.count !== 1) {
          return {
            started: false as const,
            reason: "task_not_startable" as const,
          };
        }
        await openAmuxHumanEscalation(tx, {
          taskId: input.taskId,
          specialty: "cost-operations",
          reason: "operational_cost_blocked",
          openedBy: AMUX_SYSTEM_AUDIT_ACTOR,
        });
        await writeSystemAuditLog({
          systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.execution.cost_guard_blocked",
          targetType: "AmuxWorkItem",
          targetId: input.taskId,
          summary: `Blocked AMUX task ${input.taskId} before execution because its operational cost guard refused admission.`,
          metadata: {
            reason: costAdmission.reason,
            resource_scope: costAdmission.blocked_resource.scope,
            resource_key: costAdmission.blocked_resource.key,
            evidence: costAdmission.evidence.map((item) => ({
              ...item,
              budget: item.budget.toString(),
              used: item.used.toString(),
              proposed: item.proposed.toString(),
            })),
            previous_revision: input.expectedRevision,
            next_revision: input.expectedRevision + 1,
          },
          tx,
        });
        return { started: false as const, reason: costAdmission.reason };
      }

      const attemptAggregate = await tx.amuxExecutionAttempt.aggregate({
        where: { taskId: input.taskId },
        _count: { _all: true },
        _max: { attemptNumber: true },
      });
      const budget = decideAmuxAttemptBudget({
        historical_rows: attemptAggregate._count._all,
        greatest_attempt_number: attemptAggregate._max.attemptNumber,
      });
      if (!budget.allowed) {
        const blocked = await tx.amuxWorkItem.updateMany({
          where: {
            id: input.taskId,
            owner: input.worker,
            status: "todo",
            archivedAt: null,
            revision: input.expectedRevision,
          },
          data: {
            status: "blocked",
            revision: { increment: 1 },
          },
        });
        if (blocked.count !== 1) {
          return {
            started: false as const,
            reason: "task_not_startable" as const,
          };
        }
        await openAmuxHumanEscalation(tx, {
          taskId: input.taskId,
          specialty: "execution-recovery",
          reason: "attempt_budget_exhausted",
          openedBy: AMUX_SYSTEM_AUDIT_ACTOR,
        });
        await writeSystemAuditLog({
          systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.execution.budget_exhausted",
          targetType: "AmuxWorkItem",
          targetId: input.taskId,
          summary: `Blocked AMUX task ${input.taskId} after its execution attempt budget was exhausted.`,
          metadata: {
            worker: input.worker,
            exhausted_limit: budget.exhausted_limit,
            attempts_used: budget.attempts_used,
            max_attempts: budget.max_attempts,
            previous_revision: input.expectedRevision,
            next_revision: input.expectedRevision + 1,
          },
          tx,
        });
        return {
          started: false as const,
          reason: "attempt_budget_exhausted" as const,
        };
      }

      const approvedBrief = classifyApprovedExecutionBrief(
        lockedTask.executionBrief,
        lockedTask.executionBriefDigest,
      );
      if (approvedBrief.state === "unverified") {
        return {
          started: false as const,
          reason: "execution_brief_unverified" as const,
        };
      }

      const taskRevision = input.expectedRevision + 1;

      const task = await tx.amuxWorkItem.updateMany({
        where: {
          id: input.taskId,
          owner: input.worker,
          status: "todo",
          archivedAt: null,
          revision: input.expectedRevision,
        },
        data: {
          status: "doing",
          revision: {
            increment: 1,
          },
        },
      });

      if (task.count !== 1) {
        return {
          started: false as const,
          reason: "task_not_startable" as const,
        };
      }

      const runtimeBusy = await tx.amuxWorkerRuntime.updateMany({
        where: {
          workerName: input.worker,
          instanceId: input.instanceId,
          generation: input.generation,
          status: "idle",
          dispatchReady: true,
          leaseExpiresAt: {
            gt: now,
          },
        },
        data: {
          status: "busy",
          dispatchReady: false,
        },
      });

      if (runtimeBusy.count !== 1) {
        throw new Error("AMUX runtime fence changed while starting execution");
      }

      const attemptId = randomUUID();
      const leaseExpiresAt = executionLeaseExpiry(now);

      await tx.amuxExecutionAttempt.create({
        data: {
          id: attemptId,
          taskId: input.taskId,
          worker: input.worker,
          workerInstanceId: input.instanceId,
          workerGeneration: input.generation,
          taskRevision,
          attemptNumber: budget.next_attempt_number,
          reservedCostMicrousd: lockedTask.estimatedCostMicrousd ?? BigInt(0),
          heartbeatAt: now,
          leaseExpiresAt,
          startedAt: now,
        },
      });

      if (costAdmission.reservations.length > 0) {
        await tx.amuxCostLedgerEntry.createMany({
          data: costAdmission.reservations.map((reservation) => ({
            scope: reservation.scope,
            resourceKey: reservation.resourceKey,
            budgetWindowStartsAt: reservation.budgetWindowStartsAt,
            budgetWindowEndsAt: reservation.budgetWindowEndsAt,
            taskId: input.taskId,
            attemptId,
            kind: "reservation",
            amountMicrousd: reservation.amountMicrousd,
          })),
        });
      }

      const [taskSnapshot, previousAttempt] = await Promise.all([
        tx.amuxWorkItem.findUniqueOrThrow({
          where: {
            id: input.taskId,
          },
          select: {
            title: true,
            description: true,
            kind: true,
            priority: true,
          },
        }),
        tx.amuxExecutionAttempt.findFirst({
          where: {
            taskId: input.taskId,
            id: { not: attemptId },
            endedAt: { not: null },
          },
          orderBy: [
            { attemptNumber: "desc" },
            { startedAt: "desc" },
            { id: "desc" },
          ],
          select: { outcome: true, toStatus: true },
        }),
      ]);

      const deliveryPrompt = buildAmuxDeliveryPrompt({
        taskId: input.taskId,
        title: taskSnapshot.title,
        description: taskSnapshot.description,
        kind: taskSnapshot.kind,
        priority: taskSnapshot.priority,
        worker: input.worker,
        attemptId,
        attemptNumber: budget.next_attempt_number,
        taskRevision,
        executionBrief: lockedTask.executionBrief,
        executionBriefDigest: lockedTask.executionBriefDigest,
        previousAttempt,
      });

      /*
       * Durable delivery is part of execution start itself.
       *
       * If this write, either audit write, or transaction commit fails, the
       * Todo->Doing mutation, runtime Busy transition and execution attempt all
       * roll back with it. There is no started-without-delivery state.
       */
      await tx.amuxWorkDelivery.create({
        data: {
          attemptId,
          taskId: input.taskId,
          worker: input.worker,
          workerInstanceId: input.instanceId,
          workerGeneration: input.generation,
          taskRevision,
          prompt: deliveryPrompt,
          status: "queued",
        },
      });

      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.execution.started",
        targetType: "AmuxWorkItem",
        targetId: input.taskId,
        summary: `Started AMUX execution ${attemptId}.`,
        metadata: {
          attempt_id: attemptId,
          attempt_number: budget.next_attempt_number,
          max_attempts: budget.max_attempts,
          reserved_cost_microusd: (
            lockedTask.estimatedCostMicrousd ?? BigInt(0)
          ).toString(),
          guarded_resources: costAdmission.reservations.map((item) => ({
            scope: item.scope,
            key: item.resourceKey,
          })),
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: taskRevision,
        },
        tx,
      });

      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.delivery.enqueued",
        targetType: "AmuxWorkItem",
        targetId: input.taskId,
        summary: `Queued durable AMUX delivery ${attemptId} atomically with execution start.`,
        metadata: {
          attempt_id: attemptId,
          attempt_number: budget.next_attempt_number,
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: taskRevision,
          atomic_with_execution_start: true,
        },
        tx,
      });

      if (attachment) {
        await attachment.work(
          context.attachedTransaction,
          { attemptId, taskId: input.taskId, taskRevision, leaseExpiresAt },
          { dbNow: context.dbNow },
        );
      }

      context.requireLeaseAt(runtime.leaseExpiresAt);
      return {
        started: true as const,
        attemptId,
        taskRevision,
        leaseExpiresAt,
      };
    },
  );
}

/**
 * Renews an execution lease only while all three fences still agree:
 *
 * 1. attempt id,
 * 2. worker runtime instance/generation,
 * 3. task owner/status/revision.
 */
async function heartbeatAmuxExecutionBound(
  input: {
    attemptId: string;
    worker: string;
    instanceId: string;
    generation: number;
    taskRevision: number;
    now?: Date;
  },
  attachment?: AmuxAttachment<AmuxExecutionRenewedFact>,
  allowV22 = false,
): Promise<boolean> {
  return withAmuxDbBoundary(
    amuxBoundaryWithAttachment(AMUX_DB_BOUNDARIES.executionHeartbeat, attachment),
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      const runtime = await lockRuntime(tx, input.worker);

      if (
        !runtimeGenerationMatches(runtime, input, now) ||
        runtime?.status !== "busy"
      ) {
        return false;
      }

      const attempt = await lockAttempt(tx, input.attemptId);

      if (
        !attempt ||
        attempt.endedAt !== null ||
        attempt.worker !== input.worker ||
        attempt.workerInstanceId !== input.instanceId ||
        attempt.workerGeneration !== input.generation ||
        attempt.taskRevision !== input.taskRevision ||
        !attempt.leaseExpiresAt ||
        attempt.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return false;
      }

      const task = await lockTask(tx, attempt.taskId);

      if (
        !task ||
        (task.sourceSystem === "admin-idea-v4") !== allowV22 ||
        (allowV22 && (!attempt.v22AssignmentId ||
          task.v22AssignmentId !== attempt.v22AssignmentId)) ||
        task.owner !== input.worker ||
        task.status !== "doing" ||
        task.revision !== input.taskRevision
      ) {
        return false;
      }

      const nextLease = executionLeaseExpiry(now);
      const updated = await tx.amuxExecutionAttempt.updateMany({
        where: {
          id: input.attemptId,
          worker: input.worker,
          workerInstanceId: input.instanceId,
          workerGeneration: input.generation,
          taskRevision: input.taskRevision,
          endedAt: null,
          leaseExpiresAt: { gt: now },
        },
        data: {
          heartbeatAt: now,
          leaseExpiresAt: nextLease,
        },
      });

      if (updated.count !== 1) return false;
      context.requireLeaseAt(runtime.leaseExpiresAt);
      context.requireLeaseAt(attempt.leaseExpiresAt);
      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.execution.lease_renewed",
        targetType: "AmuxWorkItem",
        targetId: attempt.taskId,
        summary: `Renewed AMUX execution lease ${input.attemptId}.`,
        metadata: {
          attempt_id: input.attemptId,
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: input.taskRevision,
          lease_expires_at: nextLease.toISOString(),
        },
        tx,
      });
      if (attachment) {
        await attachment.work(
          context.attachedTransaction,
          {
            attemptId: input.attemptId,
            taskId: attempt.taskId,
            leaseExpiresAt: nextLease,
          },
          { dbNow: context.dbNow },
        );
      }
      return true;
    },
  );
}

export const heartbeatAmuxExecution = (
  input: Parameters<typeof heartbeatAmuxExecutionBound>[0],
  attachment?: AmuxAttachment<AmuxExecutionRenewedFact>,
) => heartbeatAmuxExecutionBound(input, attachment);

export const heartbeatAmuxV22TaskExecution = (
  input: Parameters<typeof heartbeatAmuxExecutionBound>[0],
) => heartbeatAmuxExecutionBound(input, {
  prismaCalls: 4,
  work: async (lent, fact, context) => {
    const run = await lent.engineeringAgentRun.findUnique({
      where: { amuxAttemptId: fact.attemptId },
      select: { id: true, status: true },
    });
    if (run?.status === "active") {
      try {
        await heartbeatEngineeringAgentRun(
          engineeringAgentTransactionInAmux(lent), {
            runId: run.id, amuxAttemptId: fact.attemptId,
            leaseMs: fact.leaseExpiresAt.getTime() - context.dbNow.getTime(),
          });
      } catch (error) {
        if (!(error instanceof EngineeringAgentStoreRefusedError &&
            error.code === "run_lease_not_live")) throw error;
        // Publication is optional. Its expired lease cannot fence the private
        // Task heartbeat; the Publisher must still reject the stale run.
      }
    }
  },
}, true);

/** A reported result is not a cost observation. Only exact, recorded A14
 * invocation receipts allow success or automatic requeue after a failure. */
export async function settleAmuxV22TaskExecution(input: {
  attemptId: string; worker: string; instanceId: string;
  generation: number; taskRevision: number;
  outcome: "succeeded" | "failed" | "blocked";
  invocationIds: string[];
}) {
  const patch = input.outcome === "succeeded" ?
    await loadEngineeringAgentV22SettlementPatch(input.attemptId) : null;
  // Tier work and GitHub reads happen outside the short settlement transaction.
  // Any missing evidence keeps the result private; it never becomes a worker
  // assertion that the patch is T1.
  const publication = v22PublishPreflightEligible({
    policyVersion: ENGINEERING_AGENT_POLICY_VERSION,
    patchPresent: patch !== null,
    publicationEnabled: amuxV22EngineeringPublicationEnabled(
      process.env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]),
  }) ?
    await loadEngineeringAgentV22StoredCandidate(input.attemptId)
      .catch(() => null) : null;
  return withAmuxDbBoundary({ ...AMUX_DB_BOUNDARIES.executionSettle,
    prismaCallCeiling: AMUX_DB_BOUNDARIES.executionSettle.prismaCallCeiling + 40 },
    async (tx, context) => {
      const now = context.dbNow;
      const runtime = await lockRuntime(tx, input.worker);
      if (!runtimeGenerationMatches(runtime, input, now) ||
          runtime?.status !== "busy")
        return { settled: false as const, reason: "fenced_out" as const };
      const attempt = await lockAttempt(tx, input.attemptId);
      if (!attempt || !attempt.v22AssignmentId || attempt.endedAt ||
          attempt.worker !== input.worker ||
          attempt.workerInstanceId !== input.instanceId ||
          attempt.workerGeneration !== input.generation ||
          attempt.taskRevision !== input.taskRevision ||
          !attempt.leaseExpiresAt || attempt.leaseExpiresAt <= now)
        return { settled: false as const, reason: "fenced_out" as const };
      const task = await lockTask(tx, attempt.taskId);
      if (!task || task.sourceSystem !== "admin-idea-v4" ||
          task.v22AssignmentId !== attempt.v22AssignmentId ||
          task.status !== "doing" || task.owner !== input.worker ||
          task.revision !== input.taskRevision)
        return { settled: false as const, reason: "fenced_out" as const };
      const delivery = await tx.amuxWorkDelivery.findUnique({
        where: { attemptId: input.attemptId }, select: { status: true },
      });
      if (delivery?.status !== "acknowledged")
        return { settled: false as const, reason: "delivery_unverified" as const };
      const events = await tx.amuxCliUsageEvent.findMany({
        where: { attemptId: input.attemptId },
        select: { invocationId: true, status: true, completeness: true,
          projectedApiCostMicrousd: true, source: true, actualModelId: true,
          selectedModelId: true },
      });
      const expectedIds = input.invocationIds;
      const storedResult = input.outcome === "succeeded" ?
        await tx.amuxV22TaskResult.findUnique({
          where: { attemptId: input.attemptId },
          select: { taskId: true, bodyPurgedAt: true },
        }) : null;
      const receiptsComplete = v22ExecutionReceiptVerified({
        attemptId: attempt.id, invocationIds: expectedIds, events,
        outcome: input.outcome,
        reservedCostMicrousd: attempt.reservedCostMicrousd,
        resultStored: storedResult?.taskId === task.id &&
          storedResult.bodyPurgedAt === null,
      });
      if (input.outcome === "succeeded" &&
          (!storedResult || storedResult.taskId !== task.id ||
            storedResult.bodyPurgedAt !== null))
        return { settled: false as const, reason: "result_unverified" as const };
      if (input.outcome !== "blocked" && !receiptsComplete)
        return { settled: false as const, reason: "usage_unverified" as const };
      const storedPatch = await tx.amuxV22TaskPatch.findUnique({
        where: { attemptId: attempt.id },
        select: { taskId: true, patchSha256: true, baseSha: true,
          bodyPurgedAt: true },
      });
      if (!v22SettlementPatchMatches({ taskId: task.id,
        readPatch: patch, storedPatch }))
        return { settled: false as const,
          reason: "publication_state_changed" as const };
      const run = await lockEngineeringAgentV22Run(
        engineeringAgentTransactionInAmux(context.attachedTransaction),
        attempt.id);
      let product = run ? await tx.engineeringAgentWorkItem.findFirst({
        where: { runId: run.id, kind: { in: ["publish", "t2_draft"] } },
        select: { id: true, kind: true, patchDigest: true, baseSha: true },
      }) : null;
      if (patch) {
        const assignment = await tx.amuxV22WorkerAssignment.findUnique({
          where: { id: attempt.v22AssignmentId },
          select: { role: true, workItemId: true },
        });
        if (!run || run.status !== "active" ||
            !["shadow", "t1"].includes(run.modeAtStart) ||
            run.cardId !== task.id || run.baseSha !== patch.baseSha ||
            patch.taskId !== task.id ||
            assignment?.role !== "implement" ||
            assignment.workItemId !== task.id)
          return { settled: false as const,
            reason: "publication_state_changed" as const };
        if (product && (product.patchDigest !== patch.sha256 ||
            product.baseSha !== patch.baseSha))
          return { settled: false as const,
            reason: "publication_product_conflict" as const };
        if (!product) {
          const publish = v22PublishCandidateMatches({
            policyVersion: ENGINEERING_AGENT_POLICY_VERSION,
            modeAtStart: run.modeAtStart, runId: run.id,
            taskId: task.id, baseSha: patch.baseSha,
            patchDigest: patch.sha256, publication,
            currentImageProofDigest:
              currentEngineeringAgentV22ImageProofDigest(),
          }) &&
            amuxV22EngineeringPublicationEnabled(
              process.env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]) &&
            (await readEngineeringAgentSwitches(tx)).publishAllowed &&
            await readAmuxV22PublicPrConsent(task.id, tx);
          const engineeringTx = engineeringAgentTransactionInAmux(
            context.attachedTransaction);
          product = await openEngineeringAgentV22Product(engineeringTx, {
            runId: run.id, taskId: task.id, patch, publish,
            candidate: publication?.ok ? publication.candidate : null,
          });
        }
      }
      const budget = settlementDestinationForBudget({
        requested_status: input.outcome === "succeeded" ? "review" :
          input.outcome === "failed" ? "todo" : "blocked",
        attempt_number: attempt.attemptNumber,
      });
      const next = budget.to_status;
      await tx.amuxWorkItem.update({ where: { id: task.id }, data: {
        status: next, owner: null, claimedAt: null, v22AssignmentId: null,
        reviewPrNumber: null,
        revision: { increment: 1 },
      } });
      await tx.amuxExecutionAttempt.update({ where: { id: attempt.id },
        data: { endedAt: now, leaseExpiresAt: null, heartbeatAt: now,
          outcome: input.outcome, toStatus: next, endedBy: input.worker,
          reason: budget.exhausted_limit ??
            (receiptsComplete ? "reported_result" : "usage_outcome_unknown") },
      });
      await tx.amuxWorkerRuntime.updateMany({ where: {
        workerName: input.worker, instanceId: input.instanceId,
        generation: input.generation, status: "busy",
      }, data: { status: "idle", dispatchReady: false } });
      if (next === "review" || next === "blocked")
        await openAmuxHumanEscalation(tx, { taskId: task.id,
          specialty: next === "review" ? AMUX_DEFAULT_REVIEW_SPECIALTY :
            "execution-recovery",
          reason: next === "review" ? "human_review_required" :
            budget.exhausted_limit ?? (receiptsComplete ?
              "execution_blocked" : "usage_outcome_unknown"),
          openedBy: input.worker });
      await cancelPendingAmuxWorkDelivery(tx, attempt.id, now);
      await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.v22.execution.settled", targetType: "AmuxWorkItem",
        targetId: task.id, summary: "Settled an assignment-bound AMUX v22 Task.",
        metadata: { attemptId: attempt.id, outcome: input.outcome,
          toStatus: next, invocationIds: expectedIds,
          receiptsComplete, reservedCostMicrousd:
            attempt.reservedCostMicrousd.toString(),
          imageProofDigest: product?.kind === "publish" &&
            publication?.ok ? publication.imageProofDigest : null },
      });
      if (run?.status === "active") {
        await endEngineeringAgentRun(
          engineeringAgentTransactionInAmux(context.attachedTransaction), {
            runId: run.id, amuxAttemptId: attempt.id,
            outcome: v22RunOutcomeForProduct({ taskOutcome: input.outcome,
              productKind: product?.kind ?? null }),
            halt: "none",
          });
      }
      context.requireLeaseAt(runtime.leaseExpiresAt);
      context.requireLeaseAt(attempt.leaseExpiresAt);
      return { settled: true as const, taskRevision: task.revision + 1 };
    });
}

/** Expiry is an unknown execution result, never permission to retry. */
export async function quarantineExpiredAmuxV22TaskExecutions(limit = 50) {
  const candidates = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.executionRecoveryRead, (tx, context) =>
      tx.amuxExecutionAttempt.findMany({ where: {
        v22AssignmentId: { not: null }, endedAt: null,
        leaseExpiresAt: { lte: context.dbNow },
      }, orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
      take: Math.min(Math.max(limit, 1), 200),
      select: { id: true, worker: true },
      }));
  let quarantined = 0;
  for (const candidate of candidates) {
    const changed = await withAmuxDbBoundary(
      { ...AMUX_DB_BOUNDARIES.executionRecoveryWrite,
        prismaCallCeiling:
          AMUX_DB_BOUNDARIES.executionRecoveryWrite.prismaCallCeiling + 10 },
      async (tx, context) => {
        const now = context.dbNow;
        const runtime = await lockRuntime(tx, candidate.worker);
        const attempt = await lockAttempt(tx, candidate.id);
        if (!attempt || !attempt.v22AssignmentId || attempt.endedAt ||
            !attempt.leaseExpiresAt || attempt.leaseExpiresAt > now)
          return false;
        const task = await lockTask(tx, attempt.taskId);
        if (!task || task.sourceSystem !== "admin-idea-v4" ||
            task.v22AssignmentId !== attempt.v22AssignmentId ||
            task.status !== "doing" || task.owner !== attempt.worker ||
            task.revision !== attempt.taskRevision)
          return false;
        await tx.amuxWorkItem.update({ where: { id: task.id }, data: {
          status: "blocked", owner: null, claimedAt: null,
          v22AssignmentId: null, revision: { increment: 1 },
        } });
        await tx.amuxExecutionAttempt.update({ where: { id: attempt.id },
          data: { endedAt: now, leaseExpiresAt: null,
            outcome: "expired", toStatus: "blocked",
            endedBy: "system:amux-v22-execution-reaper",
            reason: "outcome_unknown" },
        });
        if (runtime?.instanceId === attempt.workerInstanceId &&
            runtime.generation === attempt.workerGeneration &&
            runtime.status === "busy")
          await tx.amuxWorkerRuntime.updateMany({ where: {
            workerName: attempt.worker, instanceId: attempt.workerInstanceId,
            generation: attempt.workerGeneration, status: "busy",
          }, data: { status: "error", dispatchReady: false } });
        await openAmuxHumanEscalation(tx, { taskId: task.id,
          specialty: "execution-recovery", reason: "execution_lease_expired",
          openedBy: "system:amux-v22-execution-reaper" });
        await cancelPendingAmuxWorkDelivery(tx, attempt.id, now);
        await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.v22.execution.quarantined",
          targetType: "AmuxWorkItem", targetId: task.id,
          summary: "Quarantined an expired AMUX v22 Task attempt.",
          metadata: { attemptId: attempt.id, assignmentId:
            attempt.v22AssignmentId, taskRevision: task.revision + 1,
            reservedCostMicrousd: attempt.reservedCostMicrousd.toString(),
            outcome: "unknown" },
        });
        const run = await tx.engineeringAgentRun.findUnique({
          where: { amuxAttemptId: attempt.id },
          select: { id: true, status: true },
        });
        if (run?.status === "active") {
          await endEngineeringAgentRun(
            engineeringAgentTransactionInAmux(context.attachedTransaction), {
              runId: run.id, amuxAttemptId: attempt.id,
              outcome: "abandoned", halt: "none",
            });
        }
        context.recordReceipt("work_item", task.id, 1);
        context.recordReceipt("execution_attempt", attempt.id, 1);
        return true;
      });
    if (changed) quarantined++;
  }
  return quarantined;
}

/** No attempt row after locking the card proves the reserved Todo never
 * started. This is the only v22 recovery that may requeue automatically. */
export async function releaseUnstartedAmuxV22Assignments(limit = 50) {
  const candidates = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.ownershipRecoveryRead, (tx, context) =>
      tx.amuxWorkItem.findMany({ where: {
        sourceSystem: "admin-idea-v4", status: "todo",
        owner: { not: null }, v22AssignmentId: { not: null },
        claimedAt: { lte: new Date(context.dbNow.getTime() -
          AMUX_CLAIM_RESERVATION_MS) },
      }, orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
      take: Math.min(Math.max(limit, 1), 200), select: { id: true },
      }));
  let released = 0;
  for (const candidate of candidates) {
    const changed = await withAmuxDbBoundary(
      AMUX_DB_BOUNDARIES.ownershipRecoveryWrite,
      async (tx, context) => {
        const task = await lockTask(tx, candidate.id);
        if (!task || task.sourceSystem !== "admin-idea-v4" ||
            task.status !== "todo" || !task.owner ||
            !task.claimedAt || !task.v22AssignmentId ||
            task.claimedAt.getTime() + AMUX_CLAIM_RESERVATION_MS >
              context.dbNow.getTime()) return false;
        const attempted = await tx.amuxExecutionAttempt.count({ where: {
          v22AssignmentId: task.v22AssignmentId,
        } });
        if (attempted !== 0) return false;
        await tx.amuxWorkItem.update({ where: { id: task.id }, data: {
          owner: null, claimedAt: null, v22AssignmentId: null,
          revision: { increment: 1 },
        } });
        await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.v22.assignment.unstarted_released",
          targetType: "AmuxWorkItem", targetId: task.id,
          summary: "Released an unstarted AMUX v22 assignment.",
          metadata: { assignmentId: task.v22AssignmentId,
            nextTaskRevision: task.revision + 1 },
        });
        context.recordReceipt("work_item", task.id, 1);
        return true;
      });
    if (changed) released++;
  }
  return released;
}

/**
 * Settles an attempt and moves the task in the same transaction.
 *
 * A replacement worker generation, expired attempt lease, changed task
 * revision, changed owner or changed lifecycle state all fence the callback
 * out before it can modify either row.
 */
export async function settleAmuxExecution(
  input: {
    attemptId: string;
    worker: string;
    instanceId: string;
    generation: number;
    taskRevision: number;
    outcome: AmuxExecutionOutcome;
    toStatus: AmuxExecutionToStatus;
    reason?: string | null;
    actualCostMicrousd?: bigint | null;
    reviewPrNumber?: number | null;
    /** An adapter agent's own model spend for this attempt; recorded apart from its cost. */
    agentUsage?: AmuxAgentUsage | null;
    now?: Date;
  },
  attachment?: AmuxAttachment<AmuxExecutionSettledFact>,
): Promise<
  | { settled: true; taskRevision: number }
  | { settled: false; reason: "fenced_out" }
> {
  if (!validSettlement(input.outcome, input.toStatus)) {
    throw new Error(
      `Invalid AMUX execution settlement: ${input.outcome} -> ${input.toStatus}`,
    );
  }
  if (
    !amuxReviewPrNumberAccepted({
      outcome: input.outcome,
      toStatus: input.toStatus,
      reviewPrNumber: input.reviewPrNumber,
    })
  ) {
    throw new Error("Invalid AMUX review PR number for this settlement");
  }
  if (input.taskRevision > AMUX_MAX_EXPECTED_REVISION) {
    return { settled: false, reason: "fenced_out" };
  }
  if (
    input.agentUsage != null &&
    (!(AMUX_AGENT_USAGE_AGENTS as readonly string[]).includes(input.agentUsage.agentId) ||
      typeof input.agentUsage.amountMicrousd !== "bigint" ||
      input.agentUsage.amountMicrousd < BigInt(0) ||
      input.agentUsage.amountMicrousd > BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    throw new Error("Invalid AMUX agent usage");
  }

  return withAmuxDbBoundary(
    amuxBoundaryWithAttachment(AMUX_DB_BOUNDARIES.executionSettle, attachment),
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      const planning = await tx.amuxExecutionAttempt.findUnique({
        where: { id: input.attemptId },
        select: {
          task: {
            select: {
              projectKey: true,
              teamKey: true,
              effortPoints: true,
              estimatedCostMicrousd: true,
            },
          },
        },
      });
      if (!planning) {
        return { settled: false as const, reason: "fenced_out" as const };
      }
      /*
       * Resource locks come before the ordinary execution fence order so a
       * settlement delta cannot race a new cost admission. Heartbeat takes no
       * resource lock and still uses runtime -> attempt -> task.
       */
      await lockAmuxResourcePolicies(tx, amuxResourceRefs(planning.task));
      const runtime = await lockRuntime(tx, input.worker);

      if (
        !runtimeGenerationMatches(runtime, input, now) ||
        runtime?.status !== "busy"
      ) {
        return {
          settled: false as const,
          reason: "fenced_out" as const,
        };
      }

      const attempt = await lockAttempt(tx, input.attemptId);

      if (
        !attempt ||
        attempt.endedAt !== null ||
        attempt.worker !== input.worker ||
        attempt.workerInstanceId !== input.instanceId ||
        attempt.workerGeneration !== input.generation ||
        attempt.taskRevision !== input.taskRevision ||
        !attempt.leaseExpiresAt ||
        attempt.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return {
          settled: false as const,
          reason: "fenced_out" as const,
        };
      }

      const task = await lockTask(tx, attempt.taskId);

      if (
        !task ||
        task.sourceSystem === "admin-idea-v4" ||
        task.owner !== input.worker ||
        task.status !== "doing" ||
        task.revision !== input.taskRevision ||
        task.projectKey !== planning.task.projectKey ||
        task.teamKey !== planning.task.teamKey
      ) {
        return {
          settled: false as const,
          reason: "fenced_out" as const,
        };
      }

      const budgetDestination = settlementDestinationForBudget({
        requested_status: input.toStatus,
        attempt_number: attempt.attemptNumber,
      });
      // Policy version 15: a promoted card (approved brief) or one that asks
      // for review never settles to done; it goes to human review.
      const humanReviewRequired = amuxHumanReviewRequired(task);
      const effectiveToStatus =
        budgetDestination.to_status === "done" && humanReviewRequired
          ? "review"
          : budgetDestination.to_status;
      // A settlement that names the review PR field (even as null) replaces
      // the stored number, so a retried card never keeps the previous
      // attempt's PR. A caller that omits the field leaves it untouched.
      const replacesReviewPr =
        effectiveToStatus === "review" && input.reviewPrNumber !== undefined;
      const recordedReviewPrNumber = replacesReviewPr ? (input.reviewPrNumber ?? null) : null;
      const bridgeReason = amuxBridgeSettleReason(input.reason);
      // AmuxWorkItem_review_pr_check needs requiresHumanReview with a stored
      // PR, and AmuxWorkItem_human_review_shape_check needs a specialty with
      // that flag. A promoted card has neither, so recording its first PR
      // sets both; an existing specialty is kept.
      const marksHumanReview = replacesReviewPr && recordedReviewPrNumber !== null;
      const reviewSpecialty = marksHumanReview
        ? (task.reviewSpecialty ?? AMUX_DEFAULT_REVIEW_SPECIALTY)
        : task.reviewSpecialty;

      const moved = await tx.amuxWorkItem.updateMany({
        where: {
          id: attempt.taskId,
          owner: input.worker,
          status: "doing",
          archivedAt: null,
          revision: input.taskRevision,
        },
        data:
          effectiveToStatus === "todo" || effectiveToStatus === "review"
            ? {
                status: effectiveToStatus,
                owner: null,
                claimedAt: null,
                ...(replacesReviewPr ? { reviewPrNumber: recordedReviewPrNumber } : {}),
                ...(marksHumanReview ? { requiresHumanReview: true, reviewSpecialty } : {}),
                revision: {
                  increment: 1,
                },
              }
            : {
                status: effectiveToStatus,
                revision: {
                  increment: 1,
                },
              },
      });

      if (moved.count !== 1) {
        return {
          settled: false as const,
          reason: "fenced_out" as const,
        };
      }

      const closed = await tx.amuxExecutionAttempt.updateMany({
        where: {
          id: input.attemptId,
          worker: input.worker,
          workerInstanceId: input.instanceId,
          workerGeneration: input.generation,
          taskRevision: input.taskRevision,
          endedAt: null,
        },
        data: {
          heartbeatAt: now,
          leaseExpiresAt: null,
          endedAt: now,
          outcome: input.outcome,
          toStatus: effectiveToStatus,
          endedBy: input.worker,
          reason: budgetDestination.exhausted_limit
            ? "attempt_budget_exhausted"
            : bridgeReason !== null
              ? bridgeReason
              : effectiveToStatus === "review"
              ? "human_review_required"
              : input.outcome === "succeeded"
                ? "execution_succeeded"
                : input.outcome === "failed"
                  ? "execution_failed"
                  : "execution_blocked",
          settledCostMicrousd: input.actualCostMicrousd ?? null,
          costConfirmed:
            input.actualCostMicrousd !== null &&
            input.actualCostMicrousd !== undefined,
        },
      });

      if (closed.count !== 1) {
        throw new Error("AMUX execution attempt changed while settling");
      }

      if (
        input.actualCostMicrousd !== null &&
        input.actualCostMicrousd !== undefined
      ) {
        const reservations = await tx.amuxCostLedgerEntry.findMany({
          where: { attemptId: input.attemptId, kind: "reservation" },
          select: {
            scope: true,
            resourceKey: true,
            budgetWindowStartsAt: true,
            budgetWindowEndsAt: true,
            amountMicrousd: true,
          },
        });
        if (reservations.length > 0) {
          await tx.amuxCostLedgerEntry.createMany({
            data: reservations.map((reservation) => ({
              scope: reservation.scope,
              resourceKey: reservation.resourceKey,
              budgetWindowStartsAt: reservation.budgetWindowStartsAt,
              budgetWindowEndsAt: reservation.budgetWindowEndsAt,
              taskId: attempt.taskId,
              attemptId: input.attemptId,
              kind: "settlement_delta",
              amountMicrousd:
                input.actualCostMicrousd! - reservation.amountMicrousd,
            })),
          });
        }
      }

      if (input.agentUsage != null) {
        // Its own scope and kind: no admission sum, reservation or delta reads it.
        const window = amuxAgentUsageWindow(now);
        await tx.amuxCostLedgerEntry.create({
          data: {
            scope: "agent",
            resourceKey: input.agentUsage.agentId,
            budgetWindowStartsAt: window.startsAt,
            budgetWindowEndsAt: window.endsAt,
            taskId: attempt.taskId,
            attemptId: input.attemptId,
            kind: "agent_usage",
            amountMicrousd: input.agentUsage.amountMicrousd,
          },
        });
      }

      // Every card that lands in review needs a person: review -> done runs
      // only through the human review route, which requires an escalation.
      if (effectiveToStatus === "review") {
        await openAmuxHumanEscalation(tx, {
          taskId: attempt.taskId,
          specialty: reviewSpecialty,
          reason: "human_review_required",
          openedBy: input.worker,
        });
      } else if (effectiveToStatus === "blocked") {
        await openAmuxHumanEscalation(tx, {
          taskId: attempt.taskId,
          specialty: "execution-recovery",
          reason: budgetDestination.exhausted_limit
            ? "attempt_budget_exhausted"
            : bridgeReason !== null && bridgeReason !== "local_card_done"
              ? bridgeReason
              : "execution_blocked",
          openedBy: input.worker,
        });
      }

      await cancelPendingAmuxWorkDelivery(tx, input.attemptId, now);

      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.execution.settled",
        targetType: "AmuxWorkItem",
        targetId: attempt.taskId,
        summary: `Settled AMUX execution ${input.attemptId}.`,
        metadata: {
          attempt_id: input.attemptId,
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: input.taskRevision,
          next_task_revision: input.taskRevision + 1,
          outcome: input.outcome,
          requested_to_status: input.toStatus,
          to_status: effectiveToStatus,
          human_review_forced:
            input.toStatus === "done" && effectiveToStatus === "review",
          review_pr_number: recordedReviewPrNumber,
          reserved_cost_microusd: attempt.reservedCostMicrousd.toString(),
          settled_cost_microusd: input.actualCostMicrousd?.toString() ?? null,
          agent_usage_microusd: input.agentUsage?.amountMicrousd.toString() ?? null,
          attempt_number: attempt.attemptNumber,
          exhausted_limit: budgetDestination.exhausted_limit,
          max_attempts: budgetDestination.max_attempts,
        },
        tx,
      });

      if (attachment) {
        await attachment.work(
          context.attachedTransaction,
          {
            attemptId: input.attemptId,
            taskId: attempt.taskId,
            outcome: input.outcome,
            toStatus: effectiveToStatus,
            taskRevision: input.taskRevision + 1,
          },
          { dbNow: context.dbNow },
        );
      }

      context.requireLeaseAt(runtime.leaseExpiresAt);
      context.requireLeaseAt(attempt.leaseExpiresAt);
      return {
        settled: true as const,
        taskRevision: input.taskRevision + 1,
      };
    },
  );
}

/**
 * Returns expired, still-current executions to Todo.
 *
 * Candidate discovery is only a read. Every mutation re-locks the runtime,
 * attempt and task in the same ordering used by heartbeat/settle, then
 * re-validates the attempt lease and task revision before changing anything.
 *
 * A replaced worker generation is never modified.
 */
export async function reclaimExpiredAmuxExecutions(
  options: {
    now?: Date;
    limit?: number;
    onMoreWork?: () => void;
  } = {},
): Promise<number> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const candidates = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.executionRecoveryRead,
    (tx, context) => {
      const now = options.now ?? context.dbNow;
      return tx.amuxExecutionAttempt.findMany({
        where: {
          endedAt: null,
          v22AssignmentId: null,
          leaseExpiresAt: { lte: now },
        },
        orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
        take: limit,
        select: {
          id: true,
          worker: true,
        },
      });
    },
  );

  if (candidates.length >= limit) options.onMoreWork?.();

  let reclaimed = 0;

  for (const candidate of candidates) {
    let applied: boolean;
    try {
      applied = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.executionRecoveryWrite,
        async (tx, context) => {
          const now = options.now ?? context.dbNow;
          /*
           * Keep the same lock ordering used by heartbeat and settle:
           * runtime -> attempt -> task.
           */
          const runtime = await lockRuntime(tx, candidate.worker);

          const attempt = await lockAttempt(tx, candidate.id);

          if (
            !attempt ||
            attempt.endedAt !== null ||
            !attempt.leaseExpiresAt ||
            attempt.leaseExpiresAt.getTime() > now.getTime()
          ) {
            return false;
          }

          const task = await lockTask(tx, attempt.taskId);

          /*
           * Only the execution which still owns the task may recover it.
           * A mismatch is an abnormal/stale row, not authority to overwrite
           * whichever lifecycle now owns the task.
           */
          if (
            !task ||
            task.sourceSystem === "admin-idea-v4" ||
            task.owner !== attempt.worker ||
            task.status !== "doing" ||
            task.revision !== attempt.taskRevision ||
            task.revision > AMUX_MAX_EXPECTED_REVISION
          ) {
            return false;
          }

          const budgetDestination = settlementDestinationForBudget({
            requested_status: "todo",
            attempt_number: attempt.attemptNumber,
          });
          const effectiveToStatus = budgetDestination.to_status;
          // An expiry that also exhausted the attempt budget says so on the
          // attempt and its escalation, as main recorded it (#1595).
          const recoveryReason = budgetDestination.exhausted_limit
            ? "attempt_budget_exhausted"
            : "lease_expired";

          const moved = await tx.amuxWorkItem.updateMany({
            where: {
              id: attempt.taskId,
              owner: attempt.worker,
              status: "doing",
              archivedAt: null,
              revision: attempt.taskRevision,
            },
            data:
              effectiveToStatus === "todo"
                ? {
                    status: "todo",
                    owner: null,
                    claimedAt: null,
                    revision: {
                      increment: 1,
                    },
                  }
                : {
                    status: "blocked",
                    revision: {
                      increment: 1,
                    },
                  },
          });

          if (moved.count !== 1) {
            return false;
          }

          const closed = await tx.amuxExecutionAttempt.updateMany({
            where: {
              id: attempt.id,
              endedAt: null,
              leaseExpiresAt: {
                lte: now,
              },
            },
            data: {
              heartbeatAt: now,
              leaseExpiresAt: null,
              endedAt: now,
              outcome: "expired",
              toStatus: effectiveToStatus,
              endedBy: "system:amux-execution-reaper",
              reason: recoveryReason,
            },
          });

          if (closed.count !== 1) {
            throw new Error("AMUX expired execution changed while reclaiming");
          }

          // Orchestration policy version 20, section 4: the card's status and
          // revision and the attempt, as receipts of an admitted recover. The
          // escalation, delivery and runtime rows below commit with them.
          context.recordReceipt("work_item", attempt.taskId, 1);
          context.recordReceipt("execution_attempt", attempt.id, 1);

          if (effectiveToStatus === "blocked") {
            await openAmuxHumanEscalation(tx, {
              taskId: attempt.taskId,
              specialty: "execution-recovery",
              reason: budgetDestination.exhausted_limit
                ? "attempt_budget_exhausted"
                : "execution_lease_expired",
              openedBy: "system:amux-execution-reaper",
            });
          }

          await cancelPendingAmuxWorkDelivery(tx, attempt.id, now);

          /*
           * If the same runtime generation is still marked busy, quarantine it.
           * A replacement generation must never be touched here.
           */
          if (
            runtime &&
            runtime.instanceId === attempt.workerInstanceId &&
            runtime.generation === attempt.workerGeneration &&
            runtime.status === "busy"
          ) {
            await tx.amuxWorkerRuntime.updateMany({
              where: {
                workerName: attempt.worker,
                instanceId: attempt.workerInstanceId,
                generation: attempt.workerGeneration,
                status: "busy",
              },
              data: {
                status: "error",
                dispatchReady: false,
              },
            });
          }

          await writeSystemAuditLog({
            systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
            action: "amux.execution.expired",
            targetType: "AmuxWorkItem",
            targetId: attempt.taskId,
            summary: `Reclaimed expired AMUX execution ${attempt.id}.`,
            metadata: {
              attempt_id: attempt.id,
              worker: attempt.worker,
              worker_instance_id: attempt.workerInstanceId,
              worker_generation: attempt.workerGeneration,
              task_revision: attempt.taskRevision,
              next_task_revision: attempt.taskRevision + 1,
              outcome: "expired",
              to_status: effectiveToStatus,
              attempt_number: attempt.attemptNumber,
              exhausted_limit: budgetDestination.exhausted_limit,
              max_attempts: budgetDestination.max_attempts,
            },
            tx,
          });

          return true;
        },
      );
    } catch (error) {
      // Out of time: stop and report more work. Not when a receipt of this
      // admitted request may already have committed (an earlier sweep or
      // reclaim): then the deadline must reach the route, which answers an
      // unknown outcome instead of a known 200 (orchestration policy version
      // 20, section 1). A request without the identity headers has no
      // receipts and keeps the old answer.
      if (
        error instanceof AmuxDbBoundaryError &&
        error.code === "AMUX_DB_DEADLINE_EXCEEDED" &&
        !amuxRouteOrchestratorReceiptsMayHaveCommitted()
      ) {
        options.onMoreWork?.();
        break;
      }
      throw error;
    }

    if (applied) {
      reclaimed += 1;
    }
  }

  return reclaimed;
}

/**
 * Releases owner-assigned Todo reservations which never reached execution.
 *
 * Candidate discovery is only advisory. Each task is row-locked and all
 * routing facts are revalidated before mutation. An execution attempt, changed
 * revision, changed owner or changed timestamp wins over the recovery pass.
 */
export async function reclaimExpiredAmuxClaims(
  options: {
    now?: Date;
    limit?: number;
    onMoreWork?: () => void;
  } = {},
): Promise<number> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const candidates = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.ownershipRecoveryRead,
    (tx, context) => {
      const now = options.now ?? context.dbNow;
      const cutoff = new Date(now.getTime() - AMUX_CLAIM_RESERVATION_MS);
      return tx.amuxWorkItem.findMany({
        where: {
          status: "todo",
          OR: [{ sourceSystem: null },
            { sourceSystem: { not: "admin-idea-v4" } }],
          owner: { not: null },
          archivedAt: null,
          claimedAt: { lte: cutoff },
        },
        orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
        take: limit,
        select: {
          id: true,
          owner: true,
          revision: true,
          claimedAt: true,
        },
      });
    },
  );

  if (candidates.length >= limit) options.onMoreWork?.();

  let reclaimed = 0;

  for (const candidate of candidates) {
    const candidateOwner = candidate.owner;
    const candidateClaimedAt = candidate.claimedAt;

    if (!candidateOwner || !candidateClaimedAt) {
      continue;
    }

    let applied: boolean;
    try {
      applied = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.ownershipRecoveryWrite,
        async (tx, context) => {
          const now = options.now ?? context.dbNow;
          const cutoff = new Date(now.getTime() - AMUX_CLAIM_RESERVATION_MS);
          const task = await lockTask(tx, candidate.id);

          if (
            !task ||
            task.sourceSystem === "admin-idea-v4" ||
            task.status !== "todo" ||
            task.archivedAt !== null ||
            task.owner !== candidateOwner ||
            task.revision !== candidate.revision ||
            task.revision > AMUX_MAX_EXPECTED_REVISION ||
            !task.claimedAt ||
            task.claimedAt.getTime() !== candidateClaimedAt.getTime() ||
            task.claimedAt.getTime() > cutoff.getTime()
          ) {
            return false;
          }

          /*
           * Todo should imply no live execution, but fail closed if historical
           * corruption or a future lifecycle change ever violates that assumption.
           */
          const liveAttempts = await tx.amuxExecutionAttempt.count({
            where: {
              taskId: task.id,
              endedAt: null,
            },
          });

          if (liveAttempts !== 0) {
            return false;
          }

          const released = await tx.amuxWorkItem.updateMany({
            where: {
              id: task.id,
              owner: task.owner,
              status: "todo",
              archivedAt: null,
              revision: task.revision,
              claimedAt: task.claimedAt,
            },
            data: {
              owner: null,
              claimedAt: null,
              revision: {
                increment: 1,
              },
            },
          });

          if (released.count !== 1) {
            return false;
          }

          // Orchestration policy version 20, section 4: the released owner and
          // revision, as a receipt of an admitted recover.
          context.recordReceipt("work_item", task.id, 1);

          await writeSystemAuditLog({
            systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
            action: "amux.claim.expired",
            targetType: "AmuxWorkItem",
            targetId: task.id,
            summary: `Released expired AMUX ownership reservation for ${task.id}.`,
            metadata: {
              previous_worker: task.owner,
              previous_revision: task.revision,
              next_revision: task.revision + 1,
              claimed_at: task.claimedAt.toISOString(),
              reservation_ms: AMUX_CLAIM_RESERVATION_MS,
            },
            tx,
          });

          return true;
        },
      );
    } catch (error) {
      // Out of time: stop and report more work. Not when a receipt of this
      // admitted request may already have committed (an earlier sweep or
      // reclaim): then the deadline must reach the route, which answers an
      // unknown outcome instead of a known 200 (orchestration policy version
      // 20, section 1). A request without the identity headers has no
      // receipts and keeps the old answer.
      if (
        error instanceof AmuxDbBoundaryError &&
        error.code === "AMUX_DB_DEADLINE_EXCEEDED" &&
        !amuxRouteOrchestratorReceiptsMayHaveCommitted()
      ) {
        options.onMoreWork?.();
        break;
      }
      throw error;
    }

    if (applied) {
      reclaimed += 1;
    }
  }

  return reclaimed;
}
