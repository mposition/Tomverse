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
