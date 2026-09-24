import { createHash } from "node:crypto";

import {
  AMUX_MANIFEST_CANONICALIZATION_VERSION,
  amuxCanonicalJson,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
} from "./boardImportCore.ts";
import {
  type BoardPromotionItem,
  BOARD_PROMOTION_CANONICALIZATION_VERSION,
  BOARD_PROMOTION_POLICY_VERSION,
  parseBoardPromotionRequest,
} from "./boardPromotionCore.ts";

/**
 * Closed gate for one pre-approved card.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy version 8).
 *
 * The shipped code latch is false. Parsing and the numeric checks are pure.
 * Nothing here reads an execution switch, starts a worker, or spends credits.
 */

export const AUTO_PROMOTION_POLICY_VERSION = 8;
export const AUTO_PROMOTION_CANONICALIZATION_VERSION = AMUX_MANIFEST_CANONICALIZATION_VERSION;
export const AUTO_PROMOTION_APPLY_ENV = "TOMVERSE_AMUX_BOARD_AUTO_PROMOTE";
export const AUTO_PROMOTION_CODE_LATCH = false;
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
};

export type AutoConsumeRequest = {
  canonicalizationVersion: typeof AUTO_PROMOTION_CANONICALIZATION_VERSION;
  policyVersion: typeof AUTO_PROMOTION_POLICY_VERSION;
  grantId: string;
  consumptionId: string;
  snapshotId: string;
  workerId: null;
  amountCents: number;
  item: BoardPromotionItem;
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
      (key === "grantId" || key === "consumptionId" || key === "snapshotId") &&
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

const headerOk = (value: Record<string, unknown>): boolean =>
  value.canonicalizationVersion === AUTO_PROMOTION_CANONICALIZATION_VERSION &&
  value.policyVersion === AUTO_PROMOTION_POLICY_VERSION;

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

export const parseAutoGrantRequest = (
  raw: string,
): { ok: true; request: AutoGrantRequest; requestDigest: string } | { ok: false; code: string } => {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  if (!sameKeys(parsed.value, ["canonicalizationVersion", "policyVersion", "grantId", "cardId"])) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!headerOk(parsed.value)) return { ok: false, code: "schema_rejected" };
  if (typeof parsed.value.grantId !== "string" || !UUID_PATTERN.test(parsed.value.grantId)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof parsed.value.cardId !== "string" || parsed.value.cardId.length < 1 || parsed.value.cardId.length > 64) {
    return { ok: false, code: "schema_rejected" };
  }
  const request: AutoGrantRequest = {
    canonicalizationVersion: AUTO_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: AUTO_PROMOTION_POLICY_VERSION,
    grantId: parsed.value.grantId,
    cardId: parsed.value.cardId,
  };
  return { ok: true, request, requestDigest: digestOf(request) };
};

export const parseAutoConsumeRequest = (
  raw: string,
): { ok: true; request: AutoConsumeRequest; requestDigest: string } | { ok: false; code: string } => {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  if (Array.isArray(parsed.value.items) && parsed.value.items.length !== 1) return { ok: false, code: "one_card" };
  if (!sameKeys(parsed.value, [
    "canonicalizationVersion",
    "policyVersion",
    "grantId",
    "consumptionId",
    "snapshotId",
    "workerId",
    "amountCents",
    "item",
  ])) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!headerOk(parsed.value)) return { ok: false, code: "schema_rejected" };
  if (typeof parsed.value.grantId !== "string" || !UUID_PATTERN.test(parsed.value.grantId)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof parsed.value.consumptionId !== "string" || !UUID_PATTERN.test(parsed.value.consumptionId)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof parsed.value.snapshotId !== "string" || !UUID_PATTERN.test(parsed.value.snapshotId)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (parsed.value.workerId !== null) return { ok: false, code: "worker_not_admitted" };
  if (!Number.isInteger(parsed.value.amountCents)) return { ok: false, code: "schema_rejected" };
  const itemRaw = JSON.stringify({
    canonicalizationVersion: BOARD_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: BOARD_PROMOTION_POLICY_VERSION,
    items: [parsed.value.item],
  });
  const item = parseBoardPromotionRequest(itemRaw);
  if (!item.ok) return item;
  if (item.request.items.length !== 1) return { ok: false, code: "one_card" };
  const request: AutoConsumeRequest = {
    canonicalizationVersion: AUTO_PROMOTION_CANONICALIZATION_VERSION,
    policyVersion: AUTO_PROMOTION_POLICY_VERSION,
    grantId: parsed.value.grantId,
    consumptionId: parsed.value.consumptionId,
    snapshotId: parsed.value.snapshotId,
    workerId: null,
    amountCents: parsed.value.amountCents as number,
    item: item.request.items[0],
  };
  return { ok: true, request, requestDigest: digestOf(request) };
};
