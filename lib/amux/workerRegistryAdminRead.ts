import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  buildAmuxWorkerRegistryAdminView,
  type AmuxWorkerRegistryAdminView,
} from "@/lib/amux/workerRegistryCore";
import { readAmuxWorkerRegistryOrThrow } from "@/lib/amux/workerRegistryStore";

/**
 * AMUX › Operations settings › Workers (orchestration policy version 31, sections 3
 * and 8): the registry from one read inside the AMUX DB boundary. Nothing
 * here assigns or changes anything. R1's comparison with the catalog
 * environment variable went with the variable at R2e.
 *
 * A failed read throws; the page and the route show it as unavailable, never
 * as an empty registry.
 */
export async function readAmuxWorkerRegistryForAdmin(): Promise<AmuxWorkerRegistryAdminView> {
  const view = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) =>
    readAmuxWorkerRegistryOrThrow(tx),
  );
  return buildAmuxWorkerRegistryAdminView(view);
}
