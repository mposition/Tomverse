import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";

export const AMUX_DELIVERY_RECEIPT_LEASE_MS = 30_000;

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
  archivedAt: Date | null;
};

type DeliveryLockRow = {
  runtimeLeaseExpiresAt: Date;
  attemptLeaseExpiresAt: Date;
  attemptId: string;
  taskId: string;
  worker: string;
  workerInstanceId: string;
  workerGeneration: number;
  taskRevision: number;
  prompt: string;
  status: string;
  receiptId: string | null;
  leasedAt: Date | null;
  leaseExpiresAt: Date | null;
  acknowledgedAt: Date | null;
  cancelledAt: Date | null;
};

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
      "archivedAt"
    FROM "AmuxWorkItem"
    WHERE "id" = ${taskId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const lockDelivery = async (
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<DeliveryLockRow | null> => {
  const rows = await tx.$queryRaw<DeliveryLockRow[]>`
    SELECT
      "attemptId",
      "taskId",
      "worker",
      "workerInstanceId",
      "workerGeneration",
      "taskRevision",
      "prompt",
      "status",
      "receiptId",
      "leasedAt",
      "leaseExpiresAt",
      "acknowledgedAt",
      "cancelledAt"
    FROM "AmuxWorkDelivery"
    WHERE "attemptId" = ${attemptId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const runtimeMatches = (
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
  runtime.status === "busy" &&
  runtime.leaseExpiresAt.getTime() > now.getTime();

const attemptMatches = (
  attempt: AttemptLockRow | null,
  input: {
    attemptId: string;
    worker: string;
    instanceId: string;
    generation: number;
    taskRevision: number;
  },
  now: Date,
): attempt is AttemptLockRow =>
  attempt !== null &&
  attempt.id === input.attemptId &&
  attempt.worker === input.worker &&
  attempt.workerInstanceId === input.instanceId &&
  attempt.workerGeneration === input.generation &&
  attempt.taskRevision === input.taskRevision &&
  attempt.endedAt === null &&
  attempt.leaseExpiresAt !== null &&
  attempt.leaseExpiresAt.getTime() > now.getTime();

const taskMatches = (task: TaskLockRow | null, attempt: AttemptLockRow) =>
  task !== null &&
  task.id === attempt.taskId &&
  task.owner === attempt.worker &&
  task.status === "doing" &&
  task.revision === attempt.taskRevision &&
  task.archivedAt === null;

export type AmuxPulledDelivery =
  | {
      available: true;
      delivery: {
        attemptId: string;
        taskId: string;
        worker: string;
        taskRevision: number;
        prompt: string;
        receiptId: string;
        leaseExpiresAt: Date;
      };
    }
  | {
      available: false;
      reason: "none" | "runtime_not_ready";
    };

export async function pullAmuxWorkDelivery(input: {
  worker: string;
  instanceId: string;
  generation: number;
  now?: Date;
}): Promise<AmuxPulledDelivery> {
  return withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.deliveryPull,
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      const runtime = await lockRuntime(tx, input.worker);
      if (!runtimeMatches(runtime, input, now)) {
        return {
          available: false as const,
          reason: "runtime_not_ready" as const,
        };
      }

      const rows = await tx.$queryRaw<DeliveryLockRow[]>`
      SELECT
        r."leaseExpiresAt" AS "runtimeLeaseExpiresAt",
        a."leaseExpiresAt" AS "attemptLeaseExpiresAt",
        d."attemptId",
        d."taskId",
        d."worker",
        d."workerInstanceId",
        d."workerGeneration",
        d."taskRevision",
        d."prompt",
        d."status",
        d."receiptId",
        d."leasedAt",
        d."leaseExpiresAt",
        d."acknowledgedAt",
        d."cancelledAt"
      FROM "AmuxWorkerRuntime" r
      JOIN "AmuxWorkDelivery" d
        ON d."worker" = r."workerName"
       AND d."workerInstanceId" = r."instanceId"
       AND d."workerGeneration" = r."generation"
      JOIN "AmuxExecutionAttempt" a
        ON a."id" = d."attemptId"
       AND a."taskId" = d."taskId"
       AND a."worker" = d."worker"
       AND a."workerInstanceId" = d."workerInstanceId"
       AND a."workerGeneration" = d."workerGeneration"
       AND a."taskRevision" = d."taskRevision"
      JOIN "AmuxWorkItem" t
        ON t."id" = d."taskId"
       AND t."owner" = d."worker"
       AND t."revision" = d."taskRevision"
      WHERE r."workerName" = ${input.worker}
        AND r."instanceId" = ${input.instanceId}
        AND r."generation" = ${input.generation}
        AND r."status" = 'busy'
        AND r."leaseExpiresAt" > ${now}
        AND a."endedAt" IS NULL
        AND a."leaseExpiresAt" > ${now}
        AND t."status" = 'doing'
        AND t."archivedAt" IS NULL
        AND d."status" IN ('queued', 'leased')
        AND d."acknowledgedAt" IS NULL
        AND d."cancelledAt" IS NULL
      ORDER BY d."createdAt" ASC, d."attemptId" ASC
      LIMIT 1
      FOR UPDATE OF r, d, a, t SKIP LOCKED
    `;
      const delivery = rows[0] ?? null;

      if (!delivery) {
        return {
          available: false as const,
          reason: "none" as const,
        };
      }

      /*
       * A retry while the receipt lease is still live is idempotent: return
       * exactly the same receipt and deadline without mutating the row.
       *
       * Keep the guards directly on the branch so TypeScript preserves the
       * non-null receipt/deadline narrowing in the returned delivery.
       */
      if (
        delivery.status === "leased" &&
        delivery.receiptId !== null &&
        delivery.leaseExpiresAt !== null &&
        delivery.leaseExpiresAt.getTime() > now.getTime()
      ) {
        context.requireLeaseAt(delivery.runtimeLeaseExpiresAt);
        context.requireLeaseAt(delivery.attemptLeaseExpiresAt);
        context.requireLeaseAt(delivery.leaseExpiresAt);
        const receiptId = delivery.receiptId;
        const leaseExpiresAt = delivery.leaseExpiresAt;

        return {
          available: true as const,
          delivery: {
            attemptId: delivery.attemptId,
            taskId: delivery.taskId,
            worker: delivery.worker,
            taskRevision: delivery.taskRevision,
            prompt: delivery.prompt,
            receiptId,
            leaseExpiresAt,
          },
        };
      }

      /*
       * Queued work, or an expired receipt lease, gets a fresh receipt.
       * The old receipt must never become valid again.
       */
      const receiptId = randomUUID();
      const deliveryLeaseExpiresAt = new Date(
        now.getTime() + AMUX_DELIVERY_RECEIPT_LEASE_MS,
      );

      const leased = await tx.amuxWorkDelivery.updateMany({
        where: {
          attemptId: delivery.attemptId,
          status: delivery.status,
          receiptId: delivery.receiptId,
          leaseExpiresAt: delivery.leaseExpiresAt,
        },
        data: {
          status: "leased",
          receiptId,
          leasedAt: now,
          leaseExpiresAt: deliveryLeaseExpiresAt,
        },
      });

      if (leased.count !== 1) {
        return {
          available: false as const,
          reason: "none" as const,
        };
      }

      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.delivery.receipt_issued",
        targetType: "AmuxWorkItem",
        targetId: delivery.taskId,
        summary: "Issued a fenced AMUX delivery receipt.",
        metadata: {
          attempt_id: delivery.attemptId,
          receipt_id: receiptId,
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: delivery.taskRevision,
        },
        tx,
      });

      context.requireLeaseAt(delivery.runtimeLeaseExpiresAt);
      context.requireLeaseAt(delivery.attemptLeaseExpiresAt);
      return {
        available: true as const,
        delivery: {
          attemptId: delivery.attemptId,
          taskId: delivery.taskId,
          worker: delivery.worker,
          taskRevision: delivery.taskRevision,
          prompt: delivery.prompt,
          receiptId,
          leaseExpiresAt: deliveryLeaseExpiresAt,
        },
      };
    },
  );
}
export async function acknowledgeAmuxWorkDelivery(input: {
  attemptId: string;
  receiptId: string;
  worker: string;
  instanceId: string;
  generation: number;
  taskRevision: number;
  now?: Date;
}): Promise<
  | {
      acknowledged: true;
      idempotent: boolean;
    }
  | {
      acknowledged: false;
      reason: "fenced_out";
    }
> {
  return withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.deliveryAck,
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      const runtime = await lockRuntime(tx, input.worker);

      if (!runtimeMatches(runtime, input, now)) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const attempt = await lockAttempt(tx, input.attemptId);

      if (!attemptMatches(attempt, input, now)) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const task = await lockTask(tx, attempt.taskId);

      if (!taskMatches(task, attempt)) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const delivery = await lockDelivery(tx, input.attemptId);

      if (
        !delivery ||
        delivery.worker !== input.worker ||
        delivery.workerInstanceId !== input.instanceId ||
        delivery.workerGeneration !== input.generation ||
        delivery.taskRevision !== input.taskRevision ||
        delivery.receiptId !== input.receiptId
      ) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      if (delivery.status === "acknowledged") {
        return {
          acknowledged: true as const,
          idempotent: true,
        };
      }

      if (
        delivery.status !== "leased" ||
        delivery.leaseExpiresAt === null ||
        delivery.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const receiptLeaseExpiresAt = delivery.leaseExpiresAt;

      const acknowledged = await tx.amuxWorkDelivery.updateMany({
        where: {
          attemptId: input.attemptId,
          status: "leased",
          receiptId: input.receiptId,
          leaseExpiresAt: receiptLeaseExpiresAt,
        },
        data: {
          status: "acknowledged",
          leaseExpiresAt: null,
          acknowledgedAt: now,
        },
      });

      if (acknowledged.count !== 1) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.delivery.acknowledged",
        targetType: "AmuxWorkItem",
        targetId: attempt.taskId,
        summary: `Acknowledged durable AMUX delivery ${input.attemptId}.`,
        metadata: {
          attempt_id: input.attemptId,
          receipt_id: input.receiptId,
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: input.taskRevision,
        },
        tx,
      });

      if (runtime === null || attempt.leaseExpiresAt === null) {
        throw new Error("AMUX delivery acknowledgement lease invariant lost");
      }
      context.requireLeaseAt(runtime.leaseExpiresAt);
      context.requireLeaseAt(attempt.leaseExpiresAt);
      context.requireLeaseAt(receiptLeaseExpiresAt);
      return {
        acknowledged: true as const,
        idempotent: false,
      };
    },
  );
}

export async function cancelPendingAmuxWorkDelivery(
  tx: Prisma.TransactionClient,
  attemptId: string,
  now: Date,
): Promise<number> {
  const cancelled = await tx.amuxWorkDelivery.updateMany({
    where: {
      attemptId,
      status: {
        in: ["queued", "leased"],
      },
    },
    data: {
      status: "cancelled",
      leaseExpiresAt: null,
      cancelledAt: now,
    },
  });

  return cancelled.count;
}
