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
//   reserved -- raw, widened by a safety multiplier and framing overhead. This
//               is what credits, the provider budget and the input limit use.
//
// The calibration itself is versioned per tokenizer family rather than living
// in loose constants, because a single global pair cannot hold both CJK and
// Latin text inside the ESTIMATE-02 p95 budget. See
// docs/policy/tomverse-chat-model-capability-inventory.md G1, and
// `npm run report:token-estimate-accuracy` for the measured error.

/**
 * Which tokenizer's behaviour a calibration is trying to predict. Today every
 * model shares one generic entry; the point of naming the family now is that
 * per-family calibration is a lookup change rather than a rewrite once
 * per-model tokenizer identity exists.
 */
export type TokenizerFamily = "generic_multilingual";

export type EstimatorCalibration = {
  /** Stable identifier recorded alongside any estimate this produced. */
  version: string;
  family: TokenizerFamily;
  /** Tokens per Hangul/Han/Kana character. */
  cjkTokensPerCharacter: number;
  /** UTF-8 bytes per token for everything else. */
  nonCjkBytesPerToken: number;
  /**
   * Applied only when turning raw into reserved. Never applied to the raw
   * value, which would make the accuracy gates unmeasurable.
   */
  reservationSafetyMultiplier: number;
  /** Flat per-request framing cost added to the reservation, in tokens. */
  reservationFramingOverheadTokens: number;
};

const CJK_BYTES_PER_CHARACTER = 3;

/**
 * Hangul syllables, Han, Kana and CJK compatibility ideographs. Exported so a
 * caller that needs to count the same characters -- the accuracy report, for
 * one -- cannot drift by keeping its own copy.
 */
export const CJK_CHARACTER_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣豈-﫿]/gu;

export const ESTIMATOR_CALIBRATIONS: Record<string, EstimatorCalibration> = {
  // The shipped behaviour, unchanged. Its constants were a fair approximation
  // of the GPT-4-era tokenizer, which spent 1.16-1.37 tokens per CJK
  // character. Newer tokenizers are far more efficient -- o200k_base spends
  // about 0.74-0.79 -- so this now overestimates Korean by roughly 110%.
  generic_multilingual_v1: {
    version: "generic_multilingual_v1",
    family: "generic_multilingual",
    cjkTokensPerCharacter: 1.5,
    nonCjkBytesPerToken: 4,
    // Identity: v1 reserves exactly what it estimates, which is what the
    // current reservation path does. The tool overhead stays where it is in
    // createChatBudget rather than moving here, so v1 is byte-identical.
    reservationSafetyMultiplier: 1,
    reservationFramingOverheadTokens: 0,
  },

  // Measured against o200k_base, not yet active. Activating it changes credit
  // reservation, the provider budget and the input-limit rejection rate, so it
  // goes through dual-estimate shadow recording and a staged rollout rather
  // than a constant swap. The 20% margin is the floor for a family with no
  // provider-reported calibration data behind it yet; once there is enough, it
  // becomes max(1.10, Q99(actual / raw) + 0.05) per family.
  generic_multilingual_v2: {
    version: "generic_multilingual_v2",
    family: "generic_multilingual",
    cjkTokensPerCharacter: 0.8,
    nonCjkBytesPerToken: 5.5,
    reservationSafetyMultiplier: 1.2,
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

/**
 * Unbiased prediction of the prompt tokens one piece of text will produce.
 * Carries no safety margin -- this is the value ESTIMATE-01/02 grade.
 */
export const estimateRawTextTokens = (
  text: string,
  version: string = ACTIVE_ESTIMATOR_VERSION
) => {
  if (!text) return 0;
  const { cjkTokensPerCharacter, nonCjkBytesPerToken } = getCalibration(version);
  const cjkMatches = text.match(CJK_CHARACTER_PATTERN);
  const cjkCharacterCount = cjkMatches ? cjkMatches.length : 0;
  const cjkByteLength = cjkCharacterCount * CJK_BYTES_PER_CHARACTER;
  const nonCjkBytes = Math.max(0, utf8ByteLength(text) - cjkByteLength);
  return (
    Math.ceil(cjkCharacterCount * cjkTokensPerCharacter) +
    Math.ceil(nonCjkBytes / nonCjkBytesPerToken)
  );
};

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
 * The value credits, the provider budget and the input limit should use: raw,
 * widened by the calibration's safety margin and framing overhead, plus any
 * tool overhead the turn will really send.
 *
 * Under `generic_multilingual_v1` this is the identity on raw plus the tool
 * overhead, which is exactly what createChatBudget already computes.
 */
export const toReservedInputTokens = (
  rawEstimatedTokens: number,
  {
    version = ACTIVE_ESTIMATOR_VERSION,
    toolOverheadTokens = 0,
  }: { version?: string; toolOverheadTokens?: number } = {}
) => {
  const { reservationSafetyMultiplier, reservationFramingOverheadTokens } =
    getCalibration(version);
  return (
    Math.ceil(rawEstimatedTokens * reservationSafetyMultiplier) +
    reservationFramingOverheadTokens +
    toolOverheadTokens
  );
};
