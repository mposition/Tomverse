// The closed vocabularies of the ops-observer state tables, shared by the
// migration's CHECK constraints (pinned by scripts/check-enum-constraints.mjs),
// the store and the Admin genesis route (docs/policy/sre-ops.md §8).
//
// A genesis starts a fresh state chain. `initial` is the first one and is
// always shadow; `recovery` replaces an untrusted chain in the same mode;
// `activation` is the single shadow-to-live step that begins S2. There is no
// path from live back to shadow -- stopping is the switch, not a genesis.

import { RUN_DEADLINE_MS } from "./transaction-bounds-core.mjs";

export const GENESIS_REASONS = Object.freeze(["initial", "recovery", "activation"]);
export const GENESIS_MODES = Object.freeze(["shadow", "live"]);

/** Written by the triggers; a row stamped with another value is not trusted. */
export const OPS_OBSERVER_INVARIANT_VERSION = 1;

/** The furthest ahead a claimed run deadline may be (policy §6: start + 180 s). */
export const RUN_DEADLINE_CLAIM_MAX_MS = RUN_DEADLINE_MS;

/**
 * What a new genesis must look like given the current head of the chain
 * (`null` when there is none). Returns `null` when allowed, otherwise the
 * refusal the trigger raises. The migration's trigger implements the same
 * table; the integration test runs both against the same cases.
 */
export function genesisRefusal({ reason, mode, supersedesGenesisId }, head) {
  if (!GENESIS_REASONS.includes(reason) || !GENESIS_MODES.includes(mode)) return "ops_observer_genesis_shape";
  if (reason === "initial") {
    return head === null && supersedesGenesisId === null && mode === "shadow" ? null : "ops_observer_genesis_transition";
  }
  if (head === null || supersedesGenesisId !== head.id) return "ops_observer_genesis_not_head";
  if (reason === "recovery") return mode === head.mode ? null : "ops_observer_genesis_transition";
  return head.mode === "shadow" && mode === "live" ? null : "ops_observer_genesis_transition";
}

/**
 * The one genesis the owner can be offered for a chain, from the Admin view
 * (`head`, `trustReason`), or null when none fits: `initial` (shadow) with no
 * head; `recovery` in the head's mode when the chain is not trusted;
 * `activation` to live when a trusted chain is shadow. A trusted live chain
 * has no genesis -- stopping it is the switch. The seven-day rule is the
 * store's to judge; the screen only states it.
 */
export function genesisOffer({ head, trustReason }) {
  if (head === null) return { reason: "initial", mode: "shadow" };
  if (!GENESIS_MODES.includes(head.mode)) return null;
  if (trustReason !== "trusted") return { reason: "recovery", mode: head.mode };
  if (head.mode === "shadow") return { reason: "activation", mode: "live" };
  return null;
}
