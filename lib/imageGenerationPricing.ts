// Image generation pricing, kept apart from lib/modelPricing.ts on purpose.
//
// ModelPricingProfile is token-tiered end to end (input/cached/output USD per
// million tokens), and every guardrail derived from it assumes token
// arithmetic. A per-image price forced into that shape would either corrupt
// the profile type or silently misprice; this module owns the per-image
// price list instead, with its own fail-closed check
// (scripts/check-image-pricing.mjs, wired into the PR Fast Gate).
//
// Policy: docs/policy/image-generation.md. Numbers here are micro-USD
// integers, same unit as the rest of the billing code.

export const IMAGE_GENERATION_MODEL_ID = "gpt-image-2";

export const IMAGE_PRICING_VERSION = "2026-08-03-v1";

// Upper bound on what one image credit may cost Tomverse, prompt input
// included. Derived from the lowest credit-pack funded-cost budget
// (1,500 microUSD/credit on the Starter and Power packs): staying at or
// under 900 keeps at least 40% of that budget in reserve. This is a policy
// tripwire, not a provider number -- current worst case is 864 microUSD per
// credit, so a provider price rise above ~4.2% trips the check on purpose.
// Changing this constant requires the approval procedure in the policy doc
// and a new IMAGE_PRICING_VERSION.
export const IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD = 900;

// The final provider prompt (user input plus any server-added preset text)
// is capped at this many tokens. The cap is part of the fixed price: every
// per-credit cost below already budgets the full 1,000 tokens at the text
// input rate, so a request at the cap cannot exceed the ceiling.
export const IMAGE_PROMPT_MAX_TOKENS = 1_000;
export const IMAGE_PROMPT_INPUT_USD_PER_MILLION_TOKENS = 5;
export const IMAGE_PROMPT_BUDGET_MICRO_USD = Math.ceil(
  (IMAGE_PROMPT_MAX_TOKENS * IMAGE_PROMPT_INPUT_USD_PER_MILLION_TOKENS * 1_000_000) /
    1_000_000
); // 5_000

// Editing an attached photo sends that photo to the provider as input. The
// server first downscales it to fit IMAGE_EDIT_INPUT_MAX_EDGE_PX, and each
// edit-capable model below states what that photo costs and the credits an
// edit adds for it. A fixed price needs a computable worst case
// (docs/policy/image-generation.md section 12), so a model edits only once
// `verification` records the evidence its budget rests on.
export const IMAGE_EDIT_INPUT_MAX_EDGE_PX = 1_024;

export type ImageEditPricing = {
  /** Credits added to the option's own price for an edit. */
  surchargeCredits: number;
  /** Worst-case provider cost of the photo as input, micro-USD. */
  inputBudgetMicroUsd: number;
  /**
   * Set when the provider bills the photo per input token: settlement then
   * charges the reported tokens at this rate. Null when the photo costs a
   * fixed amount per edit, which settles at `inputBudgetMicroUsd`.
   */
  inputTokens: { maxTokens: number; usdPerMillionTokens: number } | null;
  /**
   * What the budget rests on: a published price or a billed measurement.
   * Null holds edits on the model whatever IMAGE_EDIT_ENABLED says.
   */
  verification: {
    verifiedAt: string;
    source: string;
    /** For a per-token photo: the largest image-input tokens measured. */
    measuredMaxTokens?: number;
  } | null;
};

const IMAGE_EDIT_PRICING: Readonly<Record<string, ImageEditPricing>> = {
  // POST /v1/images/edits bills the photo as image input at US$8 per million
  // tokens (read 2026-10-29 from developers.openai.com/api/docs/pricing). The
  // budget is 10,000 tokens. Measured 2026-10-29 (owner-approved run,
  // scripts/measure-image-edit-tokens.mjs, quality low): 1,024 image tokens
  // for 1024x1024 and 768 for 1024x768 and 768x1024 -- one token per 32x32
  // pixels, so a photo fitted inside 1024px is at most a tenth of the budget.
  // 90 credits carry the 80,000 micro-USD budget under the ceiling for every
  // option: the worst is high 1024x1024 at
  // (211,000 + 5,000 + 80,000) / (250 + 90) = 871 micro-USD per credit.
  "gpt-image-2": {
    surchargeCredits: 90,
    inputBudgetMicroUsd: 80_000,
    inputTokens: { maxTokens: 10_000, usdPerMillionTokens: 8 },
    verification: {
      verifiedAt: "2026-10-29",
      source: "scripts/measure-image-edit-tokens.mjs",
      measuredMaxTokens: 1_024,
    },
  },
  // fal-ai/nano-banana-2/edit is sold per output image at the generation's own
  // price: fal's pricing API answered unit_price 0.08 per "images" for both
  // endpoints on 2026-10-29, and the model page names no input-image charge.
  // The edit therefore adds nothing to the 120 credits already approved.
  "fal-ai/nano-banana-2": {
    surchargeCredits: 0,
    inputBudgetMicroUsd: 0,
    inputTokens: null,
    verification: null,
  },
  // xAI publishes only the output price (US$0.05 per image) and says nothing
  // about the source image of an edit. Held until a billed edit's
  // usage.cost_in_usd_ticks shows what the photo adds.
  "grok-imagine-image-quality-20260403": {
    surchargeCredits: 0,
    inputBudgetMicroUsd: 0,
    inputTokens: null,
    verification: null,
  },
};

/** A model's edit pricing, or null when it cannot edit (yet). */
export const imageEditPricing = (modelId: string): ImageEditPricing | null => {
  const pricing = Object.hasOwn(IMAGE_EDIT_PRICING, modelId) ? IMAGE_EDIT_PRICING[modelId] : null;
  if (!pricing?.verification) return null;
  const { inputTokens, verification } = pricing;
  // A per-token budget is proven only by a measurement inside it.
  if (
    inputTokens &&
    !(
      typeof verification.measuredMaxTokens === "number" &&
      verification.measuredMaxTokens > 0 &&
      verification.measuredMaxTokens <= inputTokens.maxTokens
    )
  ) {
    return null;
  }
  return pricing;
};

// The photo is read from the user's own attachment storage; anything larger
// is not a file /api/chat accepted (its MAX_ATTACHMENT_SIZE).
export const IMAGE_EDIT_SOURCE_MAX_BYTES = 10 * 1024 * 1024;

/** Attachment types an edit can start from: what sharp decodes here. */
export const IMAGE_EDIT_SOURCE_MEDIA_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/**
 * The priced size closest to the photo's shape, read upright (EXIF
 * orientations 5-8 turn the stored width and height by 90 degrees). Within
 * 10% of square stays square.
 */
export const imageEditOutputSize = (
  width: number,
  height: number,
  orientation?: number
): ImageSize => {
  const [w, h] = orientation && orientation >= 5 && orientation <= 8 ? [height, width] : [width, height];
  if (!(w > 0 && h > 0)) return "1024x1024";
  const ratio = w / h;
  if (ratio > 1.1) return "1536x1024";
  if (ratio < 1 / 1.1) return "1024x1536";
  return "1024x1024";
};

/**
 * Image models that edit a supplied photo: those with verified edit pricing.
 * Every other model refuses an edit request before anything is reserved.
 */
export const imageModelSupportsEdit = (modelId: string) => imageEditPricing(modelId) !== null;

/** Models with an edit adapter, verified or still held. */
export const IMAGE_EDIT_MODEL_IDS: readonly string[] = Object.keys(IMAGE_EDIT_PRICING);


export type ImageQuality = "low" | "medium" | "high";
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
export type ImagePreset = "draft" | "standard" | "final";

export const IMAGE_QUALITY_BY_PRESET: Record<ImagePreset, ImageQuality> = {
  draft: "low",
  standard: "medium",
  final: "high",
};

export type ImageGenerationPricingEntry = {
  quality: ImageQuality;
  size: ImageSize;
  /** Fixed credits charged on a successful generation. Never partially refunded. */
  credits: number;
  /** Official per-image output price, micro-USD. Prompt budget is added on top. */
  outputCostMicroUsd: number;
  enabled: boolean;
};

// Official gpt-image-2 output prices, verified 2026-08-03 against
// PRICE_VERIFICATION.sources. Re-verify immediately before any deploy that
// touches this table; the staleness window is enforced by
// scripts/check-image-pricing.mjs.
export const IMAGE_GENERATION_PRICING: readonly ImageGenerationPricingEntry[] = [
  { quality: "low", size: "1024x1024", credits: 15, outputCostMicroUsd: 6_000, enabled: true },
  { quality: "low", size: "1536x1024", credits: 15, outputCostMicroUsd: 5_000, enabled: true },
  { quality: "low", size: "1024x1536", credits: 15, outputCostMicroUsd: 5_000, enabled: true },
  { quality: "medium", size: "1024x1024", credits: 70, outputCostMicroUsd: 53_000, enabled: true },
  { quality: "medium", size: "1536x1024", credits: 60, outputCostMicroUsd: 41_000, enabled: true },
  { quality: "medium", size: "1024x1536", credits: 60, outputCostMicroUsd: 41_000, enabled: true },
  { quality: "high", size: "1024x1024", credits: 250, outputCostMicroUsd: 211_000, enabled: true },
  { quality: "high", size: "1536x1024", credits: 200, outputCostMicroUsd: 165_000, enabled: true },
  { quality: "high", size: "1024x1536", credits: 200, outputCostMicroUsd: 165_000, enabled: true },
];

export const PRICE_VERIFICATION = {
  verifiedAt: "2026-08-03",
  sources: [
    "https://developers.openai.com/api/docs/pricing",
    "https://developers.openai.com/api/docs/models/gpt-image-2",
  ],
} as const;

/** Worst legitimate provider cost of one request against this entry. */
export const maxRequestCostMicroUsd = (entry: ImageGenerationPricingEntry) =>
  entry.outputCostMicroUsd + IMAGE_PROMPT_BUDGET_MICRO_USD;

/**
 * Fail-closed lookup: an unknown or disabled quality/size combination
 * returns null and the caller must reject the request, never fall back to a
 * guessed price.
 */
export const getImageGenerationPricing = (
  quality: string,
  size: string
): ImageGenerationPricingEntry | null =>
  IMAGE_GENERATION_PRICING.find(
    (entry) => entry.enabled && entry.quality === quality && entry.size === size
  ) ?? null;

export const listEnabledImagePricingEntries = () =>
  IMAGE_GENERATION_PRICING.filter((entry) => entry.enabled);
