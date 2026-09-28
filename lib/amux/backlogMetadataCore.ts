import {
  AMUX_MANIFEST_CANONICALIZATION_VERSION,
  BoardImportError,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
} from "./boardImportCore.ts";
import {
  BOARD_PROMOTION_KINDS,
  BOARD_PROMOTION_PRIORITIES,
  type BoardPromotionKind,
  type BoardPromotionPriority,
} from "./boardPromotionCore.ts";

/**
 * Owner-only metadata writer for one backlog card.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy
 * version 15, "backlog 카드 메타데이터 writer").
 *
 * Parsing and classification are pure. This module does not open a
 * transaction, write an audit row, or change a card. The service is the only
 * writer, and it writes only `kind`, `priority`, `estimatedCostMicrousd` and
 * the revision. Status, owner, brief, attempts, deliveries and route decisions
 * are never written here. Nothing here starts a worker or spends credits.
 */

export const BACKLOG_METADATA_POLICY_VERSION = 15;
export const BACKLOG_METADATA_CANONICALIZATION_VERSION = AMUX_MANIFEST_CANONICALIZATION_VERSION;
export const BACKLOG_METADATA_APPLY_ENV = "TOMVERSE_AMUX_BACKLOG_METADATA";

/**
 * Second apply latch. One environment variable must not be enough to write a
 * card. The service reads this constant; the HTTP route never receives it and
 * never passes a literal `true`. Version 15 ships it on. Apply still needs the
 * environment value exactly `enabled`, which this constant does not set.
 */
export const BACKLOG_METADATA_CODE_LATCH = true;

export const BACKLOG_METADATA_COST_MIN_MICROUSD = 0;
export const BACKLOG_METADATA_COST_MAX_MICROUSD = 5_000_000;
export const BACKLOG_METADATA_RAW_BODY_MAX_BYTES = 4_096;
export const BACKLOG_METADATA_AUDIT_ACTION = "amux.backlog_metadata.updated";

/**
 * Every key the audit row may carry. No title, source key, brief or free text.
 * The write has no history table, so the audit row is the only record of what
 * it replaced: it keeps the previous and new values of all three fields. The
 * cost is an operational USD estimate in micro-dollars, carried as a string.
 */
export const BACKLOG_METADATA_AUDIT_KEYS = [
  "cardId",
  "estimatedCostMicrousd",
  "kind",
  "previousEstimatedCostMicrousd",
  "previousKind",
  "previousPriority",
  "previousRevision",
  "priority",
  "revision",
] as const;

/** Why a card is not writable, in the order the checks run. */
export const BACKLOG_METADATA_REFUSALS = [
  "not_found",
  "archived",
  "not_backlog",
  "owned",
  "brief_present",
  "revision_mismatch",
] as const;

export type BacklogMetadataRefusal = (typeof BACKLOG_METADATA_REFUSALS)[number];

const REQUEST_KEYS = [
  "canonicalizationVersion",
  "cardId",
  "estimatedCostMicrousd",
  "expectedRevision",
  "kind",
  "policyVersion",
  "priority",
] as const;

const CARD_ID_PATTERN = /^c[a-z0-9]{24}$/;
const REVISION_MAX = 2_147_483_647;

export type BacklogMetadataRequest = {
  canonicalizationVersion: typeof BACKLOG_METADATA_CANONICALIZATION_VERSION;
  policyVersion: typeof BACKLOG_METADATA_POLICY_VERSION;
  cardId: string;
  expectedRevision: number;
  kind: BoardPromotionKind;
  priority: BoardPromotionPriority;
  estimatedCostMicrousd: number | null;
};

export type BacklogMetadataParseResult =
  | { ok: true; request: BacklogMetadataRequest }
  | { ok: false; code: string };

export type BacklogMetadataCardFact = {
  id: string;
  revision: number;
  status: string;
  owner: string | null;
  claimedAt: Date | null;
  archivedAt: Date | null;
  executionBriefDigest: string | null;
  kind: string;
  priority: string;
  estimatedCostMicrousd: bigint | null;
};

export type BacklogMetadataAuditMetadata = {
  cardId: string;
  previousKind: string;
  kind: BoardPromotionKind;
  previousPriority: string;
  priority: BoardPromotionPriority;
  previousEstimatedCostMicrousd: string | null;
  estimatedCostMicrousd: string | null;
  previousRevision: number;
  revision: number;
};

/**
 * A card that failed the write's conditions. The HTTP answer is 409
 * `conflict` with this refusal, and nothing was written.
 */
export class BacklogMetadataConflict extends BoardImportError {
  readonly refusal: BacklogMetadataRefusal;

  constructor(refusal: BacklogMetadataRefusal) {
    super("conflict", 409);
    this.name = "BacklogMetadataConflict";
    this.refusal = refusal;
  }
}

const sameKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const member = (value: string, allowed: readonly string[]): boolean => allowed.includes(value);

const integerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

export const backlogMetadataApplyPermitted = (input: {
  envValue: string | undefined;
  codeLatch: boolean;
}): boolean => boardImportApplyPermitted(input);

export const parseBacklogMetadataRequest = (raw: string): BacklogMetadataParseResult => {
  if (Buffer.byteLength(raw, "utf8") > BACKLOG_METADATA_RAW_BODY_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  if (raw.includes("\u0000") || raw.includes("�")) return { ok: false, code: "content_refused" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  // The whole body, extra keys included, passes the catalog scanner before any
  // field is read. A path separator in any string is refused here.
  if (amuxCatalogTextRefused(parsed)) return { ok: false, code: "content_refused" };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "schema_rejected" };
  if (!sameKeys(parsed, REQUEST_KEYS)) return { ok: false, code: "schema_rejected" };
  const body = parsed as Record<string, unknown>;
  if (body.canonicalizationVersion !== BACKLOG_METADATA_CANONICALIZATION_VERSION) {
    return { ok: false, code: "schema_rejected" };
  }
  if (body.policyVersion !== BACKLOG_METADATA_POLICY_VERSION) return { ok: false, code: "schema_rejected" };
  if (typeof body.cardId !== "string" || !CARD_ID_PATTERN.test(body.cardId)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!integerIn(body.expectedRevision, 0, REVISION_MAX)) return { ok: false, code: "schema_rejected" };
  if (typeof body.kind !== "string" || !member(body.kind, BOARD_PROMOTION_KINDS)) {
    return { ok: false, code: body.kind === "unknown" ? "kind_not_explicit" : "schema_rejected" };
  }
  if (typeof body.priority !== "string" || !member(body.priority, BOARD_PROMOTION_PRIORITIES)) {
    return { ok: false, code: "schema_rejected" };
  }
  const cost = body.estimatedCostMicrousd;
  if (
    cost !== null &&
    !integerIn(cost, BACKLOG_METADATA_COST_MIN_MICROUSD, BACKLOG_METADATA_COST_MAX_MICROUSD)
  ) {
    return { ok: false, code: "schema_rejected" };
  }
  return {
    ok: true,
    request: {
      canonicalizationVersion: BACKLOG_METADATA_CANONICALIZATION_VERSION,
      policyVersion: BACKLOG_METADATA_POLICY_VERSION,
      cardId: body.cardId,
      expectedRevision: body.expectedRevision,
      kind: body.kind as BoardPromotionKind,
      priority: body.priority as BoardPromotionPriority,
      estimatedCostMicrousd: cost as number | null,
    },
  };
};

/**
 * The first condition the card fails, or null when the write may proceed.
 * Mirrors the `where` of `backlogMetadataCardWrite`, so a failed conditional
 * update can be read back into one named reason.
 */
export const backlogMetadataRefusal = (
  request: BacklogMetadataRequest,
  fact: BacklogMetadataCardFact | null | undefined,
): BacklogMetadataRefusal | null => {
  if (!fact || fact.id !== request.cardId) return "not_found";
  if (fact.archivedAt !== null) return "archived";
  if (fact.status !== "backlog") return "not_backlog";
  if (fact.owner !== null || fact.claimedAt !== null) return "owned";
  if (fact.executionBriefDigest !== null) return "brief_present";
  if (fact.revision !== request.expectedRevision) return "revision_mismatch";
  return null;
};

/** The one conditional card write. `data` names no status, owner or brief. */
export const backlogMetadataCardWrite = (request: BacklogMetadataRequest) => ({
  where: {
    id: request.cardId,
    revision: request.expectedRevision,
    status: "backlog" as const,
    owner: null,
    claimedAt: null,
    archivedAt: null,
    executionBriefDigest: null,
  },
  data: {
    kind: request.kind,
    priority: request.priority,
    estimatedCostMicrousd:
      request.estimatedCostMicrousd === null ? null : BigInt(request.estimatedCostMicrousd),
    revision: { increment: 1 },
  },
});

export const backlogMetadataAuditMetadata = (
  previous: Pick<BacklogMetadataCardFact, "kind" | "priority" | "estimatedCostMicrousd">,
  request: BacklogMetadataRequest,
): BacklogMetadataAuditMetadata => ({
  cardId: request.cardId,
  previousKind: previous.kind,
  kind: request.kind,
  previousPriority: previous.priority,
  priority: request.priority,
  previousEstimatedCostMicrousd:
    previous.estimatedCostMicrousd === null || previous.estimatedCostMicrousd === undefined
      ? null
      : previous.estimatedCostMicrousd.toString(),
  estimatedCostMicrousd:
    request.estimatedCostMicrousd === null ? null : String(request.estimatedCostMicrousd),
  previousRevision: request.expectedRevision,
  revision: request.expectedRevision + 1,
});
