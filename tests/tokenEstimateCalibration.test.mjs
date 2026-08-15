import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCalibrationReport,
  MEASURED_MARGIN_FLOOR,
  MIN_SAMPLES_PER_COHORT,
  PROVISIONAL_RESERVATION_MULTIPLIER,
} from "../lib/tokenEstimateCalibration.ts";

const sample = (overrides = {}) => ({
  attemptId: "attempt",
  modelId: "gpt-5-6-luna",
  providerId: "openai",
  controlEstimatorVersion: "generic_multilingual_v1",
  controlRawEstimatedInputTokens: 150,
  candidateEstimatorVersion: "hangul_segment_v2",
  candidateRawEstimatedInputTokens: 80,
  reservedInputTokens: 150,
  tokenizerFamily: "generic_multilingual",
  contentCohort: "hangul_dominant",
  hangulCharacters: 100,
  hanKanaCharacters: 0,
  nonCjkBytes: 0,
  nonCjkSymbolRatio: 0,
  providerReportedInputTokens: 75,
  inputUsageSource: "provider_reported",
  outcome: "completed",
  isPartial: false,
  isCancelled: false,
  isFallbackAttempt: false,
  ...overrides,
});

const many = (count, overrides = {}) =>
  Array.from({ length: count }, (_, index) =>
    sample({ attemptId: `attempt-${index}`, ...overrides })
  );

// --- exclusions --------------------------------------------------------------

// The failure this guards: a sample whose input count fell back to the
// reservation compares an estimate against a copy of itself and reports an
// error near zero. Including even a few of those flatters the result.
test("only provider-reported, completed turns are calibrated", () => {
  const report = buildCalibrationReport([
    sample({ attemptId: "a" }),
    sample({ attemptId: "b", inputUsageSource: "fallback_estimator" }),
    sample({ attemptId: "c", inputUsageSource: "missing" }),
    sample({ attemptId: "d", outcome: "failed" }),
    sample({ attemptId: "e", isPartial: true }),
    sample({ attemptId: "f", isCancelled: true }),
    sample({ attemptId: "g", providerReportedInputTokens: 0 }),
  ]);

  assert.equal(report.totalSamples, 7);
  assert.equal(report.eligibleSamples, 1);
  assert.deepEqual(report.exclusionsByReason, {
    input_usage_not_provider_reported: 2,
    outcome_not_completed: 1,
    partial_response: 1,
    cancelled_request: 1,
    non_positive_provider_input: 1,
  });
});

// A report that only shows what survived cannot show that one provider was
// dropped wholesale, which is exactly how a biased sample looks.
test("exclusions are attributed to their provider", () => {
  const report = buildCalibrationReport([
    ...many(3, { providerId: "anthropic", inputUsageSource: "missing" }),
    sample({ attemptId: "kept", providerId: "openai" }),
  ]);
  assert.deepEqual(report.exclusionsByProvider, { anthropic: 3 });
  assert.equal(report.eligibleSamples, 1);
});

test("an empty input produces a report rather than throwing", () => {
  const report = buildCalibrationReport([]);
  assert.equal(report.totalSamples, 0);
  assert.equal(report.eligibleSamples, 0);
  assert.deepEqual(report.cohorts, []);
});

// --- accuracy ----------------------------------------------------------------

test("accuracy is measured on the raw estimate of each arm", () => {
  // actual 75: control 150 is +100%, candidate 80 is +6.67%.
  const [cohort] = buildCalibrationReport(many(MIN_SAMPLES_PER_COHORT)).cohorts;
  assert.equal(Math.round(cohort.control.medianAbsoluteErrorPercent), 100);
  assert.equal(Math.round(cohort.candidate.medianAbsoluteErrorPercent), 7);
  assert.ok(cohort.medianErrorImprovementPercentagePoints > 90);
});

test("underestimates are counted separately from absolute error", () => {
  // candidate 80 against actual 100 is a 20% underestimate -- the direction
  // that matters for a reservation.
  const [cohort] = buildCalibrationReport(
    many(MIN_SAMPLES_PER_COHORT, { providerReportedInputTokens: 100 })
  ).cohorts;
  assert.equal(cohort.candidate.underestimateRate, 1);
  assert.equal(cohort.control.underestimateRate, 0, "control 150 is above actual 100");
});

// --- cohort segmentation -----------------------------------------------------

// The whole reason cohorts exist: a large Latin sample must not be able to
// carry a Hangul failure past the gate.
test("cohorts are reported separately, with no aggregate to hide behind", () => {
  const report = buildCalibrationReport([
    ...many(MIN_SAMPLES_PER_COHORT, { contentCohort: "hangul_dominant" }).map((s, i) => ({
      ...s,
      attemptId: `ko-${i}`,
    })),
    ...many(MIN_SAMPLES_PER_COHORT, {
      contentCohort: "latin_prose",
      candidateRawEstimatedInputTokens: 76,
    }).map((s, i) => ({ ...s, attemptId: `en-${i}` })),
  ]);

  const cohorts = report.cohorts.map((cohort) => cohort.contentCohort);
  assert.deepEqual(cohorts.sort(), ["hangul_dominant", "latin_prose"]);
  assert.ok(!("aggregate" in report), "an aggregate would hide the case that matters");
});

// --- reservation margin ------------------------------------------------------

test("an underpowered cohort keeps the provisional floor and says why", () => {
  const [cohort] = buildCalibrationReport(many(5)).cohorts;
  assert.equal(cohort.status, "UNDERPOWERED");
  assert.equal(cohort.reservationMultiplierSource, "provisional_floor");
  assert.equal(cohort.recommendedReservationMultiplier, PROVISIONAL_RESERVATION_MULTIPLIER);
  assert.ok(cohort.underpoweredReasons.length > 0);
  assert.ok(
    cohort.underpoweredReasons.some((reason) => reason.includes("cohort has 5 samples")),
    cohort.underpoweredReasons.join(" | ")
  );
});

// A family can reach its sample count on English alone while saying nothing
// about Hangul, so the CJK minimum is checked on its own.
test("a family with no CJK samples stays underpowered however large it is", () => {
  const report = buildCalibrationReport(
    many(1_200, { contentCohort: "latin_prose" }).map((s, i) => ({ ...s, attemptId: `en-${i}` }))
  );
  const [cohort] = report.cohorts;
  assert.equal(cohort.status, "UNDERPOWERED");
  assert.ok(
    cohort.underpoweredReasons.some((reason) => reason.includes("CJK samples")),
    cohort.underpoweredReasons.join(" | ")
  );
});

test("a powered cohort uses the measured tail rather than the floor", () => {
  // actual 100 against candidate 80 gives actual/raw = 1.25, so the margin is
  // 1.25 + 0.05 = 1.30 -- above the provisional floor, and measured.
  const report = buildCalibrationReport(
    many(1_200, { providerReportedInputTokens: 100 }).map((s, i) => ({
      ...s,
      attemptId: `ko-${i}`,
    }))
  );
  const [cohort] = report.cohorts;
  assert.equal(cohort.status, "ok");
  assert.equal(cohort.reservationMultiplierSource, "measured_q99");
  assert.equal(cohort.candidateQ99ActualOverRaw, 1.25);
  assert.equal(cohort.recommendedReservationMultiplier, 1.3);
});

// The correction that matters: a candidate already running above actual needs
// no padding, and multiplying it again only over-reserves.
test("a candidate that already over-estimates is not padded further", () => {
  const report = buildCalibrationReport(
    many(1_200, { candidateRawEstimatedInputTokens: 200, providerReportedInputTokens: 100 }).map(
      (s, i) => ({ ...s, attemptId: `ko-${i}` })
    )
  );
  const [cohort] = report.cohorts;
  assert.equal(cohort.candidateQ99ActualOverRaw, 0.5);
  assert.equal(
    cohort.recommendedReservationMultiplier,
    MEASURED_MARGIN_FLOOR,
    "0.5 + 0.05 is below the floor, so the floor applies"
  );
});
