// Model pricing registry.
//
// Every price this application charges internally is declared here, per model
// *and per request path*, together with where the number came from and when it
// took effect. Before this registry existed, pricing was a three-bucket
// `standard | advanced | premium` default table, so four different premium
// models (GPT-5.5, GPT-5.5 Thinking, Gemini 3.1 Pro, Claude Opus 4.8) were all
// billed internally at US$15 input / US$60 output per million tokens -- 3x to
// 7.5x their real list price. Combined with a per-user daily USD ceiling, that
// blocked paying users who still had thousands of plan credits.
//
// Rules this file exists to enforce:
//
//   1. A price is attached to the *routing path actually used*, not to a model
//      name. `routing`/`processingTier` record which path the number is for.
//      Today every provider is called directly, at standard processing tier,
//      through the first-party endpoints in lib/modelRegistryShared.ts -- there
//      is no OpenRouter/relay hop, no priority or flex tier, and no regional or
//      data-residency endpoint. If that ever changes, the entry must change
//      with it rather than keeping list pricing.
//   2. Long-context tiers are explicit. A model whose price steps up past a
//      prompt-size threshold declares every tier, and the tier is chosen from
//      the estimated prompt size.
//   3. The generic class defaults are a *conservative fallback for unknown
//      models only*. `findUnpricedModels()` reports any enabled model without
//      an explicit profile so CI and startup can fail or warn instead of
//      silently mispricing a newly enabled premium model.
//   4. Price changes are versioned, never retroactive. `pricingVersion` and
//      `costSource` are stored on each reservation/settlement snapshot, so an
//      existing UsageBucket is never recomputed when this table changes.

import type { AiProvider, AiModel, ModelUsageClass } from "@/lib/models";

export type ModelPricingRouting = "direct_provider_api" | "relay";

export type ModelProcessingTier =
    | "standard"
    | "priority"
    | "flex"
    | "batch";

/**
 * How a provider bills reasoning/thinking tokens. `billed_as_output` means the
 * provider's reported `outputTokens` already includes them, so the output rate
 * covers them and no separate line is needed -- it only affects how much output
 * headroom the reservation must carry.
 */
export type ReasoningTokenBilling =
    | "billed_as_output"
    | "billed_separately"
    | "not_billed";

export type ModelPriceTier = {
    /**
     * Highest prompt size (input tokens) this tier covers. `null` means the
     * tier has no upper bound and is the last one.
     */
    maxPromptTokens: number | null;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    /**
     * Cached-input price as a fraction of the uncached input price. Left at 1
     * (full price) whenever the provider's cache discount is not verified for
     * this exact model -- never understating cost is the conservative default.
     */
    cachedInputPriceMultiplier: number;
    /**
     * The provider's published price for *writing* an entry into the prompt
     * cache -- billed, where a write count exists to bill.
     *
     * This was audit-only until Anthropic prompt caching was turned on
     * (docs/policy/anthropic-prompt-caching.md). The reason it could not be
     * billed was not a pricing question: cache reads and cache writes are
     * separate lines on every provider's list, and only the read had a token
     * count anywhere in this application. No adapter reported writes, and
     * deriving a write count from a read count would have been inventing a
     * number.
     *
     * The Anthropic adapter now reports one --
     * `usage.inputTokenDetails.cacheWriteTokens`, from the API's own
     * `cache_creation_input_tokens` -- so for a model with this rate the write
     * is priced from a measurement rather than an estimate. See
     * `CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED`.
     *
     * `undefined` means the provider publishes no separate cache-write price
     * for this model, or none has been verified. It never means zero, and it
     * never means free: `lib/providerUsageCost.ts` refuses to price writes at
     * an absent rate and reports the tokens it could not price, so an
     * unverified rate shows up as a stated gap rather than as a discount.
     */
    cacheWriteUsdPerMillionTokens?: number;
};

/**
 * Restates, in one place a test can assert against, the rule that replaced
 * `CACHE_WRITE_PRICING_IS_RECORDED_NOT_BILLED`: a cache write is billed when,
 * and only when, both halves exist -- a verified rate on the tier *and* a
 * write-token count from the provider.
 *
 * Both halves, because either alone is a fabrication. A rate with no count
 * would have to guess how much of the prompt was written; a count with no rate
 * would have to guess what the write cost. The old flag said "never bill",
 * which was the right answer while no adapter reported a count at all and the
 * wrong one the moment the Anthropic adapter did -- a turn that writes its
 * whole prompt to cache costs 1.25x its input, and recording 1.0x is a silent
 * 25% undercount on exactly the requests this feature creates.
 *
 * A model with no verified rate is unchanged by this: its writes still cost
 * nothing in the ledger, but `providerUsageCost` now says so out loud through
 * `unpricedCacheWriteTokens` instead of the fact being implicit in a constant.
 */
export const CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED = true;

/**
 * The 5-minute cache-write premium, as a multiple of the base input rate.
 *
 * Held here as the *check* on the published per-model rates rather than as the
 * thing that computes them: every rate in this file is read off Anthropic's
 * price table, and `npm run check:model-pricing` asserts each declared write
 * rate equals its tier's input rate times this. Deriving the rate instead
 * would make the registry state a multiplier Anthropic could change without
 * anybody noticing, which is the failure mode the whole file is built against.
 *
 * The 1-hour TTL's 2x premium is deliberately absent. Nothing in this
 * application requests a 1-hour cache
 * (`lib/anthropicPromptCaching.ts`), so a constant for it would be a rate with
 * no request path -- and the first thing a reader would do with it is use it.
 */
export const PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER = 1.25;

/** Cache reads cost this multiple of the base input rate, on every provider
 * whose discount is verified here. Stated for the same reason as the write
 * multiplier: it checks the per-model `cachedInputPriceMultiplier` values
 * rather than replacing them. */
export const PROMPT_CACHE_READ_PRICE_MULTIPLIER = 0.1;

/**
 * One dated revision of a model's rates.
 *
 * A price change is a *fact with a date*, and until this existed the registry
 * could only hold the price that is true today. That left two bad options for
 * a change announced in advance: write the future number now (and bill it
 * before it takes effect) or write nothing (and bill the old number after it
 * stops being true). Both were reachable, and the second is what
 * `tests/modelPricing.test.mjs` had to guard against with a date-triggered
 * failure -- a build that breaks on a calendar day, because nothing else in
 * the system notices a price change.
 *
 * A schedule entry is neither. It is inert until `effectiveFrom`, and from
 * that instant it is what `resolveModelPricing` returns -- with its own
 * `pricingVersion`, so a reservation taken before the change and one taken
 * after are distinguishable in the ledger for ever.
 *
 * Never retroactive: an entry only ever describes requests at or after its
 * own instant. Stored reservation and settlement snapshots are not re-priced
 * by adding one, because they already carry the rates and the
 * `pricingVersion` they were taken at.
 */
export type ScheduledModelPrice = {
    /**
     * The UTC instant the rates below start applying, RFC 3339 with an
     * explicit `Z`.
     *
     * An instant rather than a date because a boundary needs a side: a request
     * at exactly this moment is priced by this entry, and one a millisecond
     * earlier by whatever came before. UTC because every other time boundary
     * in this system is UTC -- `ChatUsageBucket` periods, `ProviderDailyUsage`
     * days (`rollupDayOf`), and the provider usage and cost APIs this
     * reconciles against. A local-time price boundary would put a settlement
     * and its rollup on opposite sides of a change.
     */
    effectiveFrom: string;
    /** Ordered ascending by `maxPromptTokens`; the last entry has `null`. */
    tiers: readonly ModelPriceTier[];
    priceSource: string;
    pricingVersion: string;
    /**
     * `effectiveFrom`'s own UTC calendar date, `YYYY-MM-DD`. Redundant by
     * construction and validated to be so, because this is the field that
     * lands in the snapshot and a snapshot whose date disagrees with the
     * instant that selected it is worse than either alone.
     */
    effectiveDate: string;
    /**
     * The UTC date this application read the change off the provider, as
     * `YYYY-MM-DD`.
     *
     * A separate field from `effectiveFrom` because they answer different
     * questions and routinely differ. `verifiedAt` is provenance -- when did
     * somebody see this on the price page -- and `effectiveFrom` is the
     * boundary this registry bills on. A provider announces a change on a
     * *date*, not at a published instant, so the two cannot be the same value
     * without inventing a time of day for the announcement.
     *
     * Collapsing them was how the Sonnet 5 entry came to look wrong: it
     * carried 2026-08-11 while the announcement was 2026-08-10, and with one
     * field there was nowhere to say that the second is the reading and the
     * first is the boundary chosen from it.
     *
     * The boundary rule, applied when only a date is known: take the first
     * instant of the UTC day *after* the announcement. That is the
     * conservative direction under this file's non-retroactivity rule -- it
     * never files a request under a decision that had not been published when
     * the request ran, which taking the announcement day's own midnight would
     * do for every request earlier in that day.
     *
     * Optional: an entry whose provider published an explicit effective
     * instant has nothing to reconcile.
     */
    verifiedAt?: string;
};

export type ModelPricingProfile = {
    modelId: string;
    provider: AiProvider;
    /** The provider's own model ID, as sent upstream. */
    apiModelId: string;
    routing: ModelPricingRouting;
    processingTier: ModelProcessingTier;
    /** Ordered ascending by `maxPromptTokens`; the last entry has `null`. */
    tiers: readonly ModelPriceTier[];
    reasoningTokenBilling: ReasoningTokenBilling;
    /**
     * Provider-native web search / server-side tool price, in micro-USD per
     * executed query. Undefined when the model has no native search tool.
     */
    nativeSearchCostMicroUsdPerQuery?: number;
    /**
     * The output cap this application asks for. Not the model's capability —
     * see `providerMaxOutputTokens` — and not a promise the request will fit:
     * it is fitted down to the context window's remaining room before dispatch
     * (`lib/chatContextWindow.ts`).
     */
    maxOutputTokens: number;
    /**
     * The provider's absolute settable ceiling for the request's output cap,
     * where it is verified and differs from what this app asks for.
     *
     * Kept apart from `maxOutputTokens` because collapsing the two is what
     * broke Kimi K3: its ceiling equals its whole 1,048,576-token context
     * window, and using a capability ceiling as every request's fixed output
     * budget left no room for any input at all, so the guard refused every
     * request at every size. A capability is what the model *can* do; a request
     * cap is what this turn asks for; they are not the same number and the
     * second is bounded by the first.
     *
     * Undefined where no ceiling has been verified. It never raises the request
     * cap — only lowers it.
     */
    providerMaxOutputTokens?: number;
    /**
     * Output tokens reserved up front. Sized from the model's own answer-length
     * distribution rather than a shared constant, because a reservation that is
     * far below the real answer is settled upward after the fact and therefore
     * cannot protect anything.
     */
    reservationOutputTokens: number;
    reservationOutputBasis:
        | "p90_output_tokens"
        | "p95_output_tokens"
        | "provider_cap"
        | "conservative_default";
    /** False when the provider's cache-read discount is not verified here. */
    cachedInputPricingVerified: boolean;
    /** Where the numbers came from, for audit. */
    priceSource: string;
    pricingVersion: string;
    /** ISO date the price took effect for this application. */
    effectiveDate: string;
    /**
     * Later revisions of `tiers`, each with the instant it starts applying.
     *
     * Ascending by `effectiveFrom`, and every entry is strictly after the
     * profile's own `effectiveDate`. The fields above stay the *original*
     * entry rather than being rewritten in place, so a request dated before
     * the first revision still resolves to the version it was billed at.
     */
    priceSchedule?: readonly ScheduledModelPrice[];
};

type ModelCostClass = "standard" | "advanced" | "premium";

export const getModelCostClass = (
    usageClass: ModelUsageClass
): ModelCostClass => {
    if (
        usageClass === "premium" ||
        usageClass === "premium-reasoning" ||
        usageClass === "deep-research"
    ) {
        return "premium";
    }
    if (usageClass === "standard") return "standard";
    return "advanced";
};

/**
 * Provider-native web search cost, in micro-USD per executed query, for
 * internal cost accounting only (never charged to the user as extra credits
 * beyond the flat surcharge). OpenAI/Anthropic publish a flat US$10 per 1,000
 * searches; Google's Gemini grounding list price is US$14 per 1,000 requests
 * past the free quota and is billed here at that rate regardless of quota so
 * the internal estimate never understates cost. Perplexity is deliberately
 * absent: its own reported response cost already covers search.
 */
export const NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY: Partial<
    Record<AiProvider, number>
> = {
    openai: 10_000,
    anthropic: 10_000,
    google: 14_000,
};

export const getNativeSearchCostMicroUsdPerQuery = (provider: string) =>
    NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY[provider as AiProvider];

const flatTier = (
    inputUsdPerMillionTokens: number,
    outputUsdPerMillionTokens: number,
    cachedInputPriceMultiplier = 1,
    cacheWriteUsdPerMillionTokens?: number
): readonly ModelPriceTier[] => [
    {
        maxPromptTokens: null,
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
        cachedInputPriceMultiplier,
        // Omitted rather than guessed for a model whose cache-write rate has
        // not been read off the provider's own price list: the value is audit
        // data, so an absent one costs nothing and an invented one is a
        // fabricated record.
        ...(cacheWriteUsdPerMillionTokens === undefined
            ? {}
            : { cacheWriteUsdPerMillionTokens }),
    },
];

/**
 * The GPT-5.6 family's two-tier shape: past a 272,000-token prompt the input
 * rate doubles and the output rate goes up by half.
 *
 * `cacheWriteUsdPerMillionTokens` is the short-context cache-write rate, and
 * the long-context tier's is derived by the same x2 the input rate takes --
 * the published long-context cache-write price is exactly twice the
 * short-context one for every model in this family where both are published.
 * Omit it for a model whose cache-write price has not been verified rather
 * than guessing: it is recorded, not billed, so an absent value costs nothing
 * and an invented one would be a fabricated audit trail.
 */
const gpt56Tiers = (
    inputUsdPerMillionTokens: number,
    outputUsdPerMillionTokens: number,
    cacheWriteUsdPerMillionTokens?: number
): readonly ModelPriceTier[] => [
    {
        maxPromptTokens: 272_000,
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: 0.1,
        ...(cacheWriteUsdPerMillionTokens === undefined
            ? {}
            : { cacheWriteUsdPerMillionTokens }),
    },
    {
        maxPromptTokens: null,
        inputUsdPerMillionTokens: inputUsdPerMillionTokens * 2,
        outputUsdPerMillionTokens: outputUsdPerMillionTokens * 1.5,
        cachedInputPriceMultiplier: 0.1,
        ...(cacheWriteUsdPerMillionTokens === undefined
            ? {}
            : {
                  cacheWriteUsdPerMillionTokens:
                      cacheWriteUsdPerMillionTokens * 2,
              }),
    },
];

/**
 * Conservative defaults for a model with no explicit profile. Intentionally
 * expensive: an unpriced model should reserve too much, not too little, and
 * `findUnpricedModels()` exists so that state is loud rather than permanent.
 */
export const FALLBACK_PRICING: Record<
    ModelCostClass,
    Pick<
        ModelPricingProfile,
        | "tiers"
        | "maxOutputTokens"
        | "reservationOutputTokens"
        | "reservationOutputBasis"
        | "reasoningTokenBilling"
        | "cachedInputPricingVerified"
        | "priceSource"
        | "pricingVersion"
        | "effectiveDate"
    >
> = {
    standard: {
        tiers: flatTier(0.5, 1),
        maxOutputTokens: 2_048,
        reservationOutputTokens: 1_024,
        reservationOutputBasis: "conservative_default",
        reasoningTokenBilling: "billed_as_output",
        cachedInputPricingVerified: false,
        priceSource: "conservative_class_fallback",
        pricingVersion: "fallback-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    advanced: {
        tiers: flatTier(3, 12),
        maxOutputTokens: 4_096,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        reasoningTokenBilling: "billed_as_output",
        cachedInputPricingVerified: false,
        priceSource: "conservative_class_fallback",
        pricingVersion: "fallback-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    premium: {
        tiers: flatTier(15, 60),
        maxOutputTokens: 8_192,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        reasoningTokenBilling: "billed_as_output",
        cachedInputPricingVerified: false,
        priceSource: "conservative_class_fallback",
        pricingVersion: "fallback-2026-08-01",
        effectiveDate: "2026-08-01",
    },
};

const DIRECT_STANDARD = {
    routing: "direct_provider_api",
    processingTier: "standard",
} as const;

/*
 * Source files allowed to name a processing tier at all, each with the reason
 * it does.
 *
 * Every profile below declares `processingTier: "standard"`, and that is an
 * assertion about the request this application actually sends -- not a
 * preference. It holds only while no request sets one, because OpenAI's
 * `service_tier` defaults to `auto` when omitted, and `auto` may be served at
 * a tier whose price is not the Standard price these profiles record. Flex and
 * Batch are cheaper, Priority/Fast is dearer, and a regional-processing
 * endpoint adds a surcharge on top of any of them.
 *
 * Anthropic's `inference_geo` is guarded by the same list. It is not a
 * processing tier, but it is the same kind of thing: on Claude 4.6 and later
 * -- every Anthropic model routed to here -- `inference_geo: "us"` multiplies
 * every pricing category by 1.1x, and the profiles record the global default.
 * Verified 2026-08-04 against Anthropic's published pricing page.
 *
 * `npm run check:model-pricing` greps the tree -- **including files not yet
 * committed** -- and fails on any occurrence outside this list. The check is
 * deliberately blunt rather than clever: telling "sets a tier on the request"
 * apart from "reads the tier off the response" by regex means guessing at
 * `service_tier:` versus `service_tier =` versus `["service_tier"] =`, and a
 * guard that guesses is one refactor away from waving through the thing it
 * exists to stop. So every mention is surfaced and each exception carries a
 * written reason a reviewer can check.
 *
 * `sendsATier` is the field that matters: no entry may set it to `true`
 * without the pricing profiles that describe that tier landing in the same
 * change.
 *
 * An entry used to exempt a **whole file**, and that is the shape the guard
 * failed in. `app/api/chat/route.ts` was listed here for a mention it no
 * longer contains -- the classifier is reached through an
 * `observeServedProcessingTier` import, which names no tier -- so the one file
 * in the tree that builds the provider request held a standing exemption.
 * Adding `service_tier: "flex"` to its `streamText` call would have passed in
 * silence, which is the exact failure this check exists to prevent.
 *
 * So an entry now pins the **lines** it covers, not the file. A file listed
 * for reading a tier off a response cannot quietly gain a line that sets one:
 * an unpinned mention fails, and so does a pin whose line is gone. Both are
 * build failures rather than warnings -- a licence nobody needs is a licence
 * nobody is reading, and it outlives the reason written beside it.
 *
 * `mentions` is compared after trimming, so re-indenting a line is free and
 * rewording it is not. That is the intended trade: the text is the thing a
 * reviewer approved.
 */
// The allowlist itself lives in scripts/check-processing-tier-core.mjs.
//
// It is a build-time artifact -- nothing at runtime reads it -- and pinning it
// by line means the entries quote source code verbatim. Quoted code in a `lib`
// module is exactly what the mojibake heuristics in
// scripts/check-text-encoding.mjs are built to be suspicious of, and a pinned
// line containing `parsed?.service_tier ?? null` was read as corrupted prose.
// The data belongs beside the check that consumes it; the reasoning stays
// here, next to the profiles whose `processingTier: "standard"` claim depends
// on it.


/**
 * Still recorded as a gap, now a narrower one: a pricing snapshot records the
 * tier this registry *assumes* rather than the tier the request was *served
 * at*.
 *
 * What changed is that the discrepancy is no longer invisible.
 * `lib/servedProcessingTier.ts` classifies the tier every completed chat
 * response reports and logs `chat_served_processing_tier_mismatch` when the
 * Standard table was not the table the provider billed under. That is
 * observation, not accounting: no reservation, settlement or snapshot reads
 * it, so this constant stays `true`.
 *
 * Closing it the rest of the way means carrying the served tier into
 * settlement, which changes what a snapshot means and therefore needs its own
 * `pricingVersion` -- a separate change, and one that should be made with the
 * mismatch data this observation produces rather than before it exists.
 */
export const RESPONSE_PROCESSING_TIER_IS_NOT_RECORDED = true;

/**
 * `GET /v1/models` is **not** a price source, and nothing in this file may be
 * derived from it.
 *
 * It answers one question -- can this API key see this model -- and returns no
 * pricing whatsoever. Treating its response as confirmation of a price would
 * mean recording, as verified, a number the provider never sent. Prices here
 * come from the provider's published pricing pages, and `priceSource` names
 * which one. `npm run check:openai-model-access` exists to make the
 * visibility check available on its own without implying anything about cost.
 */
export const MODEL_LIST_ENDPOINT_IS_NOT_A_PRICE_SOURCE = true;

// ---------------------------------------------------------------------------
// Explicit per-model profiles.
//
// Verified against the request path in lib/activeAiModel.ts +
// lib/modelRegistryShared.ts: every provider below is called directly at its
// own first-party endpoint (api.openai.com, api.anthropic.com,
// generativelanguage.googleapis.com, ...), with no `service_tier` /
// priority / flex override in the request, no relay, and no regional endpoint.
// Standard published API pricing therefore applies.
// ---------------------------------------------------------------------------
export const MODEL_PRICING: readonly ModelPricingProfile[] = [
    {
        modelId: "gpt-5-6-sol",
        provider: "openai",
        apiModelId: "gpt-5.6-sol",
        ...DIRECT_STANDARD,
        tiers: gpt56Tiers(5, 30),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 16_384,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "openai_gpt_5_6_sol_model_page",
        pricingVersion: "openai-gpt-5.6-sol-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "gpt-5-6-terra",
        provider: "openai",
        apiModelId: "gpt-5.6-terra",
        ...DIRECT_STANDARD,
        tiers: gpt56Tiers(2, 12),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "openai_gpt_5_6_terra_model_page",
        pricingVersion: "openai-gpt-5.6-terra-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        // Published Standard-tier rates, USD per million tokens:
        //   short context (<=272K prompt): 0.20 in / 0.02 cached / 0.25 cache
        //                                  write / 1.20 out
        //   long context  (> 272K prompt): 0.40 in / 0.04 cached / 0.50 cache
        //                                  write / 1.80 out
        // gpt56Tiers derives the long tier from the short one, and 0.02/0.04
        // come out of the 0.1 cached multiplier. The cache-write rates are
        // recorded and not billed -- see ModelPriceTier.
        //
        // Reachability: this application caps input at 128,000 tokens for a
        // signed-in account and 16,000 for a guest (lib/chatSecurity.ts), so
        // the long tier is priced correctly but has never been reached on the
        // chat path.
        modelId: "gpt-5-6-luna",
        provider: "openai",
        apiModelId: "gpt-5.6-luna",
        ...DIRECT_STANDARD,
        tiers: gpt56Tiers(0.2, 1.2, 0.25),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "openai_gpt_5_6_luna_model_page",
        pricingVersion: "openai-gpt-5.6-luna-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "gpt-5-5",
        provider: "openai",
        apiModelId: "gpt-5.5",
        ...DIRECT_STANDARD,
        tiers: flatTier(5, 30),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 8_192,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "p90_output_tokens",
        cachedInputPricingVerified: false,
        priceSource: "openai_standard_api_list_price",
        pricingVersion: "openai-gpt-5.5-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        // Same upstream model as gpt-5-5, requested with high reasoning effort.
        // Reasoning tokens are returned inside `outputTokens`, so the price is
        // identical and only the reserved output headroom differs.
        modelId: "gpt-5-5-thinking",
        provider: "openai",
        apiModelId: "gpt-5.5",
        ...DIRECT_STANDARD,
        tiers: flatTier(5, 30),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 8_192,
        reservationOutputTokens: 6_144,
        reservationOutputBasis: "p90_output_tokens",
        cachedInputPricingVerified: false,
        priceSource: "openai_standard_api_list_price",
        pricingVersion: "openai-gpt-5.5-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        // Added when gpt-5-6-luna took over as the default model and 5.4 mini
        // became the baseline it is compared against. Until then this model
        // had no explicit profile at all, so it resolved through the generic
        // "standard" class fallback of US$0.50 in / US$1.00 out -- against a
        // published US$4.50 output rate, i.e. every 5.4 mini answer was
        // costed internally at roughly a fifth of what it actually costs, and
        // its reservation was sized from that same wrong number.
        //
        // Flat-priced: unlike the GPT-5.6 family above, 5.4 mini publishes no
        // long-context price step, so there is one unbounded tier rather than
        // a gpt56Tiers() pair. US$0.75 in / US$0.075 cached / US$4.50 out; no
        // cache-write rate is recorded because none was verified for this
        // model, and a recorded price that nobody checked is worse than none.
        //
        // Three separate output numbers, deliberately not collapsed:
        //   * 128,000 -- the provider's published maximum output.
        //   * maxOutputTokens -- the cap this app actually sends upstream
        //     (app/api/chat/route.ts passes it straight to streamText), set
        //     to the published maximum, matching every other OpenAI entry
        //     here rather than inheriting the fallback's unrelated 2,048.
        //   * reservationOutputTokens -- what the credit reservation carries,
        //     kept identical to gpt-5-6-luna's 4,096 so the two models are
        //     reserved on the same basis while they are being compared.
        // The reservation basis stays "conservative_default" because no p90
        // output-token telemetry was available to size it from.
        modelId: "gpt-5-4-mini",
        provider: "openai",
        apiModelId: "gpt-5.4-mini",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.75, 4.5, 0.1),
        reasoningTokenBilling: "billed_as_output",
        // No nativeSearchCostMicroUsdPerQuery: this model is "unverified" in
        // lib/webSearchCapability.ts, so no native search tool is ever
        // attached to it and there is no per-query cost to book.
        maxOutputTokens: 128_000,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "openai_gpt_5_4_mini_model_page",
        pricingVersion: "openai-gpt-5.4-mini-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "gemini-3-7-flash",
        provider: "google",
        apiModelId: "gemini-3.7-flash",
        ...DIRECT_STANDARD,
        // The standard rate, deliberately, and not the introductory one.
        //
        // Google publishes gemini-3.7-flash at US$0.75/US$3.75 "through
        // December 31, 2026" and US$1.50/US$7.50 "starting January 1, 2027".
        // This type has `effectiveDate` and nothing else: it can say when a
        // price starts and not when it stops. Recording the discount would
        // therefore bill at half the real cost from 1 January until somebody
        // noticed and shipped a new pricingVersion -- and nothing in this
        // repository would notice, because an expired promotion looks exactly
        // like a correct price.
        //
        // Registering the standard rate over-reserves during the discount,
        // which is the direction this file already errs in everywhere else
        // (see FALLBACK_PRICING and reservationOutputBasis). Taking the
        // discount is a separate decision that needs a human holding the
        // expiry date, not a default.
        //
        // It also happens to be identical to gemini-3-6-flash below, which is
        // why the credit band does not move: same tiers, same cache
        // multiplier, same context window, same output cap.
        tiers: flatTier(1.5, 7.5, 0.1),
        reasoningTokenBilling: "billed_as_output",
        // US$14 per 1,000 grounded requests, the same rate 3.6 Flash carries.
        nativeSearchCostMicroUsdPerQuery: 14_000,
        maxOutputTokens: 65_536,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "google_gemini_3_7_flash_standard_api_list_price",
        pricingVersion: "google-gemini-3.7-flash-2026-08-22",
        effectiveDate: "2026-08-22",
    },
    {
        modelId: "gemini-3-6-flash",
        provider: "google",
        apiModelId: "gemini-3.6-flash",
        ...DIRECT_STANDARD,
        tiers: flatTier(1.5, 7.5, 0.1),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 14_000,
        maxOutputTokens: 65_536,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "google_gemini_3_6_flash_standard_api_list_price",
        pricingVersion: "google-gemini-3.6-flash-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "gemini-3-5-flash",
        provider: "google",
        apiModelId: "gemini-3.5-flash",
        ...DIRECT_STANDARD,
        // Google prices 3.5 Flash above 3.6 Flash on output ($9 vs $7.50).
        // It therefore belongs in the same Advanced credit band; leaving it
        // on the Standard fallback understated both its price and output cap.
        tiers: flatTier(1.5, 9, 0.1),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 14_000,
        maxOutputTokens: 65_536,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "google_gemini_3_5_flash_standard_api_list_price",
        pricingVersion: "google-gemini-3.5-flash-2026-08-03",
        effectiveDate: "2026-08-03",
    },
    {
        // Stable Tomverse ID upgraded in place to Gemini 3.5 Flash-Lite.
        modelId: "gemini-2-5-flash",
        provider: "google",
        apiModelId: "gemini-3.5-flash-lite",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.3, 2.5, 0.1),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 14_000,
        maxOutputTokens: 65_536,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "google_gemini_3_5_flash_lite_standard_api_list_price",
        pricingVersion: "google-gemini-3.5-flash-lite-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "gemini-3-1-pro",
        provider: "google",
        apiModelId: "gemini-3.1-pro-preview",
        ...DIRECT_STANDARD,
        // Gemini 3.1 Pro Preview steps up past a 200K-token prompt.
        tiers: [
            {
                maxPromptTokens: 200_000,
                inputUsdPerMillionTokens: 2,
                outputUsdPerMillionTokens: 12,
                cachedInputPriceMultiplier: 1,
            },
            {
                maxPromptTokens: null,
                inputUsdPerMillionTokens: 4,
                outputUsdPerMillionTokens: 18,
                cachedInputPriceMultiplier: 1,
            },
        ],
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 14_000,
        maxOutputTokens: 8_192,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "p90_output_tokens",
        cachedInputPricingVerified: false,
        priceSource: "google_gemini_standard_api_list_price",
        pricingVersion: "google-gemini-3.1-pro-preview-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "claude-fable-5",
        provider: "anthropic",
        apiModelId: "claude-fable-5",
        ...DIRECT_STANDARD,
        // 5-minute cache write, recorded for audit and not billed. The 1-hour
        // write is twice it (US$20/MTok); only the shorter duration is stored,
        // matching the field's meaning for every other profile.
        tiers: flatTier(10, 50, 0.1, 12.5),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "anthropic_claude_5_standard_api_list_price",
        pricingVersion: "anthropic-claude-fable-5-2026-08-03",
        effectiveDate: "2026-08-03",
    },
    {
        // The Tomverse ID is stable; this profile follows its new Opus 5
        // upstream route and therefore gets a new, non-retroactive version.
        modelId: "claude-opus-4-8",
        provider: "anthropic",
        apiModelId: "claude-opus-5",
        ...DIRECT_STANDARD,
        // As above: 5-minute cache write; the 1-hour rate is US$10/MTok.
        tiers: flatTier(5, 25, 0.1, 6.25),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "anthropic_claude_5_standard_api_list_price",
        pricingVersion: "anthropic-claude-opus-5-2026-08-03",
        effectiveDate: "2026-08-03",
    },
    // Provider-verified profiles added by the 2026-08-01 catalogue migration.
    {
        modelId: "grok-4-3",
        provider: "xai",
        apiModelId: "grok-4.3",
        ...DIRECT_STANDARD,
        tiers: [
            {
                maxPromptTokens: 199_999,
                inputUsdPerMillionTokens: 1.25,
                outputUsdPerMillionTokens: 2.5,
                cachedInputPriceMultiplier: 0.16,
            },
            {
                maxPromptTokens: null,
                inputUsdPerMillionTokens: 2.5,
                outputUsdPerMillionTokens: 5,
                cachedInputPriceMultiplier: 0.16,
            },
        ],
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 16_384,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "xai_grok_4_3_standard_api_list_price",
        pricingVersion: "xai-grok-4.3-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        // Load-bearing beyond ordinary chat accounting: consolidating xAI onto
        // this model also made it the provider probe's target
        // (lib/providerProbe.ts picks the cheapest enabled probe-safe model,
        // and it is now the only xAI one). Probe cost is booked from this
        // profile against a cap shared by every provider, so on the
        // US$15/US$60 class fallback one xAI cycle cost US$0.00267 and 144
        // cycles a day came to US$0.3845 -- 38% of the whole US$1 cap from one
        // provider. At the published rate it is US$0.042.
        modelId: "grok-4-5",
        provider: "xai",
        apiModelId: "grok-4.5",
        ...DIRECT_STANDARD,
        tiers: [
            {
                maxPromptTokens: 199_999,
                inputUsdPerMillionTokens: 2,
                outputUsdPerMillionTokens: 6,
                cachedInputPriceMultiplier: 0.15,
            },
            {
                maxPromptTokens: null,
                inputUsdPerMillionTokens: 4,
                outputUsdPerMillionTokens: 12,
                cachedInputPriceMultiplier: 0.15,
            },
        ],
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 16_384,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "xai_grok_4_5_standard_api_list_price",
        pricingVersion: "xai-grok-4.5-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "llama-4-scout",
        provider: "groq",
        apiModelId: "meta-llama/llama-4-scout-17b-16e-instruct",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.11, 0.34),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 8_192,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "groq_published_token_pricing",
        pricingVersion: "groq-llama-4-scout-2026-07-21",
        effectiveDate: "2026-07-21",
    },
    {
        modelId: "deepseek-v4-flash",
        provider: "deepseek",
        apiModelId: "deepseek-v4-flash",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.14, 0.28, 0.02),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 384_000,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "deepseek_published_cache_hit_and_miss_pricing",
        pricingVersion: "deepseek-v4-flash-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "deepseek-v4-pro",
        provider: "deepseek",
        apiModelId: "deepseek-v4-pro",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.435, 0.87, 1 / 120),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 384_000,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "deepseek_published_cache_hit_and_miss_pricing",
        pricingVersion: "deepseek-v4-pro-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        modelId: "mistral-medium-3-1",
        provider: "mistral",
        apiModelId: "mistral-medium-3-5",
        ...DIRECT_STANDARD,
        tiers: flatTier(1.5, 7.5),
        reasoningTokenBilling: "billed_as_output",
        // Mistral publishes the context window but not a distinct output
        // ceiling for this model. Keep an explicit operational request cap.
        maxOutputTokens: 16_384,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "mistral_medium_3_5_model_card",
        pricingVersion: "mistral-medium-3.5-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    {
        // Historical settlement profile only: Codestral is no longer
        // enabled or listed in Tomverse Review, but old reservations remain payable.
        modelId: "codestral",
        provider: "mistral",
        apiModelId: "codestral-latest",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.3, 0.9),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 32_768,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "mistral_codestral_standard_api_list_price",
        pricingVersion: "mistral-codestral-2026-08-03",
        effectiveDate: "2026-08-03",
    },
    {
        modelId: "kimi-k3",
        provider: "moonshot",
        apiModelId: "kimi-k3",
        ...DIRECT_STANDARD,
        tiers: flatTier(3, 15, 0.1),
        reasoningTokenBilling: "billed_as_output",
        // Moonshot's documented default for max_completion_tokens. The
        // provider will accept anything up to the full window, but it rejects
        // a request whose input plus its output cap exceeds that window -- so
        // asking for the ceiling every time made the model unusable rather
        // than generous. The register records the ceiling and this source
        // (docs/policy/tomverse-chat-context-window-register.yaml).
        maxOutputTokens: 131_072,
        providerMaxOutputTokens: 1_048_576,
        reservationOutputTokens: 16_384,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "moonshot_kimi_k3_official_platform_price",
        pricingVersion: "moonshot-kimi-k3-2026-08-03",
        effectiveDate: "2026-08-03",
    },
    {
        modelId: "minimax-m3",
        provider: "minimax",
        apiModelId: "MiniMax-M3",
        ...DIRECT_STANDARD,
        // MiniMax M3 currently doubles its standard token rates above a
        // 512K-token prompt. Keep the long-context tier explicit so the
        // reservation cannot silently price a 1M prompt at the short rate.
        tiers: [
            {
                maxPromptTokens: 512_000,
                inputUsdPerMillionTokens: 0.3,
                outputUsdPerMillionTokens: 1.2,
                cachedInputPriceMultiplier: 0.2,
            },
            {
                maxPromptTokens: null,
                inputUsdPerMillionTokens: 0.6,
                outputUsdPerMillionTokens: 2.4,
                cachedInputPriceMultiplier: 0.2,
            },
        ],
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 524_288,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "minimax_m3_official_api_promotional_price",
        pricingVersion: "minimax-m3-2026-08-03",
        effectiveDate: "2026-08-03",
    },
    {
        modelId: "glm-5.2",
        provider: "zhipu",
        apiModelId: "glm-5.2",
        ...DIRECT_STANDARD,
        // The cache-read rate is published as an absolute US$0.26/1M rather
        // than as a discount, so the multiplier is written as the division
        // that reproduces it exactly instead of a rounded 0.19 -- the stored
        // number is what later re-prices a snapshot, and 0.19 would quietly
        // charge US$0.266.
        //
        // This replaces a `conservative_fallback` resolution: with no profile
        // here, GLM-5.2 priced at the standard class rate (US$0.5 / US$1) and
        // took the zhipu provider-wide cached multiplier of 0.2, which is a
        // default in this file and never was evidence about this model.
        tiers: flatTier(1.4, 4.4, 0.26 / 1.4),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 131_072,
        // Not raised alongside the ceiling. This is the up-front credit hold,
        // and it is what GLM-5.2 already reserved on the standard-class
        // fallback -- moving it is a change to how much of a user's balance a
        // single request locks, which is a decision about entitlement rather
        // than about price, and it is not what issue #256 asked for. Sizing it
        // properly needs this model's own answer-length distribution, which is
        // also what `reservationOutputBasis` would need before it could say
        // anything other than `conservative_default`.
        reservationOutputTokens: 1_024,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "zhipu_glm_5_2_published_api_price_list",
        pricingVersion: "zhipu-glm-5.2-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "claude-sonnet-5",
        provider: "anthropic",
        apiModelId: "claude-sonnet-5",
        ...DIRECT_STANDARD,
        // The rates below are Sonnet 5's *introductory* pricing, kept as the
        // profile's original entry so a request dated before 2026-08-11 still
        // resolves to the version it was billed at. What applies now is the
        // schedule entry underneath, and the two carry the same numbers -- see
        // there for why that is the whole point rather than a redundancy.
        tiers: flatTier(2, 10, 0.1, 2.5),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 128_000,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "anthropic_claude_sonnet_5_introductory_price_to_2026_08_31",
        pricingVersion: "anthropic-claude-sonnet-5-intro-2026-08-04",
        effectiveDate: "2026-08-04",
        // Anthropic made the introductory rate the standard one: announced
        // 2026-08-10, billed here from 2026-08-11T00:00:00Z.
        //
        // The launch announcement put US$2 / US$10 on an end date of
        // 2026-08-31 with US$3 / US$15 from 2026-09-01, and this file was
        // written against that -- with a date-triggered test failure so the
        // change could not be missed. On 2026-08-11 Anthropic cancelled it:
        // the pricing page's `claude-sonnet-5-introductory-pricing` note now
        // reads "is now the standard price. The previously scheduled increase
        // to $3/$15 per million input/output tokens on September 1, 2026 will
        // not occur."
        //
        // So this entry carries the *same* rates as the profile above. That
        // reads like a no-op and is not one: what changed is the term, not the
        // number, and the term is the thing this registry records. Writing it
        // down as a dated revision is what lets a settlement say which
        // decision priced it -- `...-intro-2026-08-04` for a turn taken while
        // the rate was provisional, `...-standard-2026-08-11` for one taken
        // after it was permanent -- and is what stops the next reader
        // re-deriving the cancelled increase from a `priceSource` that still
        // says "introductory_price_to_2026_08_31".
        //
        // Two dates, and they are not the same date on purpose. The
        // announcement is 2026-08-10; the boundary is 2026-08-11T00:00:00Z.
        // Anthropic published a date and not an instant, so `verifiedAt`
        // records the reading and `effectiveFrom` records the boundary chosen
        // from it -- the first instant of the following UTC day, which is the
        // only choice that never prices a request by a decision that had not
        // been published when it ran. Backdating to 2026-08-10T00:00:00Z would
        // do exactly that for every request earlier in the announcement day.
        //
        // Here the choice moves no money at all: the rates are identical
        // either side, so all it decides is which `pricingVersion` a turn on
        // 2026-08-10 is filed under. It is written down because the next
        // revision will not be so forgiving.
        //
        // Deliberately *not* a US$3 / US$15 entry dated 2026-09-01. Scheduling
        // a price Anthropic has said will not happen would overstate every
        // Sonnet 5 request by 50% from that date, and overstating is not the
        // safe direction here: provider budgets and the operational cost
        // guardrails are spent against these numbers, so an inflated rate
        // refuses requests that had the money for them.
        priceSchedule: [
            {
                effectiveFrom: "2026-08-11T00:00:00.000Z",
                tiers: flatTier(2, 10, 0.1, 2.5),
                priceSource:
                    "anthropic_claude_sonnet_5_standard_api_list_price_announced_2026_08_10",
                pricingVersion: "anthropic-claude-sonnet-5-standard-2026-08-11",
                effectiveDate: "2026-08-11",
                // The announcement, not the boundary. See above.
                verifiedAt: "2026-08-10",
            },
        ],
    },
    {
        modelId: "claude-haiku-4-5",
        provider: "anthropic",
        apiModelId: "claude-haiku-4-5-20251001",
        ...DIRECT_STANDARD,
        tiers: flatTier(1, 5, 0.1, 1.25),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 64_000,
        reservationOutputTokens: 1_024,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "anthropic_claude_haiku_4_5_list_price",
        pricingVersion: "anthropic-claude-haiku-4.5-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "mistral-small-4",
        provider: "mistral",
        apiModelId: "mistral-small-latest",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.15, 0.6, 0.1),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 128_000,
        reservationOutputTokens: 1_024,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "mistral_small_4_official_api_price_list",
        pricingVersion: "mistral-small-4-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "mistral-large-3",
        provider: "mistral",
        apiModelId: "mistral-large-latest",
        ...DIRECT_STANDARD,
        // Was reserved at the US$15 / US$60 premium fallback -- thirty times the
        // real input rate. Leaves PENDING_VERIFIED_PRICE_REGISTER with this.
        tiers: flatTier(0.5, 1.5, 0.1),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 128_000,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "mistral_large_3_official_api_price_list",
        pricingVersion: "mistral-large-3-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "kimi-k2.7-code",
        provider: "moonshot",
        apiModelId: "kimi-k2.7-code",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.95, 4, 0.2),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 32_768,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "moonshot_kimi_k2_7_code_published_price",
        pricingVersion: "moonshot-kimi-k2.7-code-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "qwen3.7-plus",
        provider: "qwen",
        apiModelId: "qwen3.7-plus",
        ...DIRECT_STANDARD,
        // Qwen prices by input length, so the tiers are explicit: a 300K prompt
        // costs three times a 200K one and a flat rate would under-charge it.
        tiers: [
            {
                maxPromptTokens: 256_000,
                inputUsdPerMillionTokens: 0.4,
                outputUsdPerMillionTokens: 1.6,
                // Implicit cache (US$0.08), not the explicit US$0.04 read: this
                // application never creates explicit cache entries, so the
                // cheaper rate is one it cannot earn.
                cachedInputPriceMultiplier: 0.2,
            },
            {
                maxPromptTokens: null,
                inputUsdPerMillionTokens: 1.2,
                outputUsdPerMillionTokens: 4.8,
                // Qwen does not publish a consistent cache rate above 256K, so
                // full price -- never understating is the conservative default,
                // and `cachedInputPricingVerified` below says this is why.
                cachedInputPriceMultiplier: 1,
            },
        ],
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 65_536,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "qwen_qwen3_7_plus_official_price_list_by_input_length",
        pricingVersion: "qwen-qwen3.7-plus-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "qwen3.6-flash",
        provider: "qwen",
        apiModelId: "qwen3.6-flash",
        ...DIRECT_STANDARD,
        tiers: [
            {
                maxPromptTokens: 256_000,
                inputUsdPerMillionTokens: 0.25,
                outputUsdPerMillionTokens: 1.5,
                // Only an *explicit* cache-read rate (US$0.025) is published for
                // this model, and nothing here creates explicit caches, so a
                // cached token bills at full price as far as this can tell.
                cachedInputPriceMultiplier: 1,
            },
            {
                maxPromptTokens: null,
                inputUsdPerMillionTokens: 1,
                outputUsdPerMillionTokens: 4,
                cachedInputPriceMultiplier: 1,
            },
        ],
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 65_536,
        reservationOutputTokens: 1_024,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "qwen_qwen3_6_flash_official_price_list_by_input_length",
        pricingVersion: "qwen-qwen3.6-flash-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "qwen3.7-max",
        provider: "qwen",
        apiModelId: "qwen3.7-max",
        ...DIRECT_STANDARD,
        // Was reserved at the US$15 / US$60 premium fallback -- six times the
        // real input rate. Leaves PENDING_VERIFIED_PRICE_REGISTER with this.
        // One tier: the published price does not step below the 991K input
        // ceiling, which is already above CHAT_USER_MAX_INPUT_TOKENS.
        tiers: flatTier(2.5, 7.5, 0.2),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 131_072,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "qwen_qwen3_7_max_official_price_list_implicit_cache",
        pricingVersion: "qwen-qwen3.7-max-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    /*
      Perplexity, all four. Two things are true of every one of them:

        * No cache-read price is published, so the multiplier stays at 1 and
          `cachedInputPricingVerified` is false. That is "unknown, charged in
          full", not "no discount exists".
        * Search is billed on top of tokens, and `perplexity` is absent from
          NATIVE_SEARCH_COST_MICRO_USD_PER_QUERY -- so until now the search half
          of a Sonar request cost nothing as far as this application knew. The
          per-model figures below are what `resolveModelPricing` reads first.

      For sonar, sonar-pro and sonar-reasoning-pro the fee is per *request* and
      varies with search context size (low/medium/high). One number has to stand
      for all three, so it is the high one: a request billed at high and priced
      at low is an understatement, and the reverse is not.
    */
    {
        modelId: "perplexity/sonar",
        provider: "perplexity",
        apiModelId: "sonar",
        ...DIRECT_STANDARD,
        tiers: flatTier(1, 1, 1),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 12_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "perplexity_sonar_official_pricing_high_context_request_fee",
        pricingVersion: "perplexity-sonar-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "perplexity/sonar-pro",
        provider: "perplexity",
        apiModelId: "sonar-pro",
        ...DIRECT_STANDARD,
        tiers: flatTier(3, 15, 1),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 14_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "perplexity_sonar_pro_official_pricing_high_context_request_fee",
        pricingVersion: "perplexity-sonar-pro-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "perplexity/sonar-reasoning-pro",
        provider: "perplexity",
        apiModelId: "sonar-reasoning-pro",
        ...DIRECT_STANDARD,
        tiers: flatTier(2, 8, 1),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 14_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "perplexity_sonar_reasoning_pro_official_pricing_high_context_request_fee",
        pricingVersion: "perplexity-sonar-reasoning-pro-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "perplexity/sonar-deep-research",
        provider: "perplexity",
        apiModelId: "sonar-deep-research",
        ...DIRECT_STANDARD,
        // Was reserved at the US$15 / US$60 premium fallback. Leaves
        // PENDING_VERIFIED_PRICE_REGISTER with this.
        tiers: flatTier(2, 8, 1),
        // Perplexity bills this model's reasoning tokens on their own line
        // (US$3/M), not inside `outputTokens`. Recorded truthfully rather than
        // folded into the output rate: nothing reads this field today, so the
        // only thing a comfortable lie would buy is a wrong answer later.
        //
        // Two of its charges are still not modelled anywhere -- those reasoning
        // tokens and citation tokens (US$2/M) -- because no usage adapter
        // reports either count. Same reasoning as `cacheWriteUsdPerMillionTokens`
        // above: a number that cannot be measured is not invented here.
        reasoningTokenBilling: "billed_separately",
        // US$5 per 1,000 search queries. Per *query* for this model, unlike the
        // per-request fee the other three carry.
        nativeSearchCostMicroUsdPerQuery: 5_000,
        maxOutputTokens: 128_000,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: false,
        priceSource: "perplexity_sonar_deep_research_official_pricing",
        pricingVersion: "perplexity-sonar-deep-research-2026-08-04",
        effectiveDate: "2026-08-04",
    },
    {
        modelId: "deepseek-r1",
        provider: "deepseek",
        apiModelId: "deepseek-reasoner",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.14, 0.28, 0.02),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 4_096,
        reservationOutputTokens: 2_048,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "deepseek_published_cache_hit_and_miss_pricing",
        pricingVersion: "deepseek-reasoner-2026-06-01",
        effectiveDate: "2026-06-01",
    },
] as const;

const pricingById = new Map(
    MODEL_PRICING.map((profile) => [profile.modelId, profile])
);

if (pricingById.size !== MODEL_PRICING.length) {
    throw new Error("Model pricing registry contains duplicate model IDs.");
}
const assertUsableTiers = (label: string, tiers: readonly ModelPriceTier[]) => {
    if (tiers.length === 0) {
        throw new Error(`${label} declares no price tier.`);
    }
    if (tiers[tiers.length - 1].maxPromptTokens !== null) {
        throw new Error(`${label} has no unbounded final price tier.`);
    }
};

/**
 * Read at module load so a malformed schedule is a boot failure rather than a
 * request that quietly falls back to the wrong price. Every check here is
 * about a property no test can observe from outside: an entry that never
 * takes effect because it is out of order, or one whose `effectiveDate`
 * disagrees with the instant that selects it and would land in the snapshot
 * saying so.
 */
for (const profile of MODEL_PRICING) {
    assertUsableTiers(`Model "${profile.modelId}"`, profile.tiers);
    if (profile.reservationOutputTokens > profile.maxOutputTokens) {
        throw new Error(
            `Model "${profile.modelId}" reserves more output than it allows.`
        );
    }
    let previousInstant = Date.parse(`${profile.effectiveDate}T00:00:00.000Z`);
    if (!Number.isFinite(previousInstant)) {
        throw new Error(
            `Model "${profile.modelId}" has an unparseable effectiveDate.`
        );
    }
    const versions = new Set([profile.pricingVersion]);
    for (const [index, revision] of (profile.priceSchedule ?? []).entries()) {
        const label = `Model "${profile.modelId}" price revision ${index}`;
        assertUsableTiers(label, revision.tiers);
        const instant = Date.parse(revision.effectiveFrom);
        if (!Number.isFinite(instant)) {
            throw new Error(`${label} has an unparseable effectiveFrom.`);
        }
        if (!revision.effectiveFrom.endsWith("Z")) {
            throw new Error(
                `${label} must state effectiveFrom as a UTC instant ending in "Z".`
            );
        }
        if (instant <= previousInstant) {
            throw new Error(
                `${label} is not strictly after the revision before it; a ` +
                    `revision that does not move forward can never take effect.`
            );
        }
        if (revision.effectiveDate !== revision.effectiveFrom.slice(0, 10)) {
            throw new Error(
                `${label} has an effectiveDate that disagrees with its ` +
                    `effectiveFrom, so the snapshot would record a date the ` +
                    `price did not start on.`
            );
        }
        if (revision.verifiedAt !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(revision.verifiedAt)) {
                throw new Error(`${label} has a malformed verifiedAt.`);
            }
            // A boundary before the reading would be this registry billing a
            // change it had not yet seen -- the retroactive application the
            // whole mechanism exists to prevent, arriving through provenance
            // instead of through rates.
            if (Date.parse(`${revision.verifiedAt}T00:00:00.000Z`) > instant) {
                throw new Error(
                    `${label} takes effect before the date it was verified on, ` +
                        `so it would price requests by a change nobody had read yet.`
                );
            }
        }
        // A revision that reuses the version before it makes two different
        // decisions indistinguishable in every stored snapshot, which is the
        // one thing `pricingVersion` exists to prevent.
        if (versions.has(revision.pricingVersion)) {
            throw new Error(
                `${label} reuses pricingVersion "${revision.pricingVersion}".`
            );
        }
        versions.add(revision.pricingVersion);
        previousInstant = instant;
    }
}

export const getModelPricingProfile = (modelId: string) =>
    pricingById.get(modelId);

export type PricingCostSource =
    | "registry"
    | "registry_long_context"
    | "registry_env_override"
    | "model_registry_override"
    | "conservative_fallback"
    | "conservative_fallback_env_override";

export type ResolvedModelPricing = {
    modelId: string;
    provider: AiProvider;
    apiModelId: string;
    routing: ModelPricingRouting;
    processingTier: ModelProcessingTier;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
    /**
     * What one million cache-*write* tokens cost, or null where this
     * application has no verified rate for the model.
     *
     * Null is not zero and is not "no cache writes happen": it means nobody
     * read the number off the provider's price list, so pricing a write with
     * it would be inventing a figure. `lib/providerUsageCost.ts` refuses to
     * bill writes at a null rate and reports the tokens it could not price,
     * which is how the gap stays visible instead of becoming a silent
     * undercount.
     */
    cacheWriteUsdPerMillionTokens: number | null;
    maxOutputTokens: number;
    /**
     * The provider's absolute settable ceiling, where verified. Null when it
     * is unknown, which is not the same as "equal to what we ask for".
     */
    providerMaxOutputTokens: number | null;
    reservationOutputTokens: number;
    reservationOutputBasis: ModelPricingProfile["reservationOutputBasis"];
    reasoningTokenBilling: ReasoningTokenBilling;
    nativeSearchCostMicroUsdPerQuery?: number;
    /** Prompt-size threshold that selected the applied tier, if any. */
    longContextThresholdTokens: number | null;
    costSource: PricingCostSource;
    priceSource: string;
    pricingVersion: string;
    effectiveDate: string;
    cachedInputPricingVerified: boolean;
    /** True when no explicit profile exists and the class fallback was used. */
    isFallbackPricing: boolean;
};

const modelEnvKey = (modelId: string, suffix: string) =>
    `CHAT_MODEL_${modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${suffix}`;

const positiveNumber = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const boundedMultiplier = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
        ? parsed
        : fallback;
};

/**
 * The revision in force at `at`, or null when the profile's own entry is.
 *
 * Last-wins over a schedule validated to be ascending, so the boundary has a
 * side: a request at exactly `effectiveFrom` is priced by that revision, one a
 * millisecond earlier by what came before. Inclusive-at-the-instant matches
 * how every other UTC boundary in this system is read -- a bucket period
 * starts at its own timestamp -- and leaves no moment that belongs to neither
 * price.
 *
 * An unparseable or absent `at` falls back to now rather than to the oldest
 * entry: a caller that could not say when is asking about today, and answering
 * with a superseded price would be the silent wrong number this whole
 * mechanism exists to avoid.
 */
const selectPriceRevision = (
    profile: ModelPricingProfile,
    at?: Date | number
): ScheduledModelPrice | null => {
    if (!profile.priceSchedule?.length) return null;
    const raw = at instanceof Date ? at.getTime() : at;
    const instant = Number.isFinite(raw) ? (raw as number) : Date.now();
    let selected: ScheduledModelPrice | null = null;
    for (const revision of profile.priceSchedule) {
        if (Date.parse(revision.effectiveFrom) <= instant) {
            selected = revision;
        } else {
            break;
        }
    }
    return selected;
};

const selectTier = (
    tiers: readonly ModelPriceTier[],
    estimatedPromptTokens: number
) => {
    const promptTokens = Number.isFinite(estimatedPromptTokens)
        ? Math.max(0, estimatedPromptTokens)
        : 0;
    for (let index = 0; index < tiers.length; index += 1) {
        const tier = tiers[index];
        if (tier.maxPromptTokens === null || promptTokens <= tier.maxPromptTokens) {
            return { tier, index };
        }
    }
    return { tier: tiers[tiers.length - 1], index: tiers.length - 1 };
};

type PricedModel = Pick<
    AiModel,
    | "id"
    | "usageClass"
    | "provider"
    | "apiModel"
    | "maxOutputTokens"
    | "reservationOutputTokens"
    | "inputUsdPerMillionTokens"
    | "outputUsdPerMillionTokens"
    | "cachedInputPriceMultiplier"
>;

/**
 * Resolves the price actually applied to one request.
 *
 * Precedence: DB/admin model-registry override, then environment override,
 * then the explicit registry profile (with the long-context tier chosen from
 * `estimatedPromptTokens`), then the conservative class fallback.
 */
export const resolveModelPricing = (
    model: PricedModel,
    options?: {
        estimatedPromptTokens?: number;
        /**
         * The instant to price for. Defaults to now.
         *
         * Passed rather than read from the clock inside so two things can be
         * true at once: a live request prices at the rates in force when it is
         * dispatched, and a report or a reconciliation can re-derive what a
         * past request was priced at by naming its own date. It never rewrites
         * a stored snapshot -- those already carry their rates and their
         * `pricingVersion`; this only answers what the registry said at a
         * moment.
         */
        at?: Date | number;
    }
): ResolvedModelPricing => {
    const profile = pricingById.get(model.id);
    const revision = profile
        ? selectPriceRevision(profile, options?.at)
        : null;
    const fallback = FALLBACK_PRICING[getModelCostClass(model.usageClass)];
    const tiers = revision?.tiers ?? profile?.tiers ?? fallback.tiers;
    const { tier, index } = selectTier(
        tiers,
        options?.estimatedPromptTokens ?? 0
    );
    const longContextThresholdTokens =
        index > 0 ? tiers[index - 1].maxPromptTokens : null;

    const envInput = process.env[modelEnvKey(model.id, "INPUT_USD_PER_MILLION")];
    const envOutput =
        process.env[modelEnvKey(model.id, "OUTPUT_USD_PER_MILLION")];
    const envCached =
        process.env[modelEnvKey(model.id, "CACHED_INPUT_PRICE_MULTIPLIER")];
    const envMaxOutput =
        process.env[modelEnvKey(model.id, "MAX_OUTPUT_TOKENS")];
    const envReservationOutput =
        process.env[modelEnvKey(model.id, "RESERVATION_OUTPUT_TOKENS")];

    const inputUsdPerMillionTokens =
        model.inputUsdPerMillionTokens ??
        positiveNumber(envInput, tier.inputUsdPerMillionTokens);
    const outputUsdPerMillionTokens =
        model.outputUsdPerMillionTokens ??
        positiveNumber(envOutput, tier.outputUsdPerMillionTokens);
    const cachedInputPriceMultiplier =
        model.cachedInputPriceMultiplier ??
        boundedMultiplier(
            envCached,
            // An explicit model profile wins over provider defaults. This is
            // important for Medium 3.5: its input/output list price is
            // verified, but no model-specific cached-input price was found,
            // so its tier deliberately uses 1 (no discount) rather than the
            // legacy Mistral-wide fallback below.
            profile
                ? tier.cachedInputPriceMultiplier
                : model.provider === "mistral"
                  ? 0.1
                  : model.provider === "zhipu"
                    ? 0.2
                    : tier.cachedInputPriceMultiplier
        );

    const maxOutputTokens = Math.floor(
        model.maxOutputTokens ??
            positiveNumber(
                envMaxOutput,
                profile?.maxOutputTokens ?? fallback.maxOutputTokens
            )
    );
    const reservationOutputTokens = Math.min(
        maxOutputTokens,
        Math.floor(
            model.reservationOutputTokens ??
                positiveNumber(
                    envReservationOutput,
                    profile?.reservationOutputTokens ??
                        fallback.reservationOutputTokens
                )
        )
    );

    const hasRegistryOverride =
        model.inputUsdPerMillionTokens !== undefined ||
        model.outputUsdPerMillionTokens !== undefined ||
        model.cachedInputPriceMultiplier !== undefined;
    const hasEnvOverride = Boolean(envInput || envOutput || envCached);

    const costSource: PricingCostSource = hasRegistryOverride
        ? "model_registry_override"
        : hasEnvOverride
          ? profile
              ? "registry_env_override"
              : "conservative_fallback_env_override"
          : profile
            ? index > 0
                ? "registry_long_context"
                : "registry"
            : "conservative_fallback";

    return {
        modelId: model.id,
        provider: model.provider,
        apiModelId: profile?.apiModelId ?? model.apiModel,
        routing: profile?.routing ?? "direct_provider_api",
        processingTier: profile?.processingTier ?? "standard",
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
        cachedInputPriceMultiplier,
        // Deliberately *not* env- or DB-overridable, unlike the three rates
        // above. There is no admin control for a cache-write rate and adding
        // one through the back door would let an override move a price nobody
        // can see in the console. A model whose input rate is overridden keeps
        // whatever verified write rate the registry holds, and the resolved
        // pair is checked for consistency by `npm run check:model-pricing`.
        cacheWriteUsdPerMillionTokens:
            tier.cacheWriteUsdPerMillionTokens ?? null,
        maxOutputTokens,
        providerMaxOutputTokens: profile?.providerMaxOutputTokens ?? null,
        reservationOutputTokens,
        reservationOutputBasis:
            profile?.reservationOutputBasis ?? fallback.reservationOutputBasis,
        reasoningTokenBilling:
            profile?.reasoningTokenBilling ?? fallback.reasoningTokenBilling,
        nativeSearchCostMicroUsdPerQuery:
            profile?.nativeSearchCostMicroUsdPerQuery ??
            getNativeSearchCostMicroUsdPerQuery(model.provider),
        longContextThresholdTokens,
        costSource,
        // The revision in force wins over the profile's original entry, and
        // both lose to no profile at all. Reading these three off the same
        // `revision ?? profile ?? fallback` chain as `tiers` above is what
        // keeps a snapshot's rates and its `pricingVersion` describing one
        // decision: taking the rates from a revision and the version from the
        // profile would file a settlement under a price it was not charged.
        priceSource:
            revision?.priceSource ?? profile?.priceSource ?? fallback.priceSource,
        pricingVersion:
            revision?.pricingVersion ??
            profile?.pricingVersion ??
            fallback.pricingVersion,
        effectiveDate:
            revision?.effectiveDate ??
            profile?.effectiveDate ??
            fallback.effectiveDate,
        cachedInputPricingVerified:
            profile?.cachedInputPricingVerified ??
            fallback.cachedInputPricingVerified,
        isFallbackPricing: !profile,
    };
};

/**
 * How long a premium model may stay on the conservative fallback before the CI
 * warning becomes a failure. Pending is a temporary state with a deadline, not
 * a resting place.
 */
export const PENDING_PRICE_VERIFICATION_WINDOW_DAYS = 90;

export type PendingVerifiedPriceEntry = {
    modelId: string;
    /**
     * Who is accountable for verifying the price. `null` means unassigned --
     * reported as a warning, and the entry still expires on schedule.
     */
    owner: string | null;
    /** Tracking issue for the verification. `null` means not filed yet. */
    verificationTicket: string | null;
    /** ISO date (UTC) the model was accepted onto the fallback. */
    registeredAt: string;
    /** ISO date (UTC) after which the check fails instead of warning. */
    expiresAt: string;
    /**
     * Explicit sign-off to keep the model enabled in production while its price
     * is unverified. Pricing a model conservatively is a billing decision, so
     * it needs an owner's name on it separately from the code review that added
     * the entry. `null` means nobody has approved it.
     */
    productionApproval: {
        approvedBy: string;
        approvedAt: string;
        rationale: string;
    } | null;
    /**
     * Where the settled cost comes from once the response arrives.
     * `provider_reported_usage` means the fallback rates only ever size the
     * up-front reservation and never reach a settled figure.
     */
    settlementSource: "reservation_pricing" | "provider_reported_usage";
    note?: string;
};

/**
 * Enabled premium models that are knowingly still on the conservative fallback
 * because no verified price source has been recorded for them yet.
 *
 * This register exists so the check below can be fail-closed for *new* models
 * without silently blessing the ones that predate it. Being on it is not an
 * exemption: the fallback deliberately overstates cost (US$15/US$60), which
 * over-sizes reservations, rejects some requests earlier than the real price
 * would, and -- everywhere settlement uses the reservation rates -- records an
 * internal cost above what the provider actually charged. Each entry carries an
 * owner, a verification ticket and an expiry so that state is tracked rather
 * than tolerated. Adding a new model here instead of pricing it is a
 * regression, not a fix.
 *
 * See docs/policy/credit-and-cost-limits.md, "검증 대기 가격 운영".
 */
export const PENDING_VERIFIED_PRICE_REGISTER: readonly PendingVerifiedPriceEntry[] =
    [
        // Empty, and that is the point of the register rather than a gap in it.
        //
        // grok-4-5 left once its real profile went in from xAI's published
        // rates. grok-4 left for the other reason an entry stops being needed:
        // it is retired, so findUnpricedModels filters it out by `enabled`.
        //
        // mistral-large-3 (#246), qwen3.7-max (#247) and
        // perplexity/sonar-deep-research (#248) left on 2026-08-04 when their
        // published prices were recorded above, well inside the 2026-10-30
        // review date this register was holding them to. All three had been
        // reserving at the US$15 / US$60 premium fallback -- thirty times
        // mistral-large-3's real input rate, six times qwen3.7-max's.
        //
        // A model belongs here only while it is enabled in production with no
        // verified price. `npm run check:model-pricing` fails closed on any
        // premium model that is unpriced and missing from this list, so leaving
        // it empty is safe: the next one that appears cannot go unnoticed.
    ];

/** The register's model IDs, in registration order. */
export const PENDING_VERIFIED_PRICE_MODEL_IDS: readonly string[] =
    PENDING_VERIFIED_PRICE_REGISTER.map((entry) => entry.modelId);

export type UnpricedModel = {
    modelId: string;
    provider: AiProvider;
    usageClass: ModelUsageClass;
    costClass: ModelCostClass;
    severity: "error" | "warning";
};

/**
 * Enabled models with no explicit pricing profile and no complete
 * registry/environment price override. A premium-class model in this state is
 * an error: it is the exact condition that mispriced GPT-5.5 / Gemini 3.1 Pro /
 * Claude Opus 4.8 at US$15/US$60. Cheaper classes are warnings, because their
 * fallback is close enough to real list prices to be safe while a profile is
 * added.
 *
 * "Complete" is load-bearing. `resolveModelPricing` falls back to the class
 * price for each side independently, so a row carrying only an input price
 * bills its *output* on the conservative fallback -- and output is the
 * expensive half. Asking for both ends together, from either source, is what
 * makes "this model is priced" mean what it says.
 */
export const findUnpricedModels = (
    models: readonly Pick<
        AiModel,
        | "id"
        | "provider"
        | "usageClass"
        | "enabled"
        | "inputUsdPerMillionTokens"
        | "outputUsdPerMillionTokens"
    >[]
): UnpricedModel[] =>
    models
        .filter((model) => model.enabled)
        .filter((model) => !pricingById.has(model.id))
        .filter((model) => {
            // Per side, from either source: a registry column and an
            // environment override are interchangeable, a missing pair is not.
            const inputPriced =
                model.inputUsdPerMillionTokens !== undefined ||
                Boolean(process.env[modelEnvKey(model.id, "INPUT_USD_PER_MILLION")]);
            const outputPriced =
                model.outputUsdPerMillionTokens !== undefined ||
                Boolean(process.env[modelEnvKey(model.id, "OUTPUT_USD_PER_MILLION")]);
            return !(inputPriced && outputPriced);
        })
        .map((model) => {
            const costClass = getModelCostClass(model.usageClass);
            return {
                modelId: model.id,
                provider: model.provider,
                usageClass: model.usageClass,
                costClass,
                severity:
                    costClass === "premium" &&
                    !PENDING_VERIFIED_PRICE_MODEL_IDS.includes(model.id)
                        ? ("error" as const)
                        : ("warning" as const),
            };
        });

/**
 * Fail-closed guard for startup and CI. Throws when an enabled premium-class
 * model would fall back to generic pricing.
 */
export const assertPricedPremiumModels = (
    models: Parameters<typeof findUnpricedModels>[0]
) => {
    const unpriced = findUnpricedModels(models);
    const errors = unpriced.filter((entry) => entry.severity === "error");
    if (errors.length > 0) {
        throw new Error(
            `Enabled premium models have no explicit billing profile: ${errors
                .map((entry) => entry.modelId)
                .join(", ")}. Add them to lib/modelPricing.ts before enabling them.`
        );
    }
    return unpriced;
};

export type PendingPriceProblem = {
    severity: "error" | "warning";
    modelId: string;
    reason:
        | "expired"
        | "priced"
        | "duplicate"
        | "invalid_dates"
        | "unassigned_owner"
        | "missing_ticket"
        | "unapproved_production";
    message: string;
};

const parseRegisterDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
};

export const daysUntil = (expiresAt: string, now: Date) => {
    const date = parseRegisterDate(expiresAt);
    if (!date) return null;
    return Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
};

/**
 * Everything wrong with the pending-price register, checked together.
 *
 * Errors fail CI; warnings are reported and left. The split is deliberate: an
 * unassigned owner is a gap someone has to fill, while an expired entry means
 * the model has been billed at a knowingly wrong internal price for a full
 * verification window and the warning has stopped working.
 *
 * This is a CI and review check, not a startup guard. A date passing must never
 * take production down -- `assertPricedPremiumModels` stays the runtime gate,
 * and it only rejects models that were never registered at all.
 */
export const findPendingPriceRegisterProblems = ({
    models,
    now = new Date(),
    register = PENDING_VERIFIED_PRICE_REGISTER,
}: {
    models: Parameters<typeof findUnpricedModels>[0];
    now?: Date;
    register?: readonly PendingVerifiedPriceEntry[];
}): PendingPriceProblem[] => {
    const problems: PendingPriceProblem[] = [];
    const unpriced = findUnpricedModels(models);
    const seen = new Set<string>();

    for (const entry of register) {
        if (seen.has(entry.modelId)) {
            problems.push({
                severity: "error",
                modelId: entry.modelId,
                reason: "duplicate",
                message: `${entry.modelId} is listed twice in PENDING_VERIFIED_PRICE_REGISTER.`,
            });
            continue;
        }
        seen.add(entry.modelId);

        if (!unpriced.some((model) => model.modelId === entry.modelId)) {
            problems.push({
                severity: "error",
                modelId: entry.modelId,
                reason: "priced",
                message: `${entry.modelId} has an explicit pricing profile now and must leave PENDING_VERIFIED_PRICE_REGISTER.`,
            });
            continue;
        }

        const registeredAt = parseRegisterDate(entry.registeredAt);
        const expiresAt = parseRegisterDate(entry.expiresAt);
        if (!registeredAt || !expiresAt || expiresAt <= registeredAt) {
            problems.push({
                severity: "error",
                modelId: entry.modelId,
                reason: "invalid_dates",
                message: `${entry.modelId} needs a YYYY-MM-DD registeredAt and a later expiresAt (got ${entry.registeredAt} to ${entry.expiresAt}).`,
            });
        } else if (expiresAt.getTime() <= now.getTime()) {
            const overdue = Math.floor(
                (now.getTime() - expiresAt.getTime()) / 86_400_000
            );
            problems.push({
                severity: "error",
                modelId: entry.modelId,
                reason: "expired",
                message: `${entry.modelId} has been on the conservative fallback past its ${entry.expiresAt} deadline (${overdue} day(s) overdue). Add a verified pricing profile, or re-approve production enablement and set a new deadline.`,
            });
        }

        if (!entry.owner) {
            problems.push({
                severity: "warning",
                modelId: entry.modelId,
                reason: "unassigned_owner",
                message: `${entry.modelId} has no price-verification owner.`,
            });
        }
        if (!entry.verificationTicket) {
            problems.push({
                severity: "warning",
                modelId: entry.modelId,
                reason: "missing_ticket",
                message: `${entry.modelId} has no verification ticket.`,
            });
        }
        if (!entry.productionApproval) {
            problems.push({
                severity: "warning",
                modelId: entry.modelId,
                reason: "unapproved_production",
                message: `${entry.modelId} is enabled in production on an unverified price with no recorded approval.`,
            });
        }
    }

    return problems;
};
