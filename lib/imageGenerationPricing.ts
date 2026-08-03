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
