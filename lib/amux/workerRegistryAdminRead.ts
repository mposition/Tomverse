import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import {
  buildAmuxWorkerRegistryAdminView,
  type AmuxWorkerRegistryAdminView,
} from "@/lib/amux/workerRegistryCore";
import { readAmuxWorkerRegistryOrThrow } from "@/lib/amux/workerRegistryStore";

/**
 * AMUX › Execution › Workers (orchestration policy version 31, sections 3
 * and 8): the registry from one read inside the AMUX DB boundary, beside the
 * assignment catalog this server holds in `TOMVERSE_AMUX_WORKER_CATALOG_JSON`.
 * The comparison is R1's end condition; it reads the variable and never
 * changes it, and nothing here assigns anything.
 *
 * A failed read throws; the page and the route show it as unavailable, never
 * as an empty registry.
 */
export async function readAmuxWorkerRegistryForAdmin(): Promise<AmuxWorkerRegistryAdminView> {
  const view = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) =>
    readAmuxWorkerRegistryOrThrow(tx),
  );
  return buildAmuxWorkerRegistryAdminView({ ...view, catalog: getConfiguredAmuxWorkerCatalog() });
}
