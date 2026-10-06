import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_MAX_EXPECTED_REVISION } from "@/lib/amux/claimContract";
import { lockAmuxAdmissionAndReadIncident } from "@/lib/amux/incident";
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
  leaseExpiresAt: Date | null;
  endedAt: Date | null;
};

type TaskLockRow = {
  id: string;
  sourceSystem: string | null;
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
export async function heartbeatAmuxExecution(
  input: {
    attemptId: string;
    worker: string;
    instanceId: string;
    generation: number;
    taskRevision: number;
    now?: Date;
  },
  attachment?: AmuxAttachment<AmuxExecutionRenewedFact>,
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
