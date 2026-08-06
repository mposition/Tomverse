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

import type { GoogleThinkingLevel } from "@/lib/googleImageRequest";
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
  /** Display name for the picker and every place with room for it. */
  name: string;
  /**
   * A shorter label for the composer's selection chips, where the name sits
   * beside a credit badge and competes with the quality and size rows for one
   * line. Omitted means the full name already fits.
   *
   * The full name is what the picker shows and what the accessible name uses:
   * this abbreviates the visual label, never the identity.
   */
  shortName?: string;
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
  /**
   * What to ask the provider to deliver, when its API takes that as a request
   * parameter.
   *
   * Deliberately NOT `outputMimeTypes[0]`. That list is the *storage*
   * allowlist -- what the adapter may write down unmodified -- and reading it
   * as a request preference is how every Google request went out asking for
   * PNG, which its API rejects outright:
   *
   *   "The value 'image/png' is not supported for
   *    'response_format.mime_type'. Supported values: 'image/jpeg'."
   *   (observed from the API itself, 2026-08-06)
   *
   * A request, never an assumption: the response's own MIME is still what
   * gets recorded, and the storage allowlist stays as permissive as the
   * provider's documented outputs.
   */
  deliveryMimeType?: string;
  /**
   * The version of *this model's* price list.
   *
   * Per model rather than one global string, because a global one splits every
   * model's metrics whenever any model's price moves: adding xAI would have
   * started a new version for gpt-image-2 reservations whose price had not
   * changed by a cent. A reservation freezes the version of the model it was
   * priced by, so a price change to one model leaves every other model's
   * history continuous.
   */
  pricingVersion: string;
  priceVerification: ImageModelPriceVerification;
  /**
   * The model's documented output-token limit, sent on every request that
   * takes one.
   *
   * **Not a cost bound.** It is the number the provider publishes for the
   * model, and sending it is how the server avoids leaving a billable
   * parameter unset. Whether it also bounds hidden thinking is a separate
   * question, answered by `priceVerification.thinkingCapMicroUsd` -- which is
   * null for every model here that has one of these. Reading this field as
   * the cap is the mistake it is worded to prevent.
   */
  maxOutputTokens?: number;
  /**
   * Google's thinking level, per model because support is not uniform.
   * Absent omits the field: sending a parameter to a model whose acceptance of
   * it has not been verified fails in a way that reads like an outage.
   */
  thinkingLevel?: GoogleThinkingLevel;
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
  // Deliberately the string reservations already carry: this model's prices
  // have not moved, so its metrics must not gain a boundary.
  pricingVersion: "2026-08-03-v1",
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
  // Per-image prices verified 2026-08-04; the thinking cap is not established,
  // so the worst case is not provably finite and no fixed credit price can be
  // derived. That is what this reason states.
  //
  // As of the 2026-08-05 documentation review this is a **checked absence**,
  // not an unchecked gap. The Interactions API reference defines
  // `generation_config.max_output_tokens` as the maximum tokens to include in
  // the response, and reports `usage.total_output_tokens` and
  // `usage.total_thought_tokens` as separate counters. The thinking guide
  // likewise describes the charge as output plus thinking and reports the two
  // apart. Neither states that the limit covers their sum -- and the model
  // card's output limit is a limit on the same undefined quantity, so it
  // cannot supply the link either. A forum answer or a search summary does not
  // meet policy §12's official-body requirement and is not admissible here.
  //
  // What settles it is the billing signal, not more prose: a staging run that
  // sets `max_output_tokens` and shows `total_output_tokens +
  // total_thought_tokens` staying at or under it, including at a limit low
  // enough to actually bite. That run costs money and needs the §15 budget
  // approval first.
  disabledReason: "worst_case_cost_unbounded",
  // 512, 2K and 4K are advertised upstream but have no representation in
  // ImageSize yet, and Google's 1K landscape is not 1536x1024 -- a provider
  // resolution mapping is part of enabling this model, not of registering it.
  sizes: ["1024x1024"],
  qualities: ["medium"],
  prices: [],
  latencyClass: "fast",
  provenance: ["synthid"],
  outputMimeTypes: ["image/png", "image/jpeg"],
  // The only value its API accepts for response_format.mime_type,
  // established by the API rejecting image/png on 2026-08-06.
  deliveryMimeType: "image/jpeg",
  pricingVersion: "google-gemini-3-1-flash-image-2026-08-04-v1",
  // The model card's own output limit, sent on every request. It bounds
  // what is asked for; whether it also bounds hidden thinking is the open
  // question that keeps this model disabled -- see thinkingCapMicroUsd.
  maxOutputTokens: 32_768,
  priceVerification: {
    verifiedAt: "2026-08-04",
    sources: [
      "https://ai.google.dev/gemini-api/docs/pricing",
      "https://ai.google.dev/gemini-api/docs/image-generation",
      "https://ai.google.dev/gemini-api/docs/generate-content/tokens",
      "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image",
    ],
    thinkingCapMicroUsd: null,
  },
  disabledNote:
    "Per-image prices verified 2026-08-04: 0.5K $0.045 / 1K $0.067 / 2K $0.101 / 4K $0.151. GA id corrected from the preview retired 2026-06-25. BLOCKED ON THE CAP, NOT THE PRICE. The 2026-08-05 documentation review closed this as a checked absence rather than an unread page: the Interactions API reference defines max_output_tokens as the maximum tokens to include in the response and reports total_output_tokens and total_thought_tokens as separate counters, and the thinking guide describes the charge as their sum without stating that the limit covers it. The model card's 32,768 output limit bounds the same undefined quantity, so it cannot supply the link either. The conservative derivation (32,768 x $3.00/1M = 98,304 microUSD, floors 190 / 228 / 283 credits) therefore stays an inference. Unblocked by measurement, not by more prose: a staging run that sets max_output_tokens and shows total_output_tokens + total_thought_tokens staying under it, including at a limit low enough to bite. That run is billable and needs the section 15 budget approval. The Interactions adapter is implemented and unreachable while this hold stands.",
};

// Price VERIFIED 2026-08-04, held on operational grounds.
//
// The strongest candidate in the model review, and the only one whose pricing
// question is fully settled: flat per-image pricing with no prompt-token and
// no reasoning-token charge, so `thinkingCapMicroUsd` is genuinely 0 rather
// than unknown. What is missing is execution, not knowledge -- hence
// `operational_hold` rather than `price_unverified`.
//
// ENABLED 2026-08-05. The second provider, and the first real cross-provider
// comparison the feature was built for.
//
// A dated snapshot rather than `-latest`, for the same reason chat profiles
// pin one: a moving target cannot carry a fixed price, because the price is
// only meaningful for the model that was actually verified.
//
// Price verified 2026-08-04: $0.05 (1K) and $0.07 (2K) per image, flat
// regardless of prompt length, with no prompt-token or reasoning-token charge.
// Sale credits approved 2026-08-04 at 75 (1K), against a policy floor of 62 --
// 733 microUSD per credit worst case, 18.5% under the 900 ceiling. The floors
// are computed over the whole request (image output + full prompt budget +
// the zero thinking cap), not over the image price alone.
//
// Only 1K square ships. xAI's 2K is approved at 100 credits (floor 84) and
// stays out until the size system grows a resolution tier: buildXaiImageRequest
// refuses every size it has no mapping for rather than sending a resolution the
// approved credits were not priced for. 1024x1024 is also the honest comparison
// against gpt-image-2's square.
//
// The operational hold this replaces was cleared by, in order: the adapter
// (lib/xaiImageRequest.ts), then IMAGE_PROVIDER_XAI_COST_MICROUSD_PER_DAY and
// _PER_MONTH deployed to both environments ahead of this commit -- env first,
// code second, because /api/ready fails a flag-on environment whose active
// provider has no budget the moment this line changes.
const XAI_GROK_IMAGINE_IMAGE_QUALITY: ImageModelProfile = {
  id: "grok-imagine-image-quality-20260403",
  provider: "xai",
  apiModelId: "grok-imagine-image-quality-20260403",
  name: "Grok Imagine Image Quality",
  shortName: "Grok Imagine",
  lifecycle: "stable",
  disabledReason: null,
  sizes: ["1024x1024"],
  qualities: ["medium"],
  prices: [
    {
      quality: "medium",
      size: "1024x1024",
      credits: 75,
      outputCostMicroUsd: 50_000,
    },
  ],
  latencyClass: "balanced",
  // Verified absent, not merely unread: the 2026-08-04 verification found no
  // watermark, C2PA or metadata guarantee anywhere in xAI's documentation.
  // Claiming provenance a file does not carry would be worse than claiming
  // none.
  provenance: [],
  outputMimeTypes: ["image/jpeg", "image/png"],
  pricingVersion: "xai-grok-imagine-2026-08-04-v1",
  priceVerification: {
    verifiedAt: "2026-08-04",
    sources: [
      "https://docs.x.ai/developers/models/grok-imagine-image-quality",
      "https://docs.x.ai/developers/model-capabilities/imagine",
      "https://docs.x.ai/developers/model-capabilities/images/generation",
      "https://docs.x.ai/developers/rest-api-reference/inference/images",
    ],
    // Flat per-image pricing regardless of prompt length, with no separate
    // reasoning charge. Verified, not assumed.
    thinkingCapMicroUsd: 0,
  },
};

// Registered, not enabled. The review's low-cost bulk candidate: 1K only, and
// cheap enough that it is the natural Draft-tier model rather than a second
// headline slot -- two Google models would fill both comparison seats with one
// provider's failure modes, which is the opposite of what a comparison is for.
//
// Blocked by the same condition as every Google image model here: thinking
// cannot be switched off and no official token cap is established, so the
// worst case is not provably finite. The reported ~US$0.0336 image output is
// in the note, not in `prices`.
const GOOGLE_GEMINI_31_FLASH_LITE_IMAGE: ImageModelProfile = {
  id: "gemini-3.1-flash-lite-image",
  provider: "google",
  apiModelId: "gemini-3.1-flash-lite-image",
  name: "Gemini 3.1 Flash Lite Image",
  lifecycle: "stable",
  disabledReason: "worst_case_cost_unbounded",
  sizes: ["1024x1024"],
  qualities: ["low"],
  prices: [],
  latencyClass: "fast",
  // Verified 2026-08-04: this model carries C2PA in addition to SynthID, which
  // the other two do not.
  provenance: ["synthid", "c2pa"],
  outputMimeTypes: ["image/png", "image/jpeg"],
  // The only value its API accepts for response_format.mime_type,
  // established by the API rejecting image/png on 2026-08-06.
  deliveryMimeType: "image/jpeg",
  pricingVersion: "google-gemini-3-1-flash-lite-image-2026-08-04-v1",
  // The model card's own output limit, sent on every request. It bounds
  // what is asked for; whether it also bounds hidden thinking is the open
  // question that keeps this model disabled -- see thinkingCapMicroUsd.
  maxOutputTokens: 4_096,
  priceVerification: {
    verifiedAt: "2026-08-04",
    sources: [
      "https://ai.google.dev/gemini-api/docs/pricing",
      "https://ai.google.dev/gemini-api/docs/image-generation",
      "https://ai.google.dev/gemini-api/docs/generate-content/tokens",
      "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image",
    ],
    thinkingCapMicroUsd: null,
  },
  disabledNote:
    "Draft-tier candidate. Image output verified 2026-08-04 at $0.0336, 1K only (2K and 4K unsupported). Blocked on the same cap as every Google image model here, confirmed absent from the official documentation on 2026-08-05 rather than merely unread. The conservative derivation is 6,144 microUSD (4,096 output tokens x $1.50/1M), giving a floor of 50 credits -- an inference, not a documented cap. Its 4,096 limit makes it the most informative model to measure first: a low ceiling is the one likely to actually bite, and a run that never approaches the limit proves nothing about whether the limit is enforced. Even once unblocked, the review advises against filling a second comparison seat with a second Google model.",
};

// Registered, not enabled. The professional-tier candidate.
//
// The review recommends holding this one back even after the Google cap is
// established: its price band overlaps gpt-image-2 Final, so shipping it at
// launch buys little, and the case for it is a Pro/Max Final-only slot decided
// from real usage data showing Flash is not enough. Registered anyway, because
// a candidate the product has decided about reads better as a stated hold than
// as an absence -- that is what the catalogue's hold row is for.
const GOOGLE_GEMINI_3_PRO_IMAGE: ImageModelProfile = {
  id: "gemini-3-pro-image",
  provider: "google",
  apiModelId: "gemini-3-pro-image",
  name: "Gemini 3 Pro Image",
  lifecycle: "stable",
  disabledReason: "worst_case_cost_unbounded",
  sizes: ["1024x1024"],
  qualities: ["high"],
  prices: [],
  latencyClass: "slow",
  provenance: ["synthid"],
  outputMimeTypes: ["image/png", "image/jpeg"],
  // The only value its API accepts for response_format.mime_type,
  // established by the API rejecting image/png on 2026-08-06.
  deliveryMimeType: "image/jpeg",
  pricingVersion: "google-gemini-3-pro-image-2026-08-04-v1",
  // The model card's own output limit, sent on every request. It bounds
  // what is asked for; whether it also bounds hidden thinking is the open
  // question that keeps this model disabled -- see thinkingCapMicroUsd.
  maxOutputTokens: 32_768,
  priceVerification: {
    verifiedAt: "2026-08-04",
    sources: [
      "https://ai.google.dev/gemini-api/docs/pricing",
      "https://ai.google.dev/gemini-api/docs/image-generation",
      "https://ai.google.dev/gemini-api/docs/generate-content/tokens",
      "https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image",
    ],
    thinkingCapMicroUsd: null,
  },
  disabledNote:
    "Final-tier candidate. Per-image prices verified 2026-08-04: $0.134 (1K/2K) and $0.24 (4K). Blocked on the cap like the other Google models, confirmed absent from the official documentation on 2026-08-05. The derivation is 393,216 microUSD (32,768 x $12.00/1M), which would put floors at 592 and 710 credits, well past gpt-image-2 Final at 250. Held a second time by product judgement regardless of the cap: the band overlaps gpt-image-2 Final, so the review defers it until usage shows Flash is insufficient.",
};

/**
 * How many enabled models the composer will lay out inline before the
 * unselected ones move behind a picker.
 *
 * Deliberately separate from IMAGE_GROUP_MAX_MODELS, which bounds how much
 * provider work one request may start. This is an information-density
 * decision about one row of UI, and conflating the two would let an execution
 * limit silently restyle the composer.
 *
 * Three, because at two or three the second and third models are discoverable
 * without a click -- and multi-model comparison is the product, so a viewer
 * who never learns a second model exists has not been shown the feature. From
 * four the model row starts taking more space than the quality, size and
 * prompt rows it sits above.
 */
export const IMAGE_INLINE_MODEL_DISCOVERY_LIMIT = 3;

/**
 * Whether the composer collapses the *unselected* models into a picker.
 *
 * Decided by the number of enabled models, never by viewport, never by how
 * many are selected, and never by measuring wrapped lines. A viewport-driven
 * switch gives the same account a different information structure per device
 * and re-shapes the composer mid-rotation; a selection-driven one changes
 * structure while the user is choosing. The selected models and their exact
 * credits are inline in **both** modes -- only the editing list moves.
 */
export const shouldUseCompactImageModelPicker = (
  enabledModelCount: number
): boolean =>
  enabledModelCount > IMAGE_INLINE_MODEL_DISCOVERY_LIMIT;

/** The composer's visual label for a model; identity stays `name`. */
export const imageModelChipLabel = (model: ImageModelProfile): string =>
  model.shortName ?? model.name;

export const IMAGE_MODEL_REGISTRY: readonly ImageModelProfile[] = [
  OPENAI_GPT_IMAGE_2,
  GOOGLE_GEMINI_31_FLASH_IMAGE,
  XAI_GROK_IMAGINE_IMAGE_QUALITY,
  GOOGLE_GEMINI_31_FLASH_LITE_IMAGE,
  GOOGLE_GEMINI_3_PRO_IMAGE,
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
