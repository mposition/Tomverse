import {
  AMUX_MANIFEST_CANONICALIZATION_VERSION,
  BOARD_IMPORT_MAX_ITEMS,
  BOARD_IMPORT_SCANNER_RULESET_DIGEST,
  BOARD_IMPORT_SCANNER_VERSION,
  BOARD_IMPORT_SECTION_CODES,
  type BoardImportSectionCode,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
} from "./boardImportCore.ts";

/**
 * Source reconciliation after the first catalog import.
 *
 * docs/policy/development-agent-orchestration.md (policy version 4).
 *
 * Item identity is source key, section code and detail digest. A new manifest
 * digest is a property of the run, not of each card. This module does not write.
 * Preview reports applyPermitted from the shipped latch and always returns
 * writes 0. It does not throw when the latch is closed.
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
  boardImportApplyPermitted({
    envValue,
    codeLatch: AMUX_RECONCILIATION_APPLY_CODE_LATCH,
  });

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

export const AMUX_RECONCILIATION_APPLY_ENV = "TOMVERSE_AMUX_RECONCILIATION_APPLY";
export const AMUX_RECONCILIATION_POLICY_VERSION = 1;
export const AMUX_RECONCILIATION_RAW_BODY_MAX_BYTES = 65_536;
export const AMUX_RECONCILIATION_SOURCE_SYSTEM = "tomverse_private_workboard";
export const AMUX_RECONCILIATION_PLANNER_VERSION = "amux-board-planner-v2";
export const AMUX_RECONCILIATION_VALIDATOR_VERSION = "amux-board-validator-v1";
export const AMUX_RECONCILIATION_DECISIONS = ["accept_new_source_revision", "reject"] as const;

export type AmuxReconciliationDecisionName = (typeof AMUX_RECONCILIATION_DECISIONS)[number];

const SOURCE_KEY_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

const REQUEST_KEYS = [
  "canonicalizationVersion",
  "decisions",
  "manifestDigest",
  "observed",
  "plannerVersion",
  "scannerRulesetDigest",
  "scannerVersion",
  "sectionCount",
  "sourceCommit",
  "stored",
  "validatorVersion",
] as const;

const SIDE_KEYS = ["boardDigest", "items"] as const;
const ITEM_KEYS = ["detailDigest", "sectionCode", "sourceKey", "sourceVersion"] as const;
const DECISION_KEYS = ["decision", "sourceKey"] as const;

export type AmuxReconciliationRevisionWrite = {
  sourceKey: string;
  decision: AmuxReconciliationDecisionName;
  storedSectionCode: BoardImportSectionCode;
  storedDetailDigest: string;
  storedSourceVersion: string;
  observedSectionCode: BoardImportSectionCode;
  observedDetailDigest: string;
  observedSourceVersion: string;
};

export type AmuxReconciliationPlan = {
  ok: true;
  sourceSystem: typeof AMUX_RECONCILIATION_SOURCE_SYSTEM;
  sourceCommit: string;
  boardDigest: string;
  manifestDigest: string;
  canonicalizationVersion: typeof AMUX_MANIFEST_CANONICALIZATION_VERSION;
  plannerVersion: typeof AMUX_RECONCILIATION_PLANNER_VERSION;
  validatorVersion: typeof AMUX_RECONCILIATION_VALIDATOR_VERSION;
  scannerVersion: typeof BOARD_IMPORT_SCANNER_VERSION;
  scannerRulesetDigest: string;
  sectionCount: number;
  activeItemCount: number;
  globalSnapshotDrift: 0 | 1;
  itemDriftCount: number;
  noOpCount: number;
  missingCount: number;
  extraCount: number;
  revisions: AmuxReconciliationRevisionWrite[];
  preserved: typeof AMUX_RECONCILIATION_PRESERVED_CARD;
  audit: {
    policyVersion: typeof AMUX_RECONCILIATION_POLICY_VERSION;
    sourceCommit: string;
    boardDigest: string;
    manifestDigest: string;
    globalSnapshotDrift: 0 | 1;
    acceptCount: number;
    rejectCount: number;
    noOpCount: number;
    missingCount: number;
    extraCount: number;
  };
};

export type AmuxReconciliationRefusal = {
  ok: false;
  code: string;
  writes: 0;
};

export type AmuxReconciliationPreview = {
  outcome: "preview" | "reject";
  code: string | null;
  inactive: boolean;
  applyPermitted: boolean;
  writes: 0;
  globalSnapshotDrift: 0 | 1;
  itemDriftCount: number;
  noOpCount: number;
  missingCount: number;
  extraCount: number;
  acceptCount: number;
  rejectCount: number;
  acceptKeys: string[];
  rejectKeys: string[];
};

const sameKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isSectionCode = (value: string): value is BoardImportSectionCode =>
  (BOARD_IMPORT_SECTION_CODES as readonly string[]).includes(value);

const isDecision = (value: string): value is AmuxReconciliationDecisionName =>
  (AMUX_RECONCILIATION_DECISIONS as readonly string[]).includes(value);

type ParsedItem = AmuxReconciliationItem & { sourceVersion: string };

const parseItem = (value: unknown): ParsedItem | null => {
  if (!isRecord(value) || !sameKeys(value, ITEM_KEYS)) return null;
  if (typeof value.sourceKey !== "string" || !SOURCE_KEY_PATTERN.test(value.sourceKey)) return null;
  if (typeof value.sectionCode !== "string" || !isSectionCode(value.sectionCode)) return null;
  if (typeof value.detailDigest !== "string" || !SHA256_PATTERN.test(value.detailDigest)) return null;
  if (typeof value.sourceVersion !== "string" || !COMMIT_PATTERN.test(value.sourceVersion)) return null;
  return {
    sourceKey: value.sourceKey,
    sectionCode: value.sectionCode,
    detailDigest: value.detailDigest,
    sourceVersion: value.sourceVersion,
  };
};

const parseSide = (
  value: unknown,
): { boardDigest: string; items: ParsedItem[] } | null => {
  if (!isRecord(value) || !sameKeys(value, SIDE_KEYS)) return null;
  if (typeof value.boardDigest !== "string" || !SHA256_PATTERN.test(value.boardDigest)) return null;
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > BOARD_IMPORT_MAX_ITEMS) {
    return null;
  }
  const items: ParsedItem[] = [];
  for (const entry of value.items) {
    const item = parseItem(entry);
    if (!item) return null;
    items.push(item);
  }
  return { boardDigest: value.boardDigest, items };
};

const uniqueKeys = (items: readonly ParsedItem[]): boolean =>
  new Set(items.map((item) => item.sourceKey)).size === items.length;

const refuse = (code: string): AmuxReconciliationRefusal => ({ ok: false, code, writes: 0 });

/**
 * One explicit decision per drifted key. No-op, missing and extra keys are
 * not revisions. The plan names the rows a later transaction may insert. It
 * does not insert them.
 */
export const planAmuxReconciliation = (
  raw: string,
): AmuxReconciliationPlan | AmuxReconciliationRefusal => {
  if (Buffer.byteLength(raw, "utf8") > AMUX_RECONCILIATION_RAW_BODY_MAX_BYTES) return refuse("schema_rejected");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("schema_rejected");
  }
  if (amuxCatalogTextRefused(parsed)) return refuse("content_refused");
  if (!isRecord(parsed) || !sameKeys(parsed, REQUEST_KEYS)) return refuse("schema_rejected");
  if (parsed.canonicalizationVersion !== AMUX_MANIFEST_CANONICALIZATION_VERSION) return refuse("schema_rejected");
  if (parsed.plannerVersion !== AMUX_RECONCILIATION_PLANNER_VERSION) return refuse("schema_rejected");
  if (parsed.validatorVersion !== AMUX_RECONCILIATION_VALIDATOR_VERSION) return refuse("schema_rejected");
  if (parsed.scannerVersion !== BOARD_IMPORT_SCANNER_VERSION) return refuse("schema_rejected");
  if (parsed.scannerRulesetDigest !== BOARD_IMPORT_SCANNER_RULESET_DIGEST) return refuse("schema_rejected");
  if (parsed.sectionCount !== BOARD_IMPORT_SECTION_CODES.length) return refuse("schema_rejected");
  if (typeof parsed.sourceCommit !== "string" || !COMMIT_PATTERN.test(parsed.sourceCommit)) {
    return refuse("schema_rejected");
  }
  if (typeof parsed.manifestDigest !== "string" || !SHA256_PATTERN.test(parsed.manifestDigest)) {
    return refuse("schema_rejected");
  }
  const stored = parseSide(parsed.stored);
  const observed = parseSide(parsed.observed);
  if (!stored || !observed || !uniqueKeys(stored.items) || !uniqueKeys(observed.items)) {
    return refuse("schema_rejected");
  }
  if (!Array.isArray(parsed.decisions) || parsed.decisions.length > BOARD_IMPORT_MAX_ITEMS) {
    return refuse("schema_rejected");
  }
  const decisions: Array<{ sourceKey: string; decision: AmuxReconciliationDecisionName }> = [];
  for (const entry of parsed.decisions) {
    if (!isRecord(entry) || !sameKeys(entry, DECISION_KEYS)) return refuse("schema_rejected");
    if (typeof entry.sourceKey !== "string" || !SOURCE_KEY_PATTERN.test(entry.sourceKey)) {
      return refuse("schema_rejected");
    }
    if (typeof entry.decision !== "string" || !isDecision(entry.decision)) return refuse("schema_rejected");
    decisions.push({ sourceKey: entry.sourceKey, decision: entry.decision });
  }
  if (new Set(decisions.map((entry) => entry.sourceKey)).size !== decisions.length) {
    return refuse("schema_rejected");
  }
  const classified = classifySourceReconciliation({
    storedBoardDigest: stored.boardDigest,
    observedBoardDigest: observed.boardDigest,
    storedItems: stored.items,
    observedItems: observed.items,
  });
  const decisionByKey = new Map(decisions.map((entry) => [entry.sourceKey, entry.decision]));
  if (classified.itemDrift.some((key) => !decisionByKey.has(key))) return refuse("decision_required");
  if (decisions.some((entry) => !classified.itemDrift.includes(entry.sourceKey))) {
    return refuse("decision_not_drift");
  }
  const storedByKey = new Map(stored.items.map((item) => [item.sourceKey, item]));
  const observedByKey = new Map(observed.items.map((item) => [item.sourceKey, item]));
  const revisions = classified.itemDrift.map((sourceKey) => {
    const before = storedByKey.get(sourceKey);
    const after = observedByKey.get(sourceKey);
    const decision = decisionByKey.get(sourceKey);
    if (!before || !after || !decision) return null;
    return {
      sourceKey,
      decision,
      storedSectionCode: before.sectionCode as BoardImportSectionCode,
      storedDetailDigest: before.detailDigest,
      storedSourceVersion: before.sourceVersion,
      observedSectionCode: after.sectionCode as BoardImportSectionCode,
      observedDetailDigest: after.detailDigest,
      observedSourceVersion: after.sourceVersion,
    };
  });
  if (revisions.some((entry) => entry === null)) return refuse("schema_rejected");
  const written = revisions.filter((entry): entry is AmuxReconciliationRevisionWrite => entry !== null);
  const acceptCount = written.filter((entry) => entry.decision === "accept_new_source_revision").length;
  const rejectCount = written.filter((entry) => entry.decision === "reject").length;
  return {
    ok: true,
    sourceSystem: AMUX_RECONCILIATION_SOURCE_SYSTEM,
    sourceCommit: parsed.sourceCommit,
    boardDigest: observed.boardDigest,
    manifestDigest: parsed.manifestDigest,
    canonicalizationVersion: AMUX_MANIFEST_CANONICALIZATION_VERSION,
    plannerVersion: AMUX_RECONCILIATION_PLANNER_VERSION,
    validatorVersion: AMUX_RECONCILIATION_VALIDATOR_VERSION,
    scannerVersion: BOARD_IMPORT_SCANNER_VERSION,
    scannerRulesetDigest: BOARD_IMPORT_SCANNER_RULESET_DIGEST,
    sectionCount: BOARD_IMPORT_SECTION_CODES.length,
    activeItemCount: stored.items.length,
    globalSnapshotDrift: classified.globalSnapshotDrift,
    itemDriftCount: classified.itemDrift.length,
    noOpCount: classified.itemNoOp.length,
    missingCount: classified.missing.length,
    extraCount: classified.extra.length,
    revisions: written,
    preserved: AMUX_RECONCILIATION_PRESERVED_CARD,
    audit: {
      policyVersion: AMUX_RECONCILIATION_POLICY_VERSION,
      sourceCommit: parsed.sourceCommit,
      boardDigest: observed.boardDigest,
      manifestDigest: parsed.manifestDigest,
      globalSnapshotDrift: classified.globalSnapshotDrift,
      acceptCount,
      rejectCount,
      noOpCount: classified.itemNoOp.length,
      missingCount: classified.missing.length,
      extraCount: classified.extra.length,
    },
  };
};

const emptyPreview = (code: string, inactive: boolean): AmuxReconciliationPreview => ({
  outcome: "reject",
  code,
  inactive,
  applyPermitted: false,
  writes: 0,
  globalSnapshotDrift: 0,
  itemDriftCount: 0,
  noOpCount: 0,
  missingCount: 0,
  extraCount: 0,
  acceptCount: 0,
  rejectCount: 0,
  acceptKeys: [],
  rejectKeys: [],
});

/** Preview writes nothing. applyPermitted follows the shipped latch. */
export const previewAmuxReconciliation = (
  raw: string,
  envValue: string | undefined,
): AmuxReconciliationPreview => {
  const inactive = !amuxReconciliationApplyPermitted(envValue);
  const planned = planAmuxReconciliation(raw);
  if (!planned.ok) return emptyPreview(planned.code, inactive);
  const acceptKeys = planned.revisions
    .filter((entry) => entry.decision === "accept_new_source_revision")
    .map((entry) => entry.sourceKey);
  const rejectKeys = planned.revisions
    .filter((entry) => entry.decision === "reject")
    .map((entry) => entry.sourceKey);
  return {
    outcome: "preview",
    code: null,
    inactive,
    applyPermitted: !inactive,
    writes: 0,
    globalSnapshotDrift: planned.globalSnapshotDrift,
    itemDriftCount: planned.itemDriftCount,
    noOpCount: planned.noOpCount,
    missingCount: planned.missingCount,
    extraCount: planned.extraCount,
    acceptCount: acceptKeys.length,
    rejectCount: rejectKeys.length,
    acceptKeys,
    rejectKeys,
  };
};
