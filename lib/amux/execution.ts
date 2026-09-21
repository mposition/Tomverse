import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { lockAmuxAdmissionAndReadIncident } from "@/lib/amux/incident";
import { cancelPendingAmuxWorkDelivery } from "@/lib/amux/delivery";
import {
  decideAmuxAttemptBudget,
  settlementDestinationForBudget,
} from "@/lib/amux/executionBudgetCore";
import { openAmuxHumanEscalation } from "@/lib/amux/escalation";
import {
  evaluateLockedAmuxCostAdmission,
  lockAmuxResourcePolicies,
} from "@/lib/amux/resourcePolicy";
import { amuxResourceRefs } from "@/lib/amux/resourcePolicyCore";

export const AMUX_EXECUTION_LEASE_MS = 90_000;

/**
 * Ownership claim is a routing reservation, not an execution lease.
 * If no Todo -> Doing execution start wins within this window, recovery may
 * release the owner so Global Priority can route the task again.
 */
export const AMUX_CLAIM_RESERVATION_MS = 180_000;

const AMUX_EXECUTION_SYSTEM_ACTOR = "tomverse-amux-orchestrator";

export type AmuxExecutionOutcome = "succeeded" | "failed" | "blocked";

export type AmuxExecutionToStatus = "todo" | "review" | "done" | "blocked";

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

const buildAmuxDeliveryPrompt = (input: {
  taskId: string;
  title: string;
  description: string | null;
  kind: string;
  priority: string;
  worker: string;
  attemptId: string;
  attemptNumber: number;
  taskRevision: number;
  previousAttempt: {
    outcome: string | null;
    reason: string | null;
  } | null;
}) => {
  const description = input.description?.trim() || "(no description)";

  return [
    "[Tomverse AMUX work]",
    `Task: ${input.taskId}`,
    `Title: ${input.title}`,
    `Kind: ${input.kind}`,
    `Priority: ${input.priority}`,
    `Worker: ${input.worker}`,
    `Execution attempt: ${input.attemptId}`,
    `Attempt number: ${input.attemptNumber}`,
    `Task revision: ${input.taskRevision}`,
    ...(input.previousAttempt
      ? [
          `Previous outcome: ${input.previousAttempt.outcome ?? "unknown"}`,
          `Previous reason: ${input.previousAttempt.reason?.trim() || "(none recorded)"}`,
        ]
      : []),
    "",
    description,
  ].join("\n");
};

/**
 * Starts execution only for the currently-owned Todo and the currently-live
 * worker runtime generation.
 *
 * Incident lock -> resource locks -> runtime row lock -> task CAS -> attempt
 * creation are one transaction.
 * Failure at any later write rolls the todo->doing transition back.
 */
export async function startAmuxExecution(input: {
  taskId: string;
  worker: string;
  instanceId: string;
  generation: number;
  expectedRevision: number;
  now?: Date;
}): Promise<
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
        | "cost_budget_window_inactive";
    }
> {
  const now = input.now ?? new Date();
  const planning = await prisma.amuxWorkItem.findUnique({
    where: { id: input.taskId },
    select: {
      projectKey: true,
      teamKey: true,
      effortPoints: true,
      estimatedCostMicrousd: true,
    },
  });
  if (!planning) {
    return { started: false as const, reason: "task_not_startable" as const };
  }

  return prisma.$transaction(async (tx) => {
    const incident = await lockAmuxAdmissionAndReadIncident(tx, now);
    if (incident.blocks_admission) {
      return {
        started: false as const,
        reason: "incident_frozen" as const,
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
        reason: `${costAdmission.reason}:${costAdmission.blocked_resource.scope}:${costAdmission.blocked_resource.key}`,
        openedBy: AMUX_EXECUTION_SYSTEM_ACTOR,
      });
      await writeSystemAuditLog({
        systemActor: AMUX_EXECUTION_SYSTEM_ACTOR,
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
        reason: `Execution attempt budget exhausted after ${budget.attempts_used} attempts.`,
        openedBy: AMUX_EXECUTION_SYSTEM_ACTOR,
      });
      await writeSystemAuditLog({
        systemActor: AMUX_EXECUTION_SYSTEM_ACTOR,
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
        select: { outcome: true, reason: true },
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
      systemActor: AMUX_EXECUTION_SYSTEM_ACTOR,
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
      systemActor: AMUX_EXECUTION_SYSTEM_ACTOR,
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

    return {
      started: true as const,
      attemptId,
      taskRevision,
      leaseExpiresAt,
    };
  });
}

/**
 * Renews an execution lease only while all three fences still agree:
 *
 * 1. attempt id,
 * 2. worker runtime instance/generation,
 * 3. task owner/status/revision.
 */
export async function heartbeatAmuxExecution(input: {
  attemptId: string;
  worker: string;
  instanceId: string;
  generation: number;
  taskRevision: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
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
        leaseExpiresAt: {
          gt: now,
        },
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: nextLease,
      },
    });

    return updated.count === 1;
  });
}

/**
 * Settles an attempt and moves the task in the same transaction.
 *
 * A replacement worker generation, expired attempt lease, changed task
 * revision, changed owner or changed lifecycle state all fence the callback
 * out before it can modify either row.
 */
export async function settleAmuxExecution(input: {
  attemptId: string;
  worker: string;
  instanceId: string;
  generation: number;
  taskRevision: number;
  outcome: AmuxExecutionOutcome;
  toStatus: AmuxExecutionToStatus;
  reason?: string | null;
  actualCostMicrousd?: bigint | null;
  now?: Date;
}): Promise<
  | { settled: true; taskRevision: number }
  | { settled: false; reason: "fenced_out" }
> {
  if (!validSettlement(input.outcome, input.toStatus)) {
    throw new Error(
      `Invalid AMUX execution settlement: ${input.outcome} -> ${input.toStatus}`,
    );
  }

  const now = input.now ?? new Date();
  const planning = await prisma.amuxExecutionAttempt.findUnique({
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

  return prisma.$transaction(async (tx) => {
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
    const effectiveToStatus =
      budgetDestination.to_status === "done" && task.requiresHumanReview
        ? "review"
        : budgetDestination.to_status;

    const moved = await tx.amuxWorkItem.updateMany({
      where: {
        id: attempt.taskId,
        owner: input.worker,
        status: "doing",
        archivedAt: null,
        revision: input.taskRevision,
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
        reason: input.reason ?? null,
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

    if (effectiveToStatus === "review" && task.requiresHumanReview) {
      await openAmuxHumanEscalation(tx, {
        taskId: attempt.taskId,
        specialty: task.reviewSpecialty,
        reason:
          input.reason?.trim() ||
          "Task policy requires human review before completion.",
        openedBy: input.worker,
      });
    } else if (effectiveToStatus === "blocked") {
      await openAmuxHumanEscalation(tx, {
        taskId: attempt.taskId,
        specialty: "execution-recovery",
        reason:
          input.reason?.trim() ||
          (budgetDestination.exhausted_limit
            ? "Execution attempt budget exhausted."
            : "Worker reported that execution is blocked."),
        openedBy: input.worker,
      });
    }

    await cancelPendingAmuxWorkDelivery(tx, input.attemptId, now);

    await writeSystemAuditLog({
      systemActor: AMUX_EXECUTION_SYSTEM_ACTOR,
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
        reserved_cost_microusd: attempt.reservedCostMicrousd.toString(),
        settled_cost_microusd: input.actualCostMicrousd?.toString() ?? null,
        attempt_number: attempt.attemptNumber,
        exhausted_limit: budgetDestination.exhausted_limit,
        max_attempts: budgetDestination.max_attempts,
      },
      tx,
    });

    return {
      settled: true as const,
      taskRevision: input.taskRevision + 1,
    };
  });
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
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const candidates = await prisma.amuxExecutionAttempt.findMany({
    where: {
      endedAt: null,
      leaseExpiresAt: {
        lte: now,
      },
    },
    orderBy: [
      {
        leaseExpiresAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    take: limit,
    select: {
      id: true,
      worker: true,
    },
  });

  let reclaimed = 0;

  for (const candidate of candidates) {
    const applied = await prisma.$transaction(async (tx) => {
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
        task.revision !== attempt.taskRevision
      ) {
        return false;
      }

      const budgetDestination = settlementDestinationForBudget({
        requested_status: "todo",
        attempt_number: attempt.attemptNumber,
      });
      const effectiveToStatus = budgetDestination.to_status;

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
          reason: "lease_expired",
        },
      });

      if (closed.count !== 1) {
        throw new Error("AMUX expired execution changed while reclaiming");
      }

      if (effectiveToStatus === "blocked") {
        await openAmuxHumanEscalation(tx, {
          taskId: attempt.taskId,
          specialty: "execution-recovery",
          reason: "Execution lease expired and the retry budget was exhausted.",
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
        systemActor: AMUX_EXECUTION_SYSTEM_ACTOR,
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
    });

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
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const cutoff = new Date(now.getTime() - AMUX_CLAIM_RESERVATION_MS);

  const candidates = await prisma.amuxWorkItem.findMany({
    where: {
      status: "todo",
      owner: {
        not: null,
      },
      archivedAt: null,
      claimedAt: {
        lte: cutoff,
      },
    },
    orderBy: [
      {
        claimedAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    take: limit,
    select: {
      id: true,
      owner: true,
      revision: true,
      claimedAt: true,
    },
  });

  let reclaimed = 0;

  for (const candidate of candidates) {
    const candidateOwner = candidate.owner;
    const candidateClaimedAt = candidate.claimedAt;

    if (!candidateOwner || !candidateClaimedAt) {
      continue;
    }

    const applied = await prisma.$transaction(async (tx) => {
      const task = await lockTask(tx, candidate.id);

      if (
        !task ||
        task.status !== "todo" ||
        task.archivedAt !== null ||
        task.owner !== candidateOwner ||
        task.revision !== candidate.revision ||
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

      await writeSystemAuditLog({
        systemActor: AMUX_EXECUTION_SYSTEM_ACTOR,
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
    });

    if (applied) {
      reclaimed += 1;
    }
  }

  return reclaimed;
}
