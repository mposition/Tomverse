import assert from "node:assert/strict";
import test from "node:test";

import { isComparisonReviewAlreadyRunning } from "../lib/comparisonReviewInFlight.ts";

/**
 * The client half of the account AI Review in-flight claim: how the dialog
 * and Studio recognise the route's "this review is already running" answer,
 * which they report instead of treating it as a failure.
 */

test("the 409 the route sends for a run in flight is recognised, and nothing else is", () => {
  assert.equal(isComparisonReviewAlreadyRunning(409, { code: "DUPLICATE_REQUEST" }), true);
  assert.equal(isComparisonReviewAlreadyRunning(409, { code: "CONVERSATION_LOCKED" }), false);
  assert.equal(isComparisonReviewAlreadyRunning(429, { code: "DUPLICATE_REQUEST" }), false);
  assert.equal(isComparisonReviewAlreadyRunning(409, null), false);
  assert.equal(isComparisonReviewAlreadyRunning(409, "DUPLICATE_REQUEST"), false);
});
