/**
 * Trace-based error report vocabulary, shared by the server routes, the chat
 * client and the admin console. Dependency-free on purpose: these string
 * values are contractual (they are stored on Feedback rows and rendered by
 * the admin inbox), so they are defined exactly once.
 *
 * Policy background: docs/policy/trace-feedback-automation.md.
 */

/** Where a trace ID string came from. A trace ID is never an auth credential;
 * provenance only records which side of the trust boundary minted it. */
export const TRACE_PROVENANCE = {
  serverGenerated: "server_generated",
  clientSupplied: "client_supplied",
  clientFallback: "client_fallback",
  unknown: "unknown",
} as const;
export type TraceProvenance =
  (typeof TRACE_PROVENANCE)[keyof typeof TRACE_PROVENANCE];

/** Who decided the error code attached to a report. A client-side
 * classification (e.g. EMPTY_RESPONSE after a normal stream) is never
 * presented as a server-authenticated fact. */
export const ERROR_CLASSIFICATION_SOURCE = {
  server: "server",
  client: "client",
  provider: "provider",
  unknown: "unknown",
} as const;
export type ErrorClassificationSource =
  (typeof ERROR_CLASSIFICATION_SOURCE)[keyof typeof ERROR_CLASSIFICATION_SOURCE];

/** Outcome of verifying an errorReportToken on feedback submission. */
export const TOKEN_VERIFICATION_STATUS = {
  verified: "verified",
  missingToken: "missing_token",
  expired: "expired",
  invalidSignature: "invalid_signature",
  payloadMismatch: "payload_mismatch",
  unsupportedVersion: "unsupported_version",
  untrustedTraceSource: "untrusted_trace_source",
} as const;
export type TokenVerificationStatus =
  (typeof TOKEN_VERIFICATION_STATUS)[keyof typeof TOKEN_VERIFICATION_STATUS];

/** Whether a TraceErrorEvidence row exists for a verified report, and if not,
 * why not. Independent of token verification: a verified token stays verified
 * even when policy chose not to record an evidence row. */
export const EVIDENCE_AVAILABILITY = {
  recorded: "recorded",
  intentionallyNotRecorded: "intentionally_not_recorded",
  existingLimitEvent: "existing_limit_event",
  existingProviderEvent: "existing_provider_event",
  notYetAvailable: "not_yet_available",
  ambiguousTrace: "ambiguous_trace",
  notApplicable: "not_applicable",
} as const;
export type EvidenceAvailability =
  (typeof EVIDENCE_AVAILABILITY)[keyof typeof EVIDENCE_AVAILABILITY];

/**
 * Error codes whose story is already told by an existing operational record
 * (ChatLimitDecisionEvent / usage buckets / provider budget events). They are
 * reportable -- a token is still issued -- but no new evidence row is written;
 * support reads the existing record via the trace ID instead.
 */
const LIMIT_EVENT_ERROR_CODES = new Set([
  "CHAT_RATE_LIMITED",
  "CHAT_QUOTA_EXCEEDED",
  "CHAT_CONCURRENCY_EXCEEDED",
  "CHAT_IP_CONCURRENCY_EXCEEDED",
  "CONCURRENT_RESERVATION_CONFLICT",
  "PLAN_ENTITLEMENT_EXHAUSTED",
  "PLAN_DAILY_CREDIT_LIMIT_REACHED",
  "FREE_PRO_MODEL_QUOTA_EXCEEDED",
  "CREDIT_BALANCE_INSUFFICIENT",
  "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
  "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
  "INTERNAL_DAILY_COST_SAFETY_LIMIT",
  "INTERNAL_MONTHLY_COST_SAFETY_LIMIT",
  "PROVIDER_BUDGET_EXHAUSTED",
  "PROVIDER_DAILY_SPEND_LIMIT_REACHED",
  "PROVIDER_SPEND_LIMIT_REACHED",
]);

/** Routine request-shape rejections: reportable, but a fresh evidence row
 * would only duplicate what the code alone already says. */
const NON_RECORDABLE_ERROR_CODES = new Set([
  "TURNSTILE_REQUIRED",
  "TURNSTILE_FAILED",
  "TURNSTILE_UNAVAILABLE",
  "TURNSTILE_NOT_CONFIGURED",
  "SECURITY_NOT_CONFIGURED",
  "INVALID_REQUEST",
  "INVALID_ATTACHMENTS",
  "INVALID_MODEL",
  "NOT_FOUND",
  "AUTH_REQUIRED",
  "CONVERSATION_FORBIDDEN",
]);

/** Server-classified failure codes that are evidence-worthy regardless of
 * the HTTP status they ride on. The deep-research failed poll is a 200
 * response carrying a terminal failure, so status alone cannot decide. */
const RECORDABLE_ERROR_CODES = new Set([
  "AI_PROVIDER_ERROR",
  "AI_REQUEST_FAILED",
  "DEEP_RESEARCH_JOB_FAILED",
  "AI_EMPTY_RESPONSE",
]);

/**
 * Whether a server-classified chat error should get its own
 * TraceErrorEvidence row. Application/provider failures do; limit and
 * entitlement rejections point at their existing records instead; routine
 * 4xx request rejections record nothing new.
 */
export const traceEvidenceRecordability = (
  errorCode: string,
  httpStatus: number
):
  | { record: true }
  | {
      record: false;
      availability:
        | typeof EVIDENCE_AVAILABILITY.existingLimitEvent
        | typeof EVIDENCE_AVAILABILITY.intentionallyNotRecorded;
    } => {
  if (LIMIT_EVENT_ERROR_CODES.has(errorCode)) {
    return {
      record: false,
      availability: EVIDENCE_AVAILABILITY.existingLimitEvent,
    };
  }
  if (NON_RECORDABLE_ERROR_CODES.has(errorCode)) {
    return {
      record: false,
      availability: EVIDENCE_AVAILABILITY.intentionallyNotRecorded,
    };
  }
  if (RECORDABLE_ERROR_CODES.has(errorCode)) return { record: true };
  if (httpStatus >= 500) return { record: true };
  // Unlisted 4xx: reportable, but not evidence-worthy by default. Widening
  // this set is a policy decision, not a code default.
  return {
    record: false,
    availability: EVIDENCE_AVAILABILITY.intentionallyNotRecorded,
  };
};

/** Response header carrying the signed error report token. Sits next to the
 * existing X-Request-ID contract; both are set by the server error builders. */
export const ERROR_REPORT_TOKEN_HEADER = "X-Error-Report-Token";

/** Client-side per-message error context. Runtime memory only: never
 * persisted to localStorage, never sent inside a /api/chat transcript, never
 * imported or synced. The token rides in exactly one request: the feedback
 * submission it authenticates. */
export type MessageErrorReportContext = {
  traceId: string;
  traceProvenance: TraceProvenance;
  errorReportToken?: string;
  errorCode?: string;
  errorClassificationSource?: ErrorClassificationSource;
  occurredAt: string;
};
