// One shared prompt-token estimator for every surface that has to guess how
// large a request will be before the provider answers: the composer's live
// credit estimate, the comparison preflight, the chat route's reservation and
// the availability probe. They used to each carry their own
// `Buffer.byteLength(text) / 4` copy, which is why a Korean conversation could
// be reserved several times too small on one surface and not another.
//
// Byte-length/4 approximates English-ish BPE tokenization reasonably well, but
// badly underestimates CJK text: most multilingual tokenizers spend roughly
// 1-1.5 tokens per Hangul/Han/Kana character, not one token per ~4 UTF-8 bytes
// (each of those characters is itself ~3 bytes). Count CJK characters
// separately at ~1.5 tokens each and fall back to the byte heuristic for the
// rest.

const CJK_CHARACTER_PATTERN =
  /[぀-ヿ㐀-䶿一-鿿가-힣豈-﫿]/gu;

const CJK_TOKENS_PER_CHARACTER = 1.5;
const CJK_BYTES_PER_CHARACTER = 3;
const NON_CJK_BYTES_PER_TOKEN = 4;

const utf8ByteLength = (text: string) =>
  typeof Buffer !== "undefined"
    ? Buffer.byteLength(text, "utf8")
    : new TextEncoder().encode(text).length;

/** Estimated prompt tokens for one piece of text. Never negative. */
export const estimateTextTokens = (text: string) => {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_CHARACTER_PATTERN);
  const cjkCharacterCount = cjkMatches ? cjkMatches.length : 0;
  const cjkByteLength = cjkCharacterCount * CJK_BYTES_PER_CHARACTER;
  const nonCjkBytes = Math.max(0, utf8ByteLength(text) - cjkByteLength);
  return (
    Math.ceil(cjkCharacterCount * CJK_TOKENS_PER_CHARACTER) +
    Math.ceil(nonCjkBytes / NON_CJK_BYTES_PER_TOKEN)
  );
};

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
