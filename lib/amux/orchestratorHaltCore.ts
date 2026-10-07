/**
 * Orchestration policy version 20 ("orchestrator 정지(halt)와 재시작"):
 * the closed lists, the request identity headers and the pure judgements.
 *
 * docs/policy/development-agent-orchestration.md, version 20. The
 * orchestrator no longer ends its process on a write whose outcome it does
 * not know. The server admits each write call before processing it
 * (`AmuxOrchestratorWrite`), writes a receipt beside every state change it
 * commits (`AmuxOrchestratorWriteReceipt`), and keeps the orchestrator's halt
 * (`AmuxOrchestratorHalt`) until a person clears it.
 *
 * Pure: no database, no `server-only`, so the store, the routes, the Admin
 * screen, the enum-constraint check and the unit tests read one copy. The
 * database CHECK constraints of migration
 * 20260930120000_amux_orchestrator_halt hold the same lists, and
 * `npm run check:enum-constraints` compares them.
 */

/** Section 4: the three orchestrator write calls. */
export const AMUX_ORCHESTRATOR_CALL_KINDS = [
  "claim",
  "recover",
  "auto_promotion_tick",
] as const;
export type AmuxOrchestratorCallKind =
  (typeof AMUX_ORCHESTRATOR_CALL_KINDS)[number];

/**
 * Section 4: what a receipt names. Card owner, revision and status; claim
 * decision; attempt; automatic promotion grant and consumption; the quota
 * observation sweep, which deletes a batch and so names no single row.
 */
export const AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS = [
  "work_item",
  "claim_decision",
  "execution_attempt",
  "auto_promotion_grant",
  "auto_promotion_consumption",
  "v22_promotion_receipt",
  "v22_promotion_unknown",
  "v22_promotion_halt",
  "v22_worker_assignment",
  "quota_observation_batch",
] as const;
export type AmuxOrchestratorReceiptTargetKind =
  (typeof AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS)[number];

/** Section 4 and 7: how an admission is closed other than by an ack. */
export const AMUX_ORCHESTRATOR_RESOLUTIONS = [
  "no_commit",
  "human_confirmed",
] as const;
export type AmuxOrchestratorResolution =
  (typeof AMUX_ORCHESTRATOR_RESOLUTIONS)[number];

/** Section 2: the closed list of halt reasons. */
export const AMUX_ORCHESTRATOR_HALT_REASON_CODES = [
  "claim_outcome_unknown",
  "recovery_outcome_unknown",
  "promotion_outcome_unknown",
  "unacked_write_receipt",
  "contract_violation",
  "selection_read_failures",
] as const;
export type AmuxOrchestratorHaltReasonCode =
  (typeof AMUX_ORCHESTRATOR_HALT_REASON_CODES)[number];

/**
 * The reasons that are about one write call: their halt key is that call's
 * request id (section 5). The other two carry no request id.
 */
export const AMUX_ORCHESTRATOR_REQUEST_HALT_REASONS = [
  "claim_outcome_unknown",
  "recovery_outcome_unknown",
  "promotion_outcome_unknown",
  "unacked_write_receipt",
] as const satisfies readonly AmuxOrchestratorHaltReasonCode[];

export const amuxOrchestratorHaltReasonHasRequest = (
  reason: AmuxOrchestratorHaltReasonCode,
): boolean =>
  (AMUX_ORCHESTRATOR_REQUEST_HALT_REASONS as readonly string[]).includes(reason);

/** Section 4: the two acknowledgement kinds. */
export const AMUX_ORCHESTRATOR_ACK_KINDS = ["definite", "no_commit"] as const;
export type AmuxOrchestratorAckKind =
  (typeof AMUX_ORCHESTRATOR_ACK_KINDS)[number];

/**
 * Why an acknowledgement is refused. `receipts_present`: a `no_commit` ack for
 * a request that committed a state change (section 4). `not_admitted`: a
 * `definite` ack for a request the server never admitted, which no answer this
 * server sends can produce.
 */
export const AMUX_ORCHESTRATOR_ACK_REFUSALS = [
  "receipts_present",
  "not_admitted",
] as const;
export type AmuxOrchestratorAckRefusal =
  (typeof AMUX_ORCHESTRATOR_ACK_REFUSALS)[number];

/**
 * Section 1: the three 503 reasons that mean "this request committed
 * nothing". The server never sends them once a receipt of the request has
 * committed; it answers `amux_outcome_unknown` instead.
 */
export const AMUX_ORCHESTRATOR_NOTHING_COMMITTED_REASONS = [
  "amux_database_busy",
  "amux_database_deadline_exceeded",
  "amux_database_call_ceiling_exceeded",
] as const;

/** Section 4: a second admission of the same request id. Not a known answer. */
export const AMUX_ORCHESTRATOR_DUPLICATE_REQUEST_REASON = "duplicate_request";

/** Section 4: the resolver's clock margin. Correctness does not rest on it. */
export const AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS = 5_000;

/** Section 5: an acknowledged or resolved admission may be deleted after this. */
export const AMUX_ORCHESTRATOR_RETENTION_DAYS = 90;

/** Section 7: how much of the halt key a person types to clear it. */
export const AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH = 8;

/**
 * The request identity of a write call. Sent as headers so the claim, recover
 * and tick bodies -- and the wire fixtures the running Rust binaries share
 * with the routes -- stay byte for byte what they were. An orchestrator built
 * before version 20 sends neither header and is served exactly as before,
 * with no admission.
 */
export const AMUX_ORCHESTRATOR_REQUEST_ID_HEADER = "x-amux-request-id";
export const AMUX_ORCHESTRATOR_INSTANCE_ID_HEADER = "x-amux-instance-id";

/** The three audit actions of this version (section 4, 5 and 7). */
export const AMUX_ORCHESTRATOR_AUDIT_ACTIONS = {
  halted: "amux.orchestrator.halted",
  writeResolved: "amux.orchestrator.write_resolved",
  haltCleared: "amux.orchestrator.halt_cleared",
} as const;

/**
 * Section 5: the only metadata keys these audit entries carry. `systemActor`
 * is set by the system writer itself. No card title, brief, source key, free
 * text or error body.
 */
export const AMUX_ORCHESTRATOR_AUDIT_METADATA_KEYS = [
  "systemActor",
  "halt_id",
  "halt_key",
  "request_id",
  "reason_code",
  "call_kind",
  "resolution",
] as const;
export type AmuxOrchestratorAuditMetadataKey =
  (typeof AMUX_ORCHESTRATOR_AUDIT_METADATA_KEYS)[number];

/** Lower-case canonical UUID text, the form the Rust `uuid` crate prints. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isAmuxOrchestratorUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

export const isAmuxOrchestratorHaltReasonCode = (
  value: unknown,
): value is AmuxOrchestratorHaltReasonCode =>
  typeof value === "string" &&
  (AMUX_ORCHESTRATOR_HALT_REASON_CODES as readonly string[]).includes(value);

export const isAmuxOrchestratorAckKind = (
  value: unknown,
): value is AmuxOrchestratorAckKind =>
  typeof value === "string" &&
  (AMUX_ORCHESTRATOR_ACK_KINDS as readonly string[]).includes(value);

export type AmuxOrchestratorWriteIdentity =
  | { kind: "legacy" }
  | { kind: "admitted"; requestId: string; instanceId: string }
  | { kind: "invalid" };

/**
 * What the request says about its own identity. Neither header: a
 * pre-version-20 orchestrator, served without admission. Both, each a
 * canonical UUID: an admitted write. Anything else is refused before any
 * transaction.
 */
export const readAmuxOrchestratorWriteIdentity = (
  headers: Pick<Headers, "get">,
): AmuxOrchestratorWriteIdentity => {
  const requestId = headers.get(AMUX_ORCHESTRATOR_REQUEST_ID_HEADER);
  const instanceId = headers.get(AMUX_ORCHESTRATOR_INSTANCE_ID_HEADER);
  if (requestId === null && instanceId === null) return { kind: "legacy" };
  if (isAmuxOrchestratorUuid(requestId) && isAmuxOrchestratorUuid(instanceId)) {
    return { kind: "admitted", requestId, instanceId };
  }
  return { kind: "invalid" };
};

export type AmuxOrchestratorJudgement = "pending" | "no_commit" | "human_required";

/**
 * Section 4, the resolver's judgement of one admission that is neither
 * acknowledged nor resolved, on the database clock and applied under the
 * admission's row lock.
 *
 * - Before the deadline plus five seconds: undecided.
 * - After it with no receipt: the rollback is confirmed. No transaction of
 *   the request is still running (a running one holds the row lock), a later
 *   one sees the resolved admission and rolls back, and the version 19 commit
 *   fence refuses a COMMIT after the deadline.
 * - After it with a receipt: a person has to confirm.
 */
export const judgeAmuxOrchestratorWrite = (input: {
  dbNowMs: number;
  deadlineAtMs: number;
  receiptCount: number;
}): AmuxOrchestratorJudgement => {
  if (input.dbNowMs < input.deadlineAtMs + AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS) {
    return "pending";
  }
  return input.receiptCount === 0 ? "no_commit" : "human_required";
};

export type AmuxOrchestratorAckDecision =
  | { acked: true; write: "set_acked" | "none" }
  | { acked: false; reason: AmuxOrchestratorAckRefusal };

/**
 * Section 4, one acknowledgement read under the admission's row lock.
 *
 * `definite` answers a 2xx or a 409 refusal: the response confirmed whatever
 * committed, so receipts do not refuse it. `no_commit` answers one of the three
 * 503 reasons and is refused when the request has any receipt. A request the
 * server never admitted committed nothing, so a `no_commit` ack for it is true
 * and needs no row; a `definite` one cannot come from this server.
 */
export const decideAmuxOrchestratorAck = (input: {
  kind: AmuxOrchestratorAckKind;
  admission: { receiptCount: number } | null;
}): AmuxOrchestratorAckDecision => {
  if (input.admission === null) {
    return input.kind === "no_commit"
      ? { acked: true, write: "none" }
      : { acked: false, reason: "not_admitted" };
  }
  if (input.kind === "no_commit" && input.admission.receiptCount > 0) {
    return { acked: false, reason: "receipts_present" };
  }
  return { acked: true, write: "set_acked" };
};

export type AmuxOrchestratorHaltRecord = {
  haltKey: string;
  reasonCode: AmuxOrchestratorHaltReasonCode;
  requestId: string | null;
};

/**
 * The body of `POST /api/internal/amux/orchestrator/halt`: a halt key, a
 * reason from the closed list, and the request id exactly when the reason is
 * about one write call, in which case the halt key is that request id. The
 * route takes nothing else, and in particular no clear.
 */
export const parseAmuxOrchestratorHaltRecord = (
  body: unknown,
): AmuxOrchestratorHaltRecord | null => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["halt_key", "reason_code", "request_id"].includes(key))) {
    return null;
  }
  const haltKey = record.halt_key;
  const reasonCode = record.reason_code;
  const requestId = record.request_id ?? null;
  if (!isAmuxOrchestratorUuid(haltKey) || !isAmuxOrchestratorHaltReasonCode(reasonCode)) {
    return null;
  }
  if (amuxOrchestratorHaltReasonHasRequest(reasonCode)) {
    if (!isAmuxOrchestratorUuid(requestId) || requestId !== haltKey) return null;
    return { haltKey, reasonCode, requestId };
  }
  if (requestId !== null) return null;
  return { haltKey, reasonCode, requestId: null };
};

/**
 * Section 7: the person types the first eight characters of the halt key.
 * Case is not a difference a person can see in a UUID, so it is ignored;
 * anything else that differs refuses the clear.
 */
export const amuxOrchestratorHaltKeyPrefixMatches = (
  haltKey: string,
  typed: unknown,
): boolean =>
  typeof typed === "string" &&
  typed.trim().length === AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH &&
  typed.trim().toLowerCase() ===
    haltKey.slice(0, AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH);

/**
 * Audit metadata for this version's entries, restricted to the allowlist.
 * Every value is an identifier or a closed-list code; a key outside the list,
 * or a value that is not a short string, is refused rather than dropped.
 */
export const amuxOrchestratorAuditMetadata = (
  fields: Partial<Record<Exclude<AmuxOrchestratorAuditMetadataKey, "systemActor">, string | null>>,
): Record<string, string> => {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === "systemActor" ||
      !(AMUX_ORCHESTRATOR_AUDIT_METADATA_KEYS as readonly string[]).includes(key)
    ) {
      throw new Error(`AMUX orchestrator audit metadata key refused: ${key}`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 64) {
      throw new Error(`AMUX orchestrator audit metadata value refused: ${key}`);
    }
    metadata[key] = value;
  }
  return metadata;
};

/**
 * Where the Admin halts screen links a receipt's target. There is no page per
 * card, attempt, grant or consumption row, so each kind links to the section
 * that lists that kind of row, and the id is shown beside the link. The quota
 * sweep names no row and gets no link.
 */
export const AMUX_ORCHESTRATOR_RECEIPT_TARGET_HREFS: Record<
  AmuxOrchestratorReceiptTargetKind,
  string | null
> = {
  work_item: "/admin/amux-execution?tab=cards",
  claim_decision: "/admin/amux-execution?tab=assignment",
  execution_attempt: "/admin/amux-execution?tab=cards",
  auto_promotion_grant: "/admin/amux-promotion?tab=auto-promotion",
  auto_promotion_consumption: "/admin/amux-promotion?tab=auto-promotion",
  v22_promotion_receipt: "/admin/amux-promotion?tab=auto-promotion",
  v22_promotion_unknown: "/admin/amux-promotion?tab=auto-promotion",
  v22_promotion_halt: "/admin/amux-promotion?tab=auto-promotion",
  v22_worker_assignment: "/admin/amux-execution?tab=assignment",
  quota_observation_batch: null,
};
