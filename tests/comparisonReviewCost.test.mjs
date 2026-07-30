import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXTAUTH_SECRET ||= "comparison-review-cost-test-secret";

import {
  AI_REVIEW_CREDITS,
  GUEST_AI_REVIEW_CREDITS,
  QUICK_SUMMARY_CREDITS,
} from "../lib/comparisonReviewCost.ts";
import {
  COMPARISON_REVIEW_LIMITS,
  GUEST_COMPARISON_REVIEW_LIMITS,
  validateComparisonReviewInputSize,
} from "../lib/comparisonReview.ts";
import { MODEL_USAGE_CREDIT_WEIGHTS } from "../lib/models.ts";

/**
 * The comparison actions' shelf prices and the guest payload envelope.
 *
 * Both used to be written twice -- once in the rail, once in a route -- and
 * the two drifted: the rail advertised 4 credits for a run that charged 8, so
 * a balance of 6 looked affordable for something it could not pay for. These
 * assertions exist so that can only ever be one number again.
 */

test("the AI Review price is one definition, and it matches what runs", () => {
  // Two independent reviewers run for every cross-review, and every configured
  // reviewer is `advanced` class. The estimate is that arithmetic, not a
  // number someone typed.
  assert.equal(AI_REVIEW_CREDITS, MODEL_USAGE_CREDIT_WEIGHTS.advanced * 2);
  assert.equal(AI_REVIEW_CREDITS, 8);
  assert.equal(QUICK_SUMMARY_CREDITS, 1);
});

test("guests are quoted the same price, because they run the same pipeline", () => {
  assert.equal(GUEST_AI_REVIEW_CREDITS, AI_REVIEW_CREDITS);
});

test("the guest review payload envelope is narrower than the account one", () => {
  for (const key of [
    "maxQuestionCharacters",
    "maxAnswerCharacters",
    "maxTotalCharacters",
  ]) {
    assert.ok(
      GUEST_COMPARISON_REVIEW_LIMITS[key] < COMPARISON_REVIEW_LIMITS[key],
      `${key} must not be more permissive for guests`
    );
  }
  // The comparison itself is the same shape: up to three answers, as promised.
  assert.equal(
    GUEST_COMPARISON_REVIEW_LIMITS.maxResponses,
    COMPARISON_REVIEW_LIMITS.maxResponses
  );
});

test("a guest payload always fits the guest input-token budget", () => {
  // createChatBudget("guest", ...) refuses anything over
  // CHAT_GUEST_MAX_INPUT_TOKENS (16k by default). If the envelope did not fit,
  // an oversized review would be accepted by validation, claim the month's
  // trial slot, and only then fail with a token error.
  const guestInputTokenBudget = 16_000;
  const worstCase =
    Math.ceil(GUEST_COMPARISON_REVIEW_LIMITS.maxTotalCharacters / 4) + 1_200;
  assert.ok(worstCase < guestInputTokenBudget, `${worstCase} tokens`);
  // The account envelope genuinely does not fit, which is why a separate one
  // has to exist rather than the guest path reusing it.
  assert.ok(
    Math.ceil(COMPARISON_REVIEW_LIMITS.maxTotalCharacters / 4) >
      guestInputTokenBudget
  );
});

const response = (content) => ({
  messageId: "m1",
  modelId: "gpt-5-4-mini",
  modelName: "GPT-5.4 mini",
  provider: "openai",
  content,
});

test("the size validator enforces whichever envelope it is given", () => {
  const question = "q";
  const bigAnswer = "a".repeat(
    GUEST_COMPARISON_REVIEW_LIMITS.maxAnswerCharacters + 1
  );

  // Accepted for an account...
  assert.doesNotThrow(() =>
    validateComparisonReviewInputSize(question, [response(bigAnswer)])
  );
  // ...and refused for a guest, by the same function with the guest envelope.
  assert.throws(
    () =>
      validateComparisonReviewInputSize(
        question,
        [response(bigAnswer)],
        GUEST_COMPARISON_REVIEW_LIMITS
      ),
    /COMPARISON_REVIEW_INPUT_TOO_LARGE/
  );
});

test("the total is checked across answers, not just per answer", () => {
  // Three answers each under the per-answer cap can still blow the budget the
  // reviewer actually reads, which is the number that costs credits.
  const each = "a".repeat(
    Math.floor(GUEST_COMPARISON_REVIEW_LIMITS.maxTotalCharacters / 2)
  );
  assert.throws(
    () =>
      validateComparisonReviewInputSize(
        "q",
        [response(each), response(each), response(each)],
        GUEST_COMPARISON_REVIEW_LIMITS
      ),
    /COMPARISON_REVIEW_INPUT_TOO_LARGE/
  );
});
