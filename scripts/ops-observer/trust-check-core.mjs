// The trust check of the ops-observer state (docs/policy/sre-ops.md §3-7):
// before the store reads state for a run, advances it or confirms a delivery,
// the same deterministic judgement decides whether the chain can be believed.
// Anything but `trusted` means nothing is sent, nothing is written and no
// heartbeat goes out; the silence is what the dead-man monitor reports.
//
// The store gathers the facts from the database (catalogue, rows, audit HMACs)
// and hands them here. This module only judges, in the fixed order T0..T5, and
// fails closed: a fact that is missing or not exactly the passing value is a
// failure, never a pass. The first failing check names the reason.

import { GENESIS_MODES, OPS_OBSERVER_INVARIANT_VERSION } from "./genesis-core.mjs";
import { DELIVERY_STATUSES } from "./delivery-core.mjs";

/** Every reason a chain is untrusted, in the order the checks run. */
export const TRUST_REASONS = Object.freeze([
  "audit_key_missing", // T0
  "state_missing", // T1
  "genesis_unapproved", // T1
  "audit_unverified", // T1, T3c
  "schema", // T2
  "invariants_missing", // T3a
  "unenforced_write", // T3b, T3d
  "unaudited_transition", // T3c
  "checkpoint_broken", // T3c
  "genesis_too_soon", // T5
]);

/** The genesis approval the audit chain must carry (§3-10). */
export const GENESIS_AUDIT_ACTION = "ops_observer.genesis_created";
export const GENESIS_AUDIT_TARGET_TYPE = "OpsObserverGenesis";

/** Decision D5b: a genesis within seven days of the previous one is not trusted. */
export const GENESIS_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** The verdicts the store's bounded transition-ledger read may report (T3c). */
const TRANSITION_VERDICTS = Object.freeze(["unaudited_transition", "checkpoint_broken", "audit_unverified"]);

const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isUuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const isTime = (value) => value instanceof Date && Number.isFinite(value.getTime());
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * T1's approval half (`genesis` is already shape-checked, so no field below
 * can match by both being absent): exactly one audit row for the genesis, written by a
 * human, whose metadata binds the same request, predecessor and mode -- and
 * then that row's own HMAC verifies. `unknown` actors are not human.
 */
function genesisApprovalReason(genesis, auditRows) {
  if (!Array.isArray(auditRows) || auditRows.length !== 1) return "genesis_unapproved";
  const [row] = auditRows;
  if (row === null || typeof row !== "object") return "genesis_unapproved";
  const metadata = row.metadata;
  if (
    row.action !== GENESIS_AUDIT_ACTION ||
    row.targetType !== GENESIS_AUDIT_TARGET_TYPE ||
    row.targetId !== genesis.id ||
    row.actorKind !== "human" ||
    metadata === null ||
    typeof metadata !== "object" ||
    metadata.requestDigest !== genesis.requestDigest ||
    metadata.supersedesGenesisId !== genesis.supersedesGenesisId ||
    metadata.mode !== genesis.mode
  ) {
    return "genesis_unapproved";
  }
  return row.hashVerified === true ? null : "audit_unverified";
}

/** T3b: the state row was written under the current triggers. */
export function stateStampReason(state, recomputedKeysSha256, recomputedCheckpointSha256) {
  // Both stamps: the keys, and the verified checkpoint. A checkpoint moved
  // past the trigger would take earlier generations out of what T3c reads.
  const sound =
    state.invariantVersion === OPS_OBSERVER_INVARIANT_VERSION &&
    isCount(state.generation) &&
    state.stampGeneration === state.generation &&
    isSha256(recomputedKeysSha256) &&
    state.stampKeysSha256 === recomputedKeysSha256 &&
    isSha256(recomputedCheckpointSha256) &&
    state.stampCheckpointSha256 === recomputedCheckpointSha256;
  return sound ? null : "unenforced_write";
}

/** T3d: every open or touched delivery row was written under the triggers, in its genesis's mode. */
export function deliveryStampReason(deliveries, genesisMode) {
  if (!Array.isArray(deliveries)) return "unenforced_write";
  for (const row of deliveries) {
    const sound =
      row !== null &&
      typeof row === "object" &&
      row.invariantVersion === OPS_OBSERVER_INVARIANT_VERSION &&
      DELIVERY_STATUSES.includes(row.status) &&
      row.stampStatus === row.status &&
      row.mode === genesisMode;
    if (!sound) return "unenforced_write";
  }
  return null;
}

/**
 * T5: a genesis less than seven days after the one it replaced is not trusted.
 * Only the first genesis (`supersedesGenesisId === null`) has no predecessor
 * time; any other genesis without a valid one fails, so a predecessor lookup
 * that came back empty cannot skip the rule.
 */
export function genesisTooSoon(genesis, previousCreatedAt) {
  if (!isTime(genesis?.createdAt)) return true;
  if (genesis.supersedesGenesisId === null) return previousCreatedAt !== null;
  if (!isTime(previousCreatedAt)) return true;
  return genesis.createdAt.getTime() - previousCreatedAt.getTime() < GENESIS_MIN_INTERVAL_MS;
}

/**
 * Judges the gathered facts. Returns `{ trusted: true }` or
 * `{ trusted: false, reason }` with the first failing check's reason.
 */
export function judgeTrust(facts) {
  const fail = (reason) => ({ trusted: false, reason });
  const f = facts ?? {};

  // T0: without an integrity key nothing written now could be told apart later.
  if (!Number.isSafeInteger(f.auditKeyCount) || f.auditKeyCount < 1) return fail("audit_key_missing");

  // T1: the newest genesis, its state row, and the human approval of that genesis.
  const genesis = f.genesis;
  const state = f.state;
  if (
    genesis === null ||
    typeof genesis !== "object" ||
    state === null ||
    typeof state !== "object" ||
    !isUuid(genesis.id) ||
    state.genesisId !== genesis.id ||
    !GENESIS_MODES.includes(genesis.mode) ||
    !isSha256(genesis.requestDigest) ||
    !(genesis.supersedesGenesisId === null || isUuid(genesis.supersedesGenesisId)) ||
    !isTime(genesis.createdAt)
  ) {
    return fail("state_missing");
  }
  const approval = genesisApprovalReason(genesis, f.genesisAuditRows);
  if (approval) return fail(approval);

  // T2: the keys parsed against the closed schema.
  if (f.keysSchemaValid !== true) return fail("schema");

  // T3a: every trigger, index and deferral the migrations made is in the catalogue.
  if (f.catalogComplete !== true) return fail("invariants_missing");

  // T3b: the state row carries the stamp only the triggers write.
  const stamp = stateStampReason(state, f.recomputedKeysSha256, f.recomputedCheckpointSha256);
  if (stamp) return fail(stamp);

  // T3c: every generation since the checkpoint has its signed transition row.
  if (f.transitionVerdict !== null) {
    return fail(TRANSITION_VERDICTS.includes(f.transitionVerdict) ? f.transitionVerdict : "unaudited_transition");
  }

  // T3d: open and touched deliveries were written under the triggers.
  const delivery = deliveryStampReason(f.deliveries, genesis.mode);
  if (delivery) return fail(delivery);

  // T5: a genesis inside seven days of the previous one stays silent.
  if (genesisTooSoon(genesis, f.previousGenesisCreatedAt)) {
    return fail("genesis_too_soon");
  }

  return { trusted: true };
}
