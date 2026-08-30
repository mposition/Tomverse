import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPARISON_REVIEW_RUN_OUTCOMES,
  buildComparisonReviewRunRecord,
  comparisonReviewRunOutcome,
  dispatchedAttempts,
  settlementMismatches,
  contentFreeViolations,
  emptyAttemptRecord,
  reachedProvider,
} from "../lib/comparisonReviewRunCore.ts";

const startedAt = new Date("2026-08-30T00:00:00.000Z");
const completedAt = new Date("2026-08-30T00:00:04.500Z");

const input = (overrides = {}) => ({
  traceId: "trace-1",
  subjectKind: "account",
  subjectKey: "user:abc",
  userId: "abc",
  conversationId: "conv-1",
  reviewMode: "balanced",
  language: "ko",
  responseCount: 3,
  promptVersion: "comparison-review-v3",
  outcome: "completed_dual",
  errorCode: null,
  startedAt,
  completedAt,
  dualReviewRequested: true,
  dualReviewAvailable: true,
  primary: {
    ...emptyAttemptRecord(),
    reviewerModelId: "mistral-medium-3-1",
    reviewerProvider: "mistral",
    status: "completed",
  },
  secondary: {
    ...emptyAttemptRecord(),
    reviewerModelId: "claude-sonnet-5",
    reviewerProvider: "anthropic",
    status: "completed",
  },
  attempts: [],
  groundingTotalQuotes: 8,
  groundingMatchedQuotes: 7,
  sourceGroundingLevel: "high",
  ...overrides,
});

test("duration, dual completion and cross-provider are derived, not asserted by the caller", () => {
  const record = buildComparisonReviewRunRecord(input());
  assert.equal(record.durationMs, 4_500);
  assert.equal(record.dualReviewCompleted, true);
  assert.equal(record.crossProvider, true);
});

test("a caller cannot report a dual review its secondary attempt did not complete", () => {
  const record = buildComparisonReviewRunRecord(
    input({
      outcome: "completed_primary_only",
      secondary: { ...emptyAttemptRecord(), status: "failed", reviewerModelId: "x" },
    })
  );
  assert.equal(record.dualReviewCompleted, false);
});

test("cross-provider is null when there was no second attempt to compare", () => {
  const record = buildComparisonReviewRunRecord(
    input({ secondary: emptyAttemptRecord() })
  );
  assert.equal(record.crossProvider, null);
});

test("two reviewers at one provider are not reported as cross-provider", () => {
  const record = buildComparisonReviewRunRecord(
    input({
      secondary: {
        ...emptyAttemptRecord(),
        reviewerModelId: "mistral-small-4",
        reviewerProvider: "mistral",
        status: "completed",
      },
    })
  );
  assert.equal(record.dualReviewCompleted, true);
  assert.equal(record.crossProvider, false);
});

test("no user content can reach the record", () => {
  // The exact material an AI Review handles: the question, the answers, the
  // reviewer's own sentences, a verbatim quote and an attachment filename.
  const forbidden = [
    "경부고속도로는 언제 전 구간이 개통되었나요",
    "The Eiffel Tower was completed in 1889",
    "Response B contradicts the others on the opening year",
    "복용 전 진료를 받으십시오",
    "quarterly-forecast-2026.xlsx",
  ];
  const record = buildComparisonReviewRunRecord(input());
  assert.deepEqual(contentFreeViolations(record, forbidden), []);

  // And the check itself has teeth: if a field ever did carry content, it
  // would be named.
  const leaking = buildComparisonReviewRunRecord(
    input({ errorCode: "The Eiffel Tower was completed in 1889" })
  );
  assert.deepEqual(contentFreeViolations(leaking, forbidden), [
    "record.errorCode contains user content",
  ]);
});

test("only an attempt that actually reached a provider counts toward failure rates", () => {
  const refusedOnly = buildComparisonReviewRunRecord(
    input({
      outcome: "refused_before_provider",
      primary: { ...emptyAttemptRecord(), status: "refused" },
      secondary: emptyAttemptRecord(),
    })
  );
  assert.equal(reachedProvider(refusedOnly), false);

  const cached = buildComparisonReviewRunRecord(
    input({
      outcome: "cached",
      primary: { ...emptyAttemptRecord(), status: "not_attempted" },
      secondary: emptyAttemptRecord(),
    })
  );
  assert.equal(reachedProvider(cached), false);

  const failedAtProvider = buildComparisonReviewRunRecord(
    input({
      outcome: "failed",
      primary: { ...emptyAttemptRecord(), status: "failed" },
      secondary: emptyAttemptRecord(),
    })
  );
  assert.equal(reachedProvider(failedAtProvider), true);
});

test("the outcome vocabulary keeps a refusal separate from a failure and a cache hit", () => {
  assert.deepEqual([...COMPARISON_REVIEW_RUN_OUTCOMES], [
    "completed_dual",
    "completed_primary_only",
    "failed",
    "refused_before_provider",
    "cached",
  ]);
});

test("a run where every candidate refused locally is not a provider failure", () => {
  // The distinction the outcome vocabulary exists for: nothing was sent, so
  // nothing here is evidence about a reviewer model.
  assert.equal(
    comparisonReviewRunOutcome({
      primaryCompleted: false,
      secondaryCompleted: false,
      reachedProvider: false,
    }),
    "refused_before_provider"
  );
  assert.equal(
    comparisonReviewRunOutcome({
      primaryCompleted: false,
      secondaryCompleted: false,
      reachedProvider: true,
    }),
    "failed"
  );
});

test("a completed primary decides dual vs primary-only, whatever the secondary attempted", () => {
  assert.equal(
    comparisonReviewRunOutcome({
      primaryCompleted: true,
      secondaryCompleted: true,
      reachedProvider: true,
    }),
    "completed_dual"
  );
  // A secondary that was attempted and failed is still primary-only: the user
  // got one review, and the dual-completion rate is where the loss shows.
  assert.equal(
    comparisonReviewRunOutcome({
      primaryCompleted: true,
      secondaryCompleted: false,
      reachedProvider: true,
    }),
    "completed_primary_only"
  );
});


const entry = (overrides = {}) => ({
  ...emptyAttemptRecord(),
  ordinal: 1,
  slot: "primary",
  reviewerModelId: "mistral-medium-3-1",
  reviewerProvider: "mistral",
  status: "completed",
  reservedCredits: 4,
  settledCredits: 4,
  ...overrides,
});

test("only attempts that dispatched count toward a reviewer's failure rate", () => {
  const attempts = [
    entry({ ordinal: 1, status: "failed" }),
    entry({ ordinal: 2, status: "completed" }),
    entry({ ordinal: 3, status: "refused" }),
    entry({ ordinal: 4, status: "not_attempted" }),
  ];
  assert.deepEqual(
    dispatchedAttempts(attempts).map((item) => item.ordinal),
    [1, 2]
  );
});

test("settling above the reservation is the mismatch; settling below it is not", () => {
  const summary = settlementMismatches([
    entry({ ordinal: 1, reservedCredits: 8, settledCredits: 3 }),
    entry({ ordinal: 2, reservedCredits: 4, settledCredits: 9 }),
    entry({ ordinal: 3, reservedCredits: 4, settledCredits: null }),
    // A failed attempt is not a settlement question at all.
    entry({ ordinal: 4, status: "failed", settledCredits: null }),
  ]);
  assert.equal(summary.completed, 3);
  assert.equal(summary.overSettled, 1);
  assert.equal(summary.unreported, 1);
});

test("a fallback keeps the failure and still names the reviewer that answered", () => {
  // The two questions the run row and the attempt list answer separately.
  const record = buildComparisonReviewRunRecord(
    input({
      outcome: "completed_primary_only",
      attempts: [
        entry({ ordinal: 1, status: "failed", settledCredits: 0 }),
        entry({
          ordinal: 2,
          reviewerModelId: "claude-sonnet-5",
          reviewerProvider: "anthropic",
        }),
      ],
      primary: {
        ...emptyAttemptRecord(),
        reviewerModelId: "claude-sonnet-5",
        reviewerProvider: "anthropic",
        status: "completed",
      },
      secondary: emptyAttemptRecord(),
    })
  );
  assert.equal(record.primary.reviewerModelId, "claude-sonnet-5");
  assert.equal(record.attempts.length, 2);
  assert.equal(record.attempts[0].reviewerModelId, "mistral-medium-3-1");
  assert.equal(record.attempts[0].status, "failed");
});

test("no user content can reach an attempt row either", () => {
  const forbidden = [
    "경부고속도로는 언제 전 구간이 개통되었나요",
    "The Eiffel Tower was completed in 1889",
  ];
  const record = buildComparisonReviewRunRecord(
    input({ attempts: [entry(), entry({ ordinal: 2 })] })
  );
  assert.deepEqual(contentFreeViolations(record, forbidden), []);
});
