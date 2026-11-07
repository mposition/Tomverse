import type { ImageSize } from "@/lib/imageGenerationPricing";

// Pure request/response shaping for image models bought through fal, kept out
// of lib/imageProviderAdapter.ts so the part that decides what we are charged
// can be tested without a network. Which body an endpoint gets and how it
// bills thinking is one table, FAL_ENDPOINT_PROFILES, below.
//
// Three things here are load-bearing.
//
// 1. **Every priced field is sent, including the ones whose default already
//    matches.** The approved credit is 120 against a floor of 97, and that
//    floor is arithmetic over a specific request: 80,000 for a 1K image,
//    5,000 prompt budget, 2,000 for `thinking_level: "high"`. A default that
//    agrees today is not the same as a value we chose -- fal's schema is
//    theirs to change, and a floor computed from a request we did not actually
//    pin is an audit trail that disagrees with the code.
//
//    The field that shows why this is not paranoia is `aspect_ratio`. Its
//    default is `"auto"`, documented as "let the model decide based on the
//    prompt". Unpinned, the model picks the shape of an image whose price was
//    verified for 1024x1024, and nothing downstream would notice.
//
// 2. **Only the prompt comes from the user.** Everything else is fixed here.
//    `system_prompt` is sent empty for the same reason: an instruction we did
//    not write can change both the output and what it costs.
//
// 3. **The response's own MIME and host are checked, never assumed.** fal
//    returns a URL on a public CDN, so what comes back is a link, not bytes,
//    and a link is worth exactly as much as the checks applied to it.
//
// Verified against fal's published schema and pricing on 2026-08-14; the
// quotations are in docs/policy/image-generation.md §16.3 and §16.5. The Nano
// Banana 2.1 and Qwen Image 3 schemas were read 2026-11-07 (§16.9).

/** Direct, unqueued inference. `run` "sends a direct HTTP request to fal.run". */
export const FAL_RUN_URL_BASE = "https://fal.run";

/** `-H "Authorization: Key $FAL_KEY"`, not a bearer token. */
export const falAuthorizationHeader = (apiKey: string) => `Key ${apiKey}`;

/**
 * Platform headers sent on every request, and why each one is not optional.
 *
 * `X-Fal-No-Retry` -- fal retries "up to 10 total attempts on server errors".
 * The reason to refuse is narrower than it first looks: those errors are not
 * billed ("Server errors are never billed"), so retrying does not multiply the
 * bill by itself. What does is a retry after a generation that *succeeded* and
 * whose response was lost. That produces a second image and a second charge,
 * and under a fixed price the user pays once while we pay twice. Sent even on
 * the direct endpoint, which documents no server-side queue retries, because
 * the guarantee we want does not depend on which endpoint we happen to use.
 *
 * `X-Fal-Store-IO: 0` -- request payloads are kept 30 days by default, and
 * they contain the user's prompt.
 *
 * `X-Fal-Object-Lifecycle-Preference` -- the one that would be easiest to skip
 * and worst to skip. fal documents its default as "Your account setting
 * (forever and publicly readable if not configured)", and says of
 * `X-Fal-Store-IO` that it "only prevents storage of the JSON payloads. CDN
 * files generated during processing are still accessible". So the other header
 * does not cover this: without this one a user's generated image sits on a
 * public URL indefinitely.
 */
export const FAL_ASSET_EXPIRY_SECONDS = 900;

export const falPlatformHeaders = (): Record<string, string> => ({
  "X-Fal-No-Retry": "1",
  "X-Fal-Store-IO": "0",
  "X-Fal-Object-Lifecycle-Preference": JSON.stringify({
    expiration_duration_seconds: FAL_ASSET_EXPIRY_SECONDS,
  }),
});

/**
 * Where a generated file may be fetched from.
 *
 * fal documents output URLs as living on its CDN ("returned as URLs (e.g.,
 * `https://v3b.fal.media/files/...`)"), and the subdomain is versioned, so the
 * allowlist is the registrable suffix rather than a host we happen to have
 * seen. A response naming anywhere else is not a fal asset, and following it
 * would make the provider's response body into a request we make on its behalf.
 */
export const FAL_ASSET_HOST_SUFFIX = ".fal.media";

export const isFalAssetUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname.endsWith(FAL_ASSET_HOST_SUFFIX);
};

const MIME_ALLOWLIST = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * The most a generated 1K image may weigh.
 *
 * New here because this is the first adapter that fetches its result from a
 * URL rather than reading it out of the response it already has. A 1K PNG runs
 * to a few megabytes, so 16 refuses only the pathological -- and it has to be
 * checked against the declared length before the body is read, or the check
 * happens after the memory has already been spent.
 */
export const FAL_MAX_ASSET_BYTES = 16 * 1024 * 1024;

/** True when a declared Content-Length is present and already too large. */
export const falAssetLengthRefused = (contentLength: string | null): boolean => {
  if (!contentLength) return false;
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > FAL_MAX_ASSET_BYTES;
};

/**
 * What fal bills on every Nano Banana 2 request, for the thinking level it
 * pins: "If high thinking is used, an additional $0.002 will be charged"
 * (fal's Nano Banana 2 page, read 2026-08-14 and again 2026-10-21; the smoke
 * run billed 1.025 units, policy section 16.8).
 *
 * Beside that endpoint's `thinkingLevel` because the two are one decision. A
 * price revision whose thinking cap is below this is refused
 * (`imageThinkingCapEnforced`): the request would still incur the surcharge,
 * and a smaller cap would reserve and settle less than fal bills.
 */
export const FAL_HIGH_THINKING_SURCHARGE_MICRO_USD = 2_000;

/** The request schema an endpoint follows. */
export type FalBodyFormat = "nano_banana" | "qwen_image";

/**
 * How an endpoint bills thinking -- the same three answers as
 * `ImageThinkingBilling` in lib/imageModelRegistry.ts, with the surcharge
 * carried by the one that has an amount.
 */
export type FalThinkingTerms =
  | { billing: "flat_per_request"; surchargeMicroUsd: number }
  | { billing: "not_billed" }
  | { billing: "per_token_uncapped" };

export type FalEndpointProfile = {
  bodyFormat: FalBodyFormat;
  /** Where an edit of this model is sent. Used only where edit pricing exists. */
  editEndpoint: string;
  /** The `thinking_level` the request pins; null for a schema with no such field. */
  thinkingLevel: "minimal" | "high" | null;
  thinking: FalThinkingTerms;
};

/**
 * Every fal endpoint this code can send, keyed by the model's `apiModelId`.
 *
 * fal is a gateway, not a model: each endpoint has its own request schema and
 * its own price page, so "provider fal" answers neither what to send nor what
 * is billed. Before this table one Nano Banana 2 body went to every fal model
 * and the judge read Nano Banana 2's surcharge as every fal model's bound. An
 * endpoint missing here is refused by the request builder, the judge and the
 * adapter alike -- an unread schema is not a request we can price.
 *
 *   - fal-ai/nano-banana-2: flat $0.002 for `high` (section 16.3), enabled.
 *   - google/nano-banana-2.1: "billed on the tokens each request actually
 *     uses", thinking "billed as output text" at $8.823 per 1M, `thinking_level`
 *     defaults to `medium` and no parameter caps the count
 *     (fal.ai/models/google/nano-banana-2.1 and its /api and /edit/api pages,
 *     read 2026-11-07). Pinned to `minimal`, the cheapest level, and still
 *     unbounded until a measurement proves otherwise
 *     (scripts/measure-fal-token-image-thinking.mjs).
 *   - alibaba/qwen-image-3/text-to-image: a different schema (`image_size`,
 *     no `thinking_level`) priced per image, so no thinking is billed
 *     (fal.ai/models/alibaba/qwen-image-3/text-to-image/api, read 2026-11-07).
 */
export const FAL_ENDPOINT_PROFILES: Readonly<Record<string, FalEndpointProfile>> = {
  "fal-ai/nano-banana-2": {
    bodyFormat: "nano_banana",
    editEndpoint: "fal-ai/nano-banana-2/edit",
    // The 2,000 microUSD in the approved worst case is this level. Omitting it
    // disables thinking and would make the floor 95, not 97.
    thinkingLevel: "high",
    thinking: { billing: "flat_per_request", surchargeMicroUsd: FAL_HIGH_THINKING_SURCHARGE_MICRO_USD },
  },
  "google/nano-banana-2.1": {
    bodyFormat: "nano_banana",
    editEndpoint: "google/nano-banana-2.1/edit",
    // Omitted would mean `medium`, not off: the field is stated at the level
    // the measurement is meant to bound.
    thinkingLevel: "minimal",
    thinking: { billing: "per_token_uncapped" },
  },
  "alibaba/qwen-image-3/text-to-image": {
    bodyFormat: "qwen_image",
    editEndpoint: "alibaba/qwen-image-3/edit",
    thinkingLevel: null,
    thinking: { billing: "not_billed" },
  },
};

/** The endpoint's row, or null for one this code has not read (or a prototype key). */
export const falEndpointProfile = (apiModelId: unknown): FalEndpointProfile | null =>
  typeof apiModelId === "string" && Object.hasOwn(FAL_ENDPOINT_PROFILES, apiModelId)
    ? FAL_ENDPOINT_PROFILES[apiModelId]
    : null;

/** Where a generation or an edit of this model is sent, or null for an unlisted endpoint. */
export const falEndpointUrl = (apiModelId: string, edit: boolean): string | null => {
  const profile = falEndpointProfile(apiModelId);
  if (!profile) return null;
  return `${FAL_RUN_URL_BASE}/${edit ? profile.editEndpoint : apiModelId}`;
};

/** The one resolution this integration is priced and approved for. */
const RESOLUTION_BY_SIZE: Partial<Record<ImageSize, string>> = {
  "1024x1024": "1K",
};

/**
 * The same 1024x1024, in Qwen's vocabulary. Pixels rather than the
 * `square_hd` enum: the schema page lists the enum without saying what size
 * each value is, and the delivered image is measured against these pixels.
 */
const QWEN_IMAGE_SIZE_BY_SIZE: Partial<Record<ImageSize, { width: number; height: number }>> = {
  "1024x1024": { width: 1024, height: 1024 },
};

export type FalImageRequestInput = {
  /** The fal endpoint (the model's `apiModelId`); it decides the schema. */
  apiModelId: string;
  /** The only field that carries user text. */
  prompt: string;
  size: ImageSize;
  /** Requested delivery format; the response's own type is still what counts. */
  outputFormat: "png" | "jpeg" | "webp";
};

const nanoBananaBody = (
  input: FalImageRequestInput,
  thinkingLevel: string
): Record<string, unknown> | null => {
  const resolution = RESOLUTION_BY_SIZE[input.size];
  if (!resolution) return null;
  return {
    prompt: input.prompt,
    num_images: 1,
    resolution,
    // Not `auto`. See the file header.
    aspect_ratio: "1:1",
    // From the endpoint's row, where it sits beside what the level costs.
    thinking_level: thinkingLevel,
    // A separate $0.015 surcharge on Nano Banana 2, with no documented
    // default. Stated.
    enable_web_search: false,
    // "disregard any instructions in the prompt regarding the number of images
    // to generate and ignore any intermediate images generated by the model".
    // A fixed price buys one finished image, not a prompt's opinion of how many.
    limit_generations: true,
    // Nothing we did not write steers the model.
    system_prompt: "",
    output_format: input.outputFormat,
    // fal's default is "4" on a scale where 1 is strictest and 6 loosest.
    // Moderation posture is a decision, not something to inherit.
    safety_tolerance: "2",
  };
};

const qwenImageBody = (input: FalImageRequestInput): Record<string, unknown> | null => {
  const imageSize = QWEN_IMAGE_SIZE_BY_SIZE[input.size];
  if (!imageSize) return null;
  return {
    prompt: input.prompt,
    image_size: { ...imageSize },
    // Priced per image; the default is already 1, and stated anyway.
    num_images: 1,
    // Defaults to true: "automatic LLM prompt rewriting". A prompt we did not
    // write is the same as a system prompt we did not write.
    enable_prompt_expansion: false,
    negative_prompt: "",
    // The default, stated: moderation posture is a decision, not an inheritance.
    enable_safety_checker: true,
    output_format: input.outputFormat,
  };
};

/**
 * The request body for the input's endpoint, with every priced or
 * safety-relevant field stated.
 *
 * Returns null for an endpoint not in FAL_ENDPOINT_PROFILES, and for a size
 * this integration has no approved price for, rather than sending a request
 * the credits were not computed against -- on Nano Banana 2, 2K and 4K are
 * 1.5x and 2x, which is a different price and a different approval.
 */
export const buildFalImageRequest = (
  input: FalImageRequestInput
): Record<string, unknown> | null => {
  const profile = falEndpointProfile(input.apiModelId);
  if (!profile) return null;
  if (!MIME_ALLOWLIST.has(`image/${input.outputFormat}`)) return null;
  if (profile.bodyFormat === "qwen_image") return qwenImageBody(input);
  return profile.thinkingLevel ? nanoBananaBody(input, profile.thinkingLevel) : null;
};

export type FalImageAsset = {
  url: string;
  mimeType: string;
  /**
   * As reported, and null when absent: Qwen's output schema lists no width or
   * height. The adapter measures the downloaded bytes either way, so these are
   * never what the priced size is checked against.
   */
  width: number | null;
  height: number | null;
};

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;

/**
 * The one delivered image, or nothing.
 *
 * More than one fails closed rather than picking the first: the fixed price is
 * for one image, and a response carrying several means the contract is not the
 * one that was priced. `limit_generations` is meant to prevent that, and this
 * is the check that does not depend on it working.
 */
export const parseFalImageResponse = (payload: unknown): FalImageAsset | null => {
  if (!payload || typeof payload !== "object") return null;
  const images = (payload as { images?: unknown }).images;
  if (!Array.isArray(images) || images.length !== 1) return null;

  const image = images[0];
  if (!image || typeof image !== "object") return null;
  const record = image as Record<string, unknown>;

  const url = record.url;
  if (typeof url !== "string" || !isFalAssetUrl(url)) return null;

  const reported = record.content_type;
  const mimeType =
    typeof reported === "string" && MIME_ALLOWLIST.has(reported.trim())
      ? reported.trim()
      : null;
  if (!mimeType) return null;

  return {
    url,
    mimeType,
    width: finite(record.width),
    height: finite(record.height),
  };
};

/**
 * An edit: the generation's body, every priced field unchanged, plus the photo
 * as a data URI. fal sells Nano Banana 2's edit endpoint per output image at
 * the generation's price (its pricing API, 2026-10-29), so nothing priced
 * moves. Built for the Nano Banana schema only: Nano Banana 2.1's edit takes
 * the same `image_urls` (read 2026-11-07), while Qwen's edit schema has not
 * been read and so has no body.
 */
export const buildFalImageEditRequest = (
  input: FalImageRequestInput & { image: { bytes: Uint8Array; mimeType: string } }
): Record<string, unknown> | null => {
  if (falEndpointProfile(input.apiModelId)?.bodyFormat !== "nano_banana") return null;
  const body = buildFalImageRequest(input);
  if (!body) return null;
  return {
    ...body,
    image_urls: [`data:${input.image.mimeType};base64,${Buffer.from(input.image.bytes).toString("base64")}`],
  };
};
