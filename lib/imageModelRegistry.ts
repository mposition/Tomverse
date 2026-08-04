// The image model registry (policy v2 section 12 of
// docs/policy/image-generation.md).
//
// Deliberately separate from AVAILABLE_MODELS / ModelRegistry: those describe
// chat models, where `supportsImage` means "accepts image INPUT". Mixing an
// image *generation* model into that list would collide with that meaning and
// with the token-tiered pricing every chat guardrail assumes. This module owns
// the generation-side profiles instead.
//
// Pure and client-safe (no server-only import, no Prisma): the workspace model
// picker renders straight from these profiles.

import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_PROMPT_BUDGET_MICRO_USD,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";

export type ImageModelProvider = "openai" | "google";

export type ImageModelLifecycle = "stable" | "preview";

/**
 * Why a registered model is not currently selectable. `null` means enabled.
 * `price_unverified` is the section 12 fail-closed hold: the model is
 * registered so the catalogue and the tests can see it, but no request may
 * reach it until an official price has been read from the provider's own
 * documentation and its worst-case cost proven finite.
 */
export type ImageModelDisabledReason =
  | "price_unverified"
  | "worst_case_cost_unbounded"
  | "operational_hold";

export type ImageModelOptionPrice = {
  quality: ImageQuality;
  size: ImageSize;
  /** Fixed credits charged on success. Never partially refunded. */
  credits: number;
  /** Official per-image output price, micro-USD. Prompt budget is added on top. */
  outputCostMicroUsd: number;
};

export type ImageModelPriceVerification = {
  /** ISO date the price list was last read from the provider's own docs. */
  verifiedAt: string | null;
  /** Official documentation URLs only -- never a blog or a search summary. */
  sources: readonly string[];
  /**
   * Set when the provider charges for internal reasoning on an image request.
   * A fixed success price requires a provable cap; `null` means the cap could
   * not be established from official documentation, which is itself a
   * disabling condition (section 12 condition 6).
   */
  thinkingCapMicroUsd: number | null;
};

export type ImageModelProfile = {
  /** Stable internal id; equals the provider's API model id today. */
  id: string;
  provider: ImageModelProvider;
  /** Exactly the string sent to the provider. */
  apiModelId: string;
  /** Display name for the picker. */
  name: string;
  lifecycle: ImageModelLifecycle;
  disabledReason: ImageModelDisabledReason | null;
  sizes: readonly ImageSize[];
  qualities: readonly ImageQuality[];
  prices: readonly ImageModelOptionPrice[];
  /** Rough wall-clock band for the picker; not a guarantee. */
  latencyClass: "fast" | "balanced" | "slow";
  /** What the provider embeds in the returned bytes, for the UI's label. */
  provenance: readonly ("c2pa" | "synthid")[];
  /** MIME types the adapter may store unmodified. */
  outputMimeTypes: readonly string[];
  priceVerification: ImageModelPriceVerification;
  /** Free-text note surfaced in the admin panel for a disabled model. */
  disabledNote?: string;
};

const OPENAI_GPT_IMAGE_2: ImageModelProfile = {
  id: "gpt-image-2",
  provider: "openai",
  apiModelId: "gpt-image-2",
  name: "GPT Image 2",
  lifecycle: "stable",
  disabledReason: null,
  sizes: ["1024x1024", "1536x1024", "1024x1536"],
  qualities: ["low", "medium", "high"],
  prices: [
    { quality: "low", size: "1024x1024", credits: 15, outputCostMicroUsd: 6_000 },
    { quality: "low", size: "1536x1024", credits: 15, outputCostMicroUsd: 5_000 },
    { quality: "low", size: "1024x1536", credits: 15, outputCostMicroUsd: 5_000 },
    { quality: "medium", size: "1024x1024", credits: 70, outputCostMicroUsd: 53_000 },
    { quality: "medium", size: "1536x1024", credits: 60, outputCostMicroUsd: 41_000 },
    { quality: "medium", size: "1024x1536", credits: 60, outputCostMicroUsd: 41_000 },
    { quality: "high", size: "1024x1024", credits: 250, outputCostMicroUsd: 211_000 },
    { quality: "high", size: "1536x1024", credits: 200, outputCostMicroUsd: 165_000 },
    { quality: "high", size: "1024x1536", credits: 200, outputCostMicroUsd: 165_000 },
  ],
  latencyClass: "balanced",
  provenance: ["c2pa"],
  outputMimeTypes: ["image/png"],
  priceVerification: {
    verifiedAt: "2026-08-03",
    sources: [
      "https://developers.openai.com/api/docs/pricing",
      "https://developers.openai.com/api/docs/models/gpt-image-2",
    ],
    // No reasoning tokens are charged on an images request.
    thinkingCapMicroUsd: 0,
  },
};

// Registered, deliberately NOT enabled (policy sections 12 and 15).
//
// On 2026-08-03 every attempt to read ai.google.dev and the Google Cloud
// model documentation from this environment returned HTTP 403, so no price
// on this profile has been read from Google's own documentation. Search
// summaries attributed conflicting per-image figures to the same page, which
// is exactly the situation the "official body text only" rule exists for.
// The thinking cap is unknown, so the worst-case request cost is not provably
// finite and no fixed credit price can be derived. `prices` stays empty on
// purpose: an empty list cannot be mistaken for a verified one.
const GOOGLE_NANO_BANANA_2: ImageModelProfile = {
  id: "gemini-3.1-flash-image-preview",
  provider: "google",
  apiModelId: "gemini-3.1-flash-image-preview",
  name: "Nano Banana 2",
  lifecycle: "preview",
  disabledReason: "price_unverified",
  sizes: ["1024x1024"],
  qualities: ["medium"],
  prices: [],
  latencyClass: "fast",
  provenance: ["synthid"],
  outputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  priceVerification: {
    verifiedAt: null,
    sources: [
      "https://ai.google.dev/gemini-api/docs/pricing",
      "https://ai.google.dev/gemini-api/docs/image-generation",
    ],
    thinkingCapMicroUsd: null,
  },
  disabledNote:
    "Official pricing and the thinking-token cap could not be read from Google's documentation (HTTP 403 on 2026-08-03). Verify manually, then set prices, thinkingCapMicroUsd and disabledReason together.",
};

export const IMAGE_MODEL_REGISTRY: readonly ImageModelProfile[] = [
  OPENAI_GPT_IMAGE_2,
  GOOGLE_NANO_BANANA_2,
];

/** The default single selection and the v1 compatibility model. */
export const DEFAULT_IMAGE_MODEL_ID = OPENAI_GPT_IMAGE_2.id;

export const listImageModels = () => IMAGE_MODEL_REGISTRY;

export const listEnabledImageModels = () =>
  IMAGE_MODEL_REGISTRY.filter((model) => model.disabledReason === null);

export const getImageModel = (modelId: string): ImageModelProfile | null =>
  IMAGE_MODEL_REGISTRY.find((model) => model.id === modelId) ?? null;

/**
 * Fail-closed price lookup. A disabled model, an unknown model, or an option
 * with no price returns null and the caller must reject the request -- never
 * fall back to another model's price.
 */
export const getImageModelPrice = (
  modelId: string,
  quality: string,
  size: string
): ImageModelOptionPrice | null => {
  const model = getImageModel(modelId);
  if (!model || model.disabledReason !== null) return null;
  return (
    model.prices.find(
      (price) => price.quality === quality && price.size === size
    ) ?? null
  );
};

/**
 * Worst legitimate provider cost of one request: image output plus the full
 * prompt budget plus the model's proven thinking cap. Returns null when the
 * cap is unknown -- an unbounded worst case cannot carry a fixed price
 * (section 12 condition 1).
 */
export const maxImageRequestCostMicroUsd = (
  model: ImageModelProfile,
  price: ImageModelOptionPrice
): number | null => {
  const thinkingCap = model.priceVerification.thinkingCapMicroUsd;
  if (thinkingCap === null) return null;
  return price.outputCostMicroUsd + IMAGE_PROMPT_BUDGET_MICRO_USD + thinkingCap;
};

/**
 * The policy floor on credits for one option: the smallest number of credits
 * that keeps the worst-case cost at or under the per-credit ceiling. This is
 * a mathematical minimum, not the sale price -- the sale price adds the
 * margin and drift allowance the policy requires to be approved separately.
 */
export const minimumCreditsForImageOption = (
  model: ImageModelProfile,
  price: ImageModelOptionPrice
): number | null => {
  const maxCost = maxImageRequestCostMicroUsd(model, price);
  if (maxCost === null) return null;
  return Math.ceil(maxCost / IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD);
};

/** The providers that have at least one enabled model right now. */
export const listActiveImageProviders = (): readonly ImageModelProvider[] => [
  ...new Set(listEnabledImageModels().map((model) => model.provider)),
];
