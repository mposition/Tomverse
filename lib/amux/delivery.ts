import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { loadAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "@/lib/amux/ideaCrypto";
import { AMUX_V22_TASK_EXECUTION_ENV,
  AMUX_V22_SEALED_DELIVERY_MARKER,
  amuxV22TaskExecutionEnabled } from
  "@/lib/amux/v22TaskExecutionCore";
import { AMUX_V22_WORKER_AUTHORITY_NOTICE } from
  "@/lib/amux/v22ExternalAuthorityCore";

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
  v22AssignmentId: string | null;
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
        assignmentId: string | null;
        taskId: string;
        worker: string;
        taskRevision: number;
        prompt: string;
        v22Execution: {
          modelId: string;
          role: string;
          budgetMicrousd: number;
        } | null;
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
  // Key-store I/O is outside the DB transaction. The locked row below must
  // still match this candidate; a race refuses delivery rather than opening
  // another Task's sealed brief with stale keys.
  const v22Enabled = amuxV22TaskExecutionEnabled(
    process.env[AMUX_V22_TASK_EXECUTION_ENV]);
  const { sealedCandidate, candidateCard } = v22Enabled ?
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.deliveryKeyRead, async (tx) => {
      const sealedCandidate = await tx.amuxWorkDelivery.findFirst({
        where: { worker: input.worker, prompt: AMUX_V22_SEALED_DELIVERY_MARKER,
          status: { in: ["queued", "leased"] }, acknowledgedAt: null,
          cancelledAt: null },
        orderBy: [{ createdAt: "asc" }, { attemptId: "asc" }],
        select: { attemptId: true, taskId: true },
      });
      const candidateCard = sealedCandidate ? await tx.amuxWorkItem.findUnique({
        where: { id: sealedCandidate.taskId },
        select: { sourceSnapshot: true },
      }) : null;
      return { sealedCandidate, candidateCard };
    }) : { sealedCandidate: null, candidateCard: null };
  const snapshot = candidateCard?.sourceSnapshot;
  const ideaId = snapshot && typeof snapshot === "object" &&
    !Array.isArray(snapshot) && typeof snapshot.ideaId === "string" ?
      snapshot.ideaId : null;
  const briefKeys = sealedCandidate && ideaId ?
    await loadAmuxContentKeyRing([{ ideaId, purpose: "card_brief",
      subjectId: sealedCandidate.taskId }]) : null;
  const deliveryContent = async (tx: Prisma.TransactionClient,
    delivery: DeliveryLockRow) => {
    if (delivery.prompt !== AMUX_V22_SEALED_DELIVERY_MARKER)
      return { prompt: delivery.prompt, v22Execution: null };
    if (!v22Enabled) throw new Error("v22 sealed delivery is disabled");
    if (!briefKeys || sealedCandidate?.attemptId !== delivery.attemptId ||
        sealedCandidate.taskId !== delivery.taskId)
      throw new Error("v22 sealed delivery key binding changed");
    const card = await tx.amuxWorkItem.findUnique({
      where: { id: delivery.taskId },
      select: { sourceSystem: true, cardType: true,
        v4BriefCiphertext: true, v4BriefKeyId: true,
        v4BriefKeyVersion: true, v4BriefDigest: true,
        v4BriefDigestKeyId: true, v4BriefPurgedAt: true,
        v22AssignmentId: true },
    });
    const attempt = await tx.amuxExecutionAttempt.findUnique({
      where: { id: delivery.attemptId },
      select: { v22AssignmentId: true },
    });
    if (card?.sourceSystem !== "admin-idea-v4" ||
        card.cardType !== "task" || !card.v4BriefCiphertext ||
        !card.v4BriefKeyId || !card.v4BriefKeyVersion ||
        !card.v4BriefDigest || !card.v4BriefDigestKeyId ||
        card.v4BriefPurgedAt !== null ||
        !card.v22AssignmentId ||
        attempt?.v22AssignmentId !== card.v22AssignmentId)
      throw new Error("v22 sealed delivery is not assignment-bound");
    const assignment = await tx.amuxV22WorkerAssignment.findUnique({
      where: { id: card.v22AssignmentId },
      select: { workItemId: true, workerName: true,
        workerInstanceId: true, workerGeneration: true,
        modelId: true, role: true,
        perAttemptMicroUsd: true },
    });
    const budgetMicrousd = Number(assignment?.perAttemptMicroUsd);
    if (assignment?.workItemId !== delivery.taskId ||
        assignment?.workerName !== delivery.worker ||
        assignment?.workerInstanceId !== delivery.workerInstanceId ||
        assignment?.workerGeneration !== delivery.workerGeneration ||
        !Number.isSafeInteger(budgetMicrousd) ||
        budgetMicrousd < 1 || budgetMicrousd > 5_000_000)
      throw new Error("v22 delivery assignment profile is invalid");
    let plain: Buffer | null = null;
    try {
      plain = openAmuxContent({
        ciphertext: Buffer.from(card.v4BriefCiphertext),
        keyId: card.v4BriefKeyId,
        keyVersion: card.v4BriefKeyVersion,
      }, "card_brief", delivery.taskId, briefKeys as AmuxContentKeys);
      if (!verifyAmuxContentDigest(plain, "card_brief", delivery.taskId,
        card.v4BriefDigest, card.v4BriefDigestKeyId, briefKeys as AmuxContentKeys))
        throw new Error("v22 sealed delivery digest mismatch");
      return {
        prompt: `Task: ${delivery.taskId}\nExecution attempt: ${delivery.attemptId}\n` +
          `${AMUX_V22_WORKER_AUTHORITY_NOTICE}\n` +
          `Approved execution brief:\n${plain.toString("utf8")}\n\n` +
          AMUX_V22_WORKER_AUTHORITY_NOTICE,
        v22Execution: { modelId: assignment.modelId, role: assignment.role,
          budgetMicrousd },
      };
    } finally { plain?.fill(0); }
  };
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
        a."v22AssignmentId",
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
      const content = await deliveryContent(tx, delivery);

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
            assignmentId: delivery.v22AssignmentId,
            taskId: delivery.taskId,
            worker: delivery.worker,
            taskRevision: delivery.taskRevision,
            prompt: content.prompt,
            v22Execution: content.v22Execution,
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
          assignmentId: delivery.v22AssignmentId,
          taskId: delivery.taskId,
          worker: delivery.worker,
          taskRevision: delivery.taskRevision,
          prompt: content.prompt,
          v22Execution: content.v22Execution,
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
