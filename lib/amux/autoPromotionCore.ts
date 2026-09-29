import { createHash } from "node:crypto";

import {
  AMUX_MANIFEST_CANONICALIZATION_VERSION,
  amuxCanonicalJson,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
} from "./boardImportCore.ts";
import { AMUX_AUTO_PROMOTER_AUDIT_ACTOR } from "../adminAuditSystemActors.ts";
import {
  type BoardPromotionItem,
  BOARD_PROMOTION_CANONICALIZATION_VERSION,
  BOARD_PROMOTION_POLICY_VERSION,
  boardPromotionItemBindingsDigest,
  parseBoardPromotionItems,
  parseBoardPromotionRequest,
} from "./boardPromotionCore.ts";

/**
 * Gate for one pre-approved card.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy
 * version 15, "자동 승격 개정"). Version 9 ships the code latch true. Apply
 * still needs the env value exactly `enabled`.
 *
 * Version 15 binds the promotion item and a cent amount to the grant, lets the
 * system actor consume a bound grant from the internal tick, writes one cost
 * row per consumption, and adds the owner's resume writer. A grant request is
 * policy version 15. A consume request is version 15 (item and amount come
 * from the grant) or the version 8 shape, which the human route still takes.
 *
 * Parsing and the numeric checks are pure. Nothing here reads an execution
 * switch, starts a worker, or spends credits.
 */

export const AUTO_PROMOTION_POLICY_VERSION = 15;
/** The version 8 consume shape. The human route keeps accepting it. */
export const AUTO_PROMOTION_V8_CONSUME_POLICY_VERSION = 8;
export const AUTO_PROMOTION_CANONICALIZATION_VERSION = AMUX_MANIFEST_CANONICALIZATION_VERSION;
export const AUTO_PROMOTION_APPLY_ENV = "TOMVERSE_AMUX_BOARD_AUTO_PROMOTE";
export const AUTO_PROMOTION_CODE_LATCH = true;
/** Bound grants carry 1..500 cents. The cost ledger itself allows 0..500. */
export const AUTO_GRANT_AMOUNT_MIN_CENTS = 1;
/** Due grants expired by one call. */
export const AUTO_EXPIRE_BATCH = 50;
/**
 * What an actor column holds when the system actor wrote the row. The columns
 * have no User foreign key, and the linked audit row carries the listed actor
 * in `metadata.systemActor`, so this is a marker and not an account id.
 */
export const AUTO_SYSTEM_ACTOR_ROW_ID = `system:${AMUX_AUTO_PROMOTER_AUDIT_ACTOR}`;
export const AUTO_GRADUATION_DECISIONS = 20;
export const AUTO_GRADUATION_SPAN_MS = 14 * 24 * 60 * 60 * 1000;
export const AUTO_COST_EVENT_CENTS = 500;
export const AUTO_COST_24H_CENTS = 1_500;
export const AUTO_COST_30D_CENTS = 10_000;
export const AUTO_COST_24H_MS = 24 * 60 * 60 * 1000;
export const AUTO_COST_30D_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTO_GLOBAL_ACTIVE_CAP = 3;
export const AUTO_PER_WORKER_CAP = 1;
export const AUTO_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTO_UNKNOWN_BURST_COUNT = 2;
export const AUTO_UNKNOWN_BURST_MS = 15 * 60 * 1000;

export const AUTO_GRANT_STATUSES = ["active", "consumed", "expired"] as const;
export const AUTO_CONSUMPTION_STATUSES = ["consumed", "outcome_unknown"] as const;
export const AUTO_HALT_REASONS = ["critical_violation", "outcome_unknown_burst"] as const;
export const AUTO_CRITICAL_CODES = [
  "cost_exceeded",
  "worker_cap_exceeded",
  "global_wip_exceeded",
  "unapproved_todo",
  "lifecycle_write",
] as const;
export const AUTO_AUDIT_KEYS = [
  "grantId",
  "consumptionId",
  "snapshotId",
  "digest",
  "amountCents",
  "rowCount",
  "violationCode",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AutoHumanDecision = { createdAt: Date };
export type AutoCostEntry = { amountCents: number; recordedAt: Date };
export type AutoCriticalCode = (typeof AUTO_CRITICAL_CODES)[number];

export type AutoGrantRequest = {
  canonicalizationVersion: typeof AUTO_PROMOTION_CANONICALIZATION_VERSION;
  policyVersion: typeof AUTO_PROMOTION_POLICY_VERSION;
  grantId: string;
  cardId: string;
  amountCents: number;
  item: BoardPromotionItem;
};

/** Version 8 shape: the request repeats the item and the amount. */
export type AutoConsumeRequest = {
  canonicalizationVersion: typeof AUTO_PROMOTION_CANONICALIZATION_VERSION;
  policyVersion: typeof AUTO_PROMOTION_V8_CONSUME_POLICY_VERSION;
  grantId: string;
  consumptionId: string;
  snapshotId: string;
  workerId: null;
  amountCents: number;
  item: BoardPromotionItem;
};

/** Version 15 shape: the item and the amount are the ones the grant bound. */
export type AutoBoundConsumeRequest = {
  canonicalizationVersion: typeof AUTO_PROMOTION_CANONICALIZATION_VERSION;
  policyVersion: typeof AUTO_PROMOTION_POLICY_VERSION;
  grantId: string;
  consumptionId: string;
  snapshotId: string;
  workerId: null;
};

export type AutoResumeRequest = {
  canonicalizationVersion: typeof AUTO_PROMOTION_CANONICALIZATION_VERSION;
  policyVersion: typeof AUTO_PROMOTION_POLICY_VERSION;
  haltId: string;
};

/** What a grant row stores about its binding. All three are null on a legacy row. */
export type AutoGrantBinding = {
  workItemId: string;
  itemBindings: unknown;
  itemBindingsDigest: string | null;
  amountCents: number | null;
};

const sameKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const scrub = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "grantId" || key === "consumptionId" || key === "snapshotId" || key === "haltId") &&
      typeof child === "string" &&
      UUID_PATTERN.test(child)
    ) {
      copy[key] = "identifier";
    } else {
      copy[key] = scrub(child);
    }
  }
  return copy;
};

const parseObject = (raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; code: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (amuxCatalogTextRefused(scrub(parsed))) return { ok: false, code: "content_refused" };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "schema_rejected" };
  return { ok: true, value: parsed as Record<string, unknown> };
};

const headerOk = (
  value: Record<string, unknown>,
  policyVersion: number = AUTO_PROMOTION_POLICY_VERSION,
): boolean =>
  value.canonicalizationVersion === AUTO_PROMOTION_CANONICALIZATION_VERSION &&
  value.policyVersion === policyVersion;

const uuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);

/**
 * One promotion item through the version 3 item parser, so the grant, the
 * version 8 consume and the manual pilot refuse the same things: `unknown`
 * kind, a brief over 8 KiB, and anything the catalog scanner refuses.
 */
const parseOnePromotionItem = (value: unknown): { ok: true; item: BoardPromotionItem } | { ok: false; code: string } => {
  const item = parseBoardPromotionRequest(JSON.stringify({
    canonicalizationVersion: BOARD_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: BOARD_PROMOTION_POLICY_VERSION,
    items: [value],
  }));
  if (!item.ok) return item;
  if (item.request.items.length !== 1) return { ok: false, code: "one_card" };
  return { ok: true, item: item.request.items[0] };
};

const amountIn = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= AUTO_COST_EVENT_CENTS;

const digestOf = (value: unknown): string =>
  createHash("sha256").update(amuxCanonicalJson(value), "utf8").digest("hex");

export const autoPromotionApplyPermitted = (input: {
  envValue: string | undefined;
  codeLatch: boolean;
}): boolean => boardImportApplyPermitted(input);

export const autoGraduationAccepted = (
  decisions: readonly AutoHumanDecision[],
): { ok: true; count: number; spanMs: number } | { ok: false; code: "graduation_unmet"; count: number; spanMs: number } => {
  const times = decisions.map((row) => row.createdAt.getTime()).filter((time) => !Number.isNaN(time));
  const count = times.length;
  if (count === 0) return { ok: false, code: "graduation_unmet", count, spanMs: 0 };
  const spanMs = Math.max(...times) - Math.min(...times);
  if (count < AUTO_GRADUATION_DECISIONS || spanMs < AUTO_GRADUATION_SPAN_MS) {
    return { ok: false, code: "graduation_unmet", count, spanMs };
  }
  return { ok: true, count, spanMs };
};

const windowSum = (entries: readonly AutoCostEntry[], now: Date, windowMs: number): number => {
  const start = now.getTime() - windowMs;
  return entries.reduce((sum, entry) => {
    const time = entry.recordedAt.getTime();
    if (time < start || time > now.getTime()) return sum;
    return sum + entry.amountCents;
  }, 0);
};

export const autoCostAccepted = (input: {
  proposedCents: number;
  entries: readonly AutoCostEntry[];
  now: Date;
}): { ok: true } | { ok: false; code: "cost_exceeded" } => {
  if (!Number.isInteger(input.proposedCents) || input.proposedCents < 0 || input.proposedCents > AUTO_COST_EVENT_CENTS) {
    return { ok: false, code: "cost_exceeded" };
  }
  if (windowSum(input.entries, input.now, AUTO_COST_24H_MS) + input.proposedCents > AUTO_COST_24H_CENTS) {
    return { ok: false, code: "cost_exceeded" };
  }
  if (windowSum(input.entries, input.now, AUTO_COST_30D_MS) + input.proposedCents > AUTO_COST_30D_CENTS) {
    return { ok: false, code: "cost_exceeded" };
  }
  return { ok: true };
};

export const autoWorkerAdmitted = (
  workerId: string | null,
): { ok: true } | { ok: false; code: "worker_not_admitted" } =>
  workerId === null ? { ok: true } : { ok: false, code: "worker_not_admitted" };

export const autoGlobalWipAccepted = (
  activeCount: number,
): { ok: true } | { ok: false; code: "auto_wip_full" } =>
  activeCount >= AUTO_GLOBAL_ACTIVE_CAP ? { ok: false, code: "auto_wip_full" } : { ok: true };

export const autoGrantExpiresAt = (grantedAt: Date): Date => new Date(grantedAt.getTime() + AUTO_GRANT_TTL_MS);

export const autoGrantUsable = (input: {
  status: string;
  expiresAt: Date;
  now: Date;
}): { ok: true } | { ok: false; code: "grant_missing" } =>
  input.status === "active" && input.expiresAt.getTime() > input.now.getTime()
    ? { ok: true }
    : { ok: false, code: "grant_missing" };

export const autoHaltRequired = (input: {
  criticalCodes: readonly AutoCriticalCode[];
  unknownAt: readonly Date[];
  now: Date;
}): { halt: false } | { halt: true; reason: (typeof AUTO_HALT_REASONS)[number]; violationCode: AutoCriticalCode | null } => {
  const critical = input.criticalCodes[0];
  if (critical) return { halt: true, reason: "critical_violation", violationCode: critical };
  const start = input.now.getTime() - AUTO_UNKNOWN_BURST_MS;
  const recent = input.unknownAt.filter((value) => {
    const time = value.getTime();
    return time >= start && time <= input.now.getTime();
  });
  if (recent.length >= AUTO_UNKNOWN_BURST_COUNT) {
    return { halt: true, reason: "outcome_unknown_burst", violationCode: null };
  }
  return { halt: false };
};

export const autoReadbackCritical = (input: {
  activeCount: number;
  ownerCounts: readonly number[];
  costCents24h: number;
  costCents30d: number;
  unapprovedTodo: number;
  lifecycleWrites: number;
}): AutoCriticalCode[] => {
  const codes: AutoCriticalCode[] = [];
  if (input.costCents24h > AUTO_COST_24H_CENTS || input.costCents30d > AUTO_COST_30D_CENTS) codes.push("cost_exceeded");
  if (input.activeCount > AUTO_GLOBAL_ACTIVE_CAP) codes.push("global_wip_exceeded");
  if (input.ownerCounts.some((count) => count > AUTO_PER_WORKER_CAP)) codes.push("worker_cap_exceeded");
  if (input.unapprovedTodo > 0) codes.push("unapproved_todo");
  if (input.lifecycleWrites > 0) codes.push("lifecycle_write");
  return codes;
};

export const autoAuditMetadata = (
  input: Partial<Record<(typeof AUTO_AUDIT_KEYS)[number], string | number | null>>,
): Record<string, string | number | null> => {
  const metadata: Record<string, string | number | null> = {};
  for (const key of AUTO_AUDIT_KEYS) {
    if (input[key] !== undefined) metadata[key] = input[key] ?? null;
  }
  return metadata;
};

/**
 * Version 15 grant. The grant binds the whole promotion item and a cent
 * amount; `cardId` stays in the shape and has to name the item's card.
 */
export const parseAutoGrantRequest = (
  raw: string,
):
  | { ok: true; request: AutoGrantRequest; requestDigest: string; itemBindingsDigest: string }
  | { ok: false; code: string } => {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  if (Array.isArray(parsed.value.items)) return { ok: false, code: "one_card" };
  if (!sameKeys(parsed.value, ["canonicalizationVersion", "policyVersion", "grantId", "cardId", "amountCents", "item"])) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!headerOk(parsed.value)) return { ok: false, code: "schema_rejected" };
  if (!uuid(parsed.value.grantId)) return { ok: false, code: "schema_rejected" };
  if (typeof parsed.value.cardId !== "string") return { ok: false, code: "schema_rejected" };
  if (!amountIn(parsed.value.amountCents, AUTO_GRANT_AMOUNT_MIN_CENTS)) return { ok: false, code: "schema_rejected" };
  const item = parseOnePromotionItem(parsed.value.item);
  if (!item.ok) return item;
  if (item.item.cardId !== parsed.value.cardId) return { ok: false, code: "schema_rejected" };
  const request: AutoGrantRequest = {
    canonicalizationVersion: AUTO_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: AUTO_PROMOTION_POLICY_VERSION,
    grantId: parsed.value.grantId,
    cardId: item.item.cardId,
    amountCents: parsed.value.amountCents,
    item: item.item,
  };
  return {
    ok: true,
    request,
    requestDigest: digestOf(request),
    itemBindingsDigest: boardPromotionItemBindingsDigest([item.item]),
  };
};

const CONSUME_ID_KEYS = ["canonicalizationVersion", "policyVersion", "grantId", "consumptionId", "snapshotId", "workerId"];

/**
 * A consume request for the human route. Version 15 names the grant and takes
 * the item and amount the grant bound. Version 8 repeats them; on a bound
 * grant they have to be the bound ones, which the service checks.
 */
export const parseAutoConsumeRequest = (
  raw: string,
):
  | { ok: true; request: AutoConsumeRequest | AutoBoundConsumeRequest; requestDigest: string }
  | { ok: false; code: string } => {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  if (Array.isArray(parsed.value.items) && parsed.value.items.length !== 1) return { ok: false, code: "one_card" };
  const v8 = parsed.value.policyVersion === AUTO_PROMOTION_V8_CONSUME_POLICY_VERSION;
  const keys = v8 ? [...CONSUME_ID_KEYS, "amountCents", "item"] : CONSUME_ID_KEYS;
  if (!sameKeys(parsed.value, keys)) return { ok: false, code: "schema_rejected" };
  if (!headerOk(parsed.value, v8 ? AUTO_PROMOTION_V8_CONSUME_POLICY_VERSION : AUTO_PROMOTION_POLICY_VERSION)) {
    return { ok: false, code: "schema_rejected" };
  }
  const { grantId, consumptionId, snapshotId } = parsed.value;
  if (!uuid(grantId) || !uuid(consumptionId) || !uuid(snapshotId)) return { ok: false, code: "schema_rejected" };
  if (parsed.value.workerId !== null) return { ok: false, code: "worker_not_admitted" };
  if (!v8) {
    const request: AutoBoundConsumeRequest = {
      canonicalizationVersion: AUTO_PROMOTION_CANONICALIZATION_VERSION,
      policyVersion: AUTO_PROMOTION_POLICY_VERSION,
      grantId,
      consumptionId,
      snapshotId,
      workerId: null,
    };
    return { ok: true, request, requestDigest: digestOf(request) };
  }
  if (!Number.isInteger(parsed.value.amountCents)) return { ok: false, code: "schema_rejected" };
  const item = parseOnePromotionItem(parsed.value.item);
  if (!item.ok) return item;
  const request: AutoConsumeRequest = {
    canonicalizationVersion: AUTO_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: AUTO_PROMOTION_V8_CONSUME_POLICY_VERSION,
    grantId,
    consumptionId,
    snapshotId,
    workerId: null,
    amountCents: parsed.value.amountCents as number,
    item: item.item,
  };
  return { ok: true, request, requestDigest: digestOf(request) };
};

export const autoConsumeRequestIsBound = (
  request: AutoConsumeRequest | AutoBoundConsumeRequest,
): request is AutoBoundConsumeRequest => request.policyVersion === AUTO_PROMOTION_POLICY_VERSION;

/** The owner's resume request names one halt and nothing else. */
export const parseAutoResumeRequest = (
  raw: string,
): { ok: true; request: AutoResumeRequest; requestDigest: string } | { ok: false; code: string } => {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  if (!sameKeys(parsed.value, ["canonicalizationVersion", "policyVersion", "haltId"])) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!headerOk(parsed.value)) return { ok: false, code: "schema_rejected" };
  if (!uuid(parsed.value.haltId)) return { ok: false, code: "schema_rejected" };
  const request: AutoResumeRequest = {
    canonicalizationVersion: AUTO_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: AUTO_PROMOTION_POLICY_VERSION,
    haltId: parsed.value.haltId,
  };
  return { ok: true, request, requestDigest: digestOf(request) };
};

/**
 * The item a bound grant stored, read back fail-closed. The stored JSON goes
 * through the same item parser as a request, has to be exactly one item for
 * the grant's own card, and has to reproduce the stored digest.
 */
export const autoBoundItem = (
  binding: AutoGrantBinding,
):
  | { ok: true; item: BoardPromotionItem; amountCents: number; itemBindingsDigest: string }
  | { ok: false; code: "grant_unbound" | "grant_binding_invalid" } => {
  const empty =
    (binding.itemBindings === null || binding.itemBindings === undefined) &&
    binding.itemBindingsDigest === null &&
    binding.amountCents === null;
  if (empty) return { ok: false, code: "grant_unbound" };
  const items = parseBoardPromotionItems(binding.itemBindings);
  if (!items || items.length !== 1) return { ok: false, code: "grant_binding_invalid" };
  if (binding.itemBindingsDigest === null || boardPromotionItemBindingsDigest(items) !== binding.itemBindingsDigest) {
    return { ok: false, code: "grant_binding_invalid" };
  }
  if (items[0].cardId !== binding.workItemId) return { ok: false, code: "grant_binding_invalid" };
  if (!amountIn(binding.amountCents, AUTO_GRANT_AMOUNT_MIN_CENTS)) return { ok: false, code: "grant_binding_invalid" };
  return { ok: true, item: items[0], amountCents: binding.amountCents, itemBindingsDigest: binding.itemBindingsDigest };
};

/**
 * Whether this consume may use this grant's binding. The system path and a
 * version 15 request need a bound grant. A version 8 request may still use a
 * legacy grant; on a bound grant its item and amount must be the bound ones.
 */
export const autoConsumeBindingAccepted = (input: {
  binding: AutoGrantBinding;
  item: BoardPromotionItem;
  amountCents: number;
  requireBound: boolean;
}):
  | { ok: true; bound: boolean }
  | { ok: false; code: "grant_unbound" | "grant_binding_invalid" | "grant_item_mismatch" | "grant_amount_mismatch" } => {
  const bound = autoBoundItem(input.binding);
  if (!bound.ok) {
    if (bound.code === "grant_unbound" && !input.requireBound) return { ok: true, bound: false };
    return bound;
  }
  if (boardPromotionItemBindingsDigest([input.item]) !== bound.itemBindingsDigest) {
    return { ok: false, code: "grant_item_mismatch" };
  }
  if (input.amountCents !== bound.amountCents) return { ok: false, code: "grant_amount_mismatch" };
  return { ok: true, bound: true };
};

/** The request digest a system consumption stores. No free text goes in. */
export const autoSystemConsumeDigest = (input: {
  grantId: string;
  consumptionId: string;
  snapshotId: string;
  itemBindingsDigest: string;
  amountCents: number;
}): string =>
  digestOf({
    actor: AMUX_AUTO_PROMOTER_AUDIT_ACTOR,
    canonicalizationVersion: AUTO_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: AUTO_PROMOTION_POLICY_VERSION,
    ...input,
  });

/**
 * Lost consume outcomes, one per attempted consumption id. A consumption row
 * flagged by read-back and the read-back row for the same id are one event,
 * not two: counting both would let one lost outcome open a halt alone.
 */
export const autoUnknownEvents = (input: {
  consumptions: readonly { id: string; outcomeUnknownAt: Date | null }[];
  unknowns: readonly { id: string; recordedAt: Date }[];
}): Date[] => {
  const events = new Map<string, Date>();
  for (const row of input.unknowns) events.set(row.id, row.recordedAt);
  for (const row of input.consumptions) {
    if (row.outcomeUnknownAt && !events.has(row.id)) events.set(row.id, row.outcomeUnknownAt);
  }
  return [...events.values()];
};

/**
 * HTTP status of the internal tick for its `reason`. A deterministic refusal
 * is a finished tick (200). The gate (`apply_disabled`) and a lost outcome
 * (`outcome_unknown` for the consume, `expiry_outcome_unknown` for the expiry
 * step) are 409; a missing audit key is 503; an unbound audit or an
 * unexpected failure is 500.
 */
/** Grants one tick may try before it stops; still at most one card moves. */
export const AUTO_TICK_GRANT_ATTEMPTS = 10;

/**
 * Refusals that belong to the picked grant's own card, so the tick tries the
 * next grant instead of refusing every tick until this grant expires. A
 * refusal about the whole path (halt, graduation, missing capacity row, the
 * global automatic cap, incident, audit keys) ends the tick. `capacity_full`
 * and `cost_exceeded` are per card here: the first comes from this card's
 * place in the ranking cut, the second from this grant's bound amount, and a
 * later grant can still pass; if the queue is truly full every candidate is
 * refused and the tick ends at the attempt bound.
 */
const AUTO_TICK_CARD_SPECIFIC_REFUSALS = new Set([
  "not_backlog",
  "conflict",
  "dependency_open",
  "not_included",
  "lifecycle_present",
  "brief_digest_changed",
  "review_waiting",
  "grant_binding_invalid",
  "grant_missing",
  "capacity_full",
  "cost_exceeded",
]);

export const autoTickCardSpecificRefusal = (code: string): boolean =>
  AUTO_TICK_CARD_SPECIFIC_REFUSALS.has(code);

export const autoTickHttpStatus = (reason: string | null | undefined): number => {
  if (!reason) return 200;
  if (reason === "apply_disabled" || reason === "outcome_unknown" || reason === "expiry_outcome_unknown") {
    return 409;
  }
  if (reason === "audit_key_missing") return 503;
  if (reason === "audit_unbound" || reason === "auto_promotion_failed") return 500;
  return 200;
};

/**
 * Where an auto-promotion transaction was when it failed. `starting`: the
 * callback had not run yet (pool wait, BEGIN). `running`: inside the callback,
 * before it returned. `committing`: the callback had returned, so the COMMIT
 * was sent or about to be.
 */
export type AutoTransactionPhase = "starting" | "running" | "committing";

/**
 * What a failed auto-promotion transaction means for the rows it would have
 * written.
 *
 * - `outcome_unknown`: the COMMIT may or may not have taken effect. Only a
 *   failure after the callback returned is this; it is read back and never
 *   retried, and it counts toward the halt rule.
 * - `conflict`: a unique key refused a row. Nothing committed.
 * - `deadline_exceeded`: a statement, transaction or pool deadline ran out
 *   before COMMIT was sent. Nothing committed.
 * - `rolled_back`: any other failure before COMMIT was sent, a lost connection
 *   included. Nothing committed.
 *
 * A client never sends COMMIT for a transaction whose callback threw, and
 * PostgreSQL does not commit a transaction it never received a COMMIT for, so
 * every failure before `committing` is a known one. A statement timeout
 * (SQLSTATE 57014) inside the callback is the case this exists for: it rolls
 * the transaction back, and calling it unknown refused the grant for good and
 * could open a halt.
 */
export type AutoTransactionFailure = "outcome_unknown" | "conflict" | "deadline_exceeded" | "rolled_back";

const PRISMA_TIMEOUT_CODES = new Set([
  // Timed out fetching a connection from the pool.
  "P2024",
  // Transaction API error: could not start in `maxWait`, or the interactive
  // transaction's own timeout closed it.
  "P2028",
]);

const errorField = (error: unknown, key: string): unknown =>
  error && typeof error === "object" && key in error ? (error as Record<string, unknown>)[key] : undefined;

/** SQLSTATE 57014, wherever Prisma put it: the raw-query `meta.code`, or the text of a model query's error. */
export const autoTransactionStatementCancelled = (error: unknown): boolean => {
  const meta = errorField(error, "meta");
  if (errorField(meta, "code") === "57014" || errorField(error, "code") === "57014") return true;
  const texts = [errorField(meta, "database_error"), errorField(meta, "message"), errorField(error, "message")];
  return texts.some(
    (text) =>
      typeof text === "string" &&
      (/\b57014\b/.test(text) || /canceling statement due to statement timeout/i.test(text)),
  );
};

export const autoTransactionFailure = (phase: AutoTransactionPhase, error: unknown): AutoTransactionFailure => {
  if (phase === "committing") return "outcome_unknown";
  const code = errorField(error, "code");
  if (code === "P2002") return "conflict";
  if (autoTransactionStatementCancelled(error) || (typeof code === "string" && PRISMA_TIMEOUT_CODES.has(code))) {
    return "deadline_exceeded";
  }
  return "rolled_back";
};
