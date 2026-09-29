/**
 * How many input tokens one image attachment is likely to cost, from its size.
 *
 * Every image used to be counted as a flat `NATIVE_ATTACHMENT_ESTIMATED_TOKENS`
 * (16,000) in the input-limit check. That figure is an allowance, not a
 * measurement, and it made a single screenshot exhaust the whole guest budget
 * (16,000) and seven of them the signed-in one (128,000) -- a turn was refused
 * as "too long" when the provider would have read a few thousand tokens.
 *
 * The limit is now checked against this estimate. The flat allowance did not
 * go away: the difference between it and this estimate is carried to the cost
 * reservation and the credit weight (`reservationOnlyInputTokens` in
 * `createChatBudget`), so what a turn reserves and what it is charged are the
 * same as before. Only the question "is this conversation too long" changed.
 *
 * Each rule is the provider's own published formula at the most expensive
 * setting that provider offers for a default request, because this
 * application does not pin a detail level and must not assume the cheap one:
 *
 * - Anthropic: 28px patches, downscaled to a 2,576px long edge and 4,784
 *   visual tokens (the high-resolution tier; the standard tier is smaller).
 * - OpenAI: 32px patches, up to 10,000 patches and 6,000px (the `original`
 *   detail budget, the largest of the GPT-5 family's), times the family's 1.2
 *   multiplier.
 * - Google: a fixed per-image count; 2,240 is Gemini 3's `ultra_high`, twice
 *   the default.
 *
 * A provider with no published formula here keeps the flat allowance, which is
 * exactly the old behaviour. So does an image whose dimensions cannot be read.
 * Every figure is capped at the allowance, so this can only ever lower the
 * limit estimate, never raise it.
 */
import { NATIVE_ATTACHMENT_ESTIMATED_TOKENS } from "@/lib/chatAttachmentTokens";

export type ImageDimensions = { width: number; height: number };

type PatchRule = {
  kind: "patch";
  patchPixels: number;
  maxLongEdgePixels: number;
  maxPatches: number;
  multiplier: number;
};
type FixedRule = { kind: "fixed"; tokens: number };
export type ImageInputTokenRule = PatchRule | FixedRule;

export const IMAGE_INPUT_TOKEN_RULES: Readonly<
  Record<string, ImageInputTokenRule>
> = Object.freeze({
  anthropic: {
    kind: "patch",
    patchPixels: 28,
    maxLongEdgePixels: 2_576,
    maxPatches: 4_784,
    multiplier: 1,
  },
  openai: {
    kind: "patch",
    patchPixels: 32,
    maxLongEdgePixels: 6_000,
    maxPatches: 10_000,
    multiplier: 1.2,
  },
  google: { kind: "fixed", tokens: 2_240 },
});

const cap = (tokens: number) =>
  Math.min(NATIVE_ATTACHMENT_ESTIMATED_TOKENS, Math.max(1, Math.ceil(tokens)));

const patchTokens = (rule: PatchRule, { width, height }: ImageDimensions) => {
  const longEdge = Math.max(width, height);
  const scale = longEdge > rule.maxLongEdgePixels
    ? rule.maxLongEdgePixels / longEdge
    : 1;
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  const patches =
    Math.ceil(scaledWidth / rule.patchPixels) *
    Math.ceil(scaledHeight / rule.patchPixels);
  // A provider that finds an image over its patch budget shrinks it until it
  // fits, so the budget is the most the image can cost.
  return Math.min(rule.maxPatches, patches) * rule.multiplier;
};

/**
 * The limit estimate for one image, for a provider.
 *
 * `null` dimensions -- a format this reader does not know, or a header it
 * could not parse -- fall back to the flat allowance. Guessing low there would
 * let an unmeasured image through the limit on nothing.
 */
export const estimateImageInputTokens = (
  provider: string,
  dimensions: ImageDimensions | null
): number => {
  const rule = IMAGE_INPUT_TOKEN_RULES[provider];
  if (!rule) return NATIVE_ATTACHMENT_ESTIMATED_TOKENS;
  if (rule.kind === "fixed") return cap(rule.tokens);
  if (
    !dimensions ||
    !(dimensions.width > 0) ||
    !(dimensions.height > 0) ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height)
  ) {
    return NATIVE_ATTACHMENT_ESTIMATED_TOKENS;
  }
  return cap(patchTokens(rule, dimensions));
};

/**
 * The most one image can cost a provider, when its dimensions are unknown.
 *
 * The comparison preflight sees only a media type and a byte count, and a byte
 * count bounds nothing about pixels -- a flat-colour PNG is tiny at any size.
 * It uses this instead: the provider's own ceiling, which is never below what
 * the chat route will later compute from the real image, so the preflight can
 * only be stricter than the dispatch, never looser.
 */
export const maxImageInputTokens = (provider: string): number => {
  const rule = IMAGE_INPUT_TOKEN_RULES[provider];
  if (!rule) return NATIVE_ATTACHMENT_ESTIMATED_TOKENS;
  if (rule.kind === "fixed") return cap(rule.tokens);
  return cap(rule.maxPatches * rule.multiplier);
};

const readUint32BE = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) >>> 0) +
  (bytes[offset + 1] << 16) +
  (bytes[offset + 2] << 8) +
  bytes[offset + 3];
const readUint16BE = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] << 8) + bytes[offset + 1];
const readUint16LE = (bytes: Uint8Array, offset: number) =>
  bytes[offset] + (bytes[offset + 1] << 8);
const readUint24LE = (bytes: Uint8Array, offset: number) =>
  bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);

const valid = (width: number, height: number): ImageDimensions | null =>
  width > 0 && height > 0 ? { width, height } : null;

const pngDimensions = (bytes: Uint8Array) => {
  // Signature (8) + IHDR length (4) + "IHDR" (4), then width and height.
  if (bytes.length < 24) return null;
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  return valid(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
};

const isJpegStartOfFrame = (marker: number) =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

const jpegDimensions = (bytes: Uint8Array) => {
  let offset = 2;
  // Bounded by the buffer: every step advances by at least the segment
  // header, so a malformed length cannot hold the loop in place.
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return null;
    if (isJpegStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) return null;
      return valid(
        readUint16BE(bytes, offset + 7),
        readUint16BE(bytes, offset + 5)
      );
    }
    offset += 2 + length;
  }
  return null;
};

const webpDimensions = (bytes: Uint8Array) => {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8X") {
    return valid(readUint24LE(bytes, 24) + 1, readUint24LE(bytes, 27) + 1);
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    return valid(
      readUint16LE(bytes, 26) & 0x3fff,
      readUint16LE(bytes, 28) & 0x3fff
    );
  }
  return null;
};

const gifDimensions = (bytes: Uint8Array) =>
  bytes.length < 10 ? null : valid(readUint16LE(bytes, 6), readUint16LE(bytes, 8));

/**
 * Width and height from the image's own header, without decoding it.
 *
 * Read from the bytes that are actually sent -- the normalized image, which
 * keeps the original's dimensions -- so the estimate is about the same pixels
 * the provider will see. Anything unrecognised is `null`, never a guess.
 */
export const readImageDimensions = (
  input: Uint8Array
): ImageDimensions | null => {
  const bytes = input;
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return pngDimensions(bytes);
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegDimensions(bytes);
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP"
  ) {
    return webpDimensions(bytes);
  }
  if (
    bytes.length >= 6 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "GIF8"
  ) {
    return gifDimensions(bytes);
  }
  return null;
};

/**
 * The comparison preflight's share of the same split, per model.
 *
 * `limitTokens` is what the images count against the input limit -- each at
 * its provider's ceiling, since the preflight has no pixels to measure --
 * and `reservationOnlyInputTokens` is the rest of the flat allowance, for
 * `createChatBudget`. The two always add up to the flat allowance per image,
 * so the credits the preflight quotes are the ones it quoted before.
 */
export const splitPreflightImageTokens = (
  provider: string,
  attachments: ReadonlyArray<{ mediaType: string }>
) => {
  const images = attachments.filter((attachment) =>
    attachment.mediaType.startsWith("image/")
  ).length;
  const limitTokens = images * maxImageInputTokens(provider);
  return {
    limitTokens,
    reservationOnlyInputTokens:
      images * NATIVE_ATTACHMENT_ESTIMATED_TOKENS - limitTokens,
  };
};
