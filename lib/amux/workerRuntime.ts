import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { AMUX_PRISMA_INT_MAX } from "@/lib/amux/claimContract";

export const AMUX_WORKER_RUNTIME_LEASE_MS = 90_000;

export type AmuxWorkerRuntimeStatus =
  "starting" | "idle" | "busy" | "error" | "stopped";

export type AmuxWorkerRuntimeSnapshot = {
  workerName: string;
  instanceId: string;
  generation: number;
  status: string;
  dispatchReady: boolean;
  heartbeatAt: Date;
  leaseExpiresAt: Date;
};

type RegisterRow = AmuxWorkerRuntimeSnapshot;

const leaseExpiry = (now: Date) =>
  new Date(now.getTime() + AMUX_WORKER_RUNTIME_LEASE_MS);

/**
 * Starts a new fenced runtime generation.
 *
 * One SQL statement increments generation under the row lock created by
 * INSERT .. ON CONFLICT, so two simultaneous registrations cannot receive the
 * same generation. A heartbeat from the old generation can no longer mutate
 * the replacement runtime.
 */
export async function registerAmuxWorkerRuntime(
  workerName: string,
  instanceId: string,
  suppliedNow?: Date,
): Promise<RegisterRow> {
  const rows = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.workerRegister,
    async (tx, context) => {
      const now = suppliedNow ?? context.dbNow;
      const leaseExpiresAt = leaseExpiry(now);
      const registered = await tx.$queryRaw<RegisterRow[]>`
    INSERT INTO "AmuxWorkerRuntime" (
      "workerName",
      "instanceId",
      "generation",
      "status",
      "dispatchReady",
      "heartbeatAt",
      "leaseExpiresAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${workerName},
      ${instanceId},
      1,
      'starting',
      false,
      ${now},
      ${leaseExpiresAt},
      ${now},
      ${now}
    )
    ON CONFLICT ("workerName")
    DO UPDATE SET
      "instanceId" = EXCLUDED."instanceId",
      "generation" =
        "AmuxWorkerRuntime"."generation" + 1,
      "status" = 'starting',
      "dispatchReady" = false,
      "heartbeatAt" = EXCLUDED."heartbeatAt",
      "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "AmuxWorkerRuntime"."generation" < ${AMUX_PRISMA_INT_MAX}
    RETURNING
      "workerName",
      "instanceId",
      "generation",
      "status",
      "dispatchReady",
      "heartbeatAt",
      "leaseExpiresAt"
  `;
      if (registered[0]) {
        await writeSystemAuditLog({
          systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.worker.registered",
          targetType: "AmuxWorkerRuntime",
          targetId: workerName,
          summary: "Registered fenced AMUX worker runtime generation.",
          metadata: {
            worker: workerName,
            instance_id: instanceId,
            generation: registered[0].generation,
          },
          tx,
        });
      }
      return registered;
    },
  );

  const row = rows[0];

  if (!row) {
    throw new Error("AMUX worker registration returned no row");
  }

  return row;
}

/**
 * Extends exactly one still-live generation.
 *
 * An expired or superseded runtime must register again. In particular an old
 * process cannot wake up later and overwrite the status of its replacement.
 */
export type AmuxWorkerHeartbeatReason =
  "runtime_lease_lost" | "active_execution";

export async function heartbeatAmuxWorkerRuntime(input: {
  workerName: string;
  instanceId: string;
  generation: number;
  status: AmuxWorkerRuntimeStatus;
  dispatchReady: boolean;
  now?: Date;
}): Promise<{
  accepted: boolean;
  leaseExpiresAt: Date;
  reason?: AmuxWorkerHeartbeatReason;
}> {
  return withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.workerHeartbeat,
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      const nextLease = leaseExpiry(now);
      /*
       * Serialize runtime state with execution start/heartbeat/settle, all of
       * which lock this same logical worker first.
       */
      const rows = await tx.$queryRaw<AmuxWorkerRuntimeSnapshot[]>`
        SELECT
          "workerName",
          "instanceId",
          "generation",
          "status",
          "dispatchReady",
          "heartbeatAt",
          "leaseExpiresAt"
        FROM "AmuxWorkerRuntime"
        WHERE "workerName" = ${input.workerName}
        FOR UPDATE
      `;

      const runtime = rows[0];

      if (
        !runtime ||
        runtime.instanceId !== input.instanceId ||
        runtime.generation !== input.generation ||
        runtime.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return {
          accepted: false,
          leaseExpiresAt: runtime?.leaseExpiresAt ?? nextLease,
          reason: "runtime_lease_lost" as const,
        };
      }

      /*
       * Only the worker knows its real turn boundary, so settlement itself does
       * not synthesize Idle. Conversely, the worker may not advertise Idle while
       * this exact runtime generation still owns a live execution attempt.
       */
      if (input.status === "idle") {
        const liveAttempts = await tx.amuxExecutionAttempt.count({
          where: {
            worker: input.workerName,
            workerInstanceId: input.instanceId,
            workerGeneration: input.generation,
            endedAt: null,
          },
        });

        if (liveAttempts > 0) {
          return {
            accepted: false,
            leaseExpiresAt: runtime.leaseExpiresAt,
            reason: "active_execution" as const,
          };
        }
      }

      const dispatchReady = input.status === "idle" && input.dispatchReady;

      const result = await tx.amuxWorkerRuntime.updateMany({
        where: {
          workerName: input.workerName,
          instanceId: input.instanceId,
          generation: input.generation,
          leaseExpiresAt: {
            gt: now,
          },
        },
        data: {
          status: input.status,
          dispatchReady,
          heartbeatAt: now,
          leaseExpiresAt: nextLease,
        },
      });

      if (result.count !== 1) {
        return {
          accepted: false,
          leaseExpiresAt: runtime.leaseExpiresAt,
          reason: "runtime_lease_lost" as const,
        };
      }

      // Lease refresh alone is high-frequency telemetry. A status or dispatch
      // authority transition is a control-plane mutation and is audited in
      // this same transaction.
      if (runtime.status !== input.status || runtime.dispatchReady !== dispatchReady) {
        await writeSystemAuditLog({
          systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.worker.status_changed",
          targetType: "AmuxWorkerRuntime",
          targetId: input.workerName,
          summary: "Changed AMUX worker runtime dispatch authority.",
          metadata: {
            worker: input.workerName,
            instance_id: input.instanceId,
            generation: input.generation,
            from_status: runtime.status,
            to_status: input.status,
            from_dispatch_ready: runtime.dispatchReady,
            to_dispatch_ready: dispatchReady,
          },
          tx,
        });
      }

      context.requireLeaseAt(runtime.leaseExpiresAt);
      return {
        accepted: true,
        leaseExpiresAt: nextLease,
      };
    },
  );
}

export async function amuxWorkerRuntimeByName(
  workerNames: readonly string[],
  transaction?: Prisma.TransactionClient,
): Promise<Map<string, AmuxWorkerRuntimeSnapshot>> {
  if (workerNames.length === 0) {
    return new Map();
  }

  const read = (tx: Prisma.TransactionClient) =>
    tx.amuxWorkerRuntime.findMany({
      where: {
        workerName: {
          in: [...workerNames],
        },
      },
      select: {
        workerName: true,
        instanceId: true,
        generation: true,
        status: true,
        dispatchReady: true,
        heartbeatAt: true,
        leaseExpiresAt: true,
      },
    });
  const rows = transaction
    ? await read(transaction)
    : await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCatalogRead, read);

  return new Map(rows.map((row) => [row.workerName, row]));
}
