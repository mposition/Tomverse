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

import { falEndpointProfile, type FalThinkingTerms } from "@/lib/falImageRequest";
import type { GoogleThinkingLevel } from "@/lib/googleImageRequest";
import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_PROMPT_BUDGET_MICRO_USD,
  imageEditPricing,
  type ImageQuality,
  type ImageSize,
} from "@/lib/imageGenerationPricing";

/**
 * Who we call, who bills us, and whose outage it is when a request fails.
 *
 * Every existing consumer of `provider` already means this one: the budget env
 * names (`IMAGE_PROVIDER_{P}_COST_*`), the adapter dispatch, the credential
 * lookup, provider health and readiness. Keeping the name attached to that
 * meaning is what makes adding a gateway safe -- nothing has to be re-read.
 */
export type ImageModelProvider = "openai" | "google" | "xai" | "fal" | "qwen";

/**
 * Who made the model, which is a different question and is about to stop having
 * the same answer.
 *
 * Nano Banana 2 is Google's model bought through fal: the card should say
 * Google, and the budget, credential, retry policy and failure attribution are
 * all fal's. One field cannot answer both without one of them being wrong, and
 * the wrong one would be silent -- a fal request drawing down
 * `IMAGE_PROVIDER_GOOGLE_COST_*` still adds up, it just adds up somewhere with
 * no money in it.
 *
 * The same alphabet as ImageModelProvider today. That is a coincidence of the
 * current roster, not a relationship, and the two are separate aliases so the
 * next reader has to decide which one they mean.
 */
export type ImageModelOwner = "openai" | "google" | "xai" | "fal" | "qwen";

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
  /** Who we call and who bills us. Drives budget, credential and readiness. */
  provider: ImageModelProvider;
  /**
   * Who made the model, when that is not the provider we buy it from.
   *
   * Omitted means they are the same, which is true of every direct integration
   * and keeps those entries saying exactly what they said before. Read it
   * through `imageModelOwner()` rather than directly, so the default lives in
   * one place.
   */
  modelOwner?: ImageModelOwner;
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
// Published prices are not enough on their own. Google's thinking cannot be
// switched off and no official maximum for text/thinking tokens is documented,
// so the worst case rests on measurement: see the reason below.
const GOOGLE_GEMINI_31_FLASH_IMAGE: ImageModelProfile = {
  id: "gemini-3.1-flash-image",
  provider: "google",
  apiModelId: "gemini-3.1-flash-image",
  name: "Gemini 3.1 Flash Image",
  lifecycle: "stable",
  // Per-image prices verified 2026-08-04. The thinking cap has no documented
  // basis: the 2026-08-05 documentation review closed that as a **checked
  // absence**, not an unchecked gap. The Interactions API reference defines
  // `generation_config.max_output_tokens` as the maximum tokens to include in
  // the response, and reports `usage.total_output_tokens` and
  // `usage.total_thought_tokens` as separate counters. The thinking guide
  // likewise describes the charge as output plus thinking and reports the two
  // apart. Neither states that the limit covers their sum -- and the model
  // card's output limit is a limit on the same undefined quantity, so it
  // cannot supply the link either. A forum answer or a search summary does not
  // meet policy §12's official-body requirement and is not admissible here.
  //
  // The 2026-08-14 run answered no for a strict ceiling: a request to
  // gemini-3.1-flash-lite-image with `max_output_tokens: 2048` reported 1,602
  // output plus 931 thinking -- 2,533 -- and returned a finished image.
  //
  // Re-measured 2026-11-12 on this model and Flash Lite (23 billed samples,
  // .github/audits/image-model-verification-worksheet.md section J), and the
  // owner decided on 2026-11-13 to price the measured bound with a margin
  // (GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS, below). The cap is therefore known and
  // what is missing is operational: approved sale credits, which arrive as a
  // catalogue price revision, and the Google provider budget.
  disabledReason: "operational_hold",
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
  // The limit the 2026-11-12 measurement sent, not the model card's 32,768:
  // the thinking cap below holds only for a request that sends this number
  // (GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS). A 1K image came back at 1,575-1,699
  // output tokens under it in 12 of 12 samples.
  maxOutputTokens: 2_048,
  priceVerification: {
    verifiedAt: "2026-08-04",
    sources: [
      "https://ai.google.dev/gemini-api/docs/pricing",
      "https://ai.google.dev/gemini-api/docs/image-generation",
      "https://ai.google.dev/gemini-api/docs/generate-content/tokens",
      "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image",
    ],
    // 2 x 2,048 tokens at $3.00 per 1M text output (GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS).
    thinkingCapMicroUsd: 12_288,
  },
  disabledNote:
    "Per-image price verified 2026-08-04: 1K $0.067. Thinking cap 12,288 microUSD: twice the 2,048 output limit the request sends, at $3.00 per 1M text output, from the 2026-11-12 measurement (owner decision 2026-11-13, measured bound with a margin). Policy floor 94 credits at 1K. Held until sale credits are approved as a catalogue price revision and the Google provider budget is set.",
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
// Thinking cannot be switched off. Its cap is the bound measured on
// 2026-11-12 with a margin (GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS), so the hold is
// operational: no sale credits are approved, hence no `prices`.
const GOOGLE_GEMINI_31_FLASH_LITE_IMAGE: ImageModelProfile = {
  id: "gemini-3.1-flash-lite-image",
  provider: "google",
  apiModelId: "gemini-3.1-flash-lite-image",
  name: "Gemini 3.1 Flash Lite Image",
  lifecycle: "stable",
  disabledReason: "operational_hold",
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
  // The limit the 2026-11-12 measurement sent, not the model card's 4,096
  // (GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS). At 1,536 the image itself (1,610
  // tokens) passed the limit, so this is not lowered further.
  maxOutputTokens: 2_048,
  priceVerification: {
    verifiedAt: "2026-08-04",
    sources: [
      "https://ai.google.dev/gemini-api/docs/pricing",
      "https://ai.google.dev/gemini-api/docs/image-generation",
      "https://ai.google.dev/gemini-api/docs/generate-content/tokens",
      "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image",
    ],
    // 2 x 2,048 tokens at $1.50 per 1M text output (GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS).
    thinkingCapMicroUsd: 6_144,
  },
  disabledNote:
    "Draft-tier candidate. Image output verified 2026-08-04 at $0.0336, 1K only. Thinking cap 6,144 microUSD: twice the 2,048 output limit the request sends, at $1.50 per 1M text output, from the 2026-11-12 measurement (owner decision 2026-11-13, measured bound with a margin). Policy floor 50 credits. Held until sale credits are approved as a catalogue price revision and the Google provider budget is set.",
};

// Nano Banana 2 -- Google's model, bought through fal rather than called
// directly. Registered, not enabled, and blocked on price verification only.
//
// The direct route is closed and will stay closed. The 2026-08-14 measurement
// showed `max_output_tokens` does not bound what Google bills
// (.github/audits/image-model-verification-worksheet.md §I), so a fixed price
// on a direct call would be a fixed price over an unbounded cost. Routing the
// same model through a gateway that sells it per successful image moves the
// variable part to someone whose business it is, and leaves Tomverse with the
// bounded_fixed contract every other image model here already has.
//
// So `provider` is fal and `modelOwner` is google, and the difference is not
// cosmetic. The budget this draws down is IMAGE_PROVIDER_FAL_COST_*, the
// credential is fal's, readiness checks fal, and an outage here is fal's
// gateway or Google's model and the two want telling apart. What the user sees
// is Google's model, with fal named in the detail view rather than hidden.
//
// Price read from fal's own published text on 2026-08-14, quoted in policy
// §16.4. The hold is `operational_hold` rather than `price_unverified`: the
// pricing question is closed, and what is missing is an adapter, a budget and
// an approved sale credit. `prices` stays empty until that credit is approved
// -- the reason is allowed to carry figures precisely so approved ones are
// validated, and putting an unapproved candidate there would be the entry
// asserting a decision nobody made.
const FAL_NANO_BANANA_2: ImageModelProfile = {
  id: "fal-ai/nano-banana-2",
  provider: "fal",
  modelOwner: "google",
  apiModelId: "fal-ai/nano-banana-2",
  name: "Nano Banana 2",
  shortName: "Nano Banana 2",
  lifecycle: "stable",
  // Enabled 2026-08-14, after one real generation through the adapter's own
  // request builder and response parser proved the seven things this entry
  // previously only believed: exactly one image, an asset on fal's CDN, a MIME
  // we may store, no redirect off the allowed host, a body inside the ceiling,
  // and -- the one that could not be assumed -- an image that is actually the
  // 1024x1024 that was priced. Evidence and the billed figure are in
  // .github/audits/evidence/fal-nano-banana-2-smoke/ and policy section 16.8.
  //
  // Enabling this row does not expose anything on its own: image generation as
  // a whole sits behind `feature.imageGenerationEnabled`, an AppSetting that is
  // off unless a row says exactly "true".
  disabledReason: null,
  // 1K only, deliberately, and not because the gateway is limited: a single
  // size is one price to verify, one worst case to state and one row to
  // explain. 2K and 4K are sold at multiples and can be added as their own
  // decisions once the first one is real.
  sizes: ["1024x1024"],
  // Same tier as Grok Imagine, which is the model it sits beside in the
  // picker. A single-tier model still has to say which shelf it is on.
  qualities: ["medium"],
  // 120 approved 2026-08-14 against a floor of 97. That is 725 microUSD per
  // credit, within a rounding error of Grok Imagine's 733 (55,000 over 75), so
  // the two neighbours carry the same headroom rather than one quietly
  // carrying less. 115 would have been 757 and harder to explain on screen.
  prices: [
    { quality: "medium", size: "1024x1024", credits: 120, outputCostMicroUsd: 80_000 },
  ],
  latencyClass: "balanced",
  // Inherited from the underlying Google model rather than asserted about the
  // gateway. Worth re-reading against a real response before this is enabled,
  // since what fal returns is what we would be storing and labelling.
  provenance: ["synthid"],
  outputMimeTypes: ["image/png", "image/jpeg"],
  pricingVersion: "fal-nano-banana-2-2026-08-14-v1",
  priceVerification: {
    verifiedAt: "2026-08-14",
    sources: [
      "https://fal.ai/models/fal-ai/nano-banana-2",
      "https://fal.ai/docs/documentation/model-apis/pricing",
    ],
    // 2,000 because the request asks for it, not as a safety margin. fal's
    // schema says of `thinking_level`: "When set, enables model thinking with
    // the given level ('minimal' or 'high') ... Omit to disable", and its
    // pricing says "If high thinking is used, an additional $0.002 will be
    // charged". The approved configuration sends `high`, so 2,000 is the
    // surcharge this integration intends to incur every time.
    //
    // Stated that way on purpose. A cap of 2,000 beside an adapter that omits
    // the field would price a request the product does not make, and a cap of
    // 0 beside an adapter that sends `high` would underprice the one it does.
    // The number and the request have to be one decision, which is why the
    // pinned field list lives in policy §16.5 rather than in the adapter alone.
    //
    // Web search is a separate surcharge ($0.015) and is deliberately not
    // folded in: it is not reasoning, and the request pins it off. That makes
    // it a property the adapter has to keep true, not a number to carry.
    thinkingCapMicroUsd: 2_000,
  },
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
    "Final-tier candidate. Per-image prices verified 2026-08-04: $0.134 (1K/2K) and $0.24 (4K). Blocked on the cap: no documented one exists (confirmed 2026-08-05) and this model was not in the 2026-11-12 measurement that bounded Flash and Flash Lite. The derivation is 393,216 microUSD (32,768 x $12.00/1M), which would put floors at 592 and 710 credits, well past gpt-image-2 Final at 250. Held a second time by product judgement regardless of the cap: the band overlaps gpt-image-2 Final, so the review defers it until usage shows Flash is insufficient.",
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

export type ImageComposerModelLayout = {
  compact: boolean;
  /** Rendered in the composer's own row, uncollapsed, with exact prices. */
  inline: readonly ImageModelProfile[];
  /** Rendered inside the picker. Empty whenever `compact` is false. */
  picker: readonly ImageModelProfile[];
};

/**
 * Which enabled models the composer shows where.
 *
 * Pure, and separate from the component, because the branch it decides cannot
 * be reached by an end-to-end test today: two models are enabled and the
 * threshold is three, so the compact rendering only appears once a fourth is
 * activated. A rule that ships untested until the day it matters is a rule
 * nobody can trust on that day, and enabling the three held Google models
 * would take the count straight from 2 to 5.
 *
 * Order follows the registry in both lists, so a model does not jump position
 * when it is selected -- it moves container, and that is the only change.
 */
export const imageComposerModelLayout = (
  models: readonly ImageModelProfile[],
  selectedModelIds: readonly string[]
): ImageComposerModelLayout => {
  const compact = shouldUseCompactImageModelPicker(models.length);
  if (!compact) return { compact, inline: models, picker: [] };
  const selected = new Set(selectedModelIds);
  return {
    compact,
    inline: models.filter((model) => selected.has(model.id)),
    picker: models.filter((model) => !selected.has(model.id)),
  };
};

/**
 * What to ask a provider to deliver for this model.
 *
 * One function rather than the expression written at each call site: the
 * adapter and the thinking-cap measurement script both build a Google request,
 * and when the adapter learned that Google only accepts `image/jpeg` the script
 * kept asking for PNG -- so the next measurement run would have failed exactly
 * as the first one did, for a reason already fixed.
 */
export const imageDeliveryMimeType = (model: ImageModelProfile): string =>
  model.deliveryMimeType ?? model.outputMimeTypes[0] ?? "image/png";

/** The composer's visual label for a model; identity stays `name`. */
export const imageModelChipLabel = (model: ImageModelProfile): string =>
  model.shortName ?? model.name;

export const IMAGE_MODEL_REGISTRY: readonly ImageModelProfile[] = [
  OPENAI_GPT_IMAGE_2,
  GOOGLE_GEMINI_31_FLASH_IMAGE,
  XAI_GROK_IMAGINE_IMAGE_QUALITY,
  GOOGLE_GEMINI_31_FLASH_LITE_IMAGE,
  GOOGLE_GEMINI_3_PRO_IMAGE,
  FAL_NANO_BANANA_2,
];

/** The default single selection and the v1 compatibility model. */
export const DEFAULT_IMAGE_MODEL_ID = OPENAI_GPT_IMAGE_2.id;

/**
 * Lookups over an explicit catalogue. Pure: nothing here reads module state, so
 * a client component can resolve against the list it was handed (the image
 * catalogue context, components/images/ImageModelCatalogProvider.tsx) without
 * touching the server-only global below.
 */
export const findImageModel = (
  models: readonly ImageModelProfile[],
  modelId: string
): ImageModelProfile | null =>
  models.find((model) => model.id === modelId) ?? null;

/**
 * Fail-closed price lookup. A disabled model, an unknown model, or an option
 * with no price returns null and the caller must reject the request -- never
 * fall back to another model's price.
 */
export const findImageModelPrice = (
  models: readonly ImageModelProfile[],
  modelId: string,
  quality: string,
  size: string
): ImageModelOptionPrice | null => {
  const model = findImageModel(models, modelId);
  if (!model || model.disabledReason !== null) return null;
  return (
    model.prices.find(
      (price) => price.quality === quality && price.size === size
    ) ?? null
  );
};

/**
 * The catalogue the server-side lookups below read. Starts as the code seed;
 * the server replaces it with the resolved catalogue (code seed +
 * ModelCatalogEntry rows + effective price revisions, lib/modelCatalog.ts). If
 * the database cannot be read, it stays the code seed.
 *
 * Server-only by contract: a browser must never write it. Client components
 * receive the catalogue the server rendered the page with through the image
 * catalogue context instead, because a module global is shared between server
 * requests and survives a prop going undefined.
 */
let activeImageModels: readonly ImageModelProfile[] = IMAGE_MODEL_REGISTRY;

export const setActiveImageModelCatalog = (models: readonly ImageModelProfile[]) => {
  activeImageModels = models;
};

export const resetActiveImageModelCatalog = () => {
  activeImageModels = IMAGE_MODEL_REGISTRY;
};

export const listImageModels = () => activeImageModels;

export const listEnabledImageModels = () =>
  activeImageModels.filter((model) => model.disabledReason === null);

export const getImageModel = (modelId: string): ImageModelProfile | null =>
  findImageModel(activeImageModels, modelId);

export const getImageModelPrice = (
  modelId: string,
  quality: string,
  size: string
): ImageModelOptionPrice | null =>
  findImageModelPrice(activeImageModels, modelId, quality, size);

/**
 * How a provider bills the thinking of one image request, and so whether the
 * request this code sends keeps it at or under `thinkingCapMicroUsd`.
 *
 * Code, not data. A price revision can *state* a cap; only the request the
 * adapter builds can *hold* it, and a cap nothing enforces is a reservation
 * the provider is free to exceed (section 12 condition 2).
 *
 *   - `not_billed`: no reasoning charge on an image request. OpenAI images and
 *     xAI, both verified 2026-08-04. A stated cap is a margin, never owed.
 *     Qwen (Model Studio International): billed per output image, and the
 *     price page states no separate thinking or prompt-rewrite charge for
 *     qwen-image (read 2026-11-07); `buildQwenImageRequest` also sends
 *     `prompt_extend: false`, which `enable_thinking` requires to be true. No
 *     Qwen model is seeded, so this applies only to a runtime catalogue row.
 *   - `flat_per_request`: a fixed surcharge for the thinking level the request
 *     pins. fal's Nano Banana 2 page: "If high thinking is used, an additional
 *     $0.002 will be charged" (re-read 2026-10-21), and that endpoint's row
 *     pins `high`. The surcharge cannot exceed its own price, and it is
 *     incurred on every request whether or not the response reports a
 *     thinking count -- fal reports none. So the cap is a bound only at or
 *     above that surcharge: below it, the request still spends the full
 *     amount.
 *   - `per_token_uncapped`: billed per thinking token with no request
 *     parameter that bounds the count. Google direct: thinking "is enabled by
 *     default and cannot be disabled in the API"; `thinking_level` is a level
 *     ("relative allowances for thinking rather than strict token
 *     guarantees"); and `max_output_tokens: 2048` billed 2,533 output+thinking
 *     on gemini-3.1-flash-lite-image on 2026-08-14 (policy section 12.1). The
 *     thinking guide updated 2026-10-14 now calls `max_output_tokens` a hard
 *     cutoff including thought tokens, which is the opposite of that
 *     measurement; until a new measurement settles it, it is not a bound.
 *     This is what a Google model with no row in
 *     GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS still is.
 *   - `per_token_within_output_limit`: billed per token, and the output limit
 *     the request sends holds the count. Only a Google direct model listed in
 *     GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS, and only while its request sends that
 *     row's limit and no thinking level.
 *
 * fal answers per endpoint, not per provider: its row in
 * FAL_ENDPOINT_PROFILES (lib/falImageRequest.ts) says which of the first three
 * it is -- google/nano-banana-2.1 is `per_token_uncapped` -- and an endpoint
 * with no row has no answer.
 */
export type ImageThinkingBilling =
  | "not_billed"
  | "flat_per_request"
  | "per_token_uncapped"
  | "per_token_within_output_limit";

/**
 * Google direct image models whose billable text and thinking the request's
 * `max_output_tokens` was measured to hold, keyed by `apiModelId`.
 *
 * Owner decision 2026-11-13 (policy section 12.1): the worst case is the
 * measured bound with a margin, not a documented strict ceiling.
 *
 *   - 2026-11-12, 23 billed samples on these two models at 1K square
 *     (.github/audits/image-model-verification-worksheet.md section J): with
 *     thinking forced to `high` and the limit at 2,048, output plus thinking
 *     stayed at or under the limit in 10 of 10 and the request stopped without
 *     an image; with the level omitted, 12 of 12 reported zero thinking and
 *     1,575-1,699 output. The one sample over a limit (1,610 at 1,536) carried
 *     its image: an image is emitted whole, so it can pass the limit, and its
 *     price is the option's `outputCostMicroUsd`, not thinking.
 *   - 2026-08-14 the same parameter held thinking alone under the limit and
 *     counted output beside it (1,602 + 931 at 2,048).
 *
 * Both readings keep the tokens that are not the image at or under twice the
 * limit, so the cap is that many tokens at the model's text output rate (the
 * rate thinking is billed at). `maxOutputTokens` is the limit the measurement
 * sent; a request that sends another, or pins a thinking level, is not the one
 * that was measured (`imageThinkingCapEnforced`). gemini-3-pro-image has no
 * row: it was not measured.
 */
export const GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS: Readonly<
  Record<string, { maxOutputTokens: number; textOutputUsdPerMTok: number; imageTokensPerImage: number }>
> = {
  // imageTokensPerImage: what one 1K image is billed as, from the usage the
  // measurement read (`output_tokens_by_modality` image: 1,120 on every
  // delivered sample, worksheet sections I and J). Settlement prices billed
  // image tokens in units of it, so a response that carried more than one image
  // is not settled as one.
  "gemini-3.1-flash-image": { maxOutputTokens: 2_048, textOutputUsdPerMTok: 3, imageTokensPerImage: 1_120 },
  "gemini-3.1-flash-lite-image": { maxOutputTokens: 2_048, textOutputUsdPerMTok: 1.5, imageTokensPerImage: 1_120 },
};

/** Non-image billable tokens are held at this many times the limit sent. */
export const GOOGLE_IMAGE_OUTPUT_LIMIT_MARGIN = 2;

/** The measured row for a Google direct model, or null (also for a prototype key). */
export const googleImageOutputLimitBound = (provider: unknown, apiModelId: unknown) =>
  provider === "google" && typeof apiModelId === "string" && Object.hasOwn(GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS, apiModelId)
    ? GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS[apiModelId]
    : null;

type ImageThinkingTerms =
  | FalThinkingTerms
  | { billing: "per_token_within_output_limit"; capMicroUsd: number };

const IMAGE_PROVIDER_THINKING_BILLING: Readonly<
  Record<
    Exclude<ImageModelProvider, "fal">,
    Exclude<ImageThinkingBilling, "flat_per_request" | "per_token_within_output_limit">
  >
> = {
  openai: "not_billed",
  xai: "not_billed",
  google: "per_token_uncapped",
  qwen: "not_billed",
};

/**
 * The models of a `not_billed` provider whose per-image billing was read for
 * that family only. Qwen's price page bills the qwen-image models per image
 * with no thinking or prompt-rewrite charge (read 2026-11-07), but the same
 * endpoint serves other models -- the page prices prompt_extend separately
 * for z-image-turbo -- so another Qwen model has no proven bound until its
 * billing is read and listed here.
 */
const IMAGE_PER_IMAGE_BILLED_MODELS: Readonly<Partial<Record<ImageModelProvider, RegExp>>> = {
  qwen: /^qwen-image-/,
};

/** The terms for this model's request: per endpoint on fal, per provider elsewhere. */
const imageThinkingTerms = (provider: unknown, apiModelId: unknown): ImageThinkingTerms | null => {
  if (provider === "fal") return falEndpointProfile(apiModelId)?.thinking ?? null;
  const bound = googleImageOutputLimitBound(provider, apiModelId);
  if (bound) {
    return {
      billing: "per_token_within_output_limit",
      // Tokens times USD per million tokens is micro-USD.
      capMicroUsd: Math.ceil(GOOGLE_IMAGE_OUTPUT_LIMIT_MARGIN * bound.maxOutputTokens * bound.textOutputUsdPerMTok),
    };
  }
  // A family read as per-image is not a bound on the provider's other models.
  const family =
    typeof provider === "string" && Object.hasOwn(IMAGE_PER_IMAGE_BILLED_MODELS, provider)
      ? IMAGE_PER_IMAGE_BILLED_MODELS[provider as ImageModelProvider]
      : undefined;
  if (family && typeof apiModelId === "string" && !family.test(apiModelId)) return null;
  return typeof provider === "string" && Object.hasOwn(IMAGE_PROVIDER_THINKING_BILLING, provider)
    ? { billing: IMAGE_PROVIDER_THINKING_BILLING[provider as keyof typeof IMAGE_PROVIDER_THINKING_BILLING] }
    : null;
};

/** Null for a provider this code has no adapter for, and for an unlisted fal endpoint. */
export const imageThinkingBilling = (
  provider: unknown,
  apiModelId?: unknown
): ImageThinkingBilling | null => imageThinkingTerms(provider, apiModelId)?.billing ?? null;

/**
 * The smallest stated cap that bounds what this model's request spends on
 * thinking: 0 where thinking is not billed, the pinned level's surcharge
 * where it is flat, the measured token bound at the text rate for a Google
 * model in GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS, and null where no stated cap can
 * bound it -- including a fal model whose endpoint has no row, or that names
 * no endpoint at all.
 */
export const imageThinkingCapMinimumMicroUsd = (
  provider: unknown,
  apiModelId?: unknown
): number | null => {
  const terms = imageThinkingTerms(provider, apiModelId);
  if (terms?.billing === "not_billed") return 0;
  if (terms?.billing === "flat_per_request") return terms.surchargeMicroUsd;
  if (terms?.billing === "per_token_within_output_limit") return terms.capMicroUsd;
  return null;
};

/**
 * Whether the request this model would be sent cannot spend more on thinking
 * than its stated cap. False for an unknown cap; false for a stated cap on a
 * provider whose thinking the request cannot bound -- an operator revision can
 * write a number for an unmeasured Google model, and that number is not a
 * bound; false for a cap below the flat surcharge the request incurs anyway;
 * and false for a measured Google model whose request is not the measured one
 * (another output limit, or a pinned thinking level).
 */
export const imageThinkingCapEnforced = (
  model: Pick<
    ImageModelProfile,
    "provider" | "apiModelId" | "priceVerification" | "maxOutputTokens" | "thinkingLevel"
  >
): boolean => {
  const cap = model.priceVerification.thinkingCapMicroUsd;
  if (cap === null) return false;
  const minimum = imageThinkingCapMinimumMicroUsd(model.provider, model.apiModelId);
  if (minimum === null || cap < minimum) return false;
  const bound = googleImageOutputLimitBound(model.provider, model.apiModelId);
  return !bound || (model.maxOutputTokens === bound.maxOutputTokens && !model.thinkingLevel);
};

/**
 * Worst legitimate provider cost of one request: image output plus the full
 * prompt budget plus the model's proven thinking cap. Returns null when the
 * cap is unknown, or stated but not enforceable by the request -- an unbounded
 * worst case cannot carry a fixed price (section 12 conditions 1 and 2).
 */
export const maxImageRequestCostMicroUsd = (
  model: ImageModelProfile,
  price: ImageModelOptionPrice
): number | null => {
  const thinkingCap = model.priceVerification.thinkingCapMicroUsd;
  if (thinkingCap === null) return null;
  if (!imageThinkingCapEnforced(model)) return null;
  return price.outputCostMicroUsd + IMAGE_PROMPT_BUDGET_MICRO_USD + thinkingCap;
};

/**
 * Worst legitimate cost of an edit: the generation's worst case plus the
 * model's budget for the downscaled photo it is sent. Null wherever the
 * generation's is, and for a model that cannot edit.
 */
export const maxImageEditRequestCostMicroUsd = (
  model: ImageModelProfile,
  price: ImageModelOptionPrice
): number | null => {
  const edit = imageEditPricing(model.id);
  const generation = maxImageRequestCostMicroUsd(model, price);
  return generation === null || edit === null ? null : generation + edit.inputBudgetMicroUsd;
};

/**
 * What an edit of this option charges, or null when the model cannot edit or
 * the edit's worst case would break the per-credit ceiling. Checked on the
 * live price, because a catalogue revision can lower an option's credits to a
 * value the generation still carries and the edit's photo does not.
 */
export const imageEditCredits = (
  model: ImageModelProfile,
  price: ImageModelOptionPrice
): number | null => {
  const edit = imageEditPricing(model.id);
  const worst = maxImageEditRequestCostMicroUsd(model, price);
  if (!edit || worst === null) return null;
  const credits = price.credits + edit.surchargeCredits;
  return credits > 0 && worst / credits <= IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD ? credits : null;
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

/**
 * The brand behind a model.
 *
 * Deliberately not defaulted at each call site: a missing owner means "same as
 * the provider", and spelling that out repeatedly is how one call site ends up
 * defaulting differently from the others.
 */
export const imageModelOwner = (model: ImageModelProfile): ImageModelOwner =>
  model.modelOwner ?? model.provider;

/**
 * What a model's subtitle has to say: whose model it is, and -- only when that
 * differs -- who supplies it.
 *
 * Split out from the rendering because the presentational bug it exists to
 * prevent is not about labels being missing. The catalogue row showed
 * `provider`, which reads correctly for every direct integration because owner
 * and provider are the same string there, and became wrong the moment they
 * were not: Nano Banana 2 is Google's model bought through fal, and the row
 * either credited the wrong company or -- as it actually did -- printed
 * nothing at all.
 *
 * `gateway` is null when there is nothing extra to say, so a caller cannot
 * render "OpenAI via OpenAI".
 */
export const imageModelBrandParts = (model: ImageModelProfile) => {
  const owner = imageModelOwner(model);
  return {
    owner,
    gateway: owner === model.provider ? null : model.provider,
  } as const;
};

/** The providers that have at least one enabled model right now. */
export const listActiveImageProviders = (): readonly ImageModelProvider[] => [
  ...new Set(listEnabledImageModels().map((model) => model.provider)),
];
