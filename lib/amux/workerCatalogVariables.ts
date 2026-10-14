import "server-only";

import { z } from "zod";
import { amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_V22_WORKER_CATALOG_ENV, parseAmuxV22WorkerCatalog } from
  "@/lib/amux/v22WorkerCatalogCore";

/**
 * The assignment catalog as the two catalog variables state it
 * (`TOMVERSE_AMUX_WORKER_CATALOG_JSON` and the v22 variable). Moved from
 * lib/amux/routing.ts unchanged; orchestration policy version 35 replaces it
 * with the catalog derived from the registry (stage R2c) and deletes the
 * variables at R2e.
 */

const workerCatalogEntrySchema = z
  .object({
    worker_name: amuxMachineIdSchema,
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
    tool_capabilities: z.array(z.string().min(1).max(64)).max(16)
      .optional().default([]),

    // Static operator/lifecycle exclusions only.
    archived: z.boolean().optional().default(false),
    paused: z.boolean().optional().default(false),
    isolated: z.boolean().optional().default(false),
    blocked: z.boolean().optional().default(false),
  })
  .strict();

const workerCatalogSchema = z.array(workerCatalogEntrySchema).max(128);

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
      tool_capabilities: [...new Set(entry.tool_capabilities)].sort(),

      // Static catalog rows are overlaid with the live runtime snapshot below.
      // Start conservatively so a missing or stale runtime cannot be selected.
      running: false,
      status: "stopped",
      dispatch_ready: false,

      archived: entry.archived,
      paused: entry.paused,
      isolated: entry.isolated,
      blocked: entry.blocked,
    };
  });

  return workers.sort((a, b) => a.worker_name.localeCompare(b.worker_name));
};

export const getConfiguredAmuxWorkerCatalog = () => {
  try {
    return parseWorkerCatalog();
  } catch {
    return null;
  }
};

/** Separate Task-role/vendor/model metadata; legacy routing stays unchanged.
 * Missing metadata is a hold, never an inferred profile or fleet enrollment. */
export const getConfiguredAmuxV22WorkerCatalog = () =>
  parseAmuxV22WorkerCatalog(process.env[AMUX_V22_WORKER_CATALOG_ENV],
    getConfiguredAmuxWorkerCatalog());
