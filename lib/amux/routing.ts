import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  amuxWorkersOwningOpenCards,
  getRoutingSnapshotTask,
} from "@/lib/amux/store";
import { amuxWorkerRuntimeByName } from "@/lib/amux/workerRuntime";
import { getAmuxWorkerTelemetry } from "@/lib/amux/telemetry";
import { readAmuxAssignmentCatalogs } from "@/lib/amux/workerAssignmentCatalog";

// The catalog variables' parser lives in workerCatalogVariables.ts so the
// assignment catalog reader (version 35, section 3) can use it without a
// cycle through this module; its importers here keep their path.
export {
  getConfiguredAmuxV22WorkerCatalog,
  getConfiguredAmuxWorkerCatalog,
} from "@/lib/amux/workerCatalogVariables";

const classificationSchema = z
  .object({
    task_kind: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/i),
    complexity: z.number().int().min(1).max(10),
    risk: z.number().int().min(1).max(3),
    files_expected: z
      .union([
        z.array(z.string().trim().min(1).max(500)).max(1_000),
        z.number().int().min(0).max(1_000),
        z.null(),
      ])
      .optional(),
  })
  .passthrough();

export type AmuxRoutingSnapshot =
  | {
      eligible: false;
      execution_ready: false;
      reason: "not_eligible" | "unclassified" | "worker_catalog_unavailable";
      task: null;
      candidates: [];
      telemetry: Record<string, never>;
    }
  | {
      eligible: true;
      execution_ready: boolean;
      reason: null;
      task: {
        task_kind: string;
        complexity: number;
        risk: number;
        files_expected: number | null;
      };
      candidates: Array<{
        worker: {
          worker_name: string;
          provider: string;
          model: string | null;
          routing_roles: string[];
          running: boolean;
          status: string;
          dispatch_ready: boolean;
          archived: boolean;
          paused: boolean;
          isolated: boolean;
          blocked: boolean;
        };
        predicted_success: number | null;
        quota_remaining: number | null;
        expected_speed: number | null;
        low_rework: number | null;
        low_human_attention: number | null;
        cost_efficiency: number | null;
        provider_exhausted: boolean;
      }>;
      telemetry: Prisma.InputJsonObject;
    };

const unavailable = (
  reason: "not_eligible" | "unclassified" | "worker_catalog_unavailable",
): AmuxRoutingSnapshot => ({
  eligible: false,
  execution_ready: false,
  reason,
  task: null,
  candidates: [],
  telemetry: {},
});

export async function buildAmuxRoutingSnapshot(
  taskId: string,
  expectedRevision: number,
): Promise<AmuxRoutingSnapshot> {
  return withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.routingSnapshot,
    async (tx, { dbNow }) => {
      const row = await getRoutingSnapshotTask(taskId, expectedRevision, tx);

      if (!row) {
        return unavailable("not_eligible");
      }

      const classification = classificationSchema.safeParse(row.classification);

      if (!classification.success) {
        return unavailable("unclassified");
      }

      // Orchestration policy version 35, section 3: the variables while
      // R2c is off; the catalog derived from the registry, read in this
      // boundary, once it is on.
      const { workers } = await readAmuxAssignmentCatalogs(tx);

      if (!workers) {
        return unavailable("worker_catalog_unavailable");
      }

      const runtimeByWorker = await amuxWorkerRuntimeByName(
        workers.map((worker) => worker.worker_name),
        tx,
      );
      const telemetryByWorker = await getAmuxWorkerTelemetry(
        workers,
        dbNow,
        tx,
      );

      // A worker holds one open card at a time (the claim refuses a second), so
      // one that already owns todo or doing work is not a dispatch candidate.
      const busyOwners = await amuxWorkersOwningOpenCards(
        workers.map((worker) => worker.worker_name),
        tx,
      );

      const filesExpected = classification.data.files_expected;

      const filesExpectedCount = Array.isArray(filesExpected)
        ? filesExpected.length
        : typeof filesExpected === "number"
          ? filesExpected
          : null;

      return {
        eligible: true,
        execution_ready: workers.some((worker) => {
          const runtime = runtimeByWorker.get(worker.worker_name);
          const specialistMismatch =
            row.requiredRoutingRole !== null &&
            !worker.routing_roles.includes(
              row.requiredRoutingRole.toLowerCase(),
            );
          return (
            runtime !== undefined &&
            runtime.leaseExpiresAt.getTime() > dbNow.getTime() &&
            runtime.status === "idle" &&
            runtime.dispatchReady &&
            !busyOwners.has(worker.worker_name) &&
            !worker.archived &&
            !worker.paused &&
            !worker.isolated &&
            !worker.blocked &&
            !specialistMismatch
          );
        }),
        reason: null,
        task: {
          task_kind: classification.data.task_kind.trim().toLowerCase(),
          complexity: classification.data.complexity,
          risk: classification.data.risk,
          files_expected: filesExpectedCount,
        },
        telemetry: Object.fromEntries(
          workers.map((worker) => [
            worker.worker_name,
            telemetryByWorker.get(worker.worker_name)?.evidence ?? {
              history: { sample_size: 0 },
              quota: { state: "unknown", provider_exhausted: false },
            },
          ]),
        ) as Prisma.InputJsonObject,
        candidates: workers.map((worker) => {
          const runtime = runtimeByWorker.get(worker.worker_name);

          const fresh =
            runtime !== undefined &&
            runtime.leaseExpiresAt.getTime() > dbNow.getTime();

          const running = fresh && runtime.status !== "stopped";

          const specialistMismatch =
            row.requiredRoutingRole !== null &&
            !worker.routing_roles.includes(
              row.requiredRoutingRole.toLowerCase(),
            );

          const dispatchReady =
            running &&
            runtime.status === "idle" &&
            runtime.dispatchReady &&
            !busyOwners.has(worker.worker_name) &&
            !worker.archived &&
            !worker.paused &&
            !worker.isolated &&
            !worker.blocked &&
            !specialistMismatch;
          const telemetry = telemetryByWorker.get(worker.worker_name)?.scoring;

          return {
            worker: {
              ...worker,
              blocked: worker.blocked || specialistMismatch,
              running,
              status: running ? runtime.status : "stopped",
              dispatch_ready: dispatchReady,
            },
            predicted_success: telemetry?.predicted_success.observed
              ? telemetry.predicted_success.value
              : null,
            quota_remaining: telemetry?.quota_remaining.observed
              ? telemetry.quota_remaining.value
              : null,
            expected_speed: telemetry?.expected_speed.observed
              ? telemetry.expected_speed.value
              : null,
            low_rework: telemetry?.low_rework.observed
              ? telemetry.low_rework.value
              : null,
            low_human_attention: telemetry?.low_human_attention.observed
              ? telemetry.low_human_attention.value
              : null,
            cost_efficiency: telemetry?.cost_efficiency.observed
              ? telemetry.cost_efficiency.value
              : null,
            provider_exhausted: telemetry?.provider_exhausted ?? false,
          };
        }),
      };
    },
  );
}
