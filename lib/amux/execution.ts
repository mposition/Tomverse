import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { cancelPendingAmuxWorkDelivery } from "@/lib/amux/delivery";

export const AMUX_EXECUTION_LEASE_MS = 90_000;

/**
 * Ownership claim is a routing reservation, not an execution lease.
 * If no Todo -> Doing execution start wins within this window, recovery may
 * release the owner so Global Priority can route the task again.
 */
export const AMUX_CLAIM_RESERVATION_MS = 180_000;

const AMUX_EXECUTION_SYSTEM_ACTOR =
  "tomverse-amux-orchestrator";

export type AmuxExecutionOutcome =
  | "succeeded"
  | "failed"
  | "blocked";

export type AmuxExecutionToStatus =
  | "todo"
  | "review"
  | "done"
  | "blocked";

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
  (outcome === "succeeded" &&
    (toStatus === "review" || toStatus === "done")) ||
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
  taskRevision: number;
}) => {
  const description =
    input.description?.trim() ||
    "(no description)";

  return [
    "[Tomverse AMUX work]",
    `Task: ${input.taskId}`,
    `Title: ${input.title}`,
    `Kind: ${input.kind}`,
    `Priority: ${input.priority}`,
    `Worker: ${input.worker}`,
    `Execution attempt: ${input.attemptId}`,
    `Task revision: ${input.taskRevision}`,
    "",
    description,
  ].join("\n");
};

/**
 * Starts execution only for the currently-owned Todo and the currently-live
 * worker runtime generation.
 *
 * Runtime row lock -> task CAS -> attempt creation are one transaction.
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
      reason: "runtime_not_ready" | "task_not_startable";
    }
> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
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

    const runtimeBusy =
      await tx.amuxWorkerRuntime.updateMany({
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
      throw new Error(
        "AMUX runtime fence changed while starting execution",
      );
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
        heartbeatAt: now,
        leaseExpiresAt,
        startedAt: now,
      },
    });

    const taskSnapshot =
      await tx.amuxWorkItem.findUniqueOrThrow({
        where: {
          id: input.taskId,
        },
        select: {
          title: true,
          description: true,
          kind: true,
          priority: true,
        },
      });

    const deliveryPrompt =
      buildAmuxDeliveryPrompt({
        taskId: input.taskId,
        title: taskSnapshot.title,
        description:
          taskSnapshot.description,
        kind: taskSnapshot.kind,
        priority: taskSnapshot.priority,
        worker: input.worker,
        attemptId,
        taskRevision,
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
        workerInstanceId:
          input.instanceId,
        workerGeneration:
          input.generation,
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
      summary:
        `Queued durable AMUX delivery ${attemptId} atomically with execution start.`,
      metadata: {
        attempt_id: attemptId,
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

    const attempt = await lockAttempt(
      tx,
      input.attemptId,
    );

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

    const updated =
      await tx.amuxExecutionAttempt.updateMany({
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

  return prisma.$transaction(async (tx) => {
    /*
     * Lock order is deliberately the same as execution heartbeat:
     * runtime -> attempt -> task.
     */
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

    const attempt = await lockAttempt(
      tx,
      input.attemptId,
    );

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
      task.revision !== input.taskRevision
    ) {
      return {
        settled: false as const,
        reason: "fenced_out" as const,
      };
    }

    const moved = await tx.amuxWorkItem.updateMany({
      where: {
        id: attempt.taskId,
        owner: input.worker,
        status: "doing",
        archivedAt: null,
        revision: input.taskRevision,
      },
      data:
        input.toStatus === "todo"
          ? {
              status: "todo",
              owner: null,
              claimedAt: null,
              revision: {
                increment: 1,
              },
            }
          : {
              status: input.toStatus,
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

    const closed =
      await tx.amuxExecutionAttempt.updateMany({
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
          toStatus: input.toStatus,
          endedBy: input.worker,
          reason: input.reason ?? null,
        },
      });

    if (closed.count !== 1) {
      throw new Error(
        "AMUX execution attempt changed while settling",
      );
    }

    await cancelPendingAmuxWorkDelivery(
      tx,
      input.attemptId,
      now,
    );

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
        to_status: input.toStatus,
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
  const limit = Math.max(
    1,
    Math.min(options.limit ?? 50, 200),
  );

  const candidates =
    await prisma.amuxExecutionAttempt.findMany({
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
    const applied = await prisma.$transaction(
      async (tx) => {
        /*
         * Keep the same lock ordering used by heartbeat and settle:
         * runtime -> attempt -> task.
         */
        const runtime = await lockRuntime(
          tx,
          candidate.worker,
        );

        const attempt = await lockAttempt(
          tx,
          candidate.id,
        );

        if (
          !attempt ||
          attempt.endedAt !== null ||
          !attempt.leaseExpiresAt ||
          attempt.leaseExpiresAt.getTime() >
            now.getTime()
        ) {
          return false;
        }

        const task = await lockTask(
          tx,
          attempt.taskId,
        );

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

        const moved =
          await tx.amuxWorkItem.updateMany({
            where: {
              id: attempt.taskId,
              owner: attempt.worker,
              status: "doing",
              archivedAt: null,
              revision: attempt.taskRevision,
            },
            data: {
              status: "todo",
              owner: null,
              claimedAt: null,
              revision: {
                increment: 1,
              },
            },
          });

        if (moved.count !== 1) {
          return false;
        }

        const closed =
          await tx.amuxExecutionAttempt.updateMany({
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
              toStatus: "todo",
              endedBy:
                "system:amux-execution-reaper",
              reason: "lease_expired",
            },
          });

        if (closed.count !== 1) {
          throw new Error(
            "AMUX expired execution changed while reclaiming",
          );
        }

        await cancelPendingAmuxWorkDelivery(
          tx,
          attempt.id,
          now,
        );

        /*
         * If the same runtime generation is still marked busy, quarantine it.
         * A replacement generation must never be touched here.
         */
        if (
          runtime &&
          runtime.instanceId ===
            attempt.workerInstanceId &&
          runtime.generation ===
            attempt.workerGeneration &&
          runtime.status === "busy"
        ) {
          await tx.amuxWorkerRuntime.updateMany({
            where: {
              workerName: attempt.worker,
              instanceId:
                attempt.workerInstanceId,
              generation:
                attempt.workerGeneration,
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
          summary:
            `Reclaimed expired AMUX execution ${attempt.id}.`,
          metadata: {
            attempt_id: attempt.id,
            worker: attempt.worker,
            worker_instance_id:
              attempt.workerInstanceId,
            worker_generation:
              attempt.workerGeneration,
            task_revision:
              attempt.taskRevision,
            next_task_revision:
              attempt.taskRevision + 1,
            outcome: "expired",
            to_status: "todo",
          },
          tx,
        });

        return true;
      },
    );

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
  const limit = Math.max(
    1,
    Math.min(options.limit ?? 50, 200),
  );

  const cutoff = new Date(
    now.getTime() - AMUX_CLAIM_RESERVATION_MS,
  );

  const candidates =
    await prisma.amuxWorkItem.findMany({
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
    const candidateClaimedAt =
      candidate.claimedAt;

    if (
      !candidateOwner ||
      !candidateClaimedAt
    ) {
      continue;
    }

    const applied =
      await prisma.$transaction(async (tx) => {
        const task = await lockTask(
          tx,
          candidate.id,
        );

        if (
          !task ||
          task.status !== "todo" ||
          task.archivedAt !== null ||
          task.owner !== candidateOwner ||
          task.revision !== candidate.revision ||
          !task.claimedAt ||
          task.claimedAt.getTime() !==
            candidateClaimedAt.getTime() ||
          task.claimedAt.getTime() >
            cutoff.getTime()
        ) {
          return false;
        }

        /*
         * Todo should imply no live execution, but fail closed if historical
         * corruption or a future lifecycle change ever violates that assumption.
         */
        const liveAttempts =
          await tx.amuxExecutionAttempt.count({
            where: {
              taskId: task.id,
              endedAt: null,
            },
          });

        if (liveAttempts !== 0) {
          return false;
        }

        const released =
          await tx.amuxWorkItem.updateMany({
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
          summary:
            `Released expired AMUX ownership reservation for ${task.id}.`,
          metadata: {
            previous_worker: task.owner,
            previous_revision:
              task.revision,
            next_revision:
              task.revision + 1,
            claimed_at:
              task.claimedAt.toISOString(),
            reservation_ms:
              AMUX_CLAIM_RESERVATION_MS,
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
