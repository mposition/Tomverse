import type { ImageSize } from "@/lib/imageGenerationPricing";
import {
  optionForLegacyImageSize,
  xaiRequestForOption,
  type ImageResolutionTier,
} from "@/lib/imageResolution";

// Pure request/response shaping for xAI's image API, kept out of
// lib/imageProviderAdapter.ts so it can be tested without a network and
// without the server-only import chain.
//
// xAI's endpoint is OpenAI-shaped but not OpenAI: it takes `resolution` and
// `aspect_ratio` as separate fields rather than a `WxH` size string, and it
// reports the MIME of what it actually produced instead of being told which
// format to emit. Both differences are the reason this is a separate adapter
// path rather than a base-URL swap.

export const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";

/**
 * The product's size value translated into xAI's two request fields.
 *
 * The translation itself lives in lib/imageResolution.ts, which is the one
 * place the tier/aspect vocabulary is defined; this only adds the launch
 * scope on top (docs/policy/image-generation.md section 12.1): 1K square
 * only, because 1024x1024 is byte-for-byte the comparison against
 * gpt-image-2's square and 2K is approved but not yet sellable.
 *
 * A size outside that scope returns null and the caller must refuse. Guessing
 * a resolution would charge the approved 1K credits for an image the provider
 * priced differently.
 */
const LAUNCH_TIERS = new Set<ImageResolutionTier>(["1k"]);

export const buildXaiImageRequest = (input: {
  apiModelId: string;
  prompt: string;
  size: ImageSize;
}): Record<string, unknown> | null => {
  const option = optionForLegacyImageSize(input.size);
  if (!LAUNCH_TIERS.has(option.tier) || option.aspectRatio !== "1:1") return null;
  const mapped = xaiRequestForOption(option);
  if (!mapped) return null;
  return {
    model: input.apiModelId,
    prompt: input.prompt,
    resolution: mapped.resolution,
    aspect_ratio: mapped.aspectRatio,
    // Base64 rather than the default temporary URL: the original bytes are
    // stored server-side, and a second fetch of a short-lived URL is one more
    // way a generation the user was charged for can fail after the fact.
    response_format: "b64_json",
    n: 1,
  };
};

export type XaiImagePayload = {
  imageBase64: string;
  /** Exactly what xAI said it produced. Never inferred from the request. */
  mimeType: string;
};

const MIME_ALLOWLIST = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Reads the one image out of an xAI response.
 *
 * The MIME is taken from the response and validated against an allowlist
 * rather than defaulted: storing JPEG bytes under `image/png` would corrupt
 * every downstream consumer that trusts the recorded type, and an unexpected
 * value is a signal the contract moved, not something to paper over.
 */
export const parseXaiImageResponse = (payload: unknown): XaiImagePayload | null => {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!first || typeof first !== "object") return null;
  const imageBase64 = (first as { b64_json?: unknown }).b64_json;
  if (typeof imageBase64 !== "string" || !imageBase64) return null;
  const reported = (first as { mime_type?: unknown }).mime_type;
  const mimeType =
    typeof reported === "string" && MIME_ALLOWLIST.has(reported.trim())
      ? reported.trim()
      : null;
  if (!mimeType) return null;
  return { imageBase64, mimeType };
};
