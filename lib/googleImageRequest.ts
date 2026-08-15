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
// 2. Nothing here establishes a cost bound, and measurement has now shown
//    that nothing can. `max_output_tokens` is sent on every request because
//    the server must not leave a billable parameter unset. The documentation
//    describes it and the usage counters (`total_output_tokens`,
//    `total_thought_tokens`) separately and never states that the limit covers
//    their sum -- and on 2026-08-14 a request at 2,048 reported 2,533 of them
//    as billable usage and returned a finished image. So the limit is a
//    request parameter, not a cost ceiling. These models stay
//    `worst_case_cost_unbounded` and this code is unreachable:
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
   * Deliberately NOT named a cap, and measurement has now shown why. On
   * 2026-08-14 a request with `max_output_tokens: 2048` came back `completed`,
   * with a full image, having billed 1,602 output plus 931 thinking tokens --
   * 2,533, over the limit by 485. It does bound thinking on its own (at 512 and
   * 256 thinking stopped at limit minus three, every sample), but it does not
   * bound what we are billed for, which is their sum.
   *
   * So this is a request parameter and not a cost ceiling.
   * `priceVerification.thinkingCapMicroUsd` stays null and the Google image
   * models stay disabled: policy §12 wants a bounded worst case, and one does
   * not exist here. See .github/audits/image-model-verification-worksheet.md §I.
   *
   * A profile without one cannot be requested at all -- an absent limit would
   * mean sending a generation with no stated ceiling of any kind.
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
    // Exactly the four keys the Interactions API reference defines, and no
    // others. A fifth one -- `delivery: "inline"` -- used to sit here with a
    // comment explaining why inline bytes were preferable to a fetchable
    // reference. That reasoning was sound and the field was invented: it is
    // absent from the spec table in
    // .github/audits/image-model-verification-worksheet.md §F-2, and the API
    // refuses the whole request over it:
    //
    //   HTTP 400 invalid_request
    //   "Image delivery mode is not supported."
    //
    // Inline is what the API does anyway -- the response carries base64 in
    // `content.data`, which is what parseGoogleImageResponse reads. So the
    // preference was already satisfied, and stating it cost every Google
    // request. Same failure as the `image/png` one before it: a plausible
    // field, no documented basis, and nothing that would notice.
    response_format: {
      type: "image",
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

export type GoogleImageInteraction = {
  usage: GoogleImageUsage;
  /** Whatever Google called the stop condition, verbatim. */
  status: string | null;
  /** Images found in `model_output` steps -- 1 is the only priceable answer. */
  modelOutputImageCount: number;
  /** Step types present, for diagnosing a shape nothing was written against. */
  stepTypes: (string | null)[];
};

/**
 * The same response read for evidence rather than for an image.
 *
 * parseGoogleImageResponse fails closed on anything that is not exactly one
 * delivered image, which is right for production and wrong for the staging
 * measurement: a response that stopped because it ran out of room is the
 * single most informative sample the measurement can get, and it is precisely
 * the one with no finished image in it. Routing that through the strict parser
 * threw its `usage` away and filed it as an unreadable payload -- the run
 * would have paid for the answer and then discarded it.
 *
 * So the two questions are separated. This one never requires an image and
 * never yields one; it reads counters and stop conditions. It is not a
 * fallback for the strict parser and no production path may use it to accept
 * a response the strict parser rejected.
 */
export const readGoogleImageInteraction = (
  payload: unknown
): GoogleImageInteraction | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const steps = Array.isArray(record.steps) ? record.steps : [];

  const modelOutputImageCount = steps
    .filter(
      (step): step is { content?: unknown } =>
        Boolean(step) &&
        typeof step === "object" &&
        (step as { type?: unknown }).type === "model_output"
    )
    .flatMap((step) => (Array.isArray(step.content) ? step.content : []))
    .filter(
      (content) =>
        Boolean(content) &&
        typeof content === "object" &&
        (content as { type?: unknown }).type === "image"
    ).length;

  const usageRaw = record.usage;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? (usageRaw as Record<string, unknown>)
      : {};

  const statusRaw = record.status ?? record.finish_reason ?? record.stop_reason;

  return {
    usage: {
      inputTokens: finiteCount(usage.total_input_tokens),
      outputTokens: finiteCount(usage.total_output_tokens),
      thinkingTokens: finiteCount(usage.total_thought_tokens),
    },
    status: typeof statusRaw === "string" ? statusRaw : null,
    modelOutputImageCount,
    stepTypes: steps.map((step) => {
      const type = (step as { type?: unknown } | null)?.type;
      return typeof type === "string" ? type : null;
    }),
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
