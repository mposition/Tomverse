// The data contract for dual-estimate shadow recording (G1 step 3).
//
// Two rules this contract exists to hold, both of which are easy to break by
// accident:
//
//   1. A shadow candidate never touches production. It is recorded and
//      compared, and it must not reach credit reservation, request rejection,
//      routing, or a provider call. Only the control estimate does that.
//   2. No prompt text is stored. Everything here is derived -- character
//      counts, byte counts, a cohort label -- so a calibration sample can be
//      analysed without the conversation it came from.
//
// The third rule is about provenance, and it is the one the existing telemetry
// gets wrong. `usageSource` in lib/chatSecurity.ts is decided by whether the
// provider reported *output* tokens, while the settlement path independently
// falls back to the reserved value when *input* tokens are missing. A response
// that reports output but not input is therefore labelled
// "provider_usage_metadata" while its input figure is the estimate itself.
// Calibrating on those samples would compare an estimate against a copy of
// itself and report an error near zero.
//
// So input provenance is its own field here, decided only by whether the
// provider reported input tokens, and the calibration query filters on it.

import {
  estimateTokenBreakdown,
  type TokenEstimateBreakdown,
  type TokenizerFamily,
} from "@/lib/chatTokenEstimate";

/**
 * Canonical provenance vocabulary. The repository currently carries three
 * spellings of the same idea -- "provider_usage_metadata" and
 * "fallback_estimator" in lib/chatSecurity.ts, "provider_reported" /
 * "provider" / "estimated" in scripts/report-output-token-telemetry.mjs. New
 * telemetry uses this enum, and the older emitters normalise into it rather
 * than each analysis re-deriving the mapping.
 */
export type InputUsageSource = "provider_reported" | "fallback_estimator" | "missing";

/**
 * Which content the sample is mostly made of. Kept coarse on purpose: it has
 * to be derivable from counts alone, without retaining the text.
 *
 * `latin_prose` and `code_json` are separated because they behave differently
 * enough to invert a calibration's sign -- an English-prose byte ratio applied
 * to JSON underestimates it badly.
 */
export type ContentCohort =
  | "hangul_dominant"
  | "han_kana_dominant"
  | "mixed_cjk_latin"
  | "latin_prose"
  | "code_json";

export type ShadowAttemptOutcome = "completed" | "failed" | "cancelled";

/**
 * One shadow observation. Everything is derived or an identifier; no prompt,
 * no message content, no provider payload.
 */
export type TokenEstimateShadowSample = {
  attemptId: string;
  modelId: string;
  providerId: string;

  /** The estimate that actually drove reservation and limits. */
  controlEstimatorVersion: string;
  controlRawEstimatedInputTokens: number;

  /** The estimate under evaluation. Recorded only; never acted on. */
  candidateEstimatorVersion: string;
  candidateRawEstimatedInputTokens: number;

  /** What was really reserved, control-derived, including tool overhead. */
  reservedInputTokens: number;

  tokenizerFamily: TokenizerFamily;
  contentCohort: ContentCohort;
  hangulCharacters: number;
  hanKanaCharacters: number;
  nonCjkBytes: number;

  /**
   * Null unless the provider itself reported input tokens. Never filled from a
   * reservation fallback -- that is what `inputUsageSource` distinguishes.
   */
  providerReportedInputTokens: number | null;
  inputUsageSource: InputUsageSource;

  outcome: ShadowAttemptOutcome;
  isPartial: boolean;
  isCancelled: boolean;
  isFallbackAttempt: boolean;
};

/**
 * A sample is only usable for calibration when the provider itself reported
 * the input count and the turn completed whole. Partial, cancelled and
 * fallback-estimated turns are recorded but excluded, with the reason kept so
 * the query can report what it dropped -- silent exclusion hides the sampling
 * bias it creates.
 */
export type CalibrationExclusionReason =
  | "input_usage_not_provider_reported"
  | "outcome_not_completed"
  | "partial_response"
  | "cancelled_request"
  | "non_positive_provider_input";

export const calibrationExclusionReason = (
  sample: TokenEstimateShadowSample
): CalibrationExclusionReason | null => {
  if (sample.inputUsageSource !== "provider_reported") return "input_usage_not_provider_reported";
  if (sample.outcome !== "completed") return "outcome_not_completed";
  if (sample.isPartial) return "partial_response";
  if (sample.isCancelled) return "cancelled_request";
  if (!sample.providerReportedInputTokens || sample.providerReportedInputTokens <= 0) {
    return "non_positive_provider_input";
  }
  return null;
};

export const isCalibrationEligible = (sample: TokenEstimateShadowSample) =>
  calibrationExclusionReason(sample) === null;

/**
 * Resolves input provenance from what the provider actually returned for
 * *input* tokens, independently of anything decided from output tokens.
 */
export const resolveInputUsageSource = ({
  providerReportedInputTokens,
  providerReturnedUsage,
}: {
  providerReportedInputTokens: number | null | undefined;
  providerReturnedUsage: boolean;
}): InputUsageSource => {
  if (
    typeof providerReportedInputTokens === "number" &&
    Number.isSafeInteger(providerReportedInputTokens) &&
    providerReportedInputTokens > 0
  ) {
    return "provider_reported";
  }
  return providerReturnedUsage ? "fallback_estimator" : "missing";
};

// A request is only called Hangul- or Han/Kana-dominant when that segment
// clearly carries it, so a Korean sentence wrapped around a large code block
// lands in mixed_cjk_latin and is analysed as its own cohort rather than
// flattering the Hangul numbers.
const CJK_DOMINANCE_TOKEN_SHARE = 0.6;
const CJK_PRESENCE_TOKEN_SHARE = 0.1;
// Code and JSON tokenize far denser than prose. Bytes per token on the control
// estimate is a rough but text-free way to tell them apart.
const CODE_JSON_BYTES_PER_TOKEN_CEILING = 3.6;

/**
 * Classifies a sample from its breakdown alone. Deliberately count-based: the
 * cohort has to be derivable without keeping the text it describes.
 */
export const resolveContentCohort = (breakdown: TokenEstimateBreakdown): ContentCohort => {
  const { tokensBySegment, rawTotal, nonCjkBytes } = breakdown;
  if (rawTotal === 0) return "latin_prose";

  const hangulShare = tokensBySegment.hangul / rawTotal;
  const hanKanaShare = tokensBySegment.hanKana / rawTotal;
  const cjkShare = hangulShare + hanKanaShare;

  if (hangulShare >= CJK_DOMINANCE_TOKEN_SHARE) return "hangul_dominant";
  if (hanKanaShare >= CJK_DOMINANCE_TOKEN_SHARE) return "han_kana_dominant";
  if (cjkShare >= CJK_PRESENCE_TOKEN_SHARE) return "mixed_cjk_latin";

  const nonCjkTokens = tokensBySegment.nonCjk;
  const bytesPerToken = nonCjkTokens > 0 ? nonCjkBytes / nonCjkTokens : 0;
  return bytesPerToken > 0 && bytesPerToken <= CODE_JSON_BYTES_PER_TOKEN_CEILING
    ? "code_json"
    : "latin_prose";
};

/**
 * Builds the derived half of a shadow sample from the text, without retaining
 * it. The caller supplies identifiers, the reservation and the provider's
 * reported usage.
 */
export const buildShadowEstimate = (
  text: string,
  {
    controlVersion,
    candidateVersion,
  }: { controlVersion: string; candidateVersion: string }
) => {
  const control = estimateTokenBreakdown(text, controlVersion);
  const candidate = estimateTokenBreakdown(text, candidateVersion);
  return {
    controlEstimatorVersion: control.version,
    controlRawEstimatedInputTokens: control.rawTotal,
    candidateEstimatorVersion: candidate.version,
    candidateRawEstimatedInputTokens: candidate.rawTotal,
    contentCohort: resolveContentCohort(control),
    hangulCharacters: control.hangulCharacters,
    hanKanaCharacters: control.hanKanaCharacters,
    nonCjkBytes: control.nonCjkBytes,
  };
};
