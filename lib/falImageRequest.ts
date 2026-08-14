import type { ImageSize } from "@/lib/imageGenerationPricing";

// Pure request/response shaping for Nano Banana 2 bought through fal, kept out
// of lib/imageProviderAdapter.ts so the part that decides what we are charged
// can be tested without a network.
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
// quotations are in docs/policy/image-generation.md §16.3 and §16.5.

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

/** The one resolution this integration is priced and approved for. */
const RESOLUTION_BY_SIZE: Partial<Record<ImageSize, string>> = {
  "1024x1024": "1K",
};

export type FalImageRequestInput = {
  /** The only field that carries user text. */
  prompt: string;
  size: ImageSize;
  /** Requested delivery format; the response's own type is still what counts. */
  outputFormat: "png" | "jpeg" | "webp";
};

/**
 * The request body, with every priced or safety-relevant field stated.
 *
 * Returns null for a size this integration has no approved price for, rather
 * than sending a resolution the credits were not computed against -- 2K and 4K
 * are 1.5x and 2x, which is a different price and a different approval.
 */
export const buildFalImageRequest = (
  input: FalImageRequestInput
): Record<string, unknown> | null => {
  const resolution = RESOLUTION_BY_SIZE[input.size];
  if (!resolution) return null;
  if (!MIME_ALLOWLIST.has(`image/${input.outputFormat}`)) return null;
  return {
    prompt: input.prompt,
    num_images: 1,
    resolution,
    // Not `auto`. See the file header.
    aspect_ratio: "1:1",
    // The 2,000 microUSD in the approved worst case is this field. Omitting it
    // disables thinking and would make the floor 95, not 97.
    thinking_level: "high",
    // A separate $0.015 surcharge, with no documented default. Stated.
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

export type FalImageAsset = {
  url: string;
  mimeType: string;
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
