// Turns shadow samples into the calibration report G1 needs (step 2/3).
//
// Pure on purpose. The database wrapper lives in
// scripts/report-token-estimate-calibration.mjs; everything that decides what a
// number *means* is here, so it can be tested without a database and so a
// threshold cannot quietly differ between the query and the analysis.
//
// Two properties this module exists to enforce:
//
//   1. Only provider-reported, completed turns are calibrated. A sample whose
//      input count fell back to the reservation compares an estimate with a
//      copy of itself and reports an error near zero.
//   2. Exclusions are counted and reported, never silent. If one provider or
//      every long request is dropped, the remaining sample is biased, and a
//      report that only shows what survived cannot show that.
//
// Only the raw estimate is graded. The reservation margin is deliberate
// padding, and scoring it as accuracy would fail the gate for being safe.

import {
  calibrationExclusionReason,
  type CalibrationExclusionReason,
  type ContentCohort,
  type TokenEstimateShadowSample,
} from "@/lib/tokenEstimateShadow";

/**
 * Per tokenizer family, before a measured margin replaces the provisional
 * floor. Both have to hold: a family can reach 1,000 samples on English alone
 * while saying nothing about Hangul, which is the case this product cannot
 * afford to get wrong.
 */
export const MIN_SAMPLES_PER_FAMILY = 1_000;
export const MIN_CJK_SAMPLES_PER_FAMILY = 100;
/** Below this a single cohort's percentiles are noise, whatever the family total. */
export const MIN_SAMPLES_PER_COHORT = 100;

/**
 * Used while a family is underpowered. Deliberately above the measured values
 * so an unmeasured family over-reserves rather than under-reserves.
 */
export const PROVISIONAL_RESERVATION_MULTIPLIER = 1.2;
/**
 * Once measured, the margin is the observed tail plus a small headroom, floored
 * at 1.00: a candidate that already runs above actual needs no extra padding,
 * and multiplying it again only over-reserves.
 */
export const MEASURED_MARGIN_HEADROOM = 0.05;
export const MEASURED_MARGIN_FLOOR = 1;

const CJK_COHORTS: ContentCohort[] = ["hangul_dominant", "han_kana_dominant", "mixed_cjk_latin"];

export type CalibrationExclusionCounts = Partial<Record<CalibrationExclusionReason, number>>;

export type ArmAccuracy = {
  /** Median of |raw - actual| / actual, as a percentage. */
  medianAbsoluteErrorPercent: number;
  p95AbsoluteErrorPercent: number;
  /** Share of samples where the estimate came in below what the provider billed. */
  underestimateRate: number;
};

export type CohortCalibration = {
  tokenizerFamily: string;
  contentCohort: ContentCohort;
  sampleCount: number;
  control: ArmAccuracy;
  candidate: ArmAccuracy;
  /** Positive means the candidate is closer to actual than the control. */
  medianErrorImprovementPercentagePoints: number;
  p95ErrorImprovementPercentagePoints: number;
  /** Q99 of actual / candidateRaw -- the tail the reservation has to cover. */
  candidateQ99ActualOverRaw: number;
  recommendedReservationMultiplier: number;
  reservationMultiplierSource: "provisional_floor" | "measured_q99";
  status: "ok" | "UNDERPOWERED";
  underpoweredReasons: string[];
};

export type CalibrationReport = {
  totalSamples: number;
  eligibleSamples: number;
  exclusionsByReason: CalibrationExclusionCounts;
  /** Excluded counts per provider, so a provider-shaped bias is visible. */
  exclusionsByProvider: Record<string, number>;
  cohorts: CohortCalibration[];
};

const percentile = (sortedAscending: number[], p: number) =>
  sortedAscending.length === 0
    ? 0
    : sortedAscending[Math.min(sortedAscending.length - 1, Math.floor(p * sortedAscending.length))];

const summariseArm = (rawEstimates: number[], actuals: number[]): ArmAccuracy => {
  const absoluteErrors: number[] = [];
  let underestimates = 0;
  for (const [index, raw] of rawEstimates.entries()) {
    const actual = actuals[index];
    if (!actual) continue;
    absoluteErrors.push((Math.abs(raw - actual) / actual) * 100);
    if (raw < actual) underestimates += 1;
  }
  absoluteErrors.sort((a, b) => a - b);
  return {
    medianAbsoluteErrorPercent: percentile(absoluteErrors, 0.5),
    p95AbsoluteErrorPercent: percentile(absoluteErrors, 0.95),
    underestimateRate: absoluteErrors.length === 0 ? 0 : underestimates / absoluteErrors.length,
  };
};

const round = (value: number, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Partitions samples, then reports accuracy per tokenizer family and content
 * cohort. Aggregates are deliberately absent: an English-heavy corpus can pass
 * an overall p95 while Hangul is twice as wrong, and that is the exact failure
 * this product has to see.
 */
export const buildCalibrationReport = (
  samples: TokenEstimateShadowSample[]
): CalibrationReport => {
  const exclusionsByReason: CalibrationExclusionCounts = {};
  const exclusionsByProvider: Record<string, number> = {};
  const eligible: TokenEstimateShadowSample[] = [];

  for (const sample of samples) {
    const reason = calibrationExclusionReason(sample);
    if (reason === null) {
      eligible.push(sample);
      continue;
    }
    exclusionsByReason[reason] = (exclusionsByReason[reason] ?? 0) + 1;
    exclusionsByProvider[sample.providerId] = (exclusionsByProvider[sample.providerId] ?? 0) + 1;
  }

  const byFamily = new Map<string, TokenEstimateShadowSample[]>();
  for (const sample of eligible) {
    const bucket = byFamily.get(sample.tokenizerFamily) ?? [];
    bucket.push(sample);
    byFamily.set(sample.tokenizerFamily, bucket);
  }

  const cohorts: CohortCalibration[] = [];

  for (const [tokenizerFamily, familySamples] of byFamily) {
    const familyCjkSamples = familySamples.filter((sample) =>
      CJK_COHORTS.includes(sample.contentCohort)
    ).length;

    const byCohort = new Map<ContentCohort, TokenEstimateShadowSample[]>();
    for (const sample of familySamples) {
      const bucket = byCohort.get(sample.contentCohort) ?? [];
      bucket.push(sample);
      byCohort.set(sample.contentCohort, bucket);
    }

    for (const [contentCohort, cohortSamples] of byCohort) {
      const actuals = cohortSamples.map((sample) => sample.providerReportedInputTokens ?? 0);
      const control = summariseArm(
        cohortSamples.map((sample) => sample.controlRawEstimatedInputTokens),
        actuals
      );
      const candidate = summariseArm(
        cohortSamples.map((sample) => sample.candidateRawEstimatedInputTokens),
        actuals
      );

      const ratios = cohortSamples
        .map((sample, index) =>
          sample.candidateRawEstimatedInputTokens > 0
            ? actuals[index] / sample.candidateRawEstimatedInputTokens
            : null
        )
        .filter((ratio): ratio is number => ratio !== null && Number.isFinite(ratio))
        .sort((a, b) => a - b);
      const q99 = percentile(ratios, 0.99);

      const underpoweredReasons: string[] = [];
      if (familySamples.length < MIN_SAMPLES_PER_FAMILY) {
        underpoweredReasons.push(
          `family has ${familySamples.length} eligible samples, needs ${MIN_SAMPLES_PER_FAMILY}`
        );
      }
      if (familyCjkSamples < MIN_CJK_SAMPLES_PER_FAMILY) {
        underpoweredReasons.push(
          `family has ${familyCjkSamples} CJK samples, needs ${MIN_CJK_SAMPLES_PER_FAMILY}`
        );
      }
      if (cohortSamples.length < MIN_SAMPLES_PER_COHORT) {
        underpoweredReasons.push(
          `cohort has ${cohortSamples.length} samples, needs ${MIN_SAMPLES_PER_COHORT}`
        );
      }

      const underpowered = underpoweredReasons.length > 0;
      cohorts.push({
        tokenizerFamily,
        contentCohort,
        sampleCount: cohortSamples.length,
        control,
        candidate,
        medianErrorImprovementPercentagePoints: round(
          control.medianAbsoluteErrorPercent - candidate.medianAbsoluteErrorPercent
        ),
        p95ErrorImprovementPercentagePoints: round(
          control.p95AbsoluteErrorPercent - candidate.p95AbsoluteErrorPercent
        ),
        candidateQ99ActualOverRaw: round(q99, 3),
        recommendedReservationMultiplier: underpowered
          ? PROVISIONAL_RESERVATION_MULTIPLIER
          : round(Math.max(MEASURED_MARGIN_FLOOR, q99 + MEASURED_MARGIN_HEADROOM), 3),
        reservationMultiplierSource: underpowered ? "provisional_floor" : "measured_q99",
        status: underpowered ? "UNDERPOWERED" : "ok",
        underpoweredReasons,
      });
    }
  }

  cohorts.sort(
    (a, b) =>
      a.tokenizerFamily.localeCompare(b.tokenizerFamily) ||
      a.contentCohort.localeCompare(b.contentCohort)
  );

  return {
    totalSamples: samples.length,
    eligibleSamples: eligible.length,
    exclusionsByReason,
    exclusionsByProvider,
    cohorts,
  };
};
