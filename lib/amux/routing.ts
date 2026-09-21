import "server-only";

import { z } from "zod";
import { getRoutingSnapshotTask } from "@/lib/amux/store";
import { amuxWorkerRuntimeByName } from "@/lib/amux/workerRuntime";

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

const workerCatalogEntrySchema = z
  .object({
    worker_name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    provider: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(160).nullable().optional(),
    routing_roles: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+$/i),
      )
      .min(1)
      .max(64),

    // Static operator/lifecycle exclusions only.
    archived: z.boolean().optional().default(false),
    paused: z.boolean().optional().default(false),
    isolated: z.boolean().optional().default(false),
    blocked: z.boolean().optional().default(false),
  })
  .strict();

const workerCatalogSchema = z.array(workerCatalogEntrySchema).max(128);

export type AmuxRoutingSnapshot =
  | {
      eligible: false;
      execution_ready: false;
      reason:
        | "not_eligible"
        | "unclassified"
        | "worker_catalog_unavailable";
      task: null;
      candidates: [];
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
        predicted_success: null;
        quota_remaining: null;
        expected_speed: null;
        low_rework: null;
        low_human_attention: null;
        cost_efficiency: null;
        provider_exhausted: false;
      }>;
    };

const unavailable = (
  reason:
    | "not_eligible"
    | "unclassified"
    | "worker_catalog_unavailable",
): AmuxRoutingSnapshot => ({
  eligible: false,
  execution_ready: false,
  reason,
  task: null,
  candidates: [],
});

const parseWorkerCatalog = () => {
  const raw = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON?.trim();
  if (!raw) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = workerCatalogSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.length === 0) {
    return null;
  }

  const seen = new Set<string>();

  const workers = parsed.data.map((entry) => {
    const workerName = entry.worker_name.trim();

    if (seen.has(workerName)) {
      throw new Error(`Duplicate AMUX worker name: ${workerName}`);
    }
    seen.add(workerName);

    return {
      worker_name: workerName,
      provider: entry.provider.trim().toLowerCase(),
      model: entry.model?.trim() || null,
      routing_roles: [
        ...new Set(
          entry.routing_roles.map((role) => role.trim().toLowerCase()),
        ),
      ].sort(),

      /*
       * Tomverse does not yet have a live development-agent runtime snapshot.
       * Do not pretend a terminal boundary exists. These are static catalog
       * entries and therefore begin as stopped/not-dispatch-ready.
       *
       * The scorer deliberately permits a stopped worker because the execution
       * lifecycle layer will own startup. TOMVERSE_AMUX_EXECUTE stays the outer
       * mutation gate until that lifecycle is implemented.
       */
      running: false,
      status: "stopped",
      dispatch_ready: false,

      archived: entry.archived,
      paused: entry.paused,
      isolated: entry.isolated,
      blocked: entry.blocked,
    };
  });

  return workers.sort((a, b) =>
    a.worker_name.localeCompare(b.worker_name),
  );
};

export const getConfiguredAmuxWorkerCatalog = () => {
  try {
    return parseWorkerCatalog();
  } catch {
    return null;
  }
};

export async function buildAmuxRoutingSnapshot(
  taskId: string,
  expectedRevision: number,
): Promise<AmuxRoutingSnapshot> {
  const row = await getRoutingSnapshotTask(taskId, expectedRevision);

  if (!row) {
    return unavailable("not_eligible");
  }

  const classification = classificationSchema.safeParse(
    row.classification,
  );

  if (!classification.success) {
    return unavailable("unclassified");
  }

  const workers = getConfiguredAmuxWorkerCatalog();

  if (!workers) {
    return unavailable("worker_catalog_unavailable");
  }

  const now = new Date();

  const runtimeByWorker = await amuxWorkerRuntimeByName(
    workers.map((worker) => worker.worker_name),
  );

  const filesExpected = classification.data.files_expected;

  const filesExpectedCount =
    Array.isArray(filesExpected)
      ? filesExpected.length
      : typeof filesExpected === "number"
        ? filesExpected
        : null;

  return {
    eligible: true,
    execution_ready: false,
    reason: null,
    task: {
      task_kind: classification.data.task_kind.trim().toLowerCase(),
      complexity: classification.data.complexity,
      risk: classification.data.risk,
      files_expected: filesExpectedCount,
    },
    candidates: workers.map((worker) => {
      const runtime = runtimeByWorker.get(worker.worker_name);

      const fresh =
        runtime !== undefined &&
        runtime.leaseExpiresAt.getTime() > now.getTime();

      const running =
        fresh && runtime.status !== "stopped";

      const dispatchReady =
        running &&
        runtime.status === "idle" &&
        runtime.dispatchReady &&
        !worker.archived &&
        !worker.paused &&
        !worker.isolated &&
        !worker.blocked;

      return {
        worker: {
          ...worker,
          running,
          status: running ? runtime.status : "stopped",
          dispatch_ready: dispatchReady,
        },
        predicted_success: null,
        quota_remaining: null,
        expected_speed: null,
        low_rework: null,
        low_human_attention: null,
        cost_efficiency: null,
        provider_exhausted: false,
      };
    }),
  };
}
