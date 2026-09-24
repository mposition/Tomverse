import { createHash } from "node:crypto";

import {
  AMUX_MANIFEST_CANONICALIZATION_VERSION,
  BOARD_IMPORT_SCANNER_RULESET_DIGEST,
  BOARD_IMPORT_SCANNER_VERSION,
  amuxCanonicalJson,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
} from "./boardImportCore.ts";

/**
 * Manual promotion of one to three catalog backlog cards.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy version 5).
 * The request schema stays at policy version 3.
 *
 * Parsing and classification are pure. This module does not open a
 * transaction, write an audit row, or change a card. The service is the only
 * writer. Production apply needs both the environment latch and
 * `BOARD_PROMOTION_APPLY_CODE_LATCH`. Version 5 turns that constant on.
 * Nothing here selects a card, starts a worker, or spends credits.
 */

export const BOARD_PROMOTION_POLICY_VERSION = 3;
export const BOARD_PROMOTION_CANONICALIZATION_VERSION = AMUX_MANIFEST_CANONICALIZATION_VERSION;
export const BOARD_PROMOTION_SCANNER_VERSION = BOARD_IMPORT_SCANNER_VERSION;
export const BOARD_PROMOTION_SCANNER_RULESET_DIGEST = BOARD_IMPORT_SCANNER_RULESET_DIGEST;
export const BOARD_PROMOTION_MIN_ITEMS = 1;
export const BOARD_PROMOTION_MAX_ITEMS = 3;
export const BOARD_PROMOTION_BRIEF_MAX_BYTES = 8_192;
export const BOARD_PROMOTION_RAW_BODY_MAX_BYTES = 65_536;
export const BOARD_PROMOTION_APPLY_ENV = "TOMVERSE_AMUX_BOARD_PROMOTE";

/**
 * Second apply latch. One environment variable must not be enough to move a
 * card. The HTTP route passes this constant and never a literal `true`.
 * Version 5 arms it for the named E pilot. A caller cannot supply the latch.
 * This constant does not promote a card and does not read the environment.
 */
export const BOARD_PROMOTION_APPLY_CODE_LATCH = true;

export const BOARD_PROMOTION_APPROVAL_STATUSES = [
  "prepared",
  "approved",
  "rejected",
  "expired",
  "consumed",
] as const;

export const BOARD_PROMOTION_KINDS = [
  "blocker",
  "escalation",
  "bug",
  "code",
  "ops",
  "investigation",
  "research",
  "chore",
  "doc",
] as const;

export const BOARD_PROMOTION_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

/** Kinds the current worker router names. The default arm is not an allowlist. */
export const BOARD_PROMOTION_TASK_KINDS = [
  "architecture",
  "bugfix",
  "dependency_upgrade",
  "feature",
  "integration",
  "iteration",
  "migration",
  "reasoning",
  "refactor",
  "review",
  "security",
  "tests",
] as const;

const REQUEST_KEYS = ["canonicalizationVersion", "items", "policyVersion"] as const;
const ITEM_KEYS = [
  "cardId",
  "classification",
  "executionBrief",
  "expectedRevision",
  "kind",
  "priority",
  "sourceDigest",
] as const;
const CLASSIFICATION_KEYS = ["complexity", "files_expected", "risk", "task_kind"] as const;

const CARD_ID_PATTERN = /^c[a-z0-9]{24}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type BoardPromotionKind = (typeof BOARD_PROMOTION_KINDS)[number];
export type BoardPromotionPriority = (typeof BOARD_PROMOTION_PRIORITIES)[number];
export type BoardPromotionTaskKind = (typeof BOARD_PROMOTION_TASK_KINDS)[number];

export type BoardPromotionClassification = {
  task_kind: BoardPromotionTaskKind;
  complexity: number;
  risk: number;
  files_expected: number;
};

export type BoardPromotionItem = {
  cardId: string;
  expectedRevision: number;
  sourceDigest: string;
  kind: BoardPromotionKind;
  priority: BoardPromotionPriority;
  classification: BoardPromotionClassification;
  executionBrief: string;
};

export type BoardPromotionRequest = {
  canonicalizationVersion: typeof BOARD_PROMOTION_CANONICALIZATION_VERSION;
  policyVersion: typeof BOARD_PROMOTION_POLICY_VERSION;
  items: BoardPromotionItem[];
};

export type BoardPromotionParseResult =
  | { ok: true; request: BoardPromotionRequest; requestDigest: string; rawBodyDigest: string }
  | { ok: false; code: string };

export type BoardPromotionCardFact = {
  id: string;
  revision: number;
  status: string;
  owner: string | null;
  claimedAt: Date | null;
  archivedAt: Date | null;
  sourceSystem: string | null;
  sourceDigest: string | null;
  attemptCount: number;
  deliveryCount: number;
  routeDecisionCount: number;
  dependencies: { status: string; archivedAt: Date | null }[];
};

export type BoardPromotionClassificationResult = {
  promote: BoardPromotionItem[];
  refusal: string | null;
};

const sameKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const member = (value: string, allowed: readonly string[]): boolean => allowed.includes(value);

const integerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export const boardPromotionApplyPermitted = (input: {
  envValue: string | undefined;
  codeLatch: boolean;
}): boolean => boardImportApplyPermitted(input);

export const boardPromotionExecutionBriefDigest = (brief: string): string =>
  createHash("sha256").update(brief, "utf8").digest("hex");

export const boardPromotionRequestDigest = (request: BoardPromotionRequest): string =>
  createHash("sha256")
    .update(`amux-promotion:${BOARD_PROMOTION_CANONICALIZATION_VERSION}\n${amuxCanonicalJson(request)}`, "utf8")
    .digest("hex");

export const boardPromotionItemBindingsDigest = (items: readonly BoardPromotionItem[]): string =>
  createHash("sha256")
    .update(`amux-promotion-items:${BOARD_PROMOTION_CANONICALIZATION_VERSION}\n${amuxCanonicalJson(items)}`, "utf8")
    .digest("hex");

const parseClassification = (
  value: unknown,
): { ok: true; classification: BoardPromotionClassification } | { ok: false; code: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "schema_rejected" };
  if (!sameKeys(value, CLASSIFICATION_KEYS)) return { ok: false, code: "schema_rejected" };
  const record = value as Record<string, unknown>;
  if (typeof record.task_kind !== "string" || !member(record.task_kind, BOARD_PROMOTION_TASK_KINDS)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!integerIn(record.complexity, 1, 10) || !integerIn(record.risk, 1, 3)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!integerIn(record.files_expected, 0, 1_000)) return { ok: false, code: "schema_rejected" };
  return {
    ok: true,
    classification: {
      task_kind: record.task_kind as BoardPromotionTaskKind,
      complexity: record.complexity,
      risk: record.risk,
      files_expected: record.files_expected,
    },
  };
};

const parseItem = (value: unknown): { ok: true; item: BoardPromotionItem } | { ok: false; code: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "schema_rejected" };
  if (!sameKeys(value, ITEM_KEYS)) return { ok: false, code: "schema_rejected" };
  const record = value as Record<string, unknown>;
  if (typeof record.cardId !== "string" || !CARD_ID_PATTERN.test(record.cardId)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!integerIn(record.expectedRevision, 0, 2_147_483_647)) return { ok: false, code: "schema_rejected" };
  if (typeof record.sourceDigest !== "string" || !SHA256_PATTERN.test(record.sourceDigest)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.kind !== "string" || !member(record.kind, BOARD_PROMOTION_KINDS)) {
    return { ok: false, code: record.kind === "unknown" ? "kind_not_explicit" : "schema_rejected" };
  }
  if (typeof record.priority !== "string" || !member(record.priority, BOARD_PROMOTION_PRIORITIES)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.executionBrief !== "string" || !/\S/.test(record.executionBrief)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (Buffer.byteLength(record.executionBrief, "utf8") > BOARD_PROMOTION_BRIEF_MAX_BYTES) {
    return { ok: false, code: "brief_too_large" };
  }
  const classification = parseClassification(record.classification);
  if (!classification.ok) return classification;
  return {
    ok: true,
    item: {
      cardId: record.cardId,
      expectedRevision: record.expectedRevision,
      sourceDigest: record.sourceDigest,
      kind: record.kind as BoardPromotionKind,
      priority: record.priority as BoardPromotionPriority,
      classification: classification.classification,
      executionBrief: record.executionBrief,
    },
  };
};

export const parseBoardPromotionRequest = (raw: string): BoardPromotionParseResult => {
  if (Buffer.byteLength(raw, "utf8") > BOARD_PROMOTION_RAW_BODY_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  if (raw.includes("\u0000") || raw.includes("\uFFFD")) return { ok: false, code: "content_refused" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (amuxCatalogTextRefused(parsed)) return { ok: false, code: "content_refused" };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "schema_rejected" };
  if (!sameKeys(parsed, REQUEST_KEYS)) return { ok: false, code: "schema_rejected" };
  const body = parsed as Record<string, unknown>;
  if (body.canonicalizationVersion !== BOARD_PROMOTION_CANONICALIZATION_VERSION) {
    return { ok: false, code: "schema_rejected" };
  }
  if (body.policyVersion !== BOARD_PROMOTION_POLICY_VERSION) return { ok: false, code: "schema_rejected" };
  if (!Array.isArray(body.items)) return { ok: false, code: "schema_rejected" };
  if (body.items.length < BOARD_PROMOTION_MIN_ITEMS || body.items.length > BOARD_PROMOTION_MAX_ITEMS) {
    return { ok: false, code: "batch_size" };
  }
  const items: BoardPromotionItem[] = [];
  for (const entry of body.items) {
    const item = parseItem(entry);
    if (!item.ok) return item;
    items.push(item.item);
  }
  if (new Set(items.map((item) => item.cardId)).size !== items.length) {
    return { ok: false, code: "duplicate_card" };
  }
  const request: BoardPromotionRequest = {
    canonicalizationVersion: BOARD_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: BOARD_PROMOTION_POLICY_VERSION,
    items,
  };
  return {
    ok: true,
    request,
    requestDigest: boardPromotionRequestDigest(request),
    rawBodyDigest: createHash("sha256").update(raw, "utf8").digest("hex"),
  };
};

const refusalFor = (item: BoardPromotionItem, fact: BoardPromotionCardFact | undefined): string | null => {
  if (!fact || fact.id !== item.cardId) return "card_missing";
  if (fact.archivedAt) return "archived";
  if (fact.status !== "backlog") return "not_backlog";
  if (fact.owner !== null || fact.claimedAt !== null) return "owned";
  if (fact.revision !== item.expectedRevision) return "revision_mismatch";
  if (!fact.sourceSystem || !fact.sourceDigest) return "source_absent";
  if (fact.sourceDigest !== item.sourceDigest) return "source_mismatch";
  if (fact.attemptCount !== 0) return "attempt_present";
  if (fact.deliveryCount !== 0) return "delivery_present";
  if (fact.routeDecisionCount !== 0) return "route_decision_present";
  if (fact.dependencies.some((edge) => edge.archivedAt !== null || edge.status !== "done")) {
    return "dependency_blocked";
  }
  return null;
};

export const classifyBoardPromotion = (
  request: BoardPromotionRequest,
  facts: ReadonlyMap<string, BoardPromotionCardFact>,
): BoardPromotionClassificationResult => {
  for (const item of request.items) {
    const refusal = refusalFor(item, facts.get(item.cardId));
    if (refusal) return { promote: [], refusal };
  }
  return { promote: [...request.items], refusal: null };
};

export const boardPromotionCardWrite = (item: BoardPromotionItem) => ({
  where: {
    id: item.cardId,
    revision: item.expectedRevision,
    status: "backlog" as const,
    owner: null,
    claimedAt: null,
    archivedAt: null,
    sourceDigest: item.sourceDigest,
  },
  data: {
    status: "todo" as const,
    kind: item.kind,
    priority: item.priority,
    classification: item.classification,
    executionBrief: item.executionBrief,
    executionBriefDigest: boardPromotionExecutionBriefDigest(item.executionBrief),
    revision: item.expectedRevision + 1,
  },
});

export const parseBoardPromotionItems = (value: unknown): BoardPromotionItem[] | null => {
  if (amuxCatalogTextRefused(value)) return null;
  if (!Array.isArray(value)) return null;
  const items: BoardPromotionItem[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (!item.ok) return null;
    items.push(item.item);
  }
  if (items.length < BOARD_PROMOTION_MIN_ITEMS || items.length > BOARD_PROMOTION_MAX_ITEMS) return null;
  if (new Set(items.map((item) => item.cardId)).size !== items.length) return null;
  return items;
};
