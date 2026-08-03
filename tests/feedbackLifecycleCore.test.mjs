import assert from "node:assert/strict";
import test from "node:test";

import {
  FEEDBACK_CLOSURE_OUTCOMES,
  FEEDBACK_LIFECYCLE_STAGE,
  FEEDBACK_STATUSES,
  FEEDBACK_USER_REPLY_MAX_LENGTH,
  FEEDBACK_USER_REPLY_MIN_LENGTH,
  feedbackEmailCategory,
  feedbackUserReplyState,
  isFeedbackClosureOutcome,
  isTerminalFeedbackStatus,
  isValidFeedbackUserReply,
  lifecycleStageForStatus,
} from "../lib/feedbackLifecycleCore.ts";

// The lifecycle contract: which stages exist, which closure outcomes the
// product recognises, and what a user-facing reply must look like. The admin
// dialog, the PATCH route and the email renderer all read these values, so a
// drift here is a drift everywhere.

test("the three lifecycle stages are exactly received, reviewing, completed", () => {
  assert.deepEqual(Object.values(FEEDBACK_LIFECYCLE_STAGE).sort(), [
    "completed",
    "received",
    "reviewing",
  ]);
});

test("every closure outcome in the contract is recognised, nothing else is", () => {
  assert.deepEqual(
    [...FEEDBACK_CLOSURE_OUTCOMES].sort(),
    [
      "answered",
      "duplicate",
      "fixed",
      "no_action",
      "not_planned",
      "not_reproduced",
      "other",
      "planned",
      "shipped",
    ]
  );
  for (const outcome of FEEDBACK_CLOSURE_OUTCOMES) {
    assert.ok(isFeedbackClosureOutcome(outcome));
  }
  assert.equal(isFeedbackClosureOutcome("resolved"), false);
  assert.equal(isFeedbackClosureOutcome(""), false);
  assert.equal(isFeedbackClosureOutcome(null), false);
  assert.equal(isFeedbackClosureOutcome(undefined), false);
});

test("only resolved and closed are terminal", () => {
  assert.deepEqual(
    FEEDBACK_STATUSES.filter((status) => isTerminalFeedbackStatus(status)),
    ["resolved", "closed"]
  );
});

test("statuses map onto the stage their transition announces", () => {
  assert.equal(lifecycleStageForStatus("reviewing"), "reviewing");
  assert.equal(lifecycleStageForStatus("resolved"), "completed");
  assert.equal(lifecycleStageForStatus("closed"), "completed");
  // Returning to open announces nothing.
  assert.equal(lifecycleStageForStatus("open"), null);
  assert.equal(lifecycleStageForStatus("anything-else"), null);
});

// --- the user-facing reply contract -----------------------------------------

test("an absent reply is acceptable; a present one is bounded", () => {
  assert.equal(feedbackUserReplyState(""), "empty");
  assert.equal(feedbackUserReplyState("   "), "empty");
  assert.equal(feedbackUserReplyState(null), "empty");
  assert.equal(feedbackUserReplyState(undefined), "empty");
  assert.ok(isValidFeedbackUserReply(""));
  assert.ok(isValidFeedbackUserReply(null));

  const tooShort = "a".repeat(FEEDBACK_USER_REPLY_MIN_LENGTH - 1);
  assert.equal(feedbackUserReplyState(tooShort), "tooShort");
  assert.equal(isValidFeedbackUserReply(tooShort), false);

  const atMinimum = "a".repeat(FEEDBACK_USER_REPLY_MIN_LENGTH);
  assert.equal(feedbackUserReplyState(atMinimum), "ready");
  assert.ok(isValidFeedbackUserReply(atMinimum));

  const atMaximum = "a".repeat(FEEDBACK_USER_REPLY_MAX_LENGTH);
  assert.equal(feedbackUserReplyState(atMaximum), "ready");

  const overMaximum = "a".repeat(FEEDBACK_USER_REPLY_MAX_LENGTH + 1);
  assert.equal(feedbackUserReplyState(overMaximum), "tooLong");
  assert.equal(isValidFeedbackUserReply(overMaximum), false);
});

test("the reply length is judged on the trimmed value, like every other field", () => {
  const padded = `  ${"a".repeat(FEEDBACK_USER_REPLY_MIN_LENGTH - 1)}  `;
  assert.equal(feedbackUserReplyState(padded), "tooShort");
});

// --- category ----------------------------------------------------------------

test("only the bug type is an error report; every other type is feedback", () => {
  assert.equal(feedbackEmailCategory("bug"), "bug");
  for (const type of ["feature", "billing", "support", "other", "unknown"]) {
    assert.equal(feedbackEmailCategory(type), "feedback");
  }
});
