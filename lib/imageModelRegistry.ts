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

export type ImageModelProvider = "openai" | "google" | "xai";

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
// The identifier was corrected on 2026-08-04: `gemini-3.1-flash-image-preview`
// was retired on 2026-06-25 and replaced by the GA `gemini-3.1-flash-image`.
// That correction came from the product owner's model review, not from a page
// this environment could read -- every attempt to reach ai.google.dev returns
// HTTP 403 here, on 2026-08-03 and again on 2026-08-04. Pointing a held entry
// at a live GA id rather than a dead preview one is strictly better and
// changes nothing that can execute: the model stays disabled either way.
//
// The same review reports that Google now publishes per-image prices
// (1K US$0.067, 2K US$0.101, 4K US$0.151). They are NOT recorded below. A
// price this repository has not read from the provider's own documentation
// cannot be written into `prices` -- `check:image-pricing` enforces that a
// disabled model carries none, precisely so a hold cannot decay into a launch
// by leaving a table behind.
//
// Published prices would not be enough on their own in any case. Google's
// thinking cannot be switched off and no official maximum for text/thinking
// tokens has been established, so the worst-case cost of one request is not
// provably finite and no fixed credit price can be derived from it
// (section 12 condition 1). That is the blocking condition, and it survives
// the price list being public.
const GOOGLE_GEMINI_31_FLASH_IMAGE: ImageModelProfile = {
  id: "gemini-3.1-flash-image",
  provider: "google",
  apiModelId: "gemini-3.1-flash-image",
  name: "Gemini 3.1 Flash Image",
  lifecycle: "stable",
  disabledReason: "price_unverified",
  // 2K and 4K are advertised upstream but have no representation in ImageSize
  // yet; adding them is part of enabling this model, not of registering it.
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
      "https://ai.google.dev/gemini-api/docs/deprecations",
    ],
    thinkingCapMicroUsd: null,
  },
  disabledNote:
    "GA id corrected from gemini-3.1-flash-image-preview (retired 2026-06-25) per the product owner's review. Prices are reported published (1K $0.067 / 2K $0.101 / 4K $0.151) but have not been read from Google's documentation here (HTTP 403 on 2026-08-03 and 2026-08-04), and thinking cannot be disabled with no documented token cap -- so the worst case is not provably finite. Establish the cap first, then set prices, thinkingCapMicroUsd and disabledReason together.",
};

// Registered, not enabled. The strongest fixed-price candidate in the
// 2026-08-04 model review: xAI already has a chat provider here, so the API
// key, provider health and cost sync all exist, and the image API is
// OpenAI-shaped.
//
// A dated snapshot rather than `-latest`, for the same reason chat profiles
// pin one: a moving target cannot carry a fixed price, because the price is
// only meaningful for the model that was actually verified.
//
// The review reports fixed per-image prices of US$0.05 (1K) and US$0.07 (2K),
// which is the shape a fixed success price needs. They are not recorded: this
// environment cannot reach docs.x.ai (HTTP 403 on 2026-08-04), so nothing here
// has been read from xAI's own documentation.
//
// Note also that the review's floors of 56 and 78 credits divide the image
// price alone by the ceiling. The policy minimum is computed over the *whole*
// worst-case request -- image output plus the full IMAGE_PROMPT_BUDGET_MICRO_USD
// plus any thinking -- so the real floors are higher, and
// minimumCreditsForImageOption() is what should produce them once the figures
// are verified.
const XAI_GROK_IMAGINE_IMAGE_QUALITY: ImageModelProfile = {
  id: "grok-imagine-image-quality-20260403",
  provider: "xai",
  apiModelId: "grok-imagine-image-quality-20260403",
  name: "Grok Imagine Image Quality",
  lifecycle: "stable",
  disabledReason: "price_unverified",
  sizes: ["1024x1024"],
  qualities: ["medium"],
  prices: [],
  latencyClass: "balanced",
  // Left empty rather than guessed: what xAI embeds in the returned bytes has
  // not been read from its documentation, and claiming provenance a file does
  // not carry would be worse than claiming none.
  provenance: [],
  outputMimeTypes: ["image/jpeg", "image/png"],
  priceVerification: {
    verifiedAt: null,
    sources: [
      "https://docs.x.ai/developers/pricing",
      "https://docs.x.ai/developers/model-capabilities/images/generation",
    ],
    thinkingCapMicroUsd: null,
  },
  disabledNote:
    "Fixed per-image prices are reported as $0.05 (1K) and $0.07 (2K) by the product owner's 2026-08-04 review, but docs.x.ai returns HTTP 403 from this environment so nothing has been verified here. Enabling also needs an xAI adapter (imageProviderAdapter dispatches OpenAI only), IMAGE_PROVIDER_XAI_COST_MICROUSD_PER_DAY/_PER_MONTH, and an approved sale-credit figure at or above minimumCreditsForImageOption().",
};

export const IMAGE_MODEL_REGISTRY: readonly ImageModelProfile[] = [
  OPENAI_GPT_IMAGE_2,
  GOOGLE_GEMINI_31_FLASH_IMAGE,
  XAI_GROK_IMAGINE_IMAGE_QUALITY,
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
