import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readAmuxDerivedWorkerCatalog } from "@/lib/amux/workerAssignmentCatalog";
import {
  amuxDerivedCatalogEntryIsConstant,
  amuxWorkerSessionListOpen,
} from "@/lib/amux/workerDerivedCatalogCore";

/**
 * Orchestration policy version 35, section 4 (stage R2d): the bridge's
 * session list -- the names the derived catalog lists, without the code
 * constants (`engineering-runner` is the app's own worker, not a bridge
 * session). Read-only, one statement in its own read boundary.
 *
 * Three answers, none of them a halt for the bridge:
 * - `session_list_off` while R2d's code latch is off: the bridge keeps its
 *   environment allowlist exactly as before;
 * - `worker_catalog_unavailable` when the catalog cannot be derived: the
 *   bridge registers nothing new and offers no session for dispatch;
 * - the list, which the bridge intersects with its environment allowlist
 *   during the transition.
 */
export type AmuxWorkerSessionListAnswer =
  | { listed: true; workers: string[] }
  | { listed: false; reason: "session_list_off" | "worker_catalog_unavailable" };

export async function readAmuxWorkerSessionList(
  open: boolean = amuxWorkerSessionListOpen(),
): Promise<AmuxWorkerSessionListAnswer> {
  if (!open) return { listed: false, reason: "session_list_off" };
  const derived = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerSessionListRead, (tx) =>
    readAmuxDerivedWorkerCatalog(tx),
  );
  if (derived === null) return { listed: false, reason: "worker_catalog_unavailable" };
  return {
    listed: true,
    workers: derived.legacy
      .map((entry) => entry.worker_name)
      .filter((name) => !amuxDerivedCatalogEntryIsConstant(name)),
  };
}
