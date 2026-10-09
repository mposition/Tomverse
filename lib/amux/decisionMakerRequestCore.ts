import {
  DM_POLICY_VERSION,
  dmInstanceForProvider,
  isSnapshotTargetSha,
  type DmCard,
  type DmRoutingRefusal,
} from "./decisionMakerCore.ts";
import {
  DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE,
  isDmInstanceScope,
  type DmInstanceScope,
} from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker request ledger, policy version 1
 * (docs/policy/amux-decision-maker.md §2, §6, §9, §10), stage S1c.
 *
 * Pure: the closed vocabularies that the CHECKs of migration
 * 20261008090100_amux_decision_maker_request_ledger hold, the input checks of
 * the one writer (lib/amux/decisionMakerRequestStore.ts), the mapping from the
 * one state read to a request's state, and the transition graph the event
 * trigger enforces -- written out here so the writer refuses before the
 * database has to, and so the graph can be tested without a database. The
 * trigger stays the authority; this mirrors it.
 *
 * No I/O. No card text, prompt, proposal or free text appears anywhere here:
 * the ledger stores identifiers, closed codes and opaque digests only (§10:
 * "본문은 원장에 넣지 않는다").
 */

/** §3: a question either goes to a DM for a proposal or stays with the operator. */
export const DM_REQUEST_ROUTES = ["operator", "dm_proposal"] as const;
export type DmRequestRoute = (typeof DM_REQUEST_ROUTES)[number];

/**
 * Every refusal `routeDmQuestion()` can record, in its own order. The
 * migration's array CHECK holds the same set; tests pin both to what the
 * router actually produces.
 */
export const DM_ROUTING_REFUSAL_CODES = [
  "kill_switch_on",
  "settings_unreadable",
  "instance_off",
  "ask_type_not_allowed",
  "irreversible_term",
  "resolution_not_decision_only",
  "provider_unverified",
  "throughput_exceeded",
  "input_limit_exceeded",
  "card_secret_detected",
] as const satisfies readonly DmRoutingRefusal[];

/**
 * The request event kinds. Each is named after its §10 audit action
 * (`amux.decision.<kind>`), and the trigger requires exactly that action.
 */
export const DM_REQUEST_EVENT_KINDS = [
  "assign",
  "assign_discarded",
  "transmit_intent",
  "transmit_receipt",
  "transmit_unknown",
  "result",
  "result_rejected",
  "result_unknown",
  "stale_close",
] as const;
export type DmRequestEventKind = (typeof DM_REQUEST_EVENT_KINDS)[number];

/** Recorded by the router's actor; every other kind by the request's instance. */
export const DM_ROUTER_EVENT_KINDS = ["assign", "assign_discarded", "stale_close"] as const;

/**
 * A person's judgment of the request's proposal (§2-6, stage S1e), each named
 * after the person's §10 audit action (`amux.decision.confirm`,
 * `.edit_confirm`, `.reject`). A judgment closes its request. This module
 * never writes these kinds: the judgment table's own trigger (migration
 * 20261008130100_amux_decision_maker_judgment_delivery) inserts the event in
 * the judgment's statement, and the event guard accepts one only beside the
 * judgment row of the same transaction, kind and audit row.
 */
export const DM_JUDGMENT_EVENT_KINDS = ["confirm", "edit_confirm", "reject"] as const;
export type DmJudgmentEventKind = (typeof DM_JUDGMENT_EVENT_KINDS)[number];

/**
 * Every kind the event table holds, as its kind CHECK lists them since stage
 * S1e: this module's nine and a judgment's three.
 */
export const DM_LEDGER_EVENT_KINDS = [...DM_REQUEST_EVENT_KINDS, ...DM_JUDGMENT_EVENT_KINDS] as const;

/** The router's closing events (stage S1c). */
export const DM_ROUTER_CLOSING_EVENT_KINDS = ["assign_discarded", "stale_close"] as const;

/**
 * Events that close a request: the router's, and since stage S1e a person's
 * judgment. A request routed to the operator is closed from its creation.
 * One per request (the partial unique index of the closing kinds).
 */
export const DM_CLOSING_EVENT_KINDS = [...DM_ROUTER_CLOSING_EVENT_KINDS, ...DM_JUDGMENT_EVENT_KINDS] as const;

/** §6: the five terminal results; a request has at most one. */
export const DM_RESULT_KINDS = ["proposal", "escalate", "validation_failure", "timeout", "unavailable"] as const;
export type DmResultKind = (typeof DM_RESULT_KINDS)[number];

/**
 * The terminal results that are a DM's output and so are held to the result
 * deadline (§9). A timeout comes after that deadline by definition, and
 * "DM 불가" is not an output; both only hand the question to the operator.
 */
export const DM_DEADLINE_RESULT_KINDS = ["proposal", "escalate", "validation_failure"] as const;

/**
 * Why an arriving result was recorded as rejected (§6, §9). The first five
 * the trigger checks against the ledger's own state; `binding_mismatch` and
 * `kill_switch` are decided from values outside the ledger's state (the
 * submission and the switch store).
 */
export const DM_RESULT_REJECTION_REASONS = [
  "request_closed",
  "terminal_exists",
  "result_unknown",
  "not_transmitted",
  "deadline_passed",
  "binding_mismatch",
  "kill_switch",
] as const;
export type DmResultRejectionReason = (typeof DM_RESULT_REJECTION_REASONS)[number];

/** §5: what the DM was given from the repository. */
export const DM_SNAPSHOT_STATES = ["none", "worker_head", "develop"] as const;
export type DmSnapshotState = (typeof DM_SNAPSHOT_STATES)[number];

/** §10: the transmission records the vendor; §7 fixes it per instance. */
export const DM_VENDORS = ["openai", "anthropic"] as const;
export type DmVendor = (typeof DM_VENDORS)[number];
export const DM_VENDOR_FOR_INSTANCE = Object.freeze({
  "decision-maker-openai": "openai",
  "decision-maker-anthropic": "anthropic",
} as const satisfies Record<DmInstanceScope, DmVendor>);

/** §10's actors and actions for the ledger. */
export const DM_ROUTER_SYSTEM_ACTOR = "amux-decision-router" as const;
export const DM_REQUEST_AUDIT_ACTION = "amux.decision.route" as const;
export const DM_REQUEST_AUDIT_TARGET_TYPE = "AmuxDecisionMakerRequest" as const;
export const DM_REQUEST_EVENT_AUDIT_TARGET_TYPE = "AmuxDecisionMakerRequestEvent" as const;
export const dmEventAuditAction = (kind: DmRequestEventKind): string => `amux.decision.${kind}`;

/** §2, §9: the database-clock windows. */
export const DM_ASSIGNMENT_WINDOW_MS = 2 * 60 * 1000;
export const DM_RESULT_WINDOW_MS = 30 * 60 * 1000;
/**
 * §10: an open request is closed as stale 30 days after it was created --
 * exactly 720 hours. Since migration
 * 20261008130000_amux_decision_maker_stale_close_hours the event guard adds
 * `INTERVAL '720 hours'`, a fixed length, as this does; its earlier 30-day
 * interval followed the session time zone's calendar and was an hour off across
 * a daylight-saving change.
 */
export const DM_STALE_CLOSE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** §9: the commit reserve, `AMUX_DB_COMMIT_RESERVE_MS`; a deadline D is the window's end less this. */
export const DM_COMMIT_RESERVE_MS = 200;

const isRouterKind = (kind: DmRequestEventKind) => (DM_ROUTER_EVENT_KINDS as readonly string[]).includes(kind);

/**
 * The system actor whose audit entry an event needs: the router for
 * assignment and closing, the request's own instance for transmission and
 * results. The trigger holds the same rule.
 */
export const dmEventAuditActor = (
  kind: DmRequestEventKind,
  instance: DmInstanceScope | null,
): "amux-decision-router" | "amux-decision-maker-openai" | "amux-decision-maker-anthropic" => {
  if (isRouterKind(kind)) return DM_ROUTER_SYSTEM_ACTOR;
  if (instance === null) throw new Error(`AMUX Decision Maker ${kind} event needs an instance`);
  return DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE[instance];
};

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** Card, worker and session ids from the local AMUX: printable, no spaces, no slashes. */
const LEDGER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Term list, classification and scanner versions. */
const VERSION_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INT32_MAX = 2_147_483_647;

export const isDmLedgerIdentifier = (value: unknown): value is string =>
  typeof value === "string" && LEDGER_IDENTIFIER.test(value);
export const isDmVersionIdentifier = (value: unknown): value is string =>
  typeof value === "string" && VERSION_IDENTIFIER.test(value);
export const isDmProviderId = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_ID.test(value);
/**
 * An opaque 64-hex digest; the ledger only stores it. Stage S1d settled what
 * it is (§10, lib/amux/decisionMakerBodyCore.ts): an HMAC-SHA256 under the
 * request's own key, derived from the key of the request's 30-day key period
 * -- the input payload and snapshot manifest digests by the broker, which
 * receives the request key at assignment, and the result digest by the app,
 * from the output it stores. Never a plain hash.
 */
export const isDmDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
export const isDmRequestId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isNonNegativeInt32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= INT32_MAX;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const ownKeysAre = (value: object, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

// ---------------------------------------------------------------------------
// The request row
// ---------------------------------------------------------------------------

/** §9's binding values known when a question is routed. */
export type DmRequestBinding = {
  cardId: string;
  questionRevision: number;
  askingWorkerId: string;
  amuxSessionId: string;
  amuxSessionAttempt: number;
  askingProvider: string;
  optionSetDigest: string;
  termListVersion: string;
  classificationVersion: string;
  scannerVersion: string;
};

export const DM_REQUEST_BINDING_KEYS = [
  "cardId",
  "questionRevision",
  "askingWorkerId",
  "amuxSessionId",
  "amuxSessionAttempt",
  "askingProvider",
  "optionSetDigest",
  "termListVersion",
  "classificationVersion",
  "scannerVersion",
] as const satisfies ReadonlyArray<keyof DmRequestBinding>;

/** The format of each binding value; the migration's CHECKs hold the same. */
const BINDING_FIELD_CHECKS: Readonly<Record<keyof DmRequestBinding, (value: unknown) => boolean>> = {
  cardId: isDmLedgerIdentifier,
  questionRevision: isNonNegativeInt32,
  askingWorkerId: isDmLedgerIdentifier,
  amuxSessionId: isDmLedgerIdentifier,
  amuxSessionAttempt: isNonNegativeInt32,
  askingProvider: isDmProviderId,
  optionSetDigest: isDmDigest,
  termListVersion: isDmVersionIdentifier,
  classificationVersion: isDmVersionIdentifier,
  scannerVersion: isDmVersionIdentifier,
};

const bindingFieldsValid = (record: Record<string, unknown>, keys: ReadonlyArray<keyof DmRequestBinding>) =>
  keys.every((key) => BINDING_FIELD_CHECKS[key](record[key]));

export const parseDmRequestBinding = (value: unknown): DmRequestBinding | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ownKeysAre(value, DM_REQUEST_BINDING_KEYS)) return null;
  const binding = value as Record<string, unknown>;
  if (!bindingFieldsValid(binding, DM_REQUEST_BINDING_KEYS)) return null;
  return Object.fromEntries(DM_REQUEST_BINDING_KEYS.map((key) => [key, binding[key]])) as DmRequestBinding;
};

/**
 * What a routing caller supplies: every binding value but the option set
 * digest, which the store computes itself from the card's options under the
 * request's key (stage S1d, 2026-10-08). A caller-supplied digest could be a
 * plain hash of the option labels, which §10 forbids, and nothing tied it to
 * the options a result is later checked against.
 */
export type DmRoutingBinding = Omit<DmRequestBinding, "optionSetDigest">;

export const DM_ROUTING_BINDING_KEYS = DM_REQUEST_BINDING_KEYS.filter(
  (key): key is Exclude<keyof DmRequestBinding, "optionSetDigest"> => key !== "optionSetDigest",
);

export const parseDmRoutingBinding = (value: unknown): DmRoutingBinding | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ownKeysAre(value, DM_ROUTING_BINDING_KEYS)) return null;
  const binding = value as Record<string, unknown>;
  if (!bindingFieldsValid(binding, DM_ROUTING_BINDING_KEYS)) return null;
  return Object.fromEntries(DM_ROUTING_BINDING_KEYS.map((key) => [key, binding[key]])) as DmRoutingBinding;
};

/** What the request row records: the binding, the router's decision and the policy version. */
export type DmRequestRecordInput = DmRequestBinding & {
  policyVersion: number;
  route: DmRequestRoute;
  instance: DmInstanceScope | null;
  refusalCodes: DmRoutingRefusal[];
};

/**
 * The binding and a `routeDmQuestion()` decision, checked against each other
 * the way the migration's CHECKs check the stored row: the instance is the
 * provider's (§7) or none, `dm_proposal` carries no refusal and `operator` at
 * least one, every refusal is the router's and appears once, and an
 * unverified provider is exactly the case with no instance. The policy version
 * is this code's (§9). Null when anything disagrees.
 */
export const parseDmRequestRecord = (binding: unknown, decision: unknown): DmRequestRecordInput | null => {
  const parsedBinding = parseDmRequestBinding(binding);
  if (!parsedBinding) return null;
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) return null;
  const { route, instance, refusals } = decision as { route?: unknown; instance?: unknown; refusals?: unknown };
  if (!isOneOf(DM_REQUEST_ROUTES, route)) return null;
  if (instance !== null && !isDmInstanceScope(instance)) return null;
  if (instance !== dmInstanceForProvider(parsedBinding.askingProvider)) return null;
  if (!Array.isArray(refusals) || !refusals.every((code) => isOneOf(DM_ROUTING_REFUSAL_CODES, code))) return null;
  if (new Set(refusals).size !== refusals.length) return null;
  if ((route === "dm_proposal") !== (refusals.length === 0)) return null;
  if (refusals.includes("provider_unverified") !== (instance === null)) return null;
  return {
    ...parsedBinding,
    policyVersion: DM_POLICY_VERSION,
    route,
    instance,
    refusalCodes: [...refusals] as DmRoutingRefusal[],
  };
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const CARD_KEYS = [
  "askType",
  "resolution",
  "type",
  "tags",
  "title",
  "question",
  "options",
  "unblocks",
  "context",
  "contextPaths",
] as const satisfies ReadonlyArray<keyof DmCard>;

/**
 * The typed ask `routeDmQuestion()` reads, checked for shape only: strings,
 * string lists and `{ id, label }` options, nothing else. Sizes, terms,
 * paths and secrets are the router's own checks, which send an oversize or
 * unsafe card to the operator rather than refuse it here. The card is routed
 * and never stored (§10: "본문은 원장에 넣지 않는다").
 */
export const parseDmCard = (value: unknown): DmCard | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ownKeysAre(value, CARD_KEYS)) return null;
  const card = value as Record<string, unknown>;
  if (
    typeof card.askType !== "string" ||
    (card.resolution !== null && typeof card.resolution !== "string") ||
    typeof card.type !== "string" ||
    !isStringArray(card.tags) ||
    typeof card.title !== "string" ||
    typeof card.question !== "string" ||
    !Array.isArray(card.options) ||
    !card.options.every(
      (option) =>
        option !== null &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        ownKeysAre(option, ["id", "label"]) &&
        typeof (option as { id: unknown }).id === "string" &&
        typeof (option as { label: unknown }).label === "string",
    ) ||
    typeof card.unblocks !== "string" ||
    typeof card.context !== "string" ||
    !isStringArray(card.contextPaths)
  ) {
    return null;
  }
  return card as unknown as DmCard;
};

// ---------------------------------------------------------------------------
// The transmission record (§5, §10)
// ---------------------------------------------------------------------------

export type DmTransmission = {
  snapshotState: DmSnapshotState;
  /** Null exactly when the snapshot state is `none`. */
  snapshotTargetSha: string | null;
  /** Null exactly when the snapshot state is `none`. */
  snapshotManifestDigest: string | null;
  inputPayloadDigest: string;
};

const TRANSMISSION_KEYS = ["snapshotState", "snapshotTargetSha", "snapshotManifestDigest", "inputPayloadDigest"] as const;

export const parseDmTransmission = (value: unknown): DmTransmission | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ownKeysAre(value, TRANSMISSION_KEYS)) return null;
  const record = value as Record<string, unknown>;
  if (!isOneOf(DM_SNAPSHOT_STATES, record.snapshotState) || !isDmDigest(record.inputPayloadDigest)) return null;
  if (record.snapshotState === "none") {
    if (record.snapshotTargetSha !== null || record.snapshotManifestDigest !== null) return null;
  } else if (
    typeof record.snapshotTargetSha !== "string" ||
    !isSnapshotTargetSha(record.snapshotTargetSha) ||
    !isDmDigest(record.snapshotManifestDigest)
  ) {
    return null;
  }
  return {
    snapshotState: record.snapshotState,
    snapshotTargetSha: record.snapshotTargetSha as string | null,
    snapshotManifestDigest: record.snapshotManifestDigest as string | null,
    inputPayloadDigest: record.inputPayloadDigest,
  };
};

// ---------------------------------------------------------------------------
// A request's state, from the store's one state read
// ---------------------------------------------------------------------------

export type DmRequestClosing = "routed_to_operator" | (typeof DM_CLOSING_EVENT_KINDS)[number];

export type DmRequestState = {
  requestId: string;
  binding: DmRequestBinding & { policyVersion: number };
  route: DmRequestRoute;
  instance: DmInstanceScope | null;
  createdAtMs: number;
  assignmentDeadlineAtMs: number;
  /** The database clock when the state was read. */
  dbNowMs: number;
  assigned: boolean;
  /** Set by the assignment: its database clock plus 30 minutes. */
  resultDeadlineAtMs: number | null;
  transmission: DmTransmission | null;
  transmitOutcome: "receipt" | "unknown" | null;
  terminal: { eventId: string; resultKind: DmResultKind; resultDigest: string } | null;
  resultUnknown: boolean;
  /** Why the request is closed; a request routed to the operator is closed from its creation. */
  closing: DmRequestClosing | null;
  /** The rejection already recorded for the digest the read probed, if any. */
  probedRejection: DmResultRejectionReason | null;
};

const epochMs = (value: unknown): number | null => {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};

const nullableEpochMs = (value: unknown): number | null | undefined =>
  value === null ? null : (epochMs(value) ?? undefined);

/**
 * The state from one row of the store's state read. Anything the ledger's
 * CHECKs could not have produced makes the whole state unreadable (null):
 * a write is then refused rather than decided on a row nobody understands.
 */
export const dmRequestStateFromRow = (row: unknown): DmRequestState | null => {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const binding = parseDmRequestBinding(
    Object.fromEntries(DM_REQUEST_BINDING_KEYS.map((key) => [key, r[key]])),
  );
  if (!binding || !isDmRequestId(r.id)) return null;
  if (!isOneOf(DM_REQUEST_ROUTES, r.route)) return null;
  if (r.instance !== null && !isDmInstanceScope(r.instance)) return null;
  if (typeof r.policyVersion !== "number" || !Number.isInteger(r.policyVersion) || r.policyVersion < 1) return null;
  const createdAtMs = epochMs(r.createdAtEpochMs);
  const assignmentDeadlineAtMs = epochMs(r.assignmentDeadlineAtEpochMs);
  const dbNowMs = epochMs(r.dbNowEpochMs);
  const resultDeadlineAtMs = nullableEpochMs(r.resultDeadlineAtEpochMs);
  if (createdAtMs === null || assignmentDeadlineAtMs === null || dbNowMs === null || resultDeadlineAtMs === undefined) {
    return null;
  }
  if (typeof r.assigned !== "boolean" || typeof r.transmitted !== "boolean" || typeof r.resultUnknown !== "boolean") {
    return null;
  }
  if (r.assigned !== (resultDeadlineAtMs !== null)) return null;

  let transmission: DmTransmission | null = null;
  if (r.transmitted) {
    transmission = parseDmTransmission({
      snapshotState: r.snapshotState,
      snapshotTargetSha: r.snapshotTargetSha,
      snapshotManifestDigest: r.snapshotManifestDigest,
      inputPayloadDigest: r.inputPayloadDigest,
    });
    if (!transmission) return null;
  }

  let transmitOutcome: DmRequestState["transmitOutcome"] = null;
  if (r.transmitOutcome === "transmit_receipt") transmitOutcome = "receipt";
  else if (r.transmitOutcome === "transmit_unknown") transmitOutcome = "unknown";
  else if (r.transmitOutcome !== null) return null;

  let terminal: DmRequestState["terminal"] = null;
  if (r.terminalEventId !== null) {
    if (!isDmRequestId(r.terminalEventId) || !isOneOf(DM_RESULT_KINDS, r.terminalResultKind) || !isDmDigest(r.terminalResultDigest)) {
      return null;
    }
    terminal = { eventId: r.terminalEventId, resultKind: r.terminalResultKind, resultDigest: r.terminalResultDigest };
  }

  let closing: DmRequestClosing | null = null;
  if (r.closingKind !== null) {
    if (!isOneOf(DM_CLOSING_EVENT_KINDS, r.closingKind)) return null;
    closing = r.closingKind;
  }
  if (r.route === "operator") closing = "routed_to_operator";

  let probedRejection: DmResultRejectionReason | null = null;
  if (r.probedRejection !== null && r.probedRejection !== undefined) {
    if (!isOneOf(DM_RESULT_REJECTION_REASONS, r.probedRejection)) return null;
    probedRejection = r.probedRejection;
  }

  return {
    requestId: r.id,
    binding: { ...binding, policyVersion: r.policyVersion },
    route: r.route,
    instance: r.instance as DmInstanceScope | null,
    createdAtMs,
    assignmentDeadlineAtMs,
    dbNowMs,
    assigned: r.assigned,
    resultDeadlineAtMs,
    transmission,
    transmitOutcome,
    terminal,
    resultUnknown: r.resultUnknown,
    closing,
    probedRejection,
  };
};

// ---------------------------------------------------------------------------
// The transition graph
// ---------------------------------------------------------------------------

export type DmEventAttempt =
  | { kind: "assign" }
  | { kind: "assign_discarded" }
  | { kind: "transmit_intent"; instance: DmInstanceScope }
  | { kind: "transmit_receipt"; instance: DmInstanceScope }
  | { kind: "transmit_unknown"; instance: DmInstanceScope }
  | {
      kind: "result";
      instance: DmInstanceScope;
      resultKind: DmResultKind;
      resultDigest: string;
      inputPayloadDigest: string | null;
    }
  | { kind: "result_rejected"; instance: DmInstanceScope; resultDigest: string; rejectionReason: DmResultRejectionReason }
  | { kind: "result_unknown"; instance: DmInstanceScope; resultDigest: string }
  | { kind: "stale_close" };

/** Why the graph refuses an event. Each names one clause of the trigger. */
export type DmEventRefusal =
  | "instance_mismatch"
  | "not_routed_to_dm"
  | "closed"
  | "already_assigned"
  | "not_assigned"
  | "already_transmitted"
  | "not_transmitted"
  | "transmit_outcome_recorded"
  | "result_recorded"
  | "result_unknown_recorded"
  | "payload_mismatch"
  | "reason_inconsistent"
  | "not_stale"
  | "deadline_passed";

const deadlineReached = (nowMs: number, deadlineMs: number | null) =>
  deadlineMs === null || nowMs >= deadlineMs - DM_COMMIT_RESERVE_MS;

export const isDmDeadlineResultKind = (kind: DmResultKind): boolean =>
  (DM_DEADLINE_RESULT_KINDS as readonly string[]).includes(kind);

/**
 * Whether the trigger of migration 20261008090100 accepts this event on a
 * request in this state, at the state's database clock: null when it does,
 * otherwise the first clause it fails.
 *
 * - `assign`: a request routed to a DM, open, not yet assigned, before its
 *   assignment deadline (creation + 2 min) less the commit reserve.
 * - `assign_discarded`: assigned, open, and nothing has happened since --
 *   the local AMUX could not mark the card (§2-3). Closes the request.
 * - `transmit_intent`: assigned, open, not yet transmitted, no result and no
 *   unknown result, before the result deadline less the reserve. One per
 *   request: §10 "그 요청은 다시 보내지 않는다".
 * - `transmit_receipt` / `transmit_unknown`: after the intent, one of the two
 *   once. Accepted after the request closed or its result arrived: a
 *   transmission that happened is a fact either way.
 * - `result`: assigned, open, no result and no unknown result; every kind but
 *   `unavailable` needs the transmission intent, and the result names the
 *   intent's payload digest (none without an intent). A DM output (proposal,
 *   escalation, validation failure) must arrive before the result deadline
 *   less the reserve.
 * - `result_rejected`: always accepted for the request's own instance, but a
 *   reason the ledger can check must hold: closed, another digest's result,
 *   an unknown result, no intent, or the deadline reached.
 * - `result_unknown`: assigned, open, no result and no earlier unknown.
 * - `stale_close`: open, and 720 hours after creation.
 *
 * A request routed to the operator is closed from its creation, so only a
 * rejection can ever be recorded against it. A person's judgment (stage S1e)
 * closes a request too; it is not an attempt here, because the judgment
 * store records it and the database writes its event.
 */
export const dmEventRefusal = (state: DmRequestState, attempt: DmEventAttempt): DmEventRefusal | null => {
  const closed = state.closing !== null;
  if ("instance" in attempt && attempt.instance !== state.instance) return "instance_mismatch";

  switch (attempt.kind) {
    case "assign":
      if (state.route !== "dm_proposal") return "not_routed_to_dm";
      if (closed) return "closed";
      if (state.assigned) return "already_assigned";
      if (deadlineReached(state.dbNowMs, state.assignmentDeadlineAtMs)) return "deadline_passed";
      return null;
    case "assign_discarded":
      if (!state.assigned) return "not_assigned";
      if (closed) return "closed";
      if (state.transmission !== null) return "already_transmitted";
      if (state.terminal !== null) return "result_recorded";
      if (state.resultUnknown) return "result_unknown_recorded";
      return null;
    case "transmit_intent":
      if (!state.assigned) return "not_assigned";
      if (closed) return "closed";
      if (state.transmission !== null) return "already_transmitted";
      if (state.terminal !== null) return "result_recorded";
      if (state.resultUnknown) return "result_unknown_recorded";
      if (deadlineReached(state.dbNowMs, state.resultDeadlineAtMs)) return "deadline_passed";
      return null;
    case "transmit_receipt":
    case "transmit_unknown":
      if (state.transmission === null) return "not_transmitted";
      if (state.transmitOutcome !== null) return "transmit_outcome_recorded";
      return null;
    case "result":
      if (!state.assigned) return "not_assigned";
      if (closed) return "closed";
      if (state.terminal !== null) return "result_recorded";
      if (state.resultUnknown) return "result_unknown_recorded";
      if (state.transmission === null && attempt.resultKind !== "unavailable") return "not_transmitted";
      if (attempt.inputPayloadDigest !== (state.transmission?.inputPayloadDigest ?? null)) return "payload_mismatch";
      if (isDmDeadlineResultKind(attempt.resultKind) && deadlineReached(state.dbNowMs, state.resultDeadlineAtMs)) {
        return "deadline_passed";
      }
      return null;
    case "result_rejected": {
      const consistent = (() => {
        switch (attempt.rejectionReason) {
          case "request_closed":
            return closed;
          case "terminal_exists":
            return state.terminal !== null && state.terminal.resultDigest !== attempt.resultDigest;
          case "result_unknown":
            return state.resultUnknown;
          case "not_transmitted":
            return state.transmission === null;
          case "deadline_passed":
            return state.assigned && deadlineReached(state.dbNowMs, state.resultDeadlineAtMs);
          // The kill switch half is dmEventSwitchRefusal()'s; the binding is
          // the submission's, which the ledger does not keep.
          case "binding_mismatch":
          case "kill_switch":
            return true;
        }
      })();
      return consistent ? null : "reason_inconsistent";
    }
    case "result_unknown":
      if (!state.assigned) return "not_assigned";
      if (closed) return "closed";
      if (state.terminal !== null) return "result_recorded";
      if (state.resultUnknown) return "result_unknown_recorded";
      return null;
    case "stale_close":
      if (closed) return "closed";
      if (state.dbNowMs < state.createdAtMs + DM_STALE_CLOSE_AFTER_MS) return "not_stale";
      return null;
  }
};

/**
 * §6, §8: no DM process starts while the kill switch is on or the instance is
 * `off`, and an unreadable switch counts as both (S1b's read is fail-closed).
 * The transmission intent is the gate before any process start (§10), so the
 * writer refuses it on its own read of the switch store, taken after the lock
 * every switch change also takes; nothing is recorded for a refusal. The
 * ledger trigger refuses the same intent under the switch gate.
 */
export type DmTransmitSwitchRefusal = "settings_unreadable" | "kill_switch_on" | "instance_off";

export const dmTransmitSwitchRefusal = (switches: {
  killSwitch: boolean | null;
  instanceMode: "off" | "proposal" | null;
}): DmTransmitSwitchRefusal | null => {
  if (switches.killSwitch === null || switches.instanceMode === null) return "settings_unreadable";
  if (switches.killSwitch) return "kill_switch_on";
  if (switches.instanceMode !== "proposal") return "instance_off";
  return null;
};

/**
 * The switch clause of the event trigger, which runs after the graph and the
 * deadlines (`dmEventRefusal()`), on the switch store's newest events read
 * under the switch gate: a transmission intent needs the kill switch off and
 * the instance in proposal mode; a proposal needs the kill switch off; a
 * rejection that cites the kill switch needs it on. Instance `off` stops only
 * routing and process start (§8), so it never refuses a result. An unreadable
 * switch (null) counts as on, and cannot be cited as on. The trigger raises
 * `reason_inconsistent` as its transition refusal and the other two as its
 * switch refusal.
 */
export const dmEventSwitchRefusal = (
  attempt: DmEventAttempt,
  switches: { killSwitch: boolean | null; instanceMode: "off" | "proposal" | null },
): "kill_switch_on" | "instance_off" | "reason_inconsistent" | null => {
  const killOn = switches.killSwitch !== false;
  switch (attempt.kind) {
    case "transmit_intent":
      if (killOn) return "kill_switch_on";
      return switches.instanceMode === "proposal" ? null : "instance_off";
    case "result":
      return attempt.resultKind === "proposal" && killOn ? "kill_switch_on" : null;
    case "result_rejected":
      return attempt.rejectionReason === "kill_switch" && switches.killSwitch !== true ? "reason_inconsistent" : null;
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// Result submission (§6, §9)
// ---------------------------------------------------------------------------

/** §9's binding values as the submitter knows them. */
export type DmResultBinding = Omit<DmRequestBinding, "askingProvider"> & {
  policyVersion: number;
  /** Null when nothing was transmitted (an `unavailable` result before the intent). */
  transmission: DmTransmission | null;
};

/** The request binding values a submission repeats: all but the provider, which the instance already is. */
const SUBMITTED_REQUEST_BINDING_KEYS = DM_REQUEST_BINDING_KEYS.filter(
  (key): key is Exclude<keyof DmRequestBinding, "askingProvider"> => key !== "askingProvider",
);
const RESULT_BINDING_KEYS = [...SUBMITTED_REQUEST_BINDING_KEYS, "policyVersion", "transmission"] as const;

export type DmResultSubmission = {
  instance: DmInstanceScope;
  resultKind: DmResultKind;
  resultDigest: string;
  binding: DmResultBinding;
};

export const parseDmResultSubmission = (value: unknown): DmResultSubmission | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ownKeysAre(value, ["instance", "resultKind", "resultDigest", "binding"])) return null;
  const record = value as Record<string, unknown>;
  if (!isDmInstanceScope(record.instance) || !isOneOf(DM_RESULT_KINDS, record.resultKind) || !isDmDigest(record.resultDigest)) {
    return null;
  }
  const binding = record.binding;
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return null;
  if (!ownKeysAre(binding, RESULT_BINDING_KEYS)) return null;
  const b = binding as Record<string, unknown>;
  if (!bindingFieldsValid(b, SUBMITTED_REQUEST_BINDING_KEYS)) return null;
  if (typeof b.policyVersion !== "number" || !Number.isInteger(b.policyVersion) || b.policyVersion < 1) return null;
  const transmission = b.transmission === null ? null : parseDmTransmission(b.transmission);
  if (b.transmission !== null && transmission === null) return null;
  return {
    instance: record.instance,
    resultKind: record.resultKind,
    resultDigest: record.resultDigest,
    binding: {
      ...(Object.fromEntries(SUBMITTED_REQUEST_BINDING_KEYS.map((key) => [key, b[key]])) as Omit<
        DmRequestBinding,
        "askingProvider"
      >),
      policyVersion: b.policyVersion,
      transmission,
    },
  };
};

const sameTransmission = (left: DmTransmission | null, right: DmTransmission | null) =>
  left === null || right === null
    ? left === right
    : left.snapshotState === right.snapshotState &&
      left.snapshotTargetSha === right.snapshotTargetSha &&
      left.snapshotManifestDigest === right.snapshotManifestDigest &&
      left.inputPayloadDigest === right.inputPayloadDigest;

/** §9: every binding value the submission carries equals the stored one. */
export const dmResultBindingMatches = (state: DmRequestState, binding: DmResultBinding): boolean =>
  SUBMITTED_REQUEST_BINDING_KEYS.every((key) => state.binding[key] === binding[key]) &&
  state.binding.policyVersion === binding.policyVersion &&
  sameTransmission(state.transmission, binding.transmission);

export type DmResultSubmissionOutcome =
  | { outcome: "existing_result"; eventId: string; resultKind: DmResultKind }
  | { outcome: "existing_rejection"; reason: DmResultRejectionReason }
  | { outcome: "accept" }
  | { outcome: "reject"; reason: DmResultRejectionReason };

/**
 * What a result submission becomes (§6, §9), read on the request's state:
 *
 * - the same (request, digest) pair as the recorded result returns that
 *   result, and the same digest already rejected returns that rejection --
 *   neither writes again, so a submission is idempotent on the pair;
 * - otherwise a closed request, an unknown result, another digest's result,
 *   no transmission, a binding that differs, a DM output at or past the
 *   result deadline less the reserve, and a proposal while the kill switch is
 *   on or unreadable (§6's table: "진행 중 결과의 제안 저장 — 거부") are each
 *   recorded as a rejection;
 * - anything else is accepted as the request's one terminal result.
 *
 * The submission's instance must be the request's; the store refuses one that
 * is not before this is reached, since nothing can be recorded for it. The
 * store passes its own read of the kill switch, taken after the lock every
 * switch change also takes, and never null: it writes nothing when the switch
 * store is unreadable.
 */
export const dmResultSubmissionOutcome = (
  state: DmRequestState,
  submission: DmResultSubmission,
  killSwitch: boolean | null,
): DmResultSubmissionOutcome => {
  if (state.terminal !== null && state.terminal.resultDigest === submission.resultDigest) {
    return { outcome: "existing_result", eventId: state.terminal.eventId, resultKind: state.terminal.resultKind };
  }
  if (state.probedRejection !== null) return { outcome: "existing_rejection", reason: state.probedRejection };
  if (state.closing !== null) return { outcome: "reject", reason: "request_closed" };
  if (state.resultUnknown) return { outcome: "reject", reason: "result_unknown" };
  if (state.terminal !== null) return { outcome: "reject", reason: "terminal_exists" };
  if (!state.assigned || (state.transmission === null && submission.resultKind !== "unavailable")) {
    return { outcome: "reject", reason: "not_transmitted" };
  }
  if (!dmResultBindingMatches(state, submission.binding)) return { outcome: "reject", reason: "binding_mismatch" };
  if (isDmDeadlineResultKind(submission.resultKind) && deadlineReached(state.dbNowMs, state.resultDeadlineAtMs)) {
    return { outcome: "reject", reason: "deadline_passed" };
  }
  if (submission.resultKind === "proposal" && killSwitch !== false) return { outcome: "reject", reason: "kill_switch" };
  return { outcome: "accept" };
};

/** §9: what a submitter that lost a response learns from the (request, digest) pair. */
export type DmResultLookup =
  | { status: "accepted"; eventId: string; resultKind: DmResultKind }
  | { status: "rejected"; reason: DmResultRejectionReason }
  | { status: "not_recorded" };

export const dmResultLookup = (state: DmRequestState, resultDigest: string): DmResultLookup => {
  if (state.terminal !== null && state.terminal.resultDigest === resultDigest) {
    return { status: "accepted", eventId: state.terminal.eventId, resultKind: state.terminal.resultKind };
  }
  if (state.probedRejection !== null) return { status: "rejected", reason: state.probedRejection };
  return { status: "not_recorded" };
};

// ---------------------------------------------------------------------------
// Audit metadata
// ---------------------------------------------------------------------------

export const DM_REQUEST_AUDIT_METADATA_KEYS = ["request_id", "route", "instance", "asking_provider", "refusal_codes"] as const;
export const DM_EVENT_AUDIT_METADATA_KEYS = [
  "event_id",
  "request_id",
  "kind",
  "instance",
  "vendor",
  "snapshot_state",
  "result_kind",
  "rejection_reason",
] as const;

const AUDIT_TOKEN = /^[a-z0-9_-]{1,64}$/;

const auditToken = (key: string, value: unknown): string => {
  if (typeof value !== "string" || !AUDIT_TOKEN.test(value)) {
    throw new Error(`AMUX Decision Maker ledger audit metadata value refused: ${key}`);
  }
  return value;
};

/**
 * A request's audit metadata: closed keys, short tokens, and the refusal
 * codes as a list of tokens. No card id, digest or text.
 */
export const dmRequestAuditMetadata = (record: {
  requestId: string;
  route: DmRequestRoute;
  instance: DmInstanceScope | null;
  askingProvider: string;
  refusalCodes: readonly string[];
}): Record<string, string | string[]> => {
  const metadata: Record<string, string | string[]> = {
    request_id: auditToken("request_id", record.requestId),
    route: auditToken("route", record.route),
    asking_provider: auditToken("asking_provider", record.askingProvider),
    refusal_codes: record.refusalCodes.map((code) => auditToken("refusal_codes", code)),
  };
  if (record.instance !== null) metadata.instance = auditToken("instance", record.instance);
  return metadata;
};

/** An event's audit metadata: closed keys and short tokens. No digest, SHA or text. */
export const dmEventAuditMetadata = (
  fields: Partial<Record<(typeof DM_EVENT_AUDIT_METADATA_KEYS)[number], string | null>>,
): Record<string, string> => {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!(DM_EVENT_AUDIT_METADATA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`AMUX Decision Maker ledger audit metadata key refused: ${key}`);
    }
    if (value === null || value === undefined) continue;
    metadata[key] = auditToken(key, value);
  }
  return metadata;
};
