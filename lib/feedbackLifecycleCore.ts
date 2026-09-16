/**
 * The feedback lifecycle contract: which stages exist, which closure outcomes
 * the product recognises, and what a user-facing reply must look like.
 *
 * Pure and dependency-free on purpose, like lib/feedbackPolicy.ts: it is
 * imported by the admin client (to validate the completion dialog before the
 * server has to), by the API routes (to enforce the same rule), and exercised
 * directly by tests/feedbackLifecycleCore.test.mjs.
 */

/**
 * The three points in a report's life the submitter is emailed about. Each
 * stage maps to exactly one NotificationDelivery kind and at most one
 * FeedbackLifecycleEvent row per report.
 */
export const FEEDBACK_LIFECYCLE_STAGE = {
  received: "received",
  reviewing: "reviewing",
  completed: "completed",
} as const;

export type FeedbackLifecycleStage =
  (typeof FEEDBACK_LIFECYCLE_STAGE)[keyof typeof FEEDBACK_LIFECYCLE_STAGE];

/**
 * How a report was actually resolved. The completed email's wording is decided
 * entirely by this code (see lib/feedbackLifecycleEmails.ts), so "resolved"
 * never blanket-claims a fix: only `fixed` and `shipped` may use
 * fixed/released language.
 */
export const FEEDBACK_CLOSURE_OUTCOMES = [
  "fixed",
  "answered",
  "shipped",
  "planned",
  "duplicate",
  "not_reproduced",
  "not_planned",
  "no_action",
  "other",
] as const;

export type FeedbackClosureOutcome = (typeof FEEDBACK_CLOSURE_OUTCOMES)[number];

export const isFeedbackClosureOutcome = (
  value: unknown
): value is FeedbackClosureOutcome =>
  typeof value === "string" &&
  (FEEDBACK_CLOSURE_OUTCOMES as readonly string[]).includes(value);

/** Statuses an admin can set; mirrored by the PATCH route's schema. */
export const FEEDBACK_STATUSES = [
  "open",
  "reviewing",
  "resolved",
  "closed",
] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** The two statuses that close a report. */
export const isTerminalFeedbackStatus = (
  status: string
): status is "resolved" | "closed" => status === "resolved" || status === "closed";

/**
 * Which lifecycle stage a status transition announces, if any. Returning to
 * `open` announces nothing, and neither does any repeat of a stage -- the
 * unique (feedbackId, stage) constraint enforces the "at most once" half; this
 * only says which stage a new status belongs to.
 */
export const lifecycleStageForStatus = (
  status: string
): FeedbackLifecycleStage | null => {
  if (status === "reviewing") return FEEDBACK_LIFECYCLE_STAGE.reviewing;
  if (isTerminalFeedbackStatus(status)) return FEEDBACK_LIFECYCLE_STAGE.completed;
  return null;
};

/**
 * Whether a stage's email may be sent to this reporter, and why not.
 *
 * The three stages are not the same kind of message, and until 2026-09-16 the
 * code treated them as one: all three required the "email me status updates"
 * tick, which meant an operator could write a reply to a report, close it, and
 * have the reply reach nobody -- with the dialog, the button and the toast all
 * looking exactly as they do when a reply is sent. That happened on
 * 2026-09-15.
 *
 *  - `completed` is the **answer to the request the reporter made**, which
 *    docs/policy/email-notifications.md §3 classifies as transactional: no
 *    consent needed, because they asked. It needs an address and nothing else.
 *    (A guest only has an address here if they asked to be contacted at it; a
 *    signed-in account's address comes from the verified session.)
 *  - `received` and `reviewing` are unsolicited progress notices. They are
 *    what the tick governs, and they keep needing it.
 *
 * One function so the route, the queue renderer and the console cannot answer
 * this differently -- three copies of `email && consent` are what made the
 * incident possible.
 */
export type FeedbackStageRecipientRefusal = "no_address" | "not_consented";

export type FeedbackStageRecipientVerdict =
  | { canSend: true }
  | { canSend: false; reason: FeedbackStageRecipientRefusal };

/** Which stages the reporter's "email me status updates" tick governs. */
export const FEEDBACK_STAGE_NEEDS_CONSENT: Record<FeedbackLifecycleStage, boolean> = {
  received: true,
  reviewing: true,
  completed: false,
};

export const feedbackStageRecipient = (input: {
  stage: FeedbackLifecycleStage;
  email: string | null | undefined;
  emailUpdatesConsent: boolean | null | undefined;
}): FeedbackStageRecipientVerdict => {
  if (!input.email) return { canSend: false, reason: "no_address" };
  if (FEEDBACK_STAGE_NEEDS_CONSENT[input.stage] && !input.emailUpdatesConsent) {
    return { canSend: false, reason: "not_consented" };
  }
  return { canSend: true };
};

/**
 * The user-facing reply contract. Distinct from the internal admin note in
 * both storage and validation: this text is quoted verbatim (escaped) in the
 * completed email, so it is short by design.
 *
 * The reply is optional -- outcomes like `duplicate` need no prose -- but a
 * reply that is present must be substantial enough to read as a sentence and
 * short enough to stay a summary rather than a second message body.
 */
export const FEEDBACK_USER_REPLY_MIN_LENGTH = 10;
export const FEEDBACK_USER_REPLY_MAX_LENGTH = 1_000;

export type FeedbackUserReplyState = "empty" | "tooShort" | "tooLong" | "ready";

export const feedbackUserReplyState = (
  value: string | null | undefined
): FeedbackUserReplyState => {
  const trimmedLength = (value ?? "").trim().length;
  if (trimmedLength === 0) return "empty";
  if (trimmedLength < FEEDBACK_USER_REPLY_MIN_LENGTH) return "tooShort";
  if (trimmedLength > FEEDBACK_USER_REPLY_MAX_LENGTH) return "tooLong";
  return "ready";
};

/** Whether a closure payload is acceptable: reply absent, or within bounds. */
export const isValidFeedbackUserReply = (value: string | null | undefined) => {
  const state = feedbackUserReplyState(value);
  return state === "empty" || state === "ready";
};

/**
 * Whether a report is an error report or general feedback, for copy purposes.
 * The distinction the emails draw ("your bug report" vs "your feedback") is
 * exactly this and nothing finer.
 */
export type FeedbackEmailCategory = "bug" | "feedback";

export const feedbackEmailCategory = (type: string): FeedbackEmailCategory =>
  type === "bug" ? "bug" : "feedback";
