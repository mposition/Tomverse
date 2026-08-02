/**
 * Output-token distributions, and whether they are good enough to move
 * `reservationOutputBasis` off `conservative_default`.
 *
 * Section 3.1 of docs/policy/default-model-luna-migration.md lists nine
 * conditions a p90 has to satisfy before it may size a reservation. They are
 * written as prose there, and prose is easy to nod along to -- so they are
 * restated here as checks a sample either passes or does not, and the report
 * says which. The point is not to automate the decision: a passing checklist
 * is still only the input to a change that needs its own approval, its own
 * `pricingVersion` and its own pull request.
 *
 * Pure. The script that feeds it reads settled reservations; nothing here
 * touches a database, and nothing anywhere applies the result.
 */

export type OutputTokenSample = {
  modelId: string;
  /** Settled output tokens, including billed reasoning tokens. */
  outputTokens: number;
  /** When the reservation settled. */
  settledAt: string;
  /** e.g. "chat", "comparison-review", "title" -- see ChatCreditReservation.source. */
  workload: string;
  /** The reasoning setting in force, so a change of setting is not pooled across. */
  reasoningEffort: string | null;
  /**
   * Whether the request produced provider cost. Cancelled and partial answers
   * belong in the sample -- the reservation was taken for them too -- while a
   * failure that cost nothing does not.
   */
  billed: boolean;
  /** True when the answer was cut short (user cancellation, cap, error mid-stream). */
  partial: boolean;
  /** How the settled figure was obtained. */
  usageSource: "provider_reported" | "estimated";
};

export type Percentiles = {
  count: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

export type NineConditionCode =
  | "per_model"
  | "window_and_sample_size"
  | "workload_split"
  | "settled_tokens_only"
  | "partial_and_cancelled_included"
  | "homogeneous_configuration"
  | "auditable_record"
  | "headroom_and_floor"
  | "drift_watch";

export type ConditionResult = {
  code: NineConditionCode;
  /** null when the condition cannot be decided from data alone. */
  satisfied: boolean | null;
  detail: string;
};

export type ModelTelemetryReport = {
  modelId: string;
  overall: Percentiles;
  byWorkload: { workload: string; percentiles: Percentiles }[];
  reasoningEffortsPresent: string[];
  estimatedUsageShare: number;
  partialShare: number;
  windowStart: string | null;
  windowEnd: string | null;
  windowDays: number | null;
  conditions: ConditionResult[];
  /** Only ever "conservative_default" here. This module never proposes p90. */
  recommendedBasis: "conservative_default";
  blockers: string[];
};

/** Policy 3.1(2): the minimum settled answers per model before a p90 means anything. */
export const MIN_SAMPLES_PER_MODEL = 500;
/** Policy 3.1(2): the minimum continuous window the sample must span. */
export const MIN_WINDOW_DAYS = 14;
/** Policy 3.1(3): a workload whose p90 exceeds the overall p90 by more than this is not covered by it. */
export const WORKLOAD_P90_TOLERANCE = 1.25;
/** Policy 3.1(8): the multiplier applied above p90 if one were ever adopted. */
export const P90_SAFETY_MULTIPLIER = 1.2;

export const percentile = (sorted: readonly number[], fraction: number) => {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
};

export const summarise = (values: readonly number[]): Percentiles => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  };
};

const dayCount = (from: string, to: string) => {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return (end - start) / 86_400_000;
};

/**
 * Builds one model's report. `samples` must already be that model's own --
 * condition 1 is that two models are never pooled, and the way to satisfy a
 * condition is to make it structurally impossible to violate, not to check it
 * afterwards.
 */
export const reportModelOutputTokens = ({
  modelId,
  samples,
}: {
  modelId: string;
  samples: readonly OutputTokenSample[];
}): ModelTelemetryReport => {
  const mine = samples.filter((sample) => sample.modelId === modelId);
  // 3.1(4)(5): settled, billed answers only -- partial and cancelled ones
  // included, because a reservation was taken for them too; a failure that
  // cost nothing excluded, because none was.
  const eligible = mine.filter((sample) => sample.billed);
  const values = eligible.map((sample) => sample.outputTokens);
  const overall = summarise(values);

  const settledAts = eligible
    .map((sample) => sample.settledAt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const windowStart = settledAts[0] ?? null;
  const windowEnd = settledAts[settledAts.length - 1] ?? null;
  const windowDays =
    windowStart && windowEnd ? dayCount(windowStart, windowEnd) : null;

  const workloads = Array.from(
    new Set(eligible.map((sample) => sample.workload))
  ).sort();
  const byWorkload = workloads.map((workload) => ({
    workload,
    percentiles: summarise(
      eligible
        .filter((sample) => sample.workload === workload)
        .map((sample) => sample.outputTokens)
    ),
  }));

  const reasoningEffortsPresent = Array.from(
    new Set(eligible.map((sample) => sample.reasoningEffort ?? "unset"))
  ).sort();
  const estimatedCount = eligible.filter(
    (sample) => sample.usageSource === "estimated"
  ).length;
  const estimatedUsageShare =
    eligible.length === 0 ? 0 : estimatedCount / eligible.length;
  const partialShare =
    eligible.length === 0
      ? 0
      : eligible.filter((sample) => sample.partial).length / eligible.length;

  const heavyWorkloads = byWorkload.filter(
    (entry) =>
      overall.p90 > 0 &&
      entry.percentiles.count > 0 &&
      entry.percentiles.p90 > overall.p90 * WORKLOAD_P90_TOLERANCE
  );

  const conditions: ConditionResult[] = [
    {
      code: "per_model",
      satisfied: true,
      detail: `Computed from ${modelId}'s own settled answers only; no other model's tokens are in this figure.`,
    },
    {
      code: "window_and_sample_size",
      satisfied:
        eligible.length >= MIN_SAMPLES_PER_MODEL &&
        windowDays !== null &&
        windowDays >= MIN_WINDOW_DAYS,
      detail: `${eligible.length} settled answer(s) over ${windowDays === null ? "no" : windowDays.toFixed(1)} day(s); policy asks for >=${MIN_SAMPLES_PER_MODEL} across a continuous >=${MIN_WINDOW_DAYS}-day window.`,
    },
    {
      code: "workload_split",
      satisfied: eligible.length > 0 && heavyWorkloads.length === 0,
      detail:
        heavyWorkloads.length === 0
          ? `${workloads.length} workload(s), none whose p90 exceeds the overall p90 by more than ${WORKLOAD_P90_TOLERANCE}x.`
          : `${heavyWorkloads
              .map(
                (entry) =>
                  `${entry.workload} p90=${entry.percentiles.p90} vs overall ${overall.p90}`
              )
              .join("; ")} -- the overall p90 does not cover these, so it must not be used as if it did.`,
    },
    {
      code: "settled_tokens_only",
      satisfied: estimatedUsageShare === 0,
      detail:
        estimatedUsageShare === 0
          ? "Every sample's output tokens came from the provider's own reported usage."
          : `${(estimatedUsageShare * 100).toFixed(1)}% of samples were estimated rather than provider-reported. An estimate cannot size a reservation that the estimate itself produced.`,
    },
    {
      code: "partial_and_cancelled_included",
      satisfied: true,
      detail: `Partial and cancelled but billed answers are included (${(partialShare * 100).toFixed(1)}% of the sample); unbilled failures are excluded.`,
    },
    {
      code: "homogeneous_configuration",
      satisfied: reasoningEffortsPresent.length <= 1,
      detail:
        reasoningEffortsPresent.length <= 1
          ? `One reasoning configuration throughout (${reasoningEffortsPresent[0] ?? "none observed"}).`
          : `Samples span ${reasoningEffortsPresent.join(", ")}. Output length distributions either side of a reasoning change are not the same distribution.`,
    },
    {
      code: "auditable_record",
      satisfied: null,
      detail:
        "Requires a human: the window, sample count, per-workload distribution, percentiles, the query that produced them and the date applied have to be filed with the decision. This report is the artefact to file, not the filing.",
    },
    {
      code: "headroom_and_floor",
      satisfied: null,
      detail: `Requires a decision: policy 3.1(8) asks for headroom above p90 (x${P90_SAFETY_MULTIPLIER} is the worked example) and a floor for short-answer models. p90 x ${P90_SAFETY_MULTIPLIER} would be ${Math.ceil(overall.p90 * P90_SAFETY_MULTIPLIER)} tokens here.`,
    },
    {
      code: "drift_watch",
      satisfied: null,
      detail:
        "Requires a commitment: an alert when p90/p95 moves materially past this run, and a path back to conservative_default. Neither exists yet.",
    },
  ];

  const blockers = conditions
    .filter((condition) => condition.satisfied === false)
    .map((condition) => `${condition.code}: ${condition.detail}`);

  return {
    modelId,
    overall,
    byWorkload,
    reasoningEffortsPresent,
    estimatedUsageShare,
    partialShare,
    windowStart,
    windowEnd,
    windowDays,
    conditions,
    // Unconditional, and not a placeholder. Even a sample that satisfies every
    // measurable condition leaves three that only a human can close, and
    // changing the basis needs a new pricingVersion so old and new
    // reservations are never compared as if they were sized the same way.
    recommendedBasis: "conservative_default",
    blockers,
  };
};
