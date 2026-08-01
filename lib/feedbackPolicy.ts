/**
 * The feedback submission contract, in one place that both the client and the
 * tests can read.
 *
 * The minimum length is a product policy, not a UI detail: `/api/feedback`
 * validates `message: z.string().trim().min(5).max(2_000)` and this module is
 * what keeps every surface describing the *same* rule with the *same* trim
 * basis. Nothing here relaxes it -- FEEDBACK_MESSAGE_MIN_LENGTH exists so a
 * form can explain the rule before the server has to enforce it.
 *
 * Pure and dependency-free on purpose: it is imported by client components and
 * exercised directly by tests/feedbackPolicy.test.mjs.
 */

/** Mirrors `z.string().trim().min(5)` in app/api/feedback/route.ts. */
export const FEEDBACK_MESSAGE_MIN_LENGTH = 5;
/** Mirrors `z.string().trim().max(2_000)` in app/api/feedback/route.ts. */
export const FEEDBACK_MESSAGE_MAX_LENGTH = 2_000;
/** Mirrors `traceId: z.string().trim().max(120)`. */
export const FEEDBACK_TRACE_ID_MAX_LENGTH = 120;

/** Separates the user's own words from attached diagnostics. */
const DIAGNOSTICS_SEPARATOR = "\n\n---\n";
const TRUNCATION_MARKER = "\n[truncated]";

export type FeedbackMessageStateKind = "empty" | "tooShort" | "ready" | "tooLong";

export type FeedbackMessageState = {
  kind: FeedbackMessageStateKind;
  /**
   * Length after trimming -- the same basis the server validates on, so a
   * message made only of spaces counts as zero characters on both sides.
   */
  trimmedLength: number;
  /** Characters still needed to reach the minimum; 0 once it is met. */
  remaining: number;
  /** Characters still available before the maximum; 0 once it is exceeded. */
  available: number;
  /** True when this message alone satisfies the server contract. */
  isValid: boolean;
};

export const feedbackMessageState = (value: string): FeedbackMessageState => {
  const trimmedLength = value.trim().length;
  const remaining = Math.max(0, FEEDBACK_MESSAGE_MIN_LENGTH - trimmedLength);
  const available = Math.max(0, FEEDBACK_MESSAGE_MAX_LENGTH - trimmedLength);
  const kind: FeedbackMessageStateKind =
    trimmedLength === 0
      ? "empty"
      : trimmedLength < FEEDBACK_MESSAGE_MIN_LENGTH
        ? "tooShort"
        : trimmedLength > FEEDBACK_MESSAGE_MAX_LENGTH
          ? "tooLong"
          : "ready";
  return {
    kind,
    trimmedLength,
    remaining,
    available,
    isValid: kind === "ready",
  };
};

/**
 * Whether a form may submit at all.
 *
 * Error-report mode is the one case where the user need not type anything --
 * not because the minimum is waived, but because the form supplies a default
 * description that satisfies it. `defaultMessage` is that description, and it
 * is validated against exactly the same rule.
 */
export const canSubmitFeedback = ({
  message,
  isErrorReport = false,
  defaultMessage = "",
}: {
  message: string;
  isErrorReport?: boolean;
  defaultMessage?: string;
}) => {
  const state = feedbackMessageState(message);
  if (state.isValid) return true;
  if (!isErrorReport) return false;
  // Only an empty box falls back to the default; 1-4 typed characters are a
  // half-written sentence, and silently replacing it would throw the user's
  // words away.
  if (state.kind !== "empty") return false;
  return feedbackMessageState(defaultMessage).isValid;
};

// ---------------------------------------------------------------------------
// Diagnostics sanitisation
// ---------------------------------------------------------------------------

/**
 * Secrets that must never ride along with an automatically attached error
 * report. Order matters: the labelled `key: value` forms run first so the
 * label survives in the redacted output and stays readable to support.
 */
const DIAGNOSTIC_REDACTIONS: Array<[RegExp, string]> = [
  [/\b((?:proxy-)?authorization)\s*[:=]\s*[^\r\n]+/gi, "$1: [redacted]"],
  [/\b((?:set-)?cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [redacted]"],
  [
    /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]+/gi,
    "$1: [redacted]",
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted]"],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{6,}/gi, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/gi, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted]"],
];

/**
 * Strips credentials out of the raw error text that "Report this error"
 * attaches automatically. The user never sees this text before it is sent, so
 * it is the one part of a feedback submission nobody has reviewed.
 */
export const sanitizeFeedbackDiagnostics = (value: string) =>
  DIAGNOSTIC_REDACTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value
  ).trim();

/**
 * Builds the message body that actually goes to the server, within the 2,000
 * character contract.
 *
 * The user's own words are never truncated: whatever budget is left after them
 * goes to the diagnostics, and the diagnostics are cut instead. Before this
 * existed, a long provider error made the combined body exceed the schema's
 * maximum and the whole report came back as a bare 400.
 */
export const composeFeedbackMessage = ({
  description,
  rawErrorDetails,
}: {
  description: string;
  rawErrorDetails?: string | null;
}) => {
  const body = description.trim();
  if (!rawErrorDetails) return body.slice(0, FEEDBACK_MESSAGE_MAX_LENGTH);

  const diagnostics = sanitizeFeedbackDiagnostics(rawErrorDetails);
  if (!diagnostics) return body.slice(0, FEEDBACK_MESSAGE_MAX_LENGTH);

  const budget =
    FEEDBACK_MESSAGE_MAX_LENGTH - body.length - DIAGNOSTICS_SEPARATOR.length;
  if (budget <= TRUNCATION_MARKER.length) {
    return body.slice(0, FEEDBACK_MESSAGE_MAX_LENGTH);
  }
  const attached =
    diagnostics.length <= budget
      ? diagnostics
      : `${diagnostics.slice(0, budget - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  return `${body}${DIAGNOSTICS_SEPARATOR}${attached}`;
};

// ---------------------------------------------------------------------------
// Trace ID
// ---------------------------------------------------------------------------

/**
 * A trace ID is always optional and never gates a submission. This only
 * decides whether to offer a *hint* that the pasted value does not look like
 * one -- so it stays deliberately permissive and flags only what is obviously
 * not a trace ID: whitespace inside it, punctuation that no ID uses, or a value
 * longer than the column can hold.
 */
export const isPlausibleTraceId = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.length > FEEDBACK_TRACE_ID_MAX_LENGTH) return false;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed);
};

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FeedbackSubmitFailure =
  /** 400 -- the payload itself was rejected. */
  | "invalid"
  /** 401/403, or any Turnstile outcome: the security check has to be redone. */
  | "verification"
  /** 413 -- the body was too long for the endpoint. */
  | "tooLarge"
  /** 429 -- too many submissions in the window. */
  | "rateLimited"
  /** 5xx -- ours, not the user's. */
  | "server"
  /** The request never reached the server. */
  | "network"
  /** Anything the allow-list above does not cover. */
  | "unknown";

const ALLOWED_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

/**
 * Maps an HTTP result onto one of the sentences the product is willing to
 * show. Only the status and a strictly shaped error *code* are inputs: an
 * arbitrary string from a response body is never allowed to become user-facing
 * copy.
 */
export const classifyFeedbackFailure = (
  status: number,
  code?: string | null
): FeedbackSubmitFailure => {
  const safeCode = code && ALLOWED_ERROR_CODE.test(code) ? code : null;
  if (safeCode?.startsWith("TURNSTILE")) return "verification";
  if (status === 400) return "invalid";
  if (status === 401 || status === 403) return "verification";
  if (status === 413) return "tooLarge";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "server";
  return "unknown";
};

/** The locale key each failure is rendered with. */
export const feedbackFailureCopyKey = (failure: FeedbackSubmitFailure) =>
  `feedback.error${failure.charAt(0).toUpperCase()}${failure.slice(1)}`;

/** Failures where the user's draft is worth keeping and retrying as-is. */
export const isRetryableFeedbackFailure = (failure: FeedbackSubmitFailure) =>
  failure === "server" || failure === "network" || failure === "rateLimited";

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * A short, readable handle a user can quote back to support. Derived from the
 * record ID rather than being a second stored value, so it can never disagree
 * with what the admin inbox shows.
 */
export const feedbackReferenceFromId = (id: string) => {
  const compact = id.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return compact.length >= 8 ? compact.slice(-8) : compact;
};

/** Shape a server-supplied reference must have before it is displayed. */
export const isFeedbackReference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z0-9]{4,16}$/.test(value);
