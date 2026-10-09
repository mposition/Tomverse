/**
 * Content-free, retrospective comparison of an original-input control and a
 * Refiner-input shadow result. These observations are caller-supplied; this
 * module neither authenticates their source nor authorizes product dispatch.
 * In particular, a completed shadow result cannot change the already-started
 * turn. A post-dispatch failure must stop for reconciliation, never retry the
 * original prompt automatically.
 */

export type PromptRefinerAutoShadowMeasurement = Readonly<{
  /** Caller-reported quality on the same fixed scale, or unknown. */
  qualityScore: number | null;
  costMicroUsd: number | null;
  /** Caller-reported preparation duration, excluding answer TTFT, or unknown. */
  preparationLatencyMs: number | null;
}>;

export type PromptRefinerAutoShadowCandidateOutcome =
  | "not_attempted"
  | "failed_before_dispatch"
  | "completed"
  | "failed_after_dispatch"
  | "unknown_after_dispatch";

export type PromptRefinerAutoShadowReason =
  | "candidate_not_attempted"
  | "candidate_failed_before_dispatch"
  | "candidate_failed_after_dispatch"
  | "candidate_outcome_unknown"
  | "measurement_missing_or_invalid"
  | "quality_regressed"
  | "cost_regressed"
  | "latency_regressed"
  | "no_recorded_regression";

export type PromptRefinerAutoShadowAssessment = Readonly<{
  /** For a future turn only; never a command to dispatch the current one. */
  futureInputSignal: "keep_original" | "no_recorded_regression" | "stop_and_reconcile";
  reason: PromptRefinerAutoShadowReason;
  /** Null unless both finite, bounded durations were supplied. */
  preparationLatencyDeltaMs: number | null;
  /** A shadow row is not authenticated quality evidence or rollout approval. */
  evidenceAuthority: "caller_supplied_unverified";
  dispatchAuthorized: false;
}>;

const validQuality = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validMeasurement = (
  value: unknown
): value is PromptRefinerAutoShadowMeasurement => {
  if (typeof value !== "object" || value === null) return false;
  const measurement = value as Record<string, unknown>;
  return (
    validQuality(measurement.qualityScore) &&
    validCount(measurement.costMicroUsd) &&
    validCount(measurement.preparationLatencyMs)
  );
};

const assessment = (
  futureInputSignal: PromptRefinerAutoShadowAssessment["futureInputSignal"],
  reason: PromptRefinerAutoShadowReason,
  preparationLatencyDeltaMs: number | null = null
): PromptRefinerAutoShadowAssessment => ({
  futureInputSignal,
  reason,
  preparationLatencyDeltaMs,
  evidenceAuthority: "caller_supplied_unverified",
  dispatchAuthorized: false,
});

/**
 * Fail-closed shadow signal. Missing/invalid quality, cost or preparation
 * latency keeps the authored input. Even a no-regression result is only an
 * offline signal; a separate gate must validate evidence and authorize use.
 */
export function assessPromptRefinerAutoShadow(input: {
  original: PromptRefinerAutoShadowMeasurement;
  candidate: PromptRefinerAutoShadowMeasurement;
  candidateOutcome: PromptRefinerAutoShadowCandidateOutcome;
}): PromptRefinerAutoShadowAssessment {
  if (typeof input !== "object" || input === null) {
    return assessment("stop_and_reconcile", "candidate_outcome_unknown");
  }
  switch (input.candidateOutcome) {
    case "not_attempted":
      return assessment("keep_original", "candidate_not_attempted");
    case "failed_before_dispatch":
      return assessment("keep_original", "candidate_failed_before_dispatch");
    case "failed_after_dispatch":
      return assessment("stop_and_reconcile", "candidate_failed_after_dispatch");
    case "unknown_after_dispatch":
      return assessment("stop_and_reconcile", "candidate_outcome_unknown");
    case "completed":
      break;
    default:
      return assessment("stop_and_reconcile", "candidate_outcome_unknown");
  }

  if (!validMeasurement(input.original) || !validMeasurement(input.candidate)) {
    return assessment("keep_original", "measurement_missing_or_invalid");
  }
  const delta =
    input.candidate.preparationLatencyMs! - input.original.preparationLatencyMs!;
  if (input.candidate.qualityScore! < input.original.qualityScore!) {
    return assessment("keep_original", "quality_regressed", delta);
  }
  if (input.candidate.costMicroUsd! > input.original.costMicroUsd!) {
    return assessment("keep_original", "cost_regressed", delta);
  }
  if (delta > 0) {
    return assessment("keep_original", "latency_regressed", delta);
  }
  return assessment("no_recorded_regression", "no_recorded_regression", delta);
}
