import assert from "node:assert/strict";
import test from "node:test";

import {
  judgeM5,
  metric,
  percentile,
  summariseAdoption,
  summariseReliability,
  sequencedConversion,
  telemetryCoverage,
} from "../lib/aiReviewScorecardCore.ts";

const attempt = (overrides = {}) => ({
  reviewerModelId: "mistral-medium-3-1",
  reviewerProvider: "mistral",
  status: "completed",
  retryCount: 0,
  reservedCredits: 4,
  settledCredits: 4,
  settlementStatus: "settled",
  ...overrides,
});

const run = (overrides = {}) => ({
  attempts: [
    attempt(),
    attempt({ reviewerModelId: "claude-sonnet-5", reviewerProvider: "anthropic" }),
  ],
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
    "creditReconciliation",
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
        attempts: [],
        primaryStatus: "not_attempted",
        secondaryStatus: "not_attempted",
      })
    ),
    ...Array.from({ length: 5 }, () =>
      run({
        outcome: "refused_before_provider",
        attempts: [attempt({ status: "refused", settledCredits: null })],
        primaryStatus: "refused",
        secondaryStatus: "not_attempted",
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
        attempts: [attempt({ status: "failed", settledCredits: 0 })],
        primaryStatus: "failed",
        secondaryStatus: "not_attempted",
        dualReviewCompleted: false,
      })
    ),
    ...Array.from({ length: 30 }, () =>
      run({
        outcome: "refused_before_provider",
        attempts: [attempt({ status: "refused", settledCredits: null })],
        primaryStatus: "refused",
        secondaryStatus: "not_attempted",
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

test("a fallback cannot hide the failure that preceded it", () => {
  // The defect this is written against: the run row's primary slot held
  // whoever produced the result, so Mistral failing and Sonnet succeeding
  // recorded only Sonnet -- and Mistral's failure vanished from its own
  // failure rate. Health is computed from the attempt list for this reason.
  const fallback = () =>
    run({
      outcome: "completed_primary_only",
      attempts: [
        attempt({ status: "failed", settledCredits: 0 }),
        attempt({
          reviewerModelId: "claude-sonnet-5",
          reviewerProvider: "anthropic",
        }),
      ],
      // The slot names the reviewer that answered, which is a different and
      // also true fact.
      primaryModelId: "claude-sonnet-5",
      primaryProvider: "anthropic",
      primaryStatus: "completed",
      secondaryStatus: "not_attempted",
      dualReviewCompleted: false,
      dualReviewAvailable: false,
    });
  const card = summariseReliability(
    Array.from({ length: 25 }, fallback),
    30
  );
  const mistral = card.reviewerHealth.find(
    (entry) => entry.reviewerModelId === "mistral-medium-3-1"
  );
  assert.ok(mistral, "the failed reviewer must still appear");
  assert.equal(mistral.attempts, 25);
  assert.equal(mistral.failures, 25);
  assert.equal(mistral.failureRate.value, 1);

  const sonnet = card.reviewerHealth.find(
    (entry) => entry.reviewerModelId === "claude-sonnet-5"
  );
  assert.equal(sonnet.failures, 0);
  // The run itself completed, which is also true and separately reported.
  assert.equal(card.completionRate.value, 1);
});

test("a retry that still failed is counted as a retry", () => {
  const rows = Array.from({ length: 25 }, () =>
    run({
      outcome: "failed",
      attempts: [attempt({ status: "failed", retryCount: 1, settledCredits: 0 })],
      primaryStatus: "failed",
      secondaryStatus: "not_attempted",
    })
  );
  const card = summariseReliability(rows, 30);
  assert.equal(card.retryRate.value, 1);
  assert.equal(card.retryRate.denominator, 25);
});

test("settling above the reservation is the reconciliation signal", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => run()),
    ...Array.from({ length: 5 }, () =>
      run({
        attempts: [attempt({ reservedCredits: 4, settledCredits: 9 })],
      })
    ),
  ];
  const card = summariseReliability(rows, 30);
  assert.equal(card.creditReconciliation.numerator, 5);
  assert.equal(card.creditReconciliation.denominator, 45);
});

test("settling below the reservation is normal and is not a mismatch", () => {
  // The unused part of a reservation is released; only charging MORE than was
  // held costs a user something.
  const rows = Array.from({ length: 25 }, () =>
    run({ attempts: [attempt({ reservedCredits: 8, settledCredits: 3 })] })
  );
  const card = summariseReliability(rows, 30);
  assert.equal(card.creditReconciliation.numerator, 0);
  assert.equal(card.creditReconciliation.value, 0);
});

test("an attempt whose settlement never reported is unreconciled, not a mismatch", () => {
  // "We do not know" and "they disagree" call for different investigations, so
  // they are different metrics.
  const rows = Array.from({ length: 25 }, () =>
    run({ attempts: [attempt({ settledCredits: null, settlementStatus: null })] })
  );
  const card = summariseReliability(rows, 30);
  assert.equal(card.unreconciledSettlements.value, 1);
  assert.equal(card.creditReconciliation.denominator, 0);
  assert.equal(card.creditReconciliation.value, null);
  assert.equal(card.creditReconciliation.status, "insufficient_evidence");
});

test("dual availability and dual completion have different denominators", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => run()),
    ...Array.from({ length: 20 }, () =>
      run({
        outcome: "completed_primary_only",
        attempts: [attempt()],
        dualReviewAvailable: false,
        dualReviewCompleted: false,
        secondaryModelId: null,
        secondaryProvider: null,
        secondaryStatus: "not_attempted",
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

test("a completed attempt with no settled figure is counted as unreconciled", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    run(
      index < 3
        ? {
            attempts: [
              attempt({ settledCredits: null }),
              attempt({
                reviewerModelId: "claude-sonnet-5",
                settledCredits: null,
              }),
            ],
          }
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
        attempts: [attempt({ status: "failed", settledCredits: 0 })],
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
    rows.push(event("multi_model_compare_completed", `u${index}`, 1));
  }
  for (let index = 0; index < 20; index += 1) {
    rows.push(event("comparison_review_started", `u${index}`, 2));
    rows.push(event("comparison_review_completed", `u${index}`, 2));
  }
  for (let index = 0; index < 5; index += 1) {
    rows.push(event("followup_sent", `u${index}`, 3));
  }
  const card = summariseAdoption(rows, 30, {
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(card.comparisonToReview.denominator, 40);
  assert.equal(card.comparisonToReview.value, 0.5);
  assert.equal(card.reviewToFollowUp.denominator, 20);
  assert.equal(card.reviewToFollowUp.value, 0.25);
});

test("a conversion requires the second event to follow the first", () => {
  // The defect this replaces: "has both events in the window" counted a
  // morning follow-up as caused by an afternoon review.
  const before = [];
  for (let index = 0; index < 25; index += 1) {
    before.push(event("followup_sent", `u${index}`, 1));
    before.push(event("comparison_review_completed", `u${index}`, 2));
  }
  const beforeCard = summariseAdoption(before, 30, {
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(beforeCard.reviewToFollowUp.denominator, 25);
  assert.equal(beforeCard.reviewToFollowUp.value, 0);

  const after = [];
  for (let index = 0; index < 25; index += 1) {
    after.push(event("comparison_review_completed", `u${index}`, 1));
    after.push(event("followup_sent", `u${index}`, 2));
  }
  const afterCard = summariseAdoption(after, 30, {
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(afterCard.reviewToFollowUp.value, 1);
  assert.match(afterCard.reviewToFollowUp.excluded, /must follow the first/);
});

test("sequencedConversion names its ordering, and reports zero rather than nothing", () => {
  const rows = [
    event("comparison_review_completed", "a", 5),
    event("followup_sent", "a", 4),
  ];
  assert.deepEqual(
    sequencedConversion(rows, ["comparison_review_completed"], ["followup_sent"]),
    { converted: 0, population: 1 }
  );
  // An actor with no anchoring event is not in the population at all.
  assert.deepEqual(
    sequencedConversion(
      [event("followup_sent", "b", 4)],
      ["comparison_review_completed"],
      ["followup_sent"]
    ),
    { converted: 0, population: 0 }
  );
});

test("retention by account age is reported apart from retention after a review", () => {
  const rows = [];
  for (let index = 0; index < 25; index += 1) {
    rows.push(event("comparison_review_completed", `u${index}`, 1));
    // Something on day 9, which is 8 days after their first review.
    rows.push(event("followup_sent", `u${index}`, 9));
  }
  const card = summariseAdoption(rows, 30, {
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(card.reviewAnchoredReturnDay7.value, 1);
  assert.equal(card.reviewAnchoredReturnDay30.value, 0);
  // The account-age series is a different question and says so.
  assert.equal(card.accountAgeReturnDay7.value, 0);
  assert.match(card.accountAgeReturnDay7.excluded, /not review retention/);
  assert.match(card.reviewAnchoredReturnDay7.excluded, /floor/);
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

test("the three M5 states are judged separately and never derived from each other", () => {
  const allMet = [{ item: "a", met: true, detail: "" }];
  const oneOpen = [
    { item: "b", met: true, detail: "" },
    { item: "c", met: false, detail: "" },
  ];

  // The state that actually existed and had no name: the harness is built and
  // the dataset that would make its numbers believable does not exist yet.
  const built = judgeM5(allMet, oneOpen, oneOpen);
  assert.equal(built.scaffoldingComplete, true);
  assert.equal(built.readinessComplete, false);
  assert.equal(built.eligible, false);

  const ready = judgeM5(allMet, allMet, oneOpen);
  assert.equal(ready.readinessComplete, true);
  assert.equal(ready.eligible, false);

  // Each list is independent; none implies another in either direction.
  const oddly = judgeM5(oneOpen, oneOpen, allMet);
  assert.equal(oddly.scaffoldingComplete, false);
  assert.equal(oddly.readinessComplete, false);
  assert.equal(oddly.eligible, true);

  // An empty checklist is never a pass.
  assert.equal(judgeM5([], [], []).scaffoldingComplete, false);
  assert.equal(judgeM5([], [], []).readinessComplete, false);
  assert.equal(judgeM5([], [], []).eligible, false);
});

test("metric() reports zero honestly when the denominator is real", () => {
  const measured = metric(0, 50, "runs", { minimumDenominator: 20 });
  assert.equal(measured.status, "ok");
  assert.equal(measured.value, 0);

  const unmeasured = metric(0, 3, "runs", { minimumDenominator: 20 });
  assert.equal(unmeasured.status, "insufficient_evidence");
  assert.equal(unmeasured.value, null);
});
