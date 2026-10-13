import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import { AMUX_V22_WORKER_CATALOG_ENV, parseAmuxV22WorkerCatalog } from "@/lib/amux/v22WorkerCatalogCore";
import {
  amuxWorkerCapabilityV22Catalog,
  buildAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import { readAmuxWorkerCapabilitiesOrThrow } from "@/lib/amux/workerCapabilityStore";
import { readAmuxWorkerRegistryOrThrow } from "@/lib/amux/workerRegistryStore";

/**
 * AMUX › Execution › Workers, capabilities (orchestration policy version 35,
 * stage R2a): each registered worker's recorded capability beside what the
 * catalog variables this server holds describe for it -- the one-time import
 * proposal. It reads the variables and never changes them; nothing here
 * assigns anything until R2c.
 *
 * A failed read throws; the page and the route show it as unavailable. The
 * registry and the capabilities are read in their own boundaries, so a
 * registry row the guard would not have accepted makes the view unavailable
 * rather than partial.
 */
export async function readAmuxWorkerCapabilitiesForAdmin(): Promise<AmuxWorkerCapabilityAdminView> {
  const registry = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) =>
    readAmuxWorkerRegistryOrThrow(tx),
  );
  if (registry.registrations === null) throw new Error("AMUX worker registry is unreadable");
  const current = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityRead, (tx) =>
    readAmuxWorkerCapabilitiesOrThrow(tx),
  );
  // Only an absent v22 variable means no worker has a profile ([]); any
  // present value, blank included, is parsed, and one that does not parse is
  // unreadable (null), which blocks the import.
  const legacy = getConfiguredAmuxWorkerCatalog();
  return buildAmuxWorkerCapabilityAdminView({
    registrations: registry.registrations,
    current,
    legacy,
    v22: amuxWorkerCapabilityV22Catalog(process.env[AMUX_V22_WORKER_CATALOG_ENV], (raw) =>
      parseAmuxV22WorkerCatalog(raw, legacy),
    ),
  });
}
