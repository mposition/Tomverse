import "server-only";

import { Prisma } from "@prisma/client";

import { getConfiguredAmuxV22WorkerCatalog, getConfiguredAmuxWorkerCatalog } from "@/lib/amux/workerCatalogVariables";
import {
  amuxWorkerCapabilitiesFromNewestJsonOrThrow,
  amuxWorkerCapabilityNewestJsonSql,
} from "@/lib/amux/workerCapabilityStore";
import {
  amuxWorkerDerivedCatalogAssignmentOpen,
  deriveAmuxWorkerCatalog,
  type AmuxDerivedCatalog,
} from "@/lib/amux/workerDerivedCatalogCore";
import {
  amuxWorkerLatchNewestJsonSql,
  amuxWorkerRegistryFromNewestJsonOrThrow,
  amuxWorkerRegistryNewestJsonSql,
} from "@/lib/amux/workerRegistryStore";

/**
 * Orchestration policy version 35, section 3 (stage R2c): the one place the
 * assignment paths ask for the worker catalog. With R2c's code latch off it
 * returns the catalog variables exactly as before and sends no statement.
 * With it on, it reads the registry, the stop latches and the capabilities in
 * one statement inside the caller's existing AMUX DB boundary (so each
 * boundary's statement ceiling grows by one) and derives the catalog.
 *
 * A catalog that cannot be derived is absent (null) -- the same answer as an
 * unreadable catalog variable today, which assigns no one. A statement that
 * fails is not caught: inside the boundary it has aborted the transaction.
 * Rows the stores would not accept make the catalog absent, not shorter.
 */

type CatalogReader = Pick<Prisma.TransactionClient, "$queryRaw">;

export type AmuxConfiguredWorker = NonNullable<ReturnType<typeof getConfiguredAmuxWorkerCatalog>>[number];
export type AmuxConfiguredV22Worker = NonNullable<ReturnType<typeof getConfiguredAmuxV22WorkerCatalog>>[number];

export type AmuxAssignmentCatalogs = {
  source: "variables" | "derived";
  workers: AmuxConfiguredWorker[] | null;
  v22: AmuxConfiguredV22Worker[] | null;
};

/** The derived catalog in one statement; null when it cannot be derived. */
export async function readAmuxDerivedWorkerCatalog(client: CatalogReader): Promise<AmuxDerivedCatalog | null> {
  const rows = await client.$queryRaw<Array<{ registry: unknown; latches: unknown; capabilities: unknown }>>(
    Prisma.sql`SELECT
      ${amuxWorkerRegistryNewestJsonSql()} AS "registry",
      ${amuxWorkerLatchNewestJsonSql()} AS "latches",
      ${amuxWorkerCapabilityNewestJsonSql()} AS "capabilities"`,
  );
  const row = rows[0];
  if (row === undefined) return null;
  try {
    const registry = amuxWorkerRegistryFromNewestJsonOrThrow(row.registry, row.latches);
    return deriveAmuxWorkerCatalog({
      registrations: registry.registrations,
      capabilities: amuxWorkerCapabilitiesFromNewestJsonOrThrow(row.capabilities),
      latches: registry.latches,
    });
  } catch {
    return null;
  }
}

/** The derived catalog in the shapes the catalog variables' readers return. */
export function amuxDerivedCatalogAsConfigured(derived: AmuxDerivedCatalog): {
  workers: AmuxConfiguredWorker[];
  v22: AmuxConfiguredV22Worker[];
} {
  const workers: AmuxConfiguredWorker[] = derived.legacy.map((entry) => ({
    worker_name: entry.worker_name,
    provider: entry.provider,
    model: entry.model,
    routing_roles: [...entry.routing_roles],
    tool_capabilities: [...entry.tool_capabilities],
    // As the variables' parser does: a static row starts stopped and not
    // ready, and the live runtime snapshot overlays it.
    running: false,
    status: "stopped",
    dispatch_ready: false,
    archived: false,
    paused: false,
    isolated: false,
    blocked: false,
  }));
  const byName = new Map(workers.map((worker) => [worker.worker_name, worker]));
  const v22: AmuxConfiguredV22Worker[] = [];
  for (const profile of derived.v22) {
    const base = byName.get(profile.worker_name);
    if (base === undefined) continue;
    v22.push({
      ...base,
      worker_name: profile.worker_name,
      provider: profile.provider,
      model: profile.model,
      routing_roles: [...profile.routing_roles],
      tool_capabilities: [...profile.tool_capabilities] as AmuxConfiguredV22Worker["tool_capabilities"],
    });
  }
  return { workers, v22 };
}

export type AmuxWorkerCatalogRefusal = "worker_catalog_unavailable" | "worker_not_configured";

/**
 * Why the assignment catalog does not list this worker, or null when it
 * does: the answer the register route gives a name it may not register.
 */
export async function amuxWorkerCatalogRefusal(
  client: CatalogReader,
  workerName: string,
  open: boolean = amuxWorkerDerivedCatalogAssignmentOpen(),
): Promise<AmuxWorkerCatalogRefusal | null> {
  const { workers } = await readAmuxAssignmentCatalogs(client, open);
  if (workers === null) return "worker_catalog_unavailable";
  return workers.some((worker) => worker.worker_name === workerName) ? null : "worker_not_configured";
}

/**
 * The assignment catalog for an assignment path. `open` is the code latch;
 * a test passes it to reach both branches.
 */
export async function readAmuxAssignmentCatalogs(
  client: CatalogReader,
  open: boolean = amuxWorkerDerivedCatalogAssignmentOpen(),
): Promise<AmuxAssignmentCatalogs> {
  if (!open) {
    return {
      source: "variables",
      workers: getConfiguredAmuxWorkerCatalog(),
      v22: getConfiguredAmuxV22WorkerCatalog(),
    };
  }
  const derived = await readAmuxDerivedWorkerCatalog(client);
  if (derived === null) return { source: "derived", workers: null, v22: null };
  return { source: "derived", ...amuxDerivedCatalogAsConfigured(derived) };
}
