import { createHash } from "node:crypto";

import {
  AMUX_MANIFEST_CANONICALIZATION_VERSION,
  BOARD_IMPORT_EXPIRY_MS,
  amuxCanonicalJson,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
} from "./boardImportCore.ts";
import {
  type BoardPromotionItem,
  boardPromotionExecutionBriefDigest,
  parseBoardPromotionRequest,
} from "./boardPromotionCore.ts";
import { AMUX_GLOBAL_PRIORITY_VERSION } from "./planningCore.ts";
import { scoreAmuxScheduler } from "./schedulerScoreCore.ts";

/**
 * Recommendation pool for one human decision on one backlog card.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy version 7).
 *
 * Parsing and selection are pure. This module does not open a transaction or
 * write a card. The shipped code latch is false. Nothing here starts a worker
 * or spends credits.
 */

export const RECOMMENDATION_POLICY_VERSION = 7;
export const RECOMMENDATION_CANONICALIZATION_VERSION = AMUX_MANIFEST_CANONICALIZATION_VERSION;
export const RECOMMENDATION_SCORING_VERSION = AMUX_GLOBAL_PRIORITY_VERSION;
export const RECOMMENDATION_APPLY_ENV = "TOMVERSE_AMUX_BOARD_RECOMMEND";
export const RECOMMENDATION_CODE_LATCH = false;
export const RECOMMENDATION_LOCK_NAME = "tomverse-amux-recommendation:queue";
export const RECOMMENDATION_SNAPSHOT_BACKSTOP = 10_000;
export const RECOMMENDATION_REVIEW_AFTER_MAX_MS = 366 * 24 * 60 * 60 * 1000;
export const RECOMMENDATION_EXPIRY_MS = BOARD_IMPORT_EXPIRY_MS;
export const RECOMMENDATION_CAPACITY_ID = "queue";
export const RECOMMENDATION_CAPACITY_IDS = ["queue"] as const;

export const RECOMMENDATION_SNAPSHOT_STATUSES = ["prepared", "outcome_unknown"] as const;
export const RECOMMENDATION_DECISIONS = ["approve", "hold", "reject", "expired"] as const;
export const RECOMMENDATION_DECISION_STATUSES = [
  "consumed",
  "held",
  "rejected",
  "expired",
  "outcome_unknown",
] as const;
export const RECOMMENDATION_REASON_CODES = [
  "capacity",
  "dependency",
  "cost",
  "risk",
  "scope",
  "not_now",
] as const;
export const RECOMMENDATION_EXCLUSION_CODES = [
  "not_backlog",
  "owner_set",
  "claimed",
  "archived",
  "lifecycle_present",
  "dependency_open",
  "source_unbound",
  "brief_digest_changed",
  "incident_blocked",
  "capacity_unconfigured",
  "capacity_full",
  "review_waiting",
] as const;
export const RECOMMENDATION_DISPOSITIONS = ["included", "excluded"] as const;
export const RECOMMENDATION_CLOSED_CAPACITIES = ["closed"] as const;
export const RECOMMENDATION_AUDIT_KEYS = [
  "decisionId",
  "snapshotId",
  "digest",
  "rowCount",
  "includedCount",
  "reasonCode",
  "reviewAfter",
  "occupied",
  "wipLimit",
] as const;

const PREPARE_KEYS = ["canonicalizationVersion", "policyVersion"] as const;
const APPROVE_KEYS = [
  "canonicalizationVersion",
  "decision",
  "decisionId",
  "item",
  "policyVersion",
  "snapshotId",
] as const;
const HOLD_KEYS = [
  "canonicalizationVersion",
  "cardId",
  "decision",
  "decisionId",
  "policyVersion",
  "reasonCode",
  "reviewAfter",
  "snapshotId",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_ID_PATTERN = /^c[a-z0-9]{24}$/;

export type RecommendationExclusionCode = (typeof RECOMMENDATION_EXCLUSION_CODES)[number];
export type RecommendationReasonCode = (typeof RECOMMENDATION_REASON_CODES)[number];
export type RecommendationDecisionName = (typeof RECOMMENDATION_DECISIONS)[number];

export type RecommendationCardFact = {
  id: string;
  revision: number;
  status: string;
  owner: string | null;
  claimedAt: Date | null;
  archivedAt: Date | null;
  sourceDigest: string | null;
  executionBriefDigest: string | null;
  kind: string;
  priority: string;
  pinned: boolean;
  drag: number;
  createdAt: Date;
  attemptCount: number;
  deliveryCount: number;
  routeDecisionCount: number;
  dependentCount: number;
  dependencies: { status: string; archivedAt: Date | null }[];
  reviewAfter: Date | null;
};

export type RecommendationCapacityFact = {
  active: boolean;
  wipLimit: number | null;
} | null;

export type RecommendationRow = {
  cardId: string;
  expectedRevision: number;
  sourceDigest: string | null;
  executionBriefDigest: string | null;
  scoreTotal: number;
  disposition: (typeof RECOMMENDATION_DISPOSITIONS)[number];
  exclusionCode: RecommendationExclusionCode | null;
};

export type RecommendationSelection = {
  configured: boolean;
  wipLimit: number | null;
  occupied: number;
  remaining: number;
  rows: RecommendationRow[];
  includedCount: number;
};

export type RecommendationPrepareRequest = {
  canonicalizationVersion: typeof RECOMMENDATION_CANONICALIZATION_VERSION;
  policyVersion: typeof RECOMMENDATION_POLICY_VERSION;
};

export type RecommendationApproveRequest = {
  canonicalizationVersion: typeof RECOMMENDATION_CANONICALIZATION_VERSION;
  policyVersion: typeof RECOMMENDATION_POLICY_VERSION;
  snapshotId: string;
  decisionId: string;
  decision: "approve";
  item: BoardPromotionItem;
};

export type RecommendationHoldRequest = {
  canonicalizationVersion: typeof RECOMMENDATION_CANONICALIZATION_VERSION;
  policyVersion: typeof RECOMMENDATION_POLICY_VERSION;
  snapshotId: string;
  decisionId: string;
  decision: "hold" | "reject";
  cardId: string;
  reasonCode: RecommendationReasonCode;
  reviewAfter: string;
};

export type RecommendationDecisionRequest = RecommendationApproveRequest | RecommendationHoldRequest;

const sameKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const member = <T extends string>(value: string, allowed: readonly T[]): value is T =>
  (allowed as readonly string[]).includes(value);

export const recommendationApplyPermitted = (input: {
  envValue: string | undefined;
  codeLatch: boolean;
}): boolean => boardImportApplyPermitted(input);

export const recommendationRemaining = (
  capacity: RecommendationCapacityFact,
  occupied: number,
): { configured: boolean; wipLimit: number | null; remaining: number } => {
  const safeOccupied = Math.max(0, Math.trunc(occupied));
  if (!capacity || !capacity.active || capacity.wipLimit === null) {
    return { configured: false, wipLimit: null, remaining: 0 };
  }
  return {
    configured: true,
    wipLimit: capacity.wipLimit,
    remaining: Math.max(0, capacity.wipLimit - safeOccupied),
  };
};

const structuralExclusion = (card: RecommendationCardFact): RecommendationExclusionCode | null => {
  if (card.status !== "backlog") return "not_backlog";
  if (card.owner !== null) return "owner_set";
  if (card.claimedAt !== null) return "claimed";
  if (card.archivedAt !== null) return "archived";
  if (card.attemptCount !== 0 || card.deliveryCount !== 0 || card.routeDecisionCount !== 0) {
    return "lifecycle_present";
  }
  if (card.dependencies.some((dependency) => dependency.status !== "done" || dependency.archivedAt !== null)) {
    return "dependency_open";
  }
  if (!card.sourceDigest) return "source_unbound";
  return null;
};

const scoreOf = (card: RecommendationCardFact, now: Date): number =>
  scoreAmuxScheduler({
    facts: {
      pinned: card.pinned,
      createdAt: card.createdAt,
      kind: card.kind,
      priority: card.priority,
      dependentCount: card.dependentCount,
      drag: card.drag,
    },
    now,
    capacityWeight: 0,
  }).total;

export const selectRecommendationRows = (input: {
  cards: readonly RecommendationCardFact[];
  capacity: RecommendationCapacityFact;
  occupied: number;
  blocksAdmission: boolean;
  now: Date;
}): RecommendationSelection => {
  const capacityView = recommendationRemaining(input.capacity, input.occupied);
  const eligible: RecommendationRow[] = [];
  const excluded: RecommendationRow[] = [];
  for (const card of input.cards) {
    const structural = structuralExclusion(card);
    const reviewWaiting = card.reviewAfter !== null && card.reviewAfter.getTime() > input.now.getTime();
    const base: Omit<RecommendationRow, "disposition" | "exclusionCode"> = {
      cardId: card.id,
      expectedRevision: card.revision,
      sourceDigest: card.sourceDigest,
      executionBriefDigest: card.executionBriefDigest,
      scoreTotal: scoreOf(card, input.now),
    };
    if (structural) {
      excluded.push({ ...base, disposition: "excluded", exclusionCode: structural });
      continue;
    }
    if (reviewWaiting) {
      excluded.push({ ...base, disposition: "excluded", exclusionCode: "review_waiting" });
      continue;
    }
    eligible.push({ ...base, disposition: "included", exclusionCode: null });
  }
  eligible.sort((left, right) =>
    right.scoreTotal - left.scoreTotal || (left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0),
  );
  const capacityCode: RecommendationExclusionCode = capacityView.configured
    ? "capacity_full"
    : "capacity_unconfigured";
  const included = input.blocksAdmission ? [] : eligible.slice(0, capacityView.remaining);
  const overflow = input.blocksAdmission ? eligible : eligible.slice(capacityView.remaining);
  const overflowCode: RecommendationExclusionCode = input.blocksAdmission ? "incident_blocked" : capacityCode;
  const rows = [
    ...included,
    ...overflow.map((row) => ({ ...row, disposition: "excluded" as const, exclusionCode: overflowCode })),
    ...excluded,
  ];
  return {
    configured: capacityView.configured,
    wipLimit: capacityView.wipLimit,
    occupied: Math.max(0, Math.trunc(input.occupied)),
    remaining: input.blocksAdmission ? 0 : capacityView.remaining,
    rows,
    includedCount: included.length,
  };
};

export const recommendationRowsDigest = (rows: readonly RecommendationRow[]): string =>
  createHash("sha256")
    .update(
      `amux-recommendation-rows:${RECOMMENDATION_CANONICALIZATION_VERSION}\n${amuxCanonicalJson(
        [...rows].sort((left, right) => (left.cardId < right.cardId ? -1 : 1)),
      )}`,
      "utf8",
    )
    .digest("hex");

export const recommendationAuditMetadata = (
  input: Partial<Record<(typeof RECOMMENDATION_AUDIT_KEYS)[number], string | number | null>>,
): Record<string, string | number | null> => {
  const metadata: Record<string, string | number | null> = {};
  for (const key of RECOMMENDATION_AUDIT_KEYS) {
    if (input[key] !== undefined) metadata[key] = input[key] ?? null;
  }
  return metadata;
};

const parseObject = (raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; code: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (amuxCatalogTextRefused(scrubRecommendationIdentifiers(parsed))) return { ok: false, code: "content_refused" };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "schema_rejected" };
  return { ok: true, value: parsed as Record<string, unknown> };
};

const scrubRecommendationIdentifiers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubRecommendationIdentifiers);
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "snapshotId" || key === "decisionId") && typeof child === "string" && UUID_PATTERN.test(child)) {
      copy[key] = "identifier";
    } else {
      copy[key] = scrubRecommendationIdentifiers(child);
    }
  }
  return copy;
};

const headerOk = (value: Record<string, unknown>): boolean =>
  value.canonicalizationVersion === RECOMMENDATION_CANONICALIZATION_VERSION &&
  value.policyVersion === RECOMMENDATION_POLICY_VERSION;

export const parseRecommendationPrepareRequest = (
  raw: string,
): { ok: true; request: RecommendationPrepareRequest } | { ok: false; code: string } => {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  if (!sameKeys(parsed.value, PREPARE_KEYS) || !headerOk(parsed.value)) return { ok: false, code: "schema_rejected" };
  return {
    ok: true,
    request: {
      canonicalizationVersion: RECOMMENDATION_CANONICALIZATION_VERSION,
      policyVersion: RECOMMENDATION_POLICY_VERSION,
    },
  };
};

const parseOneItem = (item: unknown): { ok: true; item: BoardPromotionItem } | { ok: false; code: string } => {
  const wrapped = JSON.stringify({
    canonicalizationVersion: RECOMMENDATION_CANONICALIZATION_VERSION,
    policyVersion: 3,
    items: [item],
  });
  const parsed = parseBoardPromotionRequest(wrapped);
  if (!parsed.ok) return { ok: false, code: "schema_rejected" };
  if (parsed.request.items.length !== 1) return { ok: false, code: "schema_rejected" };
  return { ok: true, item: parsed.request.items[0] };
};

export const recommendationReviewAfterAccepted = (reviewAfter: string, now: Date): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(reviewAfter)) return false;
  const parsed = new Date(reviewAfter);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== reviewAfter) return false;
  const delta = parsed.getTime() - now.getTime();
  return delta > 0 && delta <= RECOMMENDATION_REVIEW_AFTER_MAX_MS;
};

export const parseRecommendationDecisionRequest = (
  raw: string,
  now: Date,
): { ok: true; request: RecommendationDecisionRequest; requestDigest: string } | { ok: false; code: string } => {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  const decision = parsed.value.decision;
  if (decision !== "approve" && decision !== "hold" && decision !== "reject") {
    return { ok: false, code: "schema_rejected" };
  }
  const keys = decision === "approve" ? APPROVE_KEYS : HOLD_KEYS;
  if (!sameKeys(parsed.value, keys) || !headerOk(parsed.value)) return { ok: false, code: "schema_rejected" };
  const snapshotId = parsed.value.snapshotId;
  const decisionId = parsed.value.decisionId;
  if (typeof snapshotId !== "string" || !UUID_PATTERN.test(snapshotId)) return { ok: false, code: "schema_rejected" };
  if (typeof decisionId !== "string" || !UUID_PATTERN.test(decisionId)) return { ok: false, code: "schema_rejected" };
  if (decision === "approve") {
    const item = parseOneItem(parsed.value.item);
    if (!item.ok) return item;
    const request: RecommendationApproveRequest = {
      canonicalizationVersion: RECOMMENDATION_CANONICALIZATION_VERSION,
      policyVersion: RECOMMENDATION_POLICY_VERSION,
      snapshotId,
      decisionId,
      decision: "approve",
      item: item.item,
    };
    return {
      ok: true,
      request,
      requestDigest: createHash("sha256")
        .update(`amux-recommendation-decision\n${amuxCanonicalJson(request)}`, "utf8")
        .digest("hex"),
    };
  }
  const cardId = parsed.value.cardId;
  const reasonCode = parsed.value.reasonCode;
  const reviewAfter = parsed.value.reviewAfter;
  if (typeof cardId !== "string" || !CARD_ID_PATTERN.test(cardId)) return { ok: false, code: "schema_rejected" };
  if (typeof reasonCode !== "string" || !member(reasonCode, RECOMMENDATION_REASON_CODES)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof reviewAfter !== "string" || !recommendationReviewAfterAccepted(reviewAfter, now)) {
    return { ok: false, code: "schema_rejected" };
  }
  const request: RecommendationHoldRequest = {
    canonicalizationVersion: RECOMMENDATION_CANONICALIZATION_VERSION,
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    snapshotId,
    decisionId,
    decision,
    cardId,
    reasonCode,
    reviewAfter,
  };
  return {
    ok: true,
    request,
    requestDigest: createHash("sha256")
      .update(`amux-recommendation-decision\n${amuxCanonicalJson(request)}`, "utf8")
      .digest("hex"),
  };
};

export const recommendationBriefDigest = boardPromotionExecutionBriefDigest;

export const recommendationApproveStillIncluded = (input: {
  row: RecommendationRow;
  live: RecommendationCardFact;
  item: BoardPromotionItem;
  blocksAdmission: boolean;
  configured: boolean;
  remaining: number;
  now: Date;
}): { ok: true } | { ok: false; code: string } => {
  if (input.row.disposition !== "included" || input.row.cardId !== input.item.cardId) {
    return { ok: false, code: "not_included" };
  }
  if (input.live.revision !== input.item.expectedRevision || input.live.revision !== input.row.expectedRevision) {
    return { ok: false, code: "revision_mismatch" };
  }
  if (input.live.sourceDigest !== input.item.sourceDigest || input.live.sourceDigest !== input.row.sourceDigest) {
    return { ok: false, code: "source_digest_mismatch" };
  }
  if (input.live.executionBriefDigest !== input.row.executionBriefDigest) {
    return { ok: false, code: "brief_digest_changed" };
  }
  const structural = structuralExclusion(input.live);
  if (structural) return { ok: false, code: structural };
  if (input.live.reviewAfter !== null && input.live.reviewAfter.getTime() > input.now.getTime()) {
    return { ok: false, code: "review_waiting" };
  }
  if (input.blocksAdmission) return { ok: false, code: "incident_blocked" };
  if (input.remaining < 1) {
    return { ok: false, code: input.configured ? "capacity_full" : "capacity_unconfigured" };
  }
  return { ok: true };
};
