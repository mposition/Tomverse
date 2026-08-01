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
    maxOutputTokens: number;
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
    cachedInputPriceMultiplier = 1
): readonly ModelPriceTier[] => [
    {
        maxPromptTokens: null,
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
        cachedInputPriceMultiplier,
    },
];

const gpt56Tiers = (
    inputUsdPerMillionTokens: number,
    outputUsdPerMillionTokens: number
): readonly ModelPriceTier[] => [
    {
        maxPromptTokens: 272_000,
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: 0.1,
    },
    {
        maxPromptTokens: null,
        inputUsdPerMillionTokens: inputUsdPerMillionTokens * 2,
        outputUsdPerMillionTokens: outputUsdPerMillionTokens * 1.5,
        cachedInputPriceMultiplier: 0.1,
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
        modelId: "gpt-5-6-luna",
        provider: "openai",
        apiModelId: "gpt-5.6-luna",
        ...DIRECT_STANDARD,
        tiers: gpt56Tiers(0.2, 1.2),
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
        modelId: "claude-opus-4-8",
        provider: "anthropic",
        apiModelId: "claude-opus-4-8",
        ...DIRECT_STANDARD,
        tiers: flatTier(5, 25),
        reasoningTokenBilling: "billed_as_output",
        nativeSearchCostMicroUsdPerQuery: 10_000,
        maxOutputTokens: 8_192,
        reservationOutputTokens: 4_096,
        reservationOutputBasis: "p90_output_tokens",
        cachedInputPricingVerified: false,
        priceSource: "anthropic_standard_api_list_price",
        pricingVersion: "anthropic-claude-opus-4-8-2026-08-01",
        effectiveDate: "2026-08-01",
    },
    // Provider-verified profiles added by the 2026-08-01 catalogue migration.
    {
        modelId: "groq-gpt-oss-120b",
        provider: "groq",
        apiModelId: "openai/gpt-oss-120b",
        ...DIRECT_STANDARD,
        tiers: flatTier(0.15, 0.6, 0.5),
        reasoningTokenBilling: "billed_as_output",
        maxOutputTokens: 65_536,
        reservationOutputTokens: 8_192,
        reservationOutputBasis: "conservative_default",
        cachedInputPricingVerified: true,
        priceSource: "groq_gpt_oss_120b_model_page",
        pricingVersion: "groq-gpt-oss-120b-2026-08-01",
        effectiveDate: "2026-08-01",
    },
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
for (const profile of MODEL_PRICING) {
    if (profile.tiers.length === 0) {
        throw new Error(`Model "${profile.modelId}" declares no price tier.`);
    }
    if (profile.tiers[profile.tiers.length - 1].maxPromptTokens !== null) {
        throw new Error(
            `Model "${profile.modelId}" has no unbounded final price tier.`
        );
    }
    if (profile.reservationOutputTokens > profile.maxOutputTokens) {
        throw new Error(
            `Model "${profile.modelId}" reserves more output than it allows.`
        );
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
    maxOutputTokens: number;
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
    options?: { estimatedPromptTokens?: number }
): ResolvedModelPricing => {
    const profile = pricingById.get(model.id);
    const fallback = FALLBACK_PRICING[getModelCostClass(model.usageClass)];
    const tiers = profile?.tiers ?? fallback.tiers;
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
        maxOutputTokens,
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
        priceSource: profile?.priceSource ?? fallback.priceSource,
        pricingVersion: profile?.pricingVersion ?? fallback.pricingVersion,
        effectiveDate: profile?.effectiveDate ?? fallback.effectiveDate,
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
        {
            modelId: "claude-fable-5",
            owner: null,
            verificationTicket: null,
            registeredAt: "2026-08-01",
            expiresAt: "2026-10-30",
            productionApproval: null,
            settlementSource: "reservation_pricing",
        },
        {
            modelId: "grok-4",
            owner: null,
            verificationTicket: null,
            registeredAt: "2026-08-01",
            expiresAt: "2026-10-30",
            productionApproval: null,
            settlementSource: "reservation_pricing",
        },
        {
            modelId: "mistral-large-3",
            owner: null,
            verificationTicket: null,
            registeredAt: "2026-08-01",
            expiresAt: "2026-10-30",
            productionApproval: null,
            settlementSource: "reservation_pricing",
        },
        {
            modelId: "qwen3.7-max",
            owner: null,
            verificationTicket: null,
            registeredAt: "2026-08-01",
            expiresAt: "2026-10-30",
            productionApproval: null,
            settlementSource: "reservation_pricing",
        },
        {
            modelId: "perplexity/sonar-deep-research",
            owner: null,
            verificationTicket: null,
            registeredAt: "2026-08-01",
            expiresAt: "2026-10-30",
            productionApproval: null,
            settlementSource: "provider_reported_usage",
            note: "Settles from the provider's own reported usage (lib/perplexityUsageCore.ts), so these rates only size the reservation. A deep-research turn issues many search queries and reasoning tokens, so a chat-shaped token reservation mis-sizes it in both directions; a dedicated reservation model is under review against the reserved/settled ratio this register reports.",
        },
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
 * Enabled models with no explicit pricing profile and no registry/environment
 * price override. A premium-class model in this state is an error: it is the
 * exact condition that mispriced GPT-5.5 / Gemini 3.1 Pro / Claude Opus 4.8 at
 * US$15/US$60. Cheaper classes are warnings, because their fallback is close
 * enough to real list prices to be safe while a profile is added.
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
        .filter(
            (model) =>
                model.inputUsdPerMillionTokens === undefined &&
                model.outputUsdPerMillionTokens === undefined &&
                !process.env[modelEnvKey(model.id, "INPUT_USD_PER_MILLION")] &&
                !process.env[modelEnvKey(model.id, "OUTPUT_USD_PER_MILLION")]
        )
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
