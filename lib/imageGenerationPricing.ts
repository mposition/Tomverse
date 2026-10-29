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

// Editing an attached photo (POST /v1/images/edits) sends that photo as image
// input, billed at the image-input rate (gpt-image-2: US$8 per million tokens,
// read 2026-10-29 from developers.openai.com/api/docs/pricing). OpenAI does
// not publish a token formula for gpt-image-2 inputs; the model reads every
// input at high fidelity. The server therefore downscales the photo to fit
// IMAGE_EDIT_INPUT_MAX_EDGE_PX before sending it, and budgets
// IMAGE_EDIT_INPUT_MAX_TOKENS for it -- about 1.5x what gpt-image-1 charged a
// high-fidelity non-square input of that size (6,563 tokens). Settlement
// records the reported image tokens, and a request over this budget is logged
// (image_edit_input_over_budget) so the number is corrected from evidence.
//
// That budget is an estimate, not a proven bound, and a fixed price needs a
// computable worst case (docs/policy/image-generation.md section 12). So edits
// stay refused -- whatever IMAGE_EDIT_ENABLED says -- until this records the
// image tokens actually reported for a 1024px edit input
// (scripts/measure-image-edit-tokens.mjs) and the budget is set from them.
export const IMAGE_EDIT_INPUT_BUDGET_VERIFICATION: {
  verifiedAt: string | null;
  /** The largest reported image-input tokens across the measured shapes. */
  measuredMaxTokens: number | null;
} = { verifiedAt: null, measuredMaxTokens: null };

/** Whether the budget below is backed by a measurement it covers. */
export const imageEditInputBudgetVerified = (
  verification = IMAGE_EDIT_INPUT_BUDGET_VERIFICATION,
  budgetTokens = IMAGE_EDIT_INPUT_MAX_TOKENS
) =>
  verification.verifiedAt !== null &&
  verification.measuredMaxTokens !== null &&
  verification.measuredMaxTokens > 0 &&
  verification.measuredMaxTokens <= budgetTokens;

export const IMAGE_EDIT_INPUT_MAX_EDGE_PX = 1_024;
export const IMAGE_EDIT_INPUT_MAX_TOKENS = 10_000;
export const IMAGE_EDIT_INPUT_USD_PER_MILLION_TOKENS = 8;
export const IMAGE_EDIT_INPUT_BUDGET_MICRO_USD = Math.ceil(
  (IMAGE_EDIT_INPUT_MAX_TOKENS * IMAGE_EDIT_INPUT_USD_PER_MILLION_TOKENS * 1_000_000) /
    1_000_000
); // 80_000

// Credits added to the option's own price for an edit. 90 credits carry the
// 80,000 micro-USD input budget under the per-credit ceiling for every
// gpt-image-2 option: the worst is high 1024x1024 at
// (211,000 + 5,000 + 80,000) / (250 + 90) = 871 micro-USD per credit.
export const IMAGE_EDIT_SURCHARGE_CREDITS = 90;

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
 * Image models whose adapter can edit a supplied photo. Only OpenAI's Images
 * API edit endpoint is implemented; every other model refuses an edit request
 * before anything is reserved.
 */
export const IMAGE_EDIT_MODEL_IDS: readonly string[] = ["gpt-image-2"];

export const imageModelSupportsEdit = (modelId: string) =>
  IMAGE_EDIT_MODEL_IDS.includes(modelId);


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
