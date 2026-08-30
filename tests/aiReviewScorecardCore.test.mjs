import assert from "node:assert/strict";
import test from "node:test";

import {
  judgeM5,
  metric,
  percentile,
  summariseAdoption,
  summariseReliability,
  telemetryCoverage,
} from "../lib/aiReviewScorecardCore.ts";

const run = (overrides = {}) => ({
  outcome: "completed_dual",
  durationMs: 5_000,
  dualReviewRequested: true,
  dualReviewAvailable: true,
  dualReviewCompleted: true,
  primaryModelId: "mistral-medium-3-1",
  primaryProvider: "mistral",
  primaryStatus: "completed",
  primaryRetryCount: 0,
  primaryReservedCredits: 4,
  primarySettlementStatus: "settled",
  secondaryModelId: "claude-sonnet-5",
  secondaryProvider: "anthropic",
  secondaryStatus: "completed",
  secondaryRetryCount: 0,
  secondaryReservedCredits: 4,
  secondarySettlementStatus: "settled",
  subjectKind: "account",
  createdAt: new Date("2026-08-30T00:00:00Z"),
  ...overrides,
});

test("too little data is insufficient_evidence, never zero and never a rate", () => {
  const card = summariseReliability([run()], 30);
  assert.equal(card.completionRate.status, "insufficient_evidence");
  assert.equal(card.completionRate.value, null);
  assert.equal(card.completionRate.denominator, 1);
  assert.equal(card.completionRate.minimumDenominator, 20);
});

test("every metric names its own denominator", () => {
  const card = summariseReliability([run()], 30);
  for (const key of [
    "completionRate",
    "primaryOnlyRate",
    "dualAvailabilityRate",
    "dualCompletionRate",
    "cachedRate",
    "retryRate",
    "unreconciledSettlements",
  ]) {
    assert.ok(
      card[key].denominatorLabel.length > 0,
      `${key} has no denominator label`
    );
  }
  assert.match(card.completionRate.excluded, /cache hits and refusals/);
});

test("cache hits and pre-provider refusals stay out of the completion denominator", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => run()),
    ...Array.from({ length: 15 }, () =>
      run({
        outcome: "cached",
        primaryStatus: "not_attempted",
        secondaryStatus: "not_attempted",
        primarySettlementStatus: null,
        secondarySettlementStatus: null,
      })
    ),
    ...Array.from({ length: 5 }, () =>
      run({
        outcome: "refused_before_provider",
        primaryStatus: "refused",
        secondaryStatus: "not_attempted",
        primarySettlementStatus: null,
        secondarySettlementStatus: null,
      })
    ),
  ];
  const card = summariseReliability(rows, 30);
  assert.equal(card.runs, 40);
  assert.equal(card.providerRuns, 20);
  assert.equal(card.completionRate.denominator, 20);
  assert.equal(card.completionRate.value, 1);
  // The excluded rows are still visible, by outcome, so nothing disappeared.
  assert.equal(card.byOutcome.cached, 15);
  assert.equal(card.byOutcome.refused_before_provider, 5);
  assert.equal(card.cachedRate.numerator, 15);
  assert.equal(card.cachedRate.denominator, 40);
});

test("a failed provider attempt lands in the reviewer's failure rate; a refusal does not", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => run()),
    ...Array.from({ length: 5 }, () =>
      run({
        outcome: "failed",
        primaryStatus: "failed",
        secondaryStatus: "not_attempted",
        primarySettlementStatus: null,
        secondarySettlementStatus: null,
        dualReviewCompleted: false,
      })
    ),
    ...Array.from({ length: 30 }, () =>
      run({
        outcome: "refused_before_provider",
        primaryStatus: "refused",
        secondaryStatus: "not_attempted",
        primarySettlementStatus: null,
        secondarySettlementStatus: null,
        dualReviewCompleted: false,
      })
    ),
  ];
  const card = summariseReliability(rows, 30);
  const primary = card.reviewerHealth.find(
    (entry) => entry.reviewerModelId === "mistral-medium-3-1"
  );
  assert.equal(primary.attempts, 25, "the 30 refusals must not be attempts");
  assert.equal(primary.failures, 5);
  assert.equal(primary.failureRate.value, 5 / 25);
});

test("dual availability and dual completion have different denominators", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => run()),
    ...Array.from({ length: 20 }, () =>
      run({
        outcome: "completed_primary_only",
        dualReviewAvailable: false,
        dualReviewCompleted: false,
        secondaryModelId: null,
        secondaryProvider: null,
        secondaryStatus: "not_attempted",
        secondarySettlementStatus: null,
      })
    ),
  ];
  const card = summariseReliability(rows, 30);
  assert.equal(card.dualAvailabilityRate.denominator, 40);
  assert.equal(card.dualAvailabilityRate.value, 0.5);
  // Only the runs where a second reviewer existed can be asked whether one ran.
  assert.equal(card.dualCompletionRate.denominator, 20);
  assert.equal(card.dualCompletionRate.value, 1);
});

test("a completed attempt with no settlement outcome is counted as unreconciled", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    run(
      index < 3
        ? { primarySettlementStatus: null, secondarySettlementStatus: null }
        : {}
    )
  );
  const card = summariseReliability(rows, 30);
  assert.equal(card.unreconciledSettlements.denominator, 40);
  assert.equal(card.unreconciledSettlements.numerator, 6);
});

test("percentiles are real observations, never interpolated", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  assert.equal(percentile(sample, 0.95), 100);
  assert.ok(sample.includes(percentile(sample, 0.5)));
});

test("only completed runs contribute to the duration percentiles", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => run({ durationMs: 5_000 })),
    ...Array.from({ length: 20 }, () =>
      run({
        outcome: "failed",
        durationMs: 45_000,
        primaryStatus: "failed",
        secondaryStatus: "not_attempted",
      })
    ),
  ];
  const card = summariseReliability(rows, 30);
  assert.equal(card.p50DurationMs, 5_000);
  assert.equal(card.p95DurationMs, 5_000);
});

test("telemetry coverage is a comparison, and says so", () => {
  const coverage = telemetryCoverage(100, 60);
  assert.equal(coverage.ratio.value, 0.6);
  assert.match(coverage.ratio.excluded, /not that a run failed/);
});

const event = (eventName, actorKey, day = 1) => ({
  eventName,
  actorKey,
  occurredAt: new Date(`2026-08-${String(day).padStart(2, "0")}T00:00:00Z`),
});

test("adoption denominators are the population each rate is about", () => {
  const rows = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(event("multi_model_compare_completed", `u${index}`));
  }
  for (let index = 0; index < 20; index += 1) {
    rows.push(event("comparison_review_started", `u${index}`));
    rows.push(event("comparison_review_completed", `u${index}`));
  }
  for (let index = 0; index < 5; index += 1) {
    rows.push(event("followup_sent", `u${index}`));
  }
  const card = summariseAdoption(rows, 30, {
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(card.comparisonToReview.denominator, 40);
  assert.equal(card.comparisonToReview.value, 0.5);
  assert.equal(card.reviewToFollowUp.denominator, 20);
  assert.equal(card.reviewToFollowUp.value, 0.25);
});

test("a second review is counted from completions, not starts", () => {
  const rows = [];
  for (let index = 0; index < 20; index += 1) {
    rows.push(event("comparison_review_completed", `u${index}`, 1));
  }
  // Ten users started a second review; only four finished one.
  for (let index = 0; index < 10; index += 1) {
    rows.push(event("comparison_review_started", `u${index}`, 2));
  }
  for (let index = 0; index < 4; index += 1) {
    rows.push(event("comparison_review_completed", `u${index}`, 2));
  }
  const card = summariseAdoption(rows, 30, {
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(card.firstToSecondReview.denominator, 20);
  assert.equal(card.firstToSecondReview.numerator, 4);
});

test("the comparison-only cohort excludes everyone who opened AI Review", () => {
  const rows = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(event("multi_model_compare_completed", `u${index}`));
  }
  for (let index = 0; index < 20; index += 1) {
    rows.push(event("comparison_review_started", `u${index}`));
    rows.push(event("comparison_review_completed", `u${index}`));
  }
  const card = summariseAdoption(rows, 30, {
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(card.cohortReturnDay7.comparisonOnly.denominator, 20);
  assert.equal(card.cohortReturnDay7.aiReview.denominator, 20);
});

test("weekly active review users read the window, not the whole sample", () => {
  const now = new Date("2026-08-30T00:00:00Z");
  const rows = [
    { eventName: "comparison_review_started", actorKey: "old", occurredAt: new Date("2026-08-01T00:00:00Z") },
    { eventName: "comparison_review_started", actorKey: "recent", occurredAt: new Date("2026-08-28T00:00:00Z") },
  ];
  const card = summariseAdoption(rows, 30, { now });
  assert.equal(card.weeklyActiveReviewUsers, 1);
});

test("readiness and eligibility are judged separately and never derived from each other", () => {
  const allMet = [{ item: "a", met: true, detail: "" }];
  const oneOpen = [
    { item: "b", met: true, detail: "" },
    { item: "c", met: false, detail: "" },
  ];

  const readyButNotEligible = judgeM5(allMet, oneOpen);
  assert.equal(readyButNotEligible.readinessComplete, true);
  assert.equal(readyButNotEligible.eligible, false);

  // The reverse is also expressible: evidence can exist while the tooling is
  // incomplete, and neither state implies the other.
  const eligibleButNotReady = judgeM5(oneOpen, allMet);
  assert.equal(eligibleButNotReady.readinessComplete, false);
  assert.equal(eligibleButNotReady.eligible, true);

  // An empty checklist is never a pass.
  assert.equal(judgeM5([], []).readinessComplete, false);
  assert.equal(judgeM5([], []).eligible, false);
});

test("metric() reports zero honestly when the denominator is real", () => {
  const measured = metric(0, 50, "runs", { minimumDenominator: 20 });
  assert.equal(measured.status, "ok");
  assert.equal(measured.value, 0);

  const unmeasured = metric(0, 3, "runs", { minimumDenominator: 20 });
  assert.equal(unmeasured.status, "insufficient_evidence");
  assert.equal(unmeasured.value, null);
});
