import "server-only";

import { Prisma } from "@prisma/client";

import {
  amuxWorkerCapabilitiesFromNewestJsonOrThrow,
  amuxWorkerCapabilityNewestJsonSql,
} from "@/lib/amux/workerCapabilityStore";
import { deriveAmuxWorkerCatalog, type AmuxDerivedCatalog } from "@/lib/amux/workerDerivedCatalogCore";
import { AMUX_V22_MULTI_PROVIDER_ENV, amuxV22MultiProviderEnabled, type AmuxV22Provider } from
  "@/lib/amux/v22WorkerClaimCore";
import type { AmuxWorkerRegistration, AmuxWorkerRoleCeiling } from "@/lib/amux/workerRegistryCore";
import {
  amuxWorkerLatchNewestJsonSql,
  amuxWorkerRegistryFromNewestJsonOrThrow,
  amuxWorkerRegistryNewestJsonSql,
} from "@/lib/amux/workerRegistryStore";

/**
 * Orchestration policy version 35, section 3: the one place the assignment
 * paths ask for the worker catalog. It reads the registry, the stop latches
 * and the capabilities in one statement inside the caller's existing AMUX DB
 * boundary and derives the catalog. Stage R2c (version 53) switched every
 * consumer to it; stage R2e removed the catalog variables it replaced, so
 * there is no other source to fall back to.
 *
 * A catalog that cannot be derived is absent (null), which assigns no one. A
 * statement that fails is not caught: inside the boundary it has aborted the
 * transaction. Rows the stores would not accept make the catalog absent, not
 * shorter.
 */

type CatalogReader = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * One assignment catalog entry, in the shape its consumers read: a static row
 * that starts stopped and not ready, which the live runtime snapshot overlays.
 * The derived catalog never holds a worker back with the four hold flags --
 * the registry's desired state and stop latch stand for them (version 35,
 * section 2) -- so they are always false; the consumers still read them.
 */
export type AmuxConfiguredWorker = {
  worker_name: string;
  provider: string;
  model: string | null;
  routing_roles: string[];
  tool_capabilities: string[];
  running: boolean;
  status: string;
  dispatch_ready: boolean;
  archived: boolean;
  paused: boolean;
  isolated: boolean;
  blocked: boolean;
};

/**
 * A worker's v22 one-shot profile overlaid on its entry: the entry's shape
 * intersected with the profile's, as the overlay has always been typed.
 */
export type AmuxConfiguredV22Worker = AmuxConfiguredWorker & {
  provider: AmuxV22Provider;
  model: string;
  routing_roles: string[];
  tool_capabilities: Array<"repo_read" | "repo_write">;
};

export type AmuxAssignmentCatalogs = {
  workers: AmuxConfiguredWorker[] | null;
  v22: AmuxConfiguredV22Worker[] | null;
  /**
   * Each registered worker's role ceiling, for the selection-time check
   * (orchestration policy version 45). Null when the catalog is absent.
   */
  ceilings: ReadonlyMap<string, AmuxWorkerRoleCeiling> | null;
};

/**
 * The registry's newest events and the catalog derived from them, in one
 * statement. Either is null when it cannot be read or derived; the office
 * seats (version 35, section 3) show every registered worker beside whether
 * the catalog assigns it.
 */
export async function readAmuxRegistryAndDerivedCatalog(client: CatalogReader): Promise<{
  registrations: AmuxWorkerRegistration[] | null;
  derived: AmuxDerivedCatalog | null;
}> {
  const rows = await client.$queryRaw<Array<{ registry: unknown; latches: unknown; capabilities: unknown }>>(
    Prisma.sql`SELECT
      ${amuxWorkerRegistryNewestJsonSql()} AS "registry",
      ${amuxWorkerLatchNewestJsonSql()} AS "latches",
      ${amuxWorkerCapabilityNewestJsonSql()} AS "capabilities"`,
  );
  const row = rows[0];
  if (row === undefined) return { registrations: null, derived: null };
  let registry: ReturnType<typeof amuxWorkerRegistryFromNewestJsonOrThrow>;
  try {
    registry = amuxWorkerRegistryFromNewestJsonOrThrow(row.registry, row.latches);
  } catch {
    return { registrations: null, derived: null };
  }
  // A capability row the store would not accept leaves no catalog, but the
  // registry it was read beside is still the registry.
  let capabilities: ReturnType<typeof amuxWorkerCapabilitiesFromNewestJsonOrThrow>;
  try {
    capabilities = amuxWorkerCapabilitiesFromNewestJsonOrThrow(row.capabilities);
  } catch {
    return { registrations: registry.registrations, derived: null };
  }
  return {
    registrations: registry.registrations,
    derived: deriveAmuxWorkerCatalog({
      registrations: registry.registrations,
      capabilities,
      latches: registry.latches,
      multiProvider: amuxV22MultiProviderEnabled(process.env[AMUX_V22_MULTI_PROVIDER_ENV]),
    }),
  };
}

/** The derived catalog in one statement; null when it cannot be derived. */
export async function readAmuxDerivedWorkerCatalog(client: CatalogReader): Promise<AmuxDerivedCatalog | null> {
  return (await readAmuxRegistryAndDerivedCatalog(client)).derived;
}

/** The derived catalog in the shapes the assignment paths read. */
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
    // A static row starts stopped and not ready; the live runtime snapshot
    // overlays it.
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
): Promise<AmuxWorkerCatalogRefusal | null> {
  const { workers } = await readAmuxAssignmentCatalogs(client);
  if (workers === null) return "worker_catalog_unavailable";
  return workers.some((worker) => worker.worker_name === workerName) ? null : "worker_not_configured";
}

/** The assignment catalog for an assignment path: one statement, always. */
export async function readAmuxAssignmentCatalogs(client: CatalogReader): Promise<AmuxAssignmentCatalogs> {
  const { registrations, derived } = await readAmuxRegistryAndDerivedCatalog(client);
  if (derived === null || registrations === null) {
    return { workers: null, v22: null, ceilings: null };
  }
  return {
    ...amuxDerivedCatalogAsConfigured(derived),
    ceilings: new Map(registrations.map((registration) => [registration.workerName, registration.roleCeiling])),
  };
}
