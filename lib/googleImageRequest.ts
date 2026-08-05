import type { ImageSize } from "@/lib/imageGenerationPricing";
import {
  googleRequestForOption,
  optionForLegacyImageSize,
  type ImageResolutionTier,
} from "@/lib/imageResolution";

// Pure request/response shaping for Google's image generation, kept out of
// lib/imageProviderAdapter.ts so it can be tested without a network and
// without the server-only import chain.
//
// Two things about this file are load-bearing.
//
// 1. It speaks the **Interactions API** and nothing else. The older
//    GenerateContent path expresses the same request with entirely different
//    names (`generationConfig.maxOutputTokens`, `candidates[].content.parts[]
//    .inlineData.data`, `usageMetadata.thoughtsTokenCount`), and its
//    `imageConfig` is marked deprecated in the API reference. Mixing the two
//    vocabularies produces a request that is valid-looking and wrong, so the
//    snake_case Interactions names are used throughout and the camelCase ones
//    appear nowhere.
//
// 2. Nothing here establishes a cost bound. `max_output_tokens` is sent on
//    every request because the server must not leave a billable parameter
//    unset -- but the official documentation describes `max_output_tokens`
//    and the thinking usage counters (`total_output_tokens`,
//    `total_thought_tokens`) separately and never states that the limit
//    covers their sum. Until a staging measurement shows it does, these
//    models stay `worst_case_cost_unbounded` and this code is unreachable:
//    generateImageWithProvider refuses any model with a disabledReason before
//    it dispatches. Policy: docs/policy/image-generation.md section 12.1.

export const GOOGLE_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

/**
 * Google authenticates with its own header, not an OpenAI-style bearer token.
 * Sending `Authorization: Bearer` here fails in a way that reads like a bad
 * key rather than a wrong protocol.
 */
export const GOOGLE_API_KEY_HEADER = "x-goog-api-key";

export type GoogleThinkingLevel = "low" | "medium" | "high";

const MIME_ALLOWLIST = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Same launch scope as xAI (policy §12.1): 1K square only, because that is
 * what the price table can express and what compares like-for-like against
 * gpt-image-2's square. A size outside it returns null and the caller refuses
 * rather than guessing a resolution the provider prices its own way.
 */
const LAUNCH_TIERS = new Set<ImageResolutionTier>(["1k"]);

export const buildGoogleImageRequest = (input: {
  apiModelId: string;
  prompt: string;
  size: ImageSize;
  /**
   * The model's documented output-token limit, sent on every request.
   *
   * Deliberately NOT named a cap: it bounds what we ask for, and whether it
   * also bounds thinking is the open question that keeps these models
   * disabled. A profile without one cannot be requested at all -- an absent
   * limit would mean sending a generation with no stated ceiling of any kind.
   */
  maxOutputTokens: number | null;
  /**
   * Per model, because support is not uniform. Null omits the field entirely:
   * sending a parameter to a model whose acceptance of it has not been
   * verified is how a request starts failing for a reason nobody expects.
   */
  thinkingLevel: GoogleThinkingLevel | null;
  /**
   * What to ask the provider to deliver. The response's own `mime_type` is
   * still what gets recorded -- this is a request, not an assumption.
   */
  deliveryMimeType: string;
}): Record<string, unknown> | null => {
  if (!input.maxOutputTokens || input.maxOutputTokens <= 0) return null;
  if (!MIME_ALLOWLIST.has(input.deliveryMimeType)) return null;
  const option = optionForLegacyImageSize(input.size);
  if (!LAUNCH_TIERS.has(option.tier) || option.aspectRatio !== "1:1") return null;
  const mapped = googleRequestForOption(option);
  return {
    model: input.apiModelId,
    input: input.prompt,
    response_format: {
      type: "image",
      // Inline bytes rather than a fetchable reference: the original is stored
      // server-side, and a second fetch is one more way a generation the user
      // was already charged for can fail after the fact.
      delivery: "inline",
      mime_type: input.deliveryMimeType,
      aspect_ratio: mapped.aspectRatio,
      image_size: mapped.imageSize,
    },
    generation_config: {
      max_output_tokens: input.maxOutputTokens,
      ...(input.thinkingLevel ? { thinking_level: input.thinkingLevel } : {}),
    },
  };
};

export type GoogleImageUsage = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
};

export type GoogleImagePayload = {
  imageBase64: string;
  /** Exactly what Google said it produced. Never inferred from the request. */
  mimeType: string;
  usage: GoogleImageUsage;
};

const finiteCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

/**
 * Reads the one delivered image out of an Interactions response.
 *
 * Only `model_output` steps are considered. A thinking model can emit images
 * as part of its reasoning, and those are not the answer -- billing the user
 * for the finished image while storing a working sketch would be wrong in the
 * one direction nobody would notice, because both are plausible images.
 *
 * More than one image in the model output fails closed rather than picking
 * the first. The fixed price is for one image; a response carrying several
 * means the contract is not the one that was priced, and choosing among them
 * would hide that.
 */
export const parseGoogleImageResponse = (
  payload: unknown
): GoogleImagePayload | null => {
  if (!payload || typeof payload !== "object") return null;
  const steps = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;

  const images = steps
    .filter(
      (step): step is { content?: unknown } =>
        Boolean(step) &&
        typeof step === "object" &&
        (step as { type?: unknown }).type === "model_output"
    )
    .flatMap((step) => (Array.isArray(step.content) ? step.content : []))
    .filter(
      (content): content is Record<string, unknown> =>
        Boolean(content) &&
        typeof content === "object" &&
        (content as { type?: unknown }).type === "image"
    );
  if (images.length !== 1) return null;

  const image = images[0];
  const imageBase64 = image.data;
  if (typeof imageBase64 !== "string" || !imageBase64) return null;
  const reported = image.mime_type;
  const mimeType =
    typeof reported === "string" && MIME_ALLOWLIST.has(reported.trim())
      ? reported.trim()
      : null;
  if (!mimeType) return null;

  // Usage sits at the top level of the interaction, not inside a step. Output
  // and thinking are read as the separate counters Google reports them as --
  // adding them here would bake in the very assumption that is not yet proven.
  const usageRaw = (payload as { usage?: unknown }).usage;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? (usageRaw as Record<string, unknown>)
      : {};

  return {
    imageBase64,
    mimeType,
    usage: {
      inputTokens: finiteCount(usage.total_input_tokens),
      outputTokens: finiteCount(usage.total_output_tokens),
      thinkingTokens: finiteCount(usage.total_thought_tokens),
    },
  };
};

/**
 * `usage.total_tokens` includes the input, so it can never be compared with
 * `max_output_tokens`. This is the quantity the staging measurement has to
 * put against the requested limit, and it exists as a named function so the
 * comparison cannot quietly be made against the wrong sum.
 */
export const googleBillableOutputTokens = (usage: GoogleImageUsage): number =>
  usage.outputTokens + usage.thinkingTokens;
