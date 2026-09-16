import assert from "node:assert/strict";
import test from "node:test";
import { TOKEN_VERIFICATION_STATUS } from "../lib/errorReportContract";
import {
  initialFeedbackLifecycleEvents,
  initialFeedbackStatus,
  qualifiesForTraceAutoReview,
} from "../lib/feedbackTraceAutoReview";

/**
 * Which new reports start in review. Only a verified token with a trace does;
 * every other verification outcome -- including no verification at all --
 * starts open, whatever the report type.
 */

const TRACE = "11111111-2222-4333-8444-555555555555";

test("every verification outcome but verified starts open", () => {
  const outcomes = [
    ...Object.values(TOKEN_VERIFICATION_STATUS),
    null,
    undefined,
    "made-up",
  ];
  for (const verification of outcomes) {
    const qualifies = verification === TOKEN_VERIFICATION_STATUS.verified;
    assert.equal(
      qualifiesForTraceAutoReview({ verification, traceId: TRACE }),
      qualifies,
      String(verification)
    );
    assert.equal(
      initialFeedbackStatus({ verification, traceId: TRACE }),
      qualifies ? "reviewing" : "open",
      String(verification)
    );
  }
});

test("a verified outcome without a trace does not qualify", () => {
  for (const traceId of [null, undefined, ""]) {
    assert.equal(
      qualifiesForTraceAutoReview({
        verification: TOKEN_VERIFICATION_STATUS.verified,
        traceId,
      }),
      false
    );
  }
});

test("an auto-reviewed report records received then reviewing, otherwise received only", () => {
  assert.deepEqual(
    initialFeedbackLifecycleEvents({
      verification: TOKEN_VERIFICATION_STATUS.verified,
      traceId: TRACE,
    }).map((event) => event.stage),
    ["received", "reviewing"]
  );
  assert.deepEqual(
    initialFeedbackLifecycleEvents({
      verification: TOKEN_VERIFICATION_STATUS.invalidSignature,
      traceId: TRACE,
    }).map((event) => event.stage),
    ["received"]
  );
});
