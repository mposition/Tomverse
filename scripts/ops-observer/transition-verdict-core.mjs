// T3c of the ops-observer trust check (docs/policy/sre-ops.md §3-7, §3-10):
// every generation since the verified checkpoint has its ledger row, and each
// ledger row names the signed system audit entry of that same advance.
//
// The store reads two bounded things -- the ledger rows of the current genesis
// from the checkpoint generation onward (a primary-key range), and the audit
// rows those name -- verifies each audit row's own HMAC, and passes the facts
// here. This module judges only. It returns null when the chain since the
// checkpoint is accounted for, otherwise the reason. A fact that is missing
// or malformed is a failure, never a pass.

export const STATE_ADVANCED_ACTION = "ops_observer.state_advanced";
export const STATE_TARGET_TYPE = "OpsObserverState";
export const OPS_OBSERVER_ACTOR = "ops-observer";

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * state:      { genesisId, generation, stampKeysSha256, verifiedThroughGeneration,
 *               verifiedThroughAuditId, verifiedThroughAuditHash }
 * ledgerRows: [{ generation, auditLogId, auditEntryHash, keysSha256 }]  -- from
 *             max(1, verifiedThroughGeneration) through the state's generation
 * auditRows:  [{ id, entryHash, action, targetType, targetId, actorKind,
 *               metadata, hashVerified }]  -- actorKind from auditRowActorKind(),
 *             hashVerified from the row's own HMAC under the integrity keys
 *
 * Returns null, "checkpoint_broken", "unaudited_transition" or "audit_unverified".
 */
export function transitionVerdict({ state, ledgerRows, auditRows }) {
  if (state === null || typeof state !== "object" || !Array.isArray(ledgerRows) || !Array.isArray(auditRows)) {
    return "unaudited_transition";
  }
  const generation = state.generation;
  const checkpoint = state.verifiedThroughGeneration;
  if (!isCount(generation) || !isCount(checkpoint) || checkpoint > generation) return "checkpoint_broken";
  // Every value compared below is shape-checked first, so no two of them can
  // agree by both being absent.
  if (typeof state.genesisId !== "string" || state.genesisId === "" || !isSha256(state.stampKeysSha256)) {
    return "unaudited_transition";
  }

  // (a) The rows cover exactly max(1, checkpoint)..generation, each once.
  const first = Math.max(1, checkpoint);
  const byGeneration = new Map();
  for (const row of ledgerRows) {
    if (
      row === null ||
      typeof row !== "object" ||
      !isCount(row.generation) ||
      byGeneration.has(row.generation) ||
      typeof row.auditLogId !== "string" ||
      row.auditLogId === "" ||
      !isSha256(row.auditEntryHash) ||
      !isSha256(row.keysSha256)
    ) {
      return "unaudited_transition";
    }
    if (row.generation < first || row.generation > generation) return "unaudited_transition";
    byGeneration.set(row.generation, row);
  }
  if (checkpoint > 0 && !byGeneration.has(checkpoint)) return "checkpoint_broken";
  for (let g = first; g <= generation; g += 1) {
    if (!byGeneration.has(g)) return "unaudited_transition";
  }

  // (b) Every audit row a ledger row names was found.
  const auditById = new Map();
  for (const row of auditRows) {
    if (row !== null && typeof row === "object" && typeof row.id === "string") auditById.set(row.id, row);
  }
  for (const row of byGeneration.values()) {
    if (!auditById.has(row.auditLogId)) return "checkpoint_broken";
  }

  // The checkpoint's three values agree with its ledger row and its audit row.
  // At checkpoint 0 the genesis approval row plays this part, and T1 checks it.
  if (checkpoint > 0) {
    const anchor = byGeneration.get(checkpoint);
    const audit = auditById.get(anchor.auditLogId);
    if (
      state.verifiedThroughAuditId !== anchor.auditLogId ||
      state.verifiedThroughAuditHash !== anchor.auditEntryHash ||
      audit.entryHash !== anchor.auditEntryHash
    ) {
      return "checkpoint_broken";
    }
  }

  // (c)-(e) Each row's audit entry is a signed state advance of this genesis by
  // the ops-observer actor, carrying the row's hash, generation and key stamp.
  for (let g = first; g <= generation; g += 1) {
    const row = byGeneration.get(g);
    const audit = auditById.get(row.auditLogId);
    if (audit.hashVerified !== true || typeof audit.entryHash !== "string") return "audit_unverified";
    const metadata = audit.metadata;
    const sound =
      audit.action === STATE_ADVANCED_ACTION &&
      audit.targetType === STATE_TARGET_TYPE &&
      audit.targetId === state.genesisId &&
      audit.actorKind === "system" &&
      metadata !== null &&
      typeof metadata === "object" &&
      metadata.systemActor === OPS_OBSERVER_ACTOR &&
      audit.entryHash === row.auditEntryHash &&
      metadata.generation === row.generation &&
      metadata.keysSha256 === row.keysSha256;
    if (!sound) return "unaudited_transition";
  }

  // (f) The newest row's key stamp is the state's.
  if (generation > 0 && byGeneration.get(generation).keysSha256 !== state.stampKeysSha256) {
    return "unaudited_transition";
  }
  return null;
}
