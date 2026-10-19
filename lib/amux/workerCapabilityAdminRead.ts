import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  buildAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import { readAmuxWorkerCapabilitiesOrThrow } from "@/lib/amux/workerCapabilityStore";
import { readAmuxWorkerRegistryOrThrow } from "@/lib/amux/workerRegistryStore";

/**
 * AMUX › Execution › Workers, capabilities (orchestration policy version 35,
 * section 2): each registered worker's recorded capability. Nothing here
 * changes anything; the catalog variables R2a imported from are gone since
 * R2e, so nothing is read from the environment either.
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
  return buildAmuxWorkerCapabilityAdminView({ registrations: registry.registrations, current });
}
