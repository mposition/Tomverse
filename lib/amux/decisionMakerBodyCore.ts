import { createHmac } from "node:crypto";

import {
  DM_ANSWER_MAX_BYTES,
  DM_CARD_TEXT_MAX_BYTES,
  DM_ESCALATION_MAX_BYTES,
  DM_RATIONALE_MAX_BYTES,
  isDmOptionId,
  type DmOutput,
} from "./decisionMakerCore.ts";
import { detectSecretsInFields } from "../engineeringAgentSecretPatterns.ts";

/**
 * The AMUX Decision Maker body store, its retention and its digest keys,
 * policy version 1 (docs/policy/amux-decision-maker.md §10, with §6 and §9
 * where they meet it), stage S1d.
 *
 * Pure: the closed vocabularies that the CHECKs of migration
 * 20261008120000_amux_decision_maker_body_store hold, the byte caps, the
 * retention and key-period arithmetic, the rules its triggers enforce --
 * written out so the one writer (lib/amux/decisionMakerBodyStore.ts) refuses
 * before the database has to -- and the keyed digests. The triggers stay the
 * authority; this mirrors them. The only I/O-free dependency outside this
 * directory is the secret scanner the router already uses.
 *
 * Digest keys (§10: "본문 식별은 서버 키의 keyed digest로 하며 평문 hash를 두지
 * 않는다"). One random 32-byte key per 30-day key period, held only in the
 * server's secret store (`AMUX_DM_DIGEST_KEYS`, lib/amux/decisionMakerDigestKeys.ts),
 * never in the database, a log or an audit entry. A request's key period is
 * derived from its database-clock `createdAt`, which is immutable, so every
 * digest of one request -- including a retried result submission -- uses the
 * same key. From the period key and the request id the app derives the
 * request key, K_R = HMAC(K_P, "amux-dm-request-key-v1\0" + requestId), and
 * every digest of that request is an HMAC under K_R with its own label: the
 * option set digest of §9's binding (computed by the request store at routing
 * from the card's options, and again from the options a result is submitted
 * with), the broker's input payload and snapshot manifest digests (the app
 * hands K_R to the broker at assignment), the result digest (computed by the
 * app from the output it stores), and each body row's digest. The database stores, per key
 * period, only a key check value, HMAC(K_P, "amux-dm-digest-key-check-v1"),
 * which lets a writer prove it holds the registered key and reveals nothing
 * about it.
 */

/** §10: the five body fields, and nothing else. */
export const DM_BODY_FIELDS = [
  "card_text",
  "dm_answer",
  "dm_rationale",
  "dm_escalation_reason",
  "operator_answer",
] as const;
export type DmBodyField = (typeof DM_BODY_FIELDS)[number];

/** §10: "운영자가 고친 답(8 KiB)". */
export const DM_OPERATOR_ANSWER_MAX_BYTES = 8 * 1024;

/**
 * §10's caps, in UTF-8 bytes. The DM output caps are S1a's, which the output
 * schema already holds (§6); the card cap is §5's.
 */
export const DM_BODY_FIELD_MAX_BYTES: Readonly<Record<DmBodyField, number>> = Object.freeze({
  card_text: DM_CARD_TEXT_MAX_BYTES,
  dm_answer: DM_ANSWER_MAX_BYTES,
  dm_rationale: DM_RATIONALE_MAX_BYTES,
  dm_escalation_reason: DM_ESCALATION_MAX_BYTES,
  operator_answer: DM_OPERATOR_ANSWER_MAX_BYTES,
});

/** §10: "요청당 합계는 40 KiB 이하다". */
export const DM_BODY_REQUEST_MAX_BYTES = 40 * 1024;

/** §10: "사건 종류는 retention_set·hold_set·hold_release 셋뿐이다". */
export const DM_RETENTION_EVENT_KINDS = ["retention_set", "hold_set", "hold_release"] as const;
export type DmRetentionEventKind = (typeof DM_RETENTION_EVENT_KINDS)[number];
export const DM_HOLD_EVENT_KINDS = ["hold_set", "hold_release"] as const;
export const DM_RETENTION_ACTOR_KINDS = ["human", "system"] as const;

/**
 * §10: "retentionUntil(닫힘 + 90일)" -- exactly 90 × 24 hours. The migration
 * adds `INTERVAL '2160 hours'`, a fixed length, never `'90 days'`, whose
 * length follows the session time zone's calendar across a DST change.
 */
export const DM_RETENTION_AFTER_CLOSE_MS = 90 * 24 * 60 * 60 * 1000;

/** §10: "키는 30일 단위로 바꾸고". */
export const DM_KEY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const DM_DIGEST_KEY_BYTES = 32;

/** The key registry's events: a period's key put into use, and destroyed. */
export const DM_DIGEST_KEY_EVENT_KINDS = ["rotate", "destroy"] as const;
export type DmDigestKeyEventKind = (typeof DM_DIGEST_KEY_EVENT_KINDS)[number];

/** §10's audit actions for this stage. The first three are a person's. */
export const DM_BODY_AUDIT_ACTIONS = {
  legalHold: "amux.decision.legal_hold",
  bodyErase: "amux.decision.body_erase",
  bodyPurge: "amux.decision.body_purge",
  digestKeyRotate: "amux.decision.digest_key_rotate",
  digestKeyDestroy: "amux.decision.digest_key_destroy",
} as const;

export const DM_RETENTION_EVENT_AUDIT_TARGET_TYPE = "AmuxDecisionMakerRetentionEvent" as const;
export const DM_DIGEST_KEY_EVENT_AUDIT_TARGET_TYPE = "AmuxDecisionMakerDigestKeyEvent" as const;
/** Purge and erase name the request whose bodies they delete. */
export const DM_BODY_DELETE_AUDIT_TARGET_TYPE = "AmuxDecisionMakerRequest" as const;

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export const isDmBodyField = (value: unknown): value is DmBodyField => isOneOf(DM_BODY_FIELDS, value);

// ---------------------------------------------------------------------------
// Key periods and digests
// ---------------------------------------------------------------------------

/**
 * The key period of a database-clock instant: whole 30-day periods since the
 * Unix epoch. The migration computes the same from a request's `createdAt`
 * (floor(epoch ms / 2,592,000,000)) and refuses a row naming another.
 */
export const dmKeyPeriodOf = (epochMs: number): number => {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) throw new Error("AMUX Decision Maker key period of an invalid instant");
  return Math.floor(epochMs / DM_KEY_PERIOD_MS);
};
export const dmKeyPeriodStartMs = (period: number): number => period * DM_KEY_PERIOD_MS;
export const dmKeyPeriodEndMs = (period: number): number => (period + 1) * DM_KEY_PERIOD_MS;
export const isDmKeyPeriod = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;

const requireKey = (key: Buffer) => {
  if (!Buffer.isBuffer(key) || key.length !== DM_DIGEST_KEY_BYTES) {
    throw new Error("AMUX Decision Maker digest key must be 32 bytes");
  }
  return key;
};

const hmac = (key: Buffer, ...parts: Array<string | Uint8Array>) => {
  const mac = createHmac("sha256", requireKey(key));
  parts.forEach((part, index) => {
    if (index > 0) mac.update(Buffer.from([0]));
    mac.update(typeof part === "string" ? Buffer.from(part, "utf8") : part);
  });
  return mac.digest();
};

/** What the registry stores for a period: proof of the key, not the key. */
export const dmDigestKeyCheck = (periodKey: Buffer): string =>
  hmac(periodKey, "amux-dm-digest-key-check-v1").toString("hex");

/**
 * K_R: one request's key, derived from its period's key and its id. Handed to
 * the broker at assignment so it can key the digests it computes (§2-4); it
 * opens no other request and does not give back K_P.
 */
export const dmRequestDigestKey = (periodKey: Buffer, requestId: string): Buffer =>
  hmac(periodKey, "amux-dm-request-key-v1", requestId);

/** A body row's digest. The field is in the input, so equal texts in two fields differ. */
export const dmBodyDigest = (requestKey: Buffer, field: DmBodyField, text: string): string =>
  hmac(requestKey, "amux-dm-body-v1", field, text).toString("hex");

/**
 * §9's option set digest: the card's options, sorted by id, as a JSON list of
 * [id, label] pairs, so a label and an id cannot run into each other. The
 * request store computes it at routing and stores it in the binding; a result
 * is accepted only with the option list that digests to the same value, so
 * no option can be added to or dropped from the set a DM output is checked
 * against.
 */
export const dmOptionSetDigest = (
  requestKey: Buffer,
  options: ReadonlyArray<{ id: string; label: string }>,
): string => {
  const pairs = [...options]
    .map((option) => [option.id, option.label])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return hmac(requestKey, "amux-dm-option-set-v1", JSON.stringify(pairs)).toString("hex");
};

/** The broker's input payload digest (§2-4, §10's transmission intent), over the exact bytes sent. */
export const dmPayloadDigest = (requestKey: Buffer, payload: Uint8Array | string): string =>
  hmac(requestKey, "amux-dm-payload-v1", payload).toString("hex");

/**
 * The broker's snapshot manifest digest (§5: "manifest는 경로와 blob id다"),
 * over the entries sorted by path. A path cannot hold a NUL (S1a's path
 * grammar refuses control characters), so the separators are unambiguous.
 */
export const dmSnapshotManifestDigest = (
  requestKey: Buffer,
  manifest: ReadonlyArray<{ path: string; blobId: string }>,
): string => {
  const entries = [...manifest].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return hmac(requestKey, "amux-dm-manifest-v1", ...entries.flatMap((entry) => [entry.path, entry.blobId])).toString("hex");
};

export type DmResultDigestInput =
  | { kind: "output"; raw: string }
  | { kind: "timeout" }
  | { kind: "unavailable" };

/**
 * The result digest of §9's (request, result digest) pair. A DM output is
 * digested over the exact bytes the broker submitted, so the broker -- which
 * holds K_R -- can compute the same pair to look a lost response up, and a
 * resubmission of the same output is the same pair. A timeout or an
 * unavailable DM has no output; its digest is fixed per request.
 */
export const dmResultDigest = (requestKey: Buffer, input: DmResultDigestInput): string =>
  input.kind === "output"
    ? hmac(requestKey, "amux-dm-result-v1", "output", input.raw).toString("hex")
    : hmac(requestKey, "amux-dm-result-v1", input.kind).toString("hex");

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export type DmBodyRefusal =
  | "unknown_field"
  | "empty"
  | "not_well_formed"
  | "too_long"
  | "secret_detected"
  | "request_too_long";

/**
 * Whether a body may be stored (§10): a listed field, non-empty, well-formed
 * text without NUL (PostgreSQL TEXT cannot hold it), within its field's cap,
 * and clear of the secret scanner the router uses ("저장 전에 secret 검사를
 * 통과해야 한다"). The migration's CHECKs hold the caps; the scan is only
 * the application's.
 */
export const dmBodyRefusal = (field: unknown, text: unknown): DmBodyRefusal | null => {
  if (!isDmBodyField(field)) return "unknown_field";
  if (typeof text !== "string" || text.length === 0) return "empty";
  if (!text.isWellFormed() || text.includes("\u0000")) return "not_well_formed";
  if (utf8Bytes(text) > DM_BODY_FIELD_MAX_BYTES[field]) return "too_long";
  if (detectSecretsInFields({ [field]: text }).length > 0) return "secret_detected";
  return null;
};

/** Every body of one write, and the request's total with the bodies it already has. */
export const dmBodiesRefusal = (
  bodies: ReadonlyArray<{ field: DmBodyField; text: string }>,
  storedBytes = 0,
): DmBodyRefusal | null => {
  for (const body of bodies) {
    const refusal = dmBodyRefusal(body.field, body.text);
    if (refusal) return refusal;
  }
  const total = bodies.reduce((sum, body) => sum + utf8Bytes(body.text), storedBytes);
  return total > DM_BODY_REQUEST_MAX_BYTES ? "request_too_long" : null;
};

/**
 * The body fields a validated DM output stores (§6, §10): a `select` stores
 * its rationale (the option id is the card's), a `free_text` its answer and
 * rationale, an `escalate` its reason -- which Admin shows and the card never
 * receives.
 */
export const dmOutputBodies = (output: DmOutput): Array<{ field: DmBodyField; text: string }> => {
  switch (output.kind) {
    case "select":
      return [{ field: "dm_rationale", text: output.rationale }];
    case "free_text":
      return [
        { field: "dm_answer", text: output.answer },
        { field: "dm_rationale", text: output.rationale },
      ];
    case "escalate":
      return [{ field: "dm_escalation_reason", text: output.reason }];
  }
};

// ---------------------------------------------------------------------------
// The terminal result's structured detail
// ---------------------------------------------------------------------------

/** §6's three kinds of DM output. */
export const DM_OUTPUT_KINDS = ["select", "free_text", "escalate"] as const;
export type DmOutputKind = (typeof DM_OUTPUT_KINDS)[number];

/**
 * What the ledger keeps of a terminal result beside its digest, with no free
 * text: the output's kind, the option a `select` chose, and the
 * `irreversible` flag Admin shows before the operator judges (§6). A
 * proposal is a select or a free text answer and always carries the flag; an
 * escalation is neither; a validation failure, a timeout and an unavailable DM
 * have no output. Migration 20261008120000_amux_decision_maker_body_store
 * holds the same shape as a CHECK, and the option id the S1a grammar.
 */
export type DmResultDetail = {
  outputKind: DmOutputKind | null;
  optionId: string | null;
  irreversible: boolean | null;
};

export const dmResultDetail = (output: DmOutput | null): DmResultDetail => {
  if (output === null) return { outputKind: null, optionId: null, irreversible: null };
  switch (output.kind) {
    case "select":
      return { outputKind: "select", optionId: output.optionId, irreversible: output.irreversible };
    case "free_text":
      return { outputKind: "free_text", optionId: null, irreversible: output.irreversible };
    case "escalate":
      return { outputKind: "escalate", optionId: null, irreversible: null };
  }
};

/** The CHECK of the detail row: which kinds carry what, for each terminal result kind. */
export const dmResultDetailShapeValid = (resultKind: string, detail: DmResultDetail): boolean => {
  const { outputKind, optionId, irreversible } = detail;
  if (optionId !== null && !isDmOptionId(optionId)) return false;
  switch (resultKind) {
    case "proposal":
      return (
        (outputKind === "select" && optionId !== null && irreversible !== null) ||
        (outputKind === "free_text" && optionId === null && irreversible !== null)
      );
    case "escalate":
      return outputKind === "escalate" && optionId === null && irreversible === null;
    case "validation_failure":
    case "timeout":
    case "unavailable":
      return outputKind === null && optionId === null && irreversible === null;
    default:
      return false;
  }
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** §10: a closed request's bodies may be purged from this instant. */
export const dmRetentionUntilMs = (closedAtMs: number): number => closedAtMs + DM_RETENTION_AFTER_CLOSE_MS;

/**
 * §10's open hold: hold events only, more `hold_set` than `hold_release`.
 * `retention_set` never counts.
 */
export const dmHoldOpen = (holdSets: number, holdReleases: number): boolean => holdSets > holdReleases;

/** One request's retention and bodies, from the store's one retention read. */
export type DmBodyRetentionState = {
  requestId: string;
  dbNowMs: number;
  retentionUntilMs: number | null;
  holdSets: number;
  holdReleases: number;
  holdOpen: boolean;
  /** The body fields the request has now, in the list's order. */
  bodyFields: DmBodyField[];
  bodyBytes: number;
};

const epochMs = (value: unknown): number | null => {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};

const count = (value: unknown): number | null => {
  const number = epochMs(value);
  return number !== null && number >= 0 ? number : null;
};

/** Null when the row holds anything the tables' CHECKs could not have produced. */
export const dmBodyRetentionStateFromRow = (requestId: string, row: unknown): DmBodyRetentionState | null => {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const dbNowMs = epochMs(r.dbNowEpochMs);
  const retentionUntilMs = r.retentionUntilEpochMs === null ? null : epochMs(r.retentionUntilEpochMs);
  const holdSets = count(r.holdSets);
  const holdReleases = count(r.holdReleases);
  const bodyBytes = count(r.bodyBytes);
  if (dbNowMs === null || holdSets === null || holdReleases === null || bodyBytes === null) return null;
  if (r.retentionUntilEpochMs !== null && retentionUntilMs === null) return null;
  if (!Array.isArray(r.bodyFields) || !r.bodyFields.every(isDmBodyField)) return null;
  if (new Set(r.bodyFields).size !== r.bodyFields.length) return null;
  const bodyFields = DM_BODY_FIELDS.filter((field) => (r.bodyFields as string[]).includes(field));
  return {
    requestId,
    dbNowMs,
    retentionUntilMs,
    holdSets,
    holdReleases,
    holdOpen: dmHoldOpen(holdSets, holdReleases),
    bodyFields,
    bodyBytes,
  };
};

export type DmHoldAction = "set" | "release";
export type DmHoldRefusal = "hold_open" | "no_open_hold";

/** §10: "hold_set은 열린 hold가 없을 때만, hold_release는 열린 hold가 있을 때만". */
export const dmHoldRefusal = (state: DmBodyRetentionState, action: DmHoldAction): DmHoldRefusal | null => {
  if (action === "set") return state.holdOpen ? "hold_open" : null;
  return state.holdOpen ? null : "no_open_hold";
};

export type DmPurgeRefusal = "not_closed" | "retained" | "held" | "no_bodies";

/**
 * §10's expiry delete: the request has its retention (it closed), the
 * retention has passed by the database clock, no hold is open, and there is
 * something to delete.
 */
export const dmPurgeRefusal = (state: DmBodyRetentionState): DmPurgeRefusal | null => {
  if (state.retentionUntilMs === null) return "not_closed";
  if (state.dbNowMs < state.retentionUntilMs) return "retained";
  if (state.holdOpen) return "held";
  if (state.bodyFields.length === 0) return "no_bodies";
  return null;
};

export type DmEraseRefusal = "held" | "no_bodies";

/**
 * §10's one exception, a confirmed personal-data deletion request: any of
 * the request's bodies, before or after its retention, but an open hold has
 * to be released first ("열린 hold가 있으면 먼저 풀어야 한다").
 */
export const dmEraseRefusal = (
  state: DmBodyRetentionState,
  fields: readonly DmBodyField[],
): DmEraseRefusal | null => {
  if (state.holdOpen) return "held";
  if (!fields.some((field) => state.bodyFields.includes(field))) return "no_bodies";
  return null;
};

// ---------------------------------------------------------------------------
// A proposal as a person's judgment reads it (stage S1e)
// ---------------------------------------------------------------------------

/**
 * What this store holds of a request's proposal when a person judges it (§6:
 * the confirmation stands only while "Admin이 보여 준 제안 본문과 스냅샷 정보의
 * digest가 저장된 값과 같을 때"): the terminal result's detail, the keyed
 * digests of the DM's answer and rationale and of an operator's answer, the
 * bytes the request's bodies hold, and the registry entry of the request's key
 * period. Never a body's text.
 */
export type DmProposalForJudgment = {
  /** The result event the detail belongs to; null when no detail is stored. */
  resultEventId: string | null;
  resultKind: string | null;
  detail: DmResultDetail | null;
  answerDigest: string | null;
  rationaleDigest: string | null;
  operatorAnswerDigest: string | null;
  bodyBytes: number;
  /** The key check value registered for the request's period; null when none is. */
  keyCheck: string | null;
  keyDestroyed: boolean;
};

const PROPOSAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROPOSAL_DIGEST = /^[0-9a-f]{64}$/;
const nullableDigest = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && PROPOSAL_DIGEST.test(value));

/** Null when the row holds anything the tables' CHECKs could not have produced. */
export const dmProposalForJudgmentFromRow = (row: unknown): DmProposalForJudgment | null => {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const bodyBytes = count(r.bodyBytes);
  if (bodyBytes === null || typeof r.keyDestroyed !== "boolean") return null;
  if (!nullableDigest(r.answerDigest) || !nullableDigest(r.rationaleDigest) || !nullableDigest(r.operatorAnswerDigest)) {
    return null;
  }
  if (!nullableDigest(r.keyCheck)) return null;
  let detail: DmResultDetail | null = null;
  if (r.resultEventId !== null) {
    if (typeof r.resultEventId !== "string" || !PROPOSAL_UUID.test(r.resultEventId) || typeof r.resultKind !== "string") {
      return null;
    }
    const candidate: DmResultDetail = {
      outputKind: (r.outputKind ?? null) as DmOutputKind | null,
      optionId: (r.optionId ?? null) as string | null,
      irreversible: (r.irreversible ?? null) as boolean | null,
    };
    if (
      !(candidate.outputKind === null || isOneOf(DM_OUTPUT_KINDS, candidate.outputKind)) ||
      !(candidate.optionId === null || typeof candidate.optionId === "string") ||
      !(candidate.irreversible === null || typeof candidate.irreversible === "boolean") ||
      !dmResultDetailShapeValid(r.resultKind, candidate)
    ) {
      return null;
    }
    detail = candidate;
  } else if (r.resultKind !== null || r.outputKind !== null || r.optionId !== null || r.irreversible !== null) {
    return null;
  }
  return {
    resultEventId: r.resultEventId as string | null,
    resultKind: (r.resultKind ?? null) as string | null,
    detail,
    answerDigest: r.answerDigest,
    rationaleDigest: r.rationaleDigest,
    operatorAnswerDigest: r.operatorAnswerDigest,
    bodyBytes,
    keyCheck: r.keyCheck,
    keyDestroyed: r.keyDestroyed,
  };
};

// ---------------------------------------------------------------------------
// The key registry
// ---------------------------------------------------------------------------

/** One key period's registry state, from the store's one key read. */
export type DmDigestKeyPeriodState = {
  keyPeriod: number;
  dbNowMs: number;
  currentKeyPeriod: number;
  /** The registered key check value; null when the period was never rotated in. */
  keyCheck: string | null;
  destroyed: boolean;
  bodies: number;
  heldRequests: number;
};

const KEY_CHECK = /^[0-9a-f]{64}$/;

export const dmDigestKeyPeriodStateFromRow = (keyPeriod: number, row: unknown): DmDigestKeyPeriodState | null => {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const dbNowMs = epochMs(r.dbNowEpochMs);
  const bodies = count(r.bodies);
  const heldRequests = count(r.heldRequests);
  if (dbNowMs === null || dbNowMs < 0 || bodies === null || heldRequests === null) return null;
  if (r.keyCheck !== null && (typeof r.keyCheck !== "string" || !KEY_CHECK.test(r.keyCheck))) return null;
  if (typeof r.destroyed !== "boolean") return null;
  // A destruction needs its rotation (the trigger refuses one without).
  if (r.destroyed && r.keyCheck === null) return null;
  return {
    keyPeriod,
    dbNowMs,
    currentKeyPeriod: dmKeyPeriodOf(dbNowMs),
    keyCheck: r.keyCheck as string | null,
    destroyed: r.destroyed,
    bodies,
    heldRequests,
  };
};

export type DmDigestKeyRotateRefusal = "already_registered" | "destroyed" | "period_too_far_ahead";

/**
 * A period's key is registered once, never after its destruction, and no
 * further ahead than the next period: the key is put into use before the
 * first request of its period needs it, not a year early.
 */
export const dmDigestKeyRotateRefusal = (state: DmDigestKeyPeriodState): DmDigestKeyRotateRefusal | null => {
  if (state.destroyed) return "destroyed";
  if (state.keyCheck !== null) return "already_registered";
  if (state.keyPeriod > state.currentKeyPeriod + 1) return "period_too_far_ahead";
  return null;
};

export type DmDigestKeyDestroyRefusal =
  | "not_registered"
  | "already_destroyed"
  | "period_not_ended"
  | "bodies_remain"
  | "hold_open"
  | "requests_open";

/**
 * §10: a period's key is destroyed once every body row of that period is
 * gone ("한 기간의 본문 행이 모두 지워지면 그 기간의 키를 파기해"), never
 * while a hold is open on one of its requests ("hold가 풀릴 때까지 둔다"),
 * and -- because a body can still be stored for an open request -- only after
 * the period has ended and none of its requests routed to a DM is still open.
 */
export const dmDigestKeyDestroyRefusal = (
  state: DmDigestKeyPeriodState,
  openRequests: number,
): DmDigestKeyDestroyRefusal | null => {
  if (state.keyCheck === null) return "not_registered";
  if (state.destroyed) return "already_destroyed";
  if (state.keyPeriod >= state.currentKeyPeriod) return "period_not_ended";
  if (state.bodies > 0) return "bodies_remain";
  if (state.heldRequests > 0) return "hold_open";
  if (openRequests > 0) return "requests_open";
  return null;
};

/**
 * Whether a writer may use this key for this period: the registry holds the
 * same key and has not destroyed it. Every body insert is held to the same by
 * the trigger.
 */
export const dmDigestKeyUsable = (state: DmDigestKeyPeriodState, keyCheck: string): boolean =>
  state.keyCheck !== null && state.keyCheck === keyCheck && !state.destroyed;

// ---------------------------------------------------------------------------
// Audit metadata
// ---------------------------------------------------------------------------

export const DM_BODY_AUDIT_METADATA_KEYS = [
  "event_id",
  "request_id",
  "kind",
  "key_period",
  "fields",
  "body_count",
] as const;
export type DmBodyAuditMetadataKey = (typeof DM_BODY_AUDIT_METADATA_KEYS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The kinds an audit entry of this stage names: a person's hold, a key event. */
const AUDITED_KINDS: readonly string[] = [...DM_HOLD_EVENT_KINDS, ...DM_DIGEST_KEY_EVENT_KINDS];

/** What each key may hold. A digest, a key check value or a body fits none of them. */
const AUDIT_VALUE_CHECKS: Readonly<Record<DmBodyAuditMetadataKey, (value: string) => boolean>> = {
  event_id: (value) => UUID.test(value),
  request_id: (value) => UUID.test(value),
  kind: (value) => AUDITED_KINDS.includes(value),
  key_period: (value) => /^(0|[1-9][0-9]{0,9})$/.test(value),
  fields: (value) => isDmBodyField(value),
  body_count: (value) => /^[0-5]$/.test(value),
};

/**
 * Closed keys, each with its own closed shape: ids, kinds, a key period, field
 * names and a count. Never a body, a digest, a key check value or a key.
 * `fields` is a list; every other key is one value.
 */
export const dmBodyAuditMetadata = (
  fields: Partial<Record<DmBodyAuditMetadataKey, string | readonly string[] | null>>,
): Record<string, string | string[]> => {
  const metadata: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!(DM_BODY_AUDIT_METADATA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`AMUX Decision Maker body audit metadata key refused: ${key}`);
    }
    if (value === null || value === undefined) continue;
    const check = AUDIT_VALUE_CHECKS[key as DmBodyAuditMetadataKey];
    const isList = key === "fields";
    if (isList !== Array.isArray(value)) {
      throw new Error(`AMUX Decision Maker body audit metadata value refused: ${key}`);
    }
    const values = typeof value === "string" ? [value] : [...value];
    if (!values.every((item) => typeof item === "string" && check(item))) {
      throw new Error(`AMUX Decision Maker body audit metadata value refused: ${key}`);
    }
    metadata[key] = isList ? values : (value as string);
  }
  return metadata;
};
