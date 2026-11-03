import "server-only";

import type { AmuxCliModelCatalogAdminView } from "@/lib/amux/cliModelCatalogCore";
import { readAmuxCliModelCatalogForAdmin } from "@/lib/amux/cliModelCatalogStore";
import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  buildAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import { readAmuxWorkerCapabilitiesOrThrow } from "@/lib/amux/workerCapabilityStore";
import { readAmuxWorkerRegistryOrThrow } from "@/lib/amux/workerRegistryStore";

/**
 * AMUX › Operations settings › Workers, capabilities (orchestration policy version 35,
 * section 2): each registered worker's recorded capability. Nothing here
 * changes anything; the catalog variables R2a imported from are gone since
 * R2e, so nothing is read from the environment either.
 *
 * A failed read throws; the page and the route show it as unavailable. The
 * registry and the capabilities are read in their own boundaries, so a
 * registry row the guard would not have accepted makes the view unavailable
 * rather than partial. The CLI model catalog (owner decision 2026-10-27) only
 * fills the model choices and their chips, so a failed read of it leaves
 * `cliModels` null and the editor falls back to typing a name.
 */
export async function readAmuxWorkerCapabilitiesForAdmin(): Promise<AmuxWorkerCapabilityAdminView> {
  const registry = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) =>
    readAmuxWorkerRegistryOrThrow(tx),
  );
  if (registry.registrations === null) throw new Error("AMUX worker registry is unreadable");
  const current = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityRead, (tx) =>
    readAmuxWorkerCapabilitiesOrThrow(tx),
  );
  let cliModels: AmuxCliModelCatalogAdminView | null = null;
  try {
    cliModels = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.cliModelCatalogRead, (tx) =>
      readAmuxCliModelCatalogForAdmin(tx),
    );
  } catch (error) {
    console.error(JSON.stringify({
      subsystem: "amux",
      event: "cli_model_catalog_read_failed",
      code: error instanceof AmuxDbBoundaryError ? error.code : null,
    }));
  }
  return buildAmuxWorkerCapabilityAdminView({ registrations: registry.registrations, current, cliModels });
}
