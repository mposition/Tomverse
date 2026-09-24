/**
 * Source reconciliation after the first catalog import.
 *
 * docs/product/governance.md v1.1 in the private workboard. Item identity is
 * source key, section code and detail digest. A new manifest digest is a
 * property of the run, not of each card. This module does not write.
 */

export const AMUX_RECONCILIATION_RUN_STATUSES = [
  "prepared",
  "approved",
  "applying",
  "consumed",
  "rejected",
  "outcome_unknown",
] as const;

export const AMUX_SOURCE_REVISION_STATES = ["observed", "accepted", "rejected"] as const;

/** Shipped off. A caller cannot supply the latch. */
export const AMUX_RECONCILIATION_APPLY_CODE_LATCH = false;

export const amuxReconciliationApplyPermitted = (envValue: string | undefined): boolean =>
  AMUX_RECONCILIATION_APPLY_CODE_LATCH === true && envValue === "enabled";

export type AmuxReconciliationItem = {
  sourceKey: string;
  sectionCode: string;
  detailDigest: string;
};

export type AmuxReconciliationClassification = {
  globalSnapshotDrift: 0 | 1;
  itemDrift: string[];
  itemNoOp: string[];
  missing: string[];
  extra: string[];
};

const byKey = (items: readonly AmuxReconciliationItem[]): Map<string, AmuxReconciliationItem> => {
  const map = new Map<string, AmuxReconciliationItem>();
  for (const item of items) map.set(item.sourceKey, item);
  return map;
};

/**
 * Compare one pinned board digest and the item identities. Manifest digest is
 * intentionally not an argument: including it would mark every stored card as
 * drift when only the global snapshot changed.
 */
export const classifySourceReconciliation = (input: {
  storedBoardDigest: string;
  observedBoardDigest: string;
  storedItems: readonly AmuxReconciliationItem[];
  observedItems: readonly AmuxReconciliationItem[];
}): AmuxReconciliationClassification => {
  const stored = byKey(input.storedItems);
  const observed = byKey(input.observedItems);
  const itemDrift: string[] = [];
  const itemNoOp: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [key, item] of stored) {
    const next = observed.get(key);
    if (!next) {
      missing.push(key);
      continue;
    }
    if (next.sectionCode === item.sectionCode && next.detailDigest === item.detailDigest) {
      itemNoOp.push(key);
    } else {
      itemDrift.push(key);
    }
  }
  for (const key of observed.keys()) {
    if (!stored.has(key)) extra.push(key);
  }
  return {
    globalSnapshotDrift: input.storedBoardDigest === input.observedBoardDigest ? 0 : 1,
    itemDrift: itemDrift.sort(),
    itemNoOp: itemNoOp.sort(),
    missing: missing.sort(),
    extra: extra.sort(),
  };
};

/** Fields an accepted revision must not write. */
export const AMUX_RECONCILIATION_PRESERVED_CARD = {
  status: "backlog",
  kind: "unknown",
  priority: "p3",
  owner: null,
  claimedAt: null,
} as const;
