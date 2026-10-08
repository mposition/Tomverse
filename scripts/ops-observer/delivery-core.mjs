// The closed vocabularies of the ops-observer reservation tables
// (docs/policy/sre-ops.md §3 rules 3 and 9, §5), shared by the migration's
// CHECK constraints (pinned by scripts/check-enum-constraints.mjs) and the
// store.
//
// A run reserves before it sends. A reservation is closed exactly once: as
// `confirmed` when a live genesis's send was confirmed, `shadowed` when a
// shadow genesis would have sent, or `abandoned` when the next run finds it
// still open and does not know whether it went out. At most one reservation is
// open at a time, and each kind of message is reserved at most once per
// incident within a mode.

import { MESSAGE_KINDS } from "./notification-budget-core.mjs";

export const DELIVERY_STATUSES = Object.freeze(["reserved", "confirmed", "shadowed", "abandoned"]);

/** How an incident began: a new open, or a reopen within the policy's window. */
export const ITEM_ORIGINS = Object.freeze(["new", "reopen"]);

/** Closed reservations are deleted after this many days (policy §10). */
export const DELIVERY_RETENTION_DAYS = 90;

/**
 * The runs whose last write lands in shared tables, and so carry a guard row
 * of this agent's whose deferred trigger refuses a late COMMIT
 * (OpsObserverRunGuard, docs/policy/sre-ops.md §6 item 5).
 */
export const RUN_GUARD_KINDS = Object.freeze(["daily_digest"]);

export { MESSAGE_KINDS };

/** The terminal status a closing confirm must use for a genesis mode. */
export function confirmStatusForMode(mode) {
  if (mode === "live") return "confirmed";
  if (mode === "shadow") return "shadowed";
  throw new Error("ops_observer_mode_unknown");
}
