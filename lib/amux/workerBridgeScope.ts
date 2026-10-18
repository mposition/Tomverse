import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readAmuxDerivedWorkerCatalog } from "@/lib/amux/workerAssignmentCatalog";
import {
  amuxWorkerBridgeScope,
  amuxWorkerBridgeScopeOpen,
  type AmuxWorkerBridgeScopeEntry,
} from "@/lib/amux/workerDerivedCatalogCore";

/**
 * Orchestration policy version 55, section 1 (stage S1): the bridge scope --
 * each worker the derived catalog lists, without the code constants, and
 * which kind of bridge serves it. Read-only, one statement in its own read
 * boundary. It sits beside the R2d session list rather than extending it:
 * installed bridges accept only the session list's exact keys.
 *
 * Three answers, none of them a halt for the bridge:
 * - `bridge_scope_off` while this stage's code latch is off;
 * - `worker_catalog_unavailable` when the catalog cannot be derived;
 * - the scope.
 */

export type AmuxWorkerBridgeScopeAnswer =
  | { listed: true; workers: AmuxWorkerBridgeScopeEntry[] }
  | { listed: false; reason: "bridge_scope_off" | "worker_catalog_unavailable" };

export async function readAmuxWorkerBridgeScope(
  open: boolean = amuxWorkerBridgeScopeOpen(),
): Promise<AmuxWorkerBridgeScopeAnswer> {
  if (!open) return { listed: false, reason: "bridge_scope_off" };
  const derived = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerBridgeScopeRead, (tx) =>
    readAmuxDerivedWorkerCatalog(tx),
  );
  if (derived === null) return { listed: false, reason: "worker_catalog_unavailable" };
  return { listed: true, workers: amuxWorkerBridgeScope(derived) };
}
