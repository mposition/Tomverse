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

import {
  CATALOG_IMAGE_SIZES, DIRECT_RASTER_MODELS, RECRAFT_API_MODEL, RECRAFT_BACKGROUND_REMOVAL, RECRAFT_SIZE, SEEDREAM_API_MODEL,
} from "@/lib/directRasterModels";
import { ALIBABA_SINGLE_PHOTO_EDIT_COST } from "@/lib/qwenImageRequest";
import { BFL_FLUX3_IMAGE_EDIT_COST } from "@/lib/bflImageRequest";
import { IDEOGRAM_MODEL_ID, IDEOGRAM_OUTPUT_COST_MICRO_USD, IDEOGRAM_SIZE } from "@/lib/ideogramImageRequest";

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
  option?: {
    provider: "qwen" | "bfl" | "google" | "openai" | "ideogram" | "recraft";
    size: ImageSize;
    quality?: ImageQuality;
    minimumOutputCostMicroUsd?: number;
  };
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

const GOOGLE_PHOTO_EDIT_COST = {
  "gemini-3.1-flash-image": { inputRate: 0.50, output: 67_200 },
  "gemini-3.1-flash-lite-image": { inputRate: 0.25, output: 33_600 },
  "gemini-nano-banana-2.1": { inputRate: 1.50, output: 33_600 },
} as const;

const OPENAI_2_6_PHOTO_EDIT_IDS: readonly string[] = [
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
];

const IMAGE_EDIT_PRICING: Readonly<Record<string, ImageEditPricing>> = {
  // One reference is a fixed $0.008. The approved option must carry the
  // entire edit under the ceiling before imageEditCredits admits the edit.
  [SEEDREAM_API_MODEL]: {
    surchargeCredits: 0,
    inputBudgetMicroUsd: 8_000,
    inputTokens: null,
    verification: { verifiedAt: "2026-11-25", source: DIRECT_RASTER_MODELS.byteplus.pricing },
  },
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
  // The edit therefore adds nothing to the 120 credits already approved. The
  // owner-approved run of scripts/measure-image-edit-providers.mjs on
  // 2026-10-29 sent a 1024x768 photo as a data URI and got back a 1024x1024
  // PNG on fal's CDN -- the image that was priced.
  "fal-ai/nano-banana-2": {
    surchargeCredits: 0,
    inputBudgetMicroUsd: 0,
    inputTokens: null,
    verification: {
      verifiedAt: "2026-10-29",
      source: "fal pricing API (fal-ai/nano-banana-2/edit) + scripts/measure-image-edit-providers.mjs",
    },
  },
  // xAI publishes only the output price (US$0.05 per image). The owner-approved
  // run of scripts/measure-image-edit-providers.mjs on 2026-10-29 read
  // usage.cost_in_usd_ticks = 600,000,000 (US$0.06) for both a 1024x1024 and a
  // 1024x768 photo: the photo adds a flat US$0.01 whatever its shape. 10
  // credits carry it at (50,000 + 5,000 + 10,000) / (75 + 10) = 765 micro-USD
  // per credit, beside the 733 the generation already carries.
  "grok-imagine-image-quality-20260403": {
    surchargeCredits: 10,
    inputBudgetMicroUsd: 10_000,
    inputTokens: null,
    verification: {
      verifiedAt: "2026-10-29",
      source: "scripts/measure-image-edit-providers.mjs (usage.cost_in_usd_ticks)",
    },
  },
};

/** A model's edit pricing, or null when it cannot edit (yet). */
export const imageEditPricing = (modelId: string): ImageEditPricing | null => {
  if (modelId === IDEOGRAM_MODEL_ID && process.env.IMAGE_IDEOGRAM_EDIT_ENABLED === "true") {
    // The 1K Medium request with one source costs $0.06, the same as
    // generation. High has a separate edit rate and is outside this option.
    return {
      surchargeCredits: 0,
      inputBudgetMicroUsd: 0,
      inputTokens: null,
      option: { provider: "ideogram", size: IDEOGRAM_SIZE, quality: "medium", minimumOutputCostMicroUsd: IDEOGRAM_OUTPUT_COST_MICRO_USD.medium },
      verification: { verifiedAt: "2026-11-25", source: "https://ideogram.ai/models/4.6/#api" },
    };
  }
  if (modelId === RECRAFT_API_MODEL && process.env.IMAGE_RECRAFT_EDIT_ENABLED === "true") {
    // The image-to-image docs link the V4 rates directly. One square input,
    // one Pro 2K raster, no style creation or extra image output.
    return {
      surchargeCredits: 0,
      inputBudgetMicroUsd: 0,
      inputTokens: null,
      option: {
        provider: "recraft", size: RECRAFT_SIZE, quality: "medium",
        minimumOutputCostMicroUsd: DIRECT_RASTER_MODELS.recraft.outputCostMicroUsd,
      },
      verification: { verifiedAt: "2026-11-25", source: "https://www.recraft.ai/docs/api-reference/tools/image-to-image" },
    };
  }
  if (modelId === RECRAFT_BACKGROUND_REMOVAL.modelId && process.env.IMAGE_RECRAFT_BACKGROUND_REMOVAL_ENABLED === "true") {
    // A flat $0.01 (10 API units) per request, read 2026-11-26. The photo is
    // the whole request: nothing is charged for it beside that price, and no
    // prompt is sent.
    return {
      surchargeCredits: 0,
      inputBudgetMicroUsd: 0,
      inputTokens: null,
      option: {
        provider: "recraft", size: RECRAFT_BACKGROUND_REMOVAL.size, quality: "medium",
        minimumOutputCostMicroUsd: RECRAFT_BACKGROUND_REMOVAL.outputCostMicroUsd,
      },
      verification: { verifiedAt: "2026-11-26", source: RECRAFT_BACKGROUND_REMOVAL.pricing },
    };
  }
  if (process.env.IMAGE_OPENAI_2_6_EDIT_ENABLED === "true" && OPENAI_2_6_PHOTO_EDIT_IDS.includes(modelId)) {
    // Each model billed 1,024 image-input tokens and 1,449 image-output tokens
    // for a 1,024-square PNG edit on 2026-11-25. Preserve the approved output
    // price and keep the original 65-credit option below its cost ceiling:
    // 43,470 output + 5,000 prompt + 1,152 * 8 photo = 57,686 micro-USD.
    const maxTokens = 1_152;
    const usdPerMillionTokens = 8;
    return {
      surchargeCredits: 0,
      inputBudgetMicroUsd: maxTokens * usdPerMillionTokens,
      inputTokens: { maxTokens, usdPerMillionTokens },
      option: { provider: "openai", size: "1024x1024", quality: "medium", minimumOutputCostMicroUsd: 43_470 },
      verification: {
        verifiedAt: "2026-11-25",
        source: "https://developers.openai.com/api/docs/pricing",
        measuredMaxTokens: 1_024,
      },
    };
  }
  if (process.env.IMAGE_ALIBABA_EDIT_ENABLED === "true" && Object.hasOwn(ALIBABA_SINGLE_PHOTO_EDIT_COST, modelId)) {
    const cost = ALIBABA_SINGLE_PHOTO_EDIT_COST[modelId as keyof typeof ALIBABA_SINGLE_PHOTO_EDIT_COST];
    return {
      surchargeCredits: 0,
      inputBudgetMicroUsd: cost.input,
      inputTokens: null,
      option: { provider: "qwen", size: "1024x1024", minimumOutputCostMicroUsd: cost.output },
      verification: { verifiedAt: "2026-11-25", source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing" },
    };
  }
  if (process.env.IMAGE_BFL_EDIT_ENABLED === "true" && Object.hasOwn(BFL_FLUX3_IMAGE_EDIT_COST, modelId)) {
    return {
      surchargeCredits: 0,
      inputBudgetMicroUsd: 0,
      inputTokens: null,
      option: {
        provider: "bfl", size: "1024x1024",
        minimumOutputCostMicroUsd: BFL_FLUX3_IMAGE_EDIT_COST[modelId as keyof typeof BFL_FLUX3_IMAGE_EDIT_COST],
      },
      verification: { verifiedAt: "2026-11-25", source: "https://bfl.ai/pricing?category=flux+3+image" },
    };
  }
  if (process.env.IMAGE_GOOGLE_EDIT_ENABLED === "true" && Object.hasOwn(GOOGLE_PHOTO_EDIT_COST, modelId)) {
    const { inputRate: rate, output } = GOOGLE_PHOTO_EDIT_COST[modelId as keyof typeof GOOGLE_PHOTO_EDIT_COST];
    // The actual Interactions edits of a public Studio PNG on 2026-11-25
    // reported 1,120 image tokens, above the preview countTokens estimate.
    // Reserve 2,048 for one reference fitted inside 1,024 px and keep the
    // model's existing measured output bound. Google publishes the direct
    // input rates below; gateway pricing does not apply to these calls.
    const maxTokens = 2_048;
    return {
      surchargeCredits: 0,
      inputBudgetMicroUsd: Math.ceil(maxTokens * rate),
      inputTokens: { maxTokens, usdPerMillionTokens: rate },
      option: { provider: "google", size: "1024x1024", quality: "medium", minimumOutputCostMicroUsd: output },
      verification: {
        verifiedAt: "2026-11-25",
        source: "https://ai.google.dev/gemini-api/docs/pricing",
        measuredMaxTokens: 1_120,
      },
    };
  }
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
export type ImageSize = (typeof CATALOG_IMAGE_SIZES)[number];
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
