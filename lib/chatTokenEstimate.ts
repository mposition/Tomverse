// One shared prompt-token estimator for every surface that has to guess how
// large a request will be before the provider answers: the composer's live
// credit estimate, the comparison preflight, the chat route's reservation and
// the availability probe. They used to each carry their own
// `Buffer.byteLength(text) / 4` copy, which is why a Korean conversation could
// be reserved several times too small on one surface and not another.
//
// Two things this module deliberately keeps apart, because conflating them is
// what makes an accuracy target unmeasurable:
//
//   raw      -- an unbiased prediction of what the tokenizer will produce.
//               This is what ESTIMATE-01/02 grade, and it must carry no safety
//               margin: a value padded for safety cannot also be scored for
//               accuracy, because the padding shows up as error.
//   reserved -- raw, widened per segment by a safety multiplier and framing
//               overhead. This is what credits, the provider budget and the
//               input limit use.
//
// Calibration is per *character segment*, not per request. The estimator has
// always summed a CJK-character term and a byte term separately, and keeping
// that split means a correction to one segment cannot move the other: a
// recalibrated Hangul coefficient leaves pure Latin, code and JSON requests
// byte-for-byte identical to before.
//
// See docs/policy/tomverse-chat-model-capability-inventory.md G1 and
// `npm run report:token-estimate-accuracy` for the measured error.

/**
 * Which tokenizer's behaviour a calibration is trying to predict. Today every
 * model shares one generic entry; naming the family now means per-family
 * calibration becomes a lookup change rather than a rewrite once per-model
 * tokenizer identity exists.
 */
export type TokenizerFamily = "generic_multilingual";

/**
 * The character segments the estimator prices separately. They are calibrated
 * and reserved independently because their tokenizer behaviour differs and
 * because the evidence for each arrives separately -- Korean samples say
 * nothing about how Han or Kana tokenize.
 */
export type EstimateSegment = "hangul" | "hanKana" | "nonCjk";

export type EstimatorCalibration = {
  /** Stable identifier recorded alongside any estimate this produced. */
  version: string;
  family: TokenizerFamily;
  /** Tokens per Hangul syllable. */
  hangulTokensPerCharacter: number;
  /** Tokens per Han ideograph, Hiragana or Katakana character. */
  hanKanaTokensPerCharacter: number;
  /** UTF-8 bytes per token for everything else. */
  nonCjkBytesPerToken: number;
  /**
   * Applied only when turning raw into reserved, per segment. Never applied to
   * the raw value, which would make the accuracy gates unmeasurable.
   */
  reservationMultiplierBySegment: Record<EstimateSegment, number>;
  /**
   * Why those multipliers are what they are. A provisional floor is a
   * placeholder for a family with no provider-reported samples behind it yet;
   * a measured value comes from Q99(actual / raw) + 0.05 on that family's
   * provider-reported cohort.
   */
  reservationMultiplierSource: "identity" | "provisional_floor" | "measured_q99";
  /** Flat per-request framing cost added to the reservation, in tokens. */
  reservationFramingOverheadTokens: number;
};

const CJK_BYTES_PER_CHARACTER = 3;

/** Hangul syllables. */
export const HANGUL_CHARACTER_PATTERN = /[가-힣]/gu;

/**
 * Every character priced by the CJK term. Kept exported because callers that
 * need to count the same class -- the accuracy report, for one -- must not
 * drift by keeping their own copy.
 *
 * Note the final range is U+8C48-U+FAFF, not the U+F900-U+FAFF compatibility
 * block it reads as: the literal here is U+8C48, a unified ideograph that
 * renders identically to U+F900. The union therefore also covers Yi, the
 * Hangul Jamo extension blocks and the Private Use Area. That is harmless for
 * real text and it is left exactly as shipped, because narrowing it would move
 * which characters are priced at the CJK rate -- a billing change, not a
 * cleanup. It is recorded rather than corrected here.
 */
export const CJK_CHARACTER_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣豈-﫿]/gu;

// Han/Kana is derived as "CJK minus Hangul" rather than written as its own
// class. Because of the range above, a separate Han/Kana pattern would also
// match Hangul and every Hangul character would be counted twice. Subtracting
// keeps the split exact and keeps the total byte-for-byte identical to the
// single-term estimator it replaces.

const IDENTITY_MULTIPLIERS: Record<EstimateSegment, number> = {
  hangul: 1,
  hanKana: 1,
  nonCjk: 1,
};

export const ESTIMATOR_CALIBRATIONS: Record<string, EstimatorCalibration> = {
  // The shipped behaviour, unchanged. Its constants were a fair approximation
  // of the GPT-4-era tokenizer, which spent 1.16-1.37 tokens per CJK
  // character. Newer tokenizers are far more efficient -- o200k_base spends
  // about 0.74-0.79 -- so this now overestimates Korean by roughly 110%.
  generic_multilingual_v1: {
    version: "generic_multilingual_v1",
    family: "generic_multilingual",
    hangulTokensPerCharacter: 1.5,
    hanKanaTokensPerCharacter: 1.5,
    nonCjkBytesPerToken: 4,
    // Identity, so v1 reserves exactly what it estimates -- which is what the
    // current reservation path does. Tool overhead stays in createChatBudget
    // rather than moving here, keeping v1 byte-identical.
    reservationMultiplierBySegment: IDENTITY_MULTIPLIERS,
    reservationMultiplierSource: "identity",
    reservationFramingOverheadTokens: 0,
  },

  // Hangul only. The 0.8 coefficient was measured against o200k_base on Korean
  // samples, and Korean samples are not evidence about Han or Kana, so those
  // stay on v1 until their own measurements exist. Non-CJK stays on v1 as
  // well: 5.5 bytes/token holds for English prose but not for code or JSON,
  // which tokenize far denser -- a global non-CJK change took json-payload to
  // -42%, an underestimate, which is the dangerous direction for a
  // reservation.
  //
  // Not active. Activating it changes credit reservation, the provider budget
  // and the input-limit rejection rate, so it goes through dual-estimate
  // shadow recording and a staged rollout rather than a constant swap.
  //
  // The 1.20 Hangul multiplier is a provisional floor, not a target. The raw
  // estimate at 0.8 already runs about 18% above actual on the current corpus,
  // so compounding 1.20 on top would over-reserve; the real value is
  // max(1.00, Q99(actual / raw) + 0.05) computed on provider-reported samples
  // for this family, which is what the calibration query exists to produce.
  hangul_segment_v2: {
    version: "hangul_segment_v2",
    family: "generic_multilingual",
    hangulTokensPerCharacter: 0.8,
    hanKanaTokensPerCharacter: 1.5,
    nonCjkBytesPerToken: 4,
    reservationMultiplierBySegment: { hangul: 1.2, hanKana: 1, nonCjk: 1 },
    reservationMultiplierSource: "provisional_floor",
    reservationFramingOverheadTokens: 0,
  },
};

/**
 * The calibration every surface uses today. Changing this is a production
 * billing change, not a refactor: it moves credits, the internal cost
 * reservation and how often a request is refused for exceeding the input
 * limit.
 */
export const ACTIVE_ESTIMATOR_VERSION = "generic_multilingual_v1";

export const getCalibration = (version: string = ACTIVE_ESTIMATOR_VERSION) => {
  const calibration = ESTIMATOR_CALIBRATIONS[version];
  if (!calibration) {
    throw new Error(`Unknown estimator calibration "${version}".`);
  }
  return calibration;
};

const utf8ByteLength = (text: string) =>
  typeof Buffer !== "undefined"
    ? Buffer.byteLength(text, "utf8")
    : new TextEncoder().encode(text).length;

const countMatches = (text: string, pattern: RegExp) => {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
};

export type TokenEstimateBreakdown = {
  version: string;
  hangulCharacters: number;
  hanKanaCharacters: number;
  nonCjkBytes: number;
  /** Raw, unpadded tokens contributed by each segment. */
  tokensBySegment: Record<EstimateSegment, number>;
  /** Sum of the segment terms. This is the value ESTIMATE-01/02 grade. */
  rawTotal: number;
};

/**
 * Segment-level breakdown of the raw estimate. Callers that only need the
 * total should use `estimateRawTextTokens`; the breakdown exists so the
 * reservation can widen each segment by its own margin, and so shadow
 * telemetry can record where an estimate came from without keeping the text.
 */
export const estimateTokenBreakdown = (
  text: string,
  version: string = ACTIVE_ESTIMATOR_VERSION
): TokenEstimateBreakdown => {
  const calibration = getCalibration(version);
  if (!text) {
    return {
      version: calibration.version,
      hangulCharacters: 0,
      hanKanaCharacters: 0,
      nonCjkBytes: 0,
      tokensBySegment: { hangul: 0, hanKana: 0, nonCjk: 0 },
      rawTotal: 0,
    };
  }

  const cjkCharacters = countMatches(text, CJK_CHARACTER_PATTERN);
  const hangulCharacters = countMatches(text, HANGUL_CHARACTER_PATTERN);
  const hanKanaCharacters = Math.max(0, cjkCharacters - hangulCharacters);
  const cjkByteLength = cjkCharacters * CJK_BYTES_PER_CHARACTER;
  const nonCjkBytes = Math.max(0, utf8ByteLength(text) - cjkByteLength);

  const tokensBySegment = {
    hangul: Math.ceil(hangulCharacters * calibration.hangulTokensPerCharacter),
    hanKana: Math.ceil(hanKanaCharacters * calibration.hanKanaTokensPerCharacter),
    nonCjk: Math.ceil(nonCjkBytes / calibration.nonCjkBytesPerToken),
  };

  return {
    version: calibration.version,
    hangulCharacters,
    hanKanaCharacters,
    nonCjkBytes,
    tokensBySegment,
    rawTotal: tokensBySegment.hangul + tokensBySegment.hanKana + tokensBySegment.nonCjk,
  };
};

/**
 * Unbiased prediction of the prompt tokens one piece of text will produce.
 * Carries no safety margin -- this is the value ESTIMATE-01/02 grade.
 */
export const estimateRawTextTokens = (
  text: string,
  version: string = ACTIVE_ESTIMATOR_VERSION
) => estimateTokenBreakdown(text, version).rawTotal;

/** Estimated prompt tokens for one piece of text. Never negative. */
export const estimateTextTokens = (text: string) => estimateRawTextTokens(text);

/** Same estimate, floored at 1 for any non-empty text. */
export const estimatePromptTokens = (text: string) =>
  text ? Math.max(1, estimateTextTokens(text)) : 0;

/**
 * Tokens a provider-native web search adds to the *input* side of the turn:
 * the tool definition itself plus the retrieved result text that gets fed back
 * into the model before it answers. Reserved up front so a searching request
 * is not settled far above its reservation.
 */
export const WEB_SEARCH_INPUT_TOKEN_OVERHEAD = 6_000;

/**
 * Tokens a provider-native tool block adds even when no search runs (the tool
 * schema is still part of the system prompt).
 */
export const TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD = 400;

export const estimateToolInputTokenOverhead = ({
  nativeSearchEnabled,
}: {
  nativeSearchEnabled: boolean;
}) =>
  nativeSearchEnabled
    ? WEB_SEARCH_INPUT_TOKEN_OVERHEAD + TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD
    : 0;

/**
 * The value credits, the provider budget and the input limit should use: each
 * raw segment widened by its own margin, plus framing and any tool overhead
 * the turn will really send.
 *
 * Widening per segment rather than per request is what keeps a Hangul
 * recalibration from touching a pure Latin, code or JSON request.
 */
export const toReservedInputTokens = (
  estimate: TokenEstimateBreakdown | number,
  {
    version = ACTIVE_ESTIMATOR_VERSION,
    toolOverheadTokens = 0,
  }: { version?: string; toolOverheadTokens?: number } = {}
) => {
  const isBreakdown = typeof estimate !== "number";
  const { reservationMultiplierBySegment, reservationFramingOverheadTokens } = getCalibration(
    isBreakdown ? estimate.version : version
  );
  const segments: EstimateSegment[] = ["hangul", "hanKana", "nonCjk"];

  // A caller holding only a total has thrown the segment mix away, and the
  // margins are per segment precisely because the mix decides which one
  // applies. Widening such a total by the largest margin any segment carries
  // is the only choice that cannot under-reserve, and under-reserving is the
  // dangerous direction: the reservation is refunded down at settlement, so an
  // over-reservation costs the user nothing while a short one is a request
  // that ran on credits nobody held.
  //
  // Identity under `generic_multilingual_v1`, whose margins are all 1, so this
  // path is byte-identical to the raw total today. It exists so a caller that
  // cannot yet supply a breakdown -- `createChatBudget`, which takes a token
  // count and is reached from eight call sites -- is not silently exempted
  // from the margin once a calibration with real margins goes active. Threading
  // the breakdown through those callers is the fix; this is the floor until
  // then.
  const widened = isBreakdown
    ? segments.reduce(
        (total, segment) =>
          total + Math.ceil(estimate.tokensBySegment[segment] * reservationMultiplierBySegment[segment]),
        0
      )
    : Math.ceil(
        estimate * Math.max(...segments.map((segment) => reservationMultiplierBySegment[segment]))
      );

  return widened + reservationFramingOverheadTokens + toolOverheadTokens;
};
