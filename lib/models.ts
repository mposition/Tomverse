export type AiProvider =
    | "openai"
    | "anthropic"
    | "google"
    | "groq"
    | "xai"
    | "deepseek"
    | "mistral"
    | "moonshot"
    | "qwen"
    | "zhipu"
    | "perplexity";

export type ModelTier = "Free" | "Pro" | "Max";
export type ModelStatus = "enabled" | "limited" | "disabled" | "coming-soon";
export type ModelUsageClass =
    | "standard"
    | "advanced"
    | "premium"
    | "reasoning"
    | "premium-reasoning"
    | "research"
    | "deep-research";
export type ModelMinimumPlan = "Guest" | "Free" | "Pro";
export type ModelUsageCategory =
    | "Standard"
    | "Advanced"
    | "Premium"
    | "Reasoning"
    | "Research";

export type ModelInputCapabilities = {
    /** The provider model accepts native image content, not only extracted text. */
    image: boolean;
    /** The provider model accepts a PDF binary when text extraction is unavailable. */
    nativePdf: boolean;
    /** Provider limit for images included in one request. */
    maxImages?: number;
    /** Provider limit for the combined base64-encoded image payload. */
    maxBase64ImagePayloadBytes?: number;
};

export const MODEL_USAGE_CREDIT_WEIGHTS = {
    standard: 1,
    advanced: 4,
    premium: 8,
    reasoning: 12,
    premiumReasoning: 16,
    search: 20,
    deepResearch: 30,
} as const;

export const INPUT_CREDIT_MULTIPLIERS = [
    { aboveTokens: 16_000, multiplier: 1.5 },
    { aboveTokens: 50_000, multiplier: 2 },
    { aboveTokens: 100_000, multiplier: 3 },
] as const;

export const getTypicalShortRequestCapacities = (monthlyCredits: number) => {
    const credits =
        Number.isFinite(monthlyCredits) && monthlyCredits > 0
            ? Math.floor(monthlyCredits)
            : 0;
    const mixedComparisonCredits =
        MODEL_USAGE_CREDIT_WEIGHTS.standard +
        MODEL_USAGE_CREDIT_WEIGHTS.advanced +
        MODEL_USAGE_CREDIT_WEIGHTS.premium;

    return {
        standardResponses: Math.floor(
            credits / MODEL_USAGE_CREDIT_WEIGHTS.standard
        ),
        advancedResponses: Math.floor(
            credits / MODEL_USAGE_CREDIT_WEIGHTS.advanced
        ),
        mixedComparisons: Math.floor(credits / mixedComparisonCredits),
        mixedComparisonCredits,
    };
};

export type AiModel = {
    id: string;
    name: string;
    apiModel: string;
    provider: AiProvider;
    icon: string;
    /** Short, model-specific user-facing purpose shown in the model picker. */
    bestFor: string;
    minimumPlan: ModelMinimumPlan;
    usageClass: ModelUsageClass;
    replacementModelId?: string;
    /** Keep historical IDs resolvable while omitting retired models from user catalogues. */
    publiclyListed?: boolean;
    enabled: boolean;
    status: ModelStatus;
    /** Private operational explanation shown only to administrators. */
    operationalReason?: string;
    /** Safe status explanation that may be shown to end users. */
    userVisibleNote?: string;
    reasoning?: "none" | "low" | "medium" | "high";
    /** Published context window for catalogue metadata and request validation. */
    contextWindowTokens?: number;
    /** Explicit per-model native input support. Omitted means text-only. */
    inputCapabilities?: ModelInputCapabilities;
    /** Provider API endpoint. Credentials always remain in environment variables. */
    apiBaseUrl?: string;
    apiKeyEnvName?: string;
    /** Explicit DB-managed base credit cost. Falls back to usageClass defaults. */
    creditWeight?: number;
    catalogDeleted?: boolean;
    sortOrder?: number;
    maxOutputTokens?: number;
    reservationOutputTokens?: number;
    inputUsdPerMillionTokens?: number;
    outputUsdPerMillionTokens?: number;
    cachedInputPriceMultiplier?: number;
};

const FULL_BINARY_INPUT = {
    image: true,
    nativePdf: true,
} as const satisfies ModelInputCapabilities;

export const DEFAULT_MODEL_ID = "gpt-5-4-mini";

export const AVAILABLE_MODELS = [
    { id: "gpt-5-5", name: "GPT-5.5", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", bestFor: "Complex analysis and important decisions", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },
    { id: "gpt-5-5-thinking", name: "GPT-5.5 Thinking", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", bestFor: "Difficult problems that benefit from step-by-step reasoning", minimumPlan: "Pro", usageClass: "premium-reasoning", enabled: true, status: "enabled", reasoning: "high", inputCapabilities: FULL_BINARY_INPUT },
    { id: "gpt-5-4-mini", name: "GPT-5.4 mini", apiModel: "gpt-5.4-mini", provider: "openai", icon: "🤖", bestFor: "Fast everyday questions and concise document work", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },

    { id: "claude-fable-5", name: "Claude Fable 5", apiModel: "claude-fable-5", provider: "anthropic", icon: "🧠", bestFor: "Polished writing, planning, and long-form analysis", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", apiModel: "claude-opus-4-8", provider: "anthropic", icon: "🧠", bestFor: "Nuanced reasoning across demanding, high-stakes tasks", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", apiModel: "claude-sonnet-5", provider: "anthropic", icon: "🧠", bestFor: "Writing, structured analysis, and detailed documents", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", apiModel: "claude-haiku-4-5-20251001", provider: "anthropic", icon: "🧠", bestFor: "Quick summaries, drafting, and lightweight analysis", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },

    { id: "gemini-3-5-flash", name: "Gemini 3.5 Flash", apiModel: "gemini-3.5-flash", provider: "google", icon: "✨", bestFor: "Fast responses with image and file analysis", minimumPlan: "Free", usageClass: "standard", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },
    { id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", apiModel: "gemini-3.1-pro-preview", provider: "google", icon: "✨", bestFor: "Detailed multimodal analysis and complex documents", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },
    { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", apiModel: "gemini-2.5-pro", provider: "google", icon: "✨", bestFor: "Legacy multimodal analysis", minimumPlan: "Free", usageClass: "advanced", replacementModelId: "gemini-3-1-pro", publiclyListed: false, enabled: false, status: "disabled", inputCapabilities: FULL_BINARY_INPUT },
    { id: "gemini-2-5-flash", name: "Gemini 3.1 Flash-Lite", apiModel: "gemini-3.1-flash-lite", provider: "google", icon: "✨", bestFor: "Low-cost everyday tasks and quick file questions", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled", inputCapabilities: FULL_BINARY_INPUT },

    { id: "llama-3-1", name: "Llama 3.1", apiModel: "llama-3.1-8b-instant", provider: "groq", icon: "∞", bestFor: "Very fast, lightweight text questions", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "llama-4-scout", name: "Llama 4 Scout", apiModel: "meta-llama/llama-4-scout-17b-16e-instruct", provider: "groq", icon: "∞", bestFor: "Fast visual questions and long-context exploration", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled", contextWindowTokens: 131_072, inputCapabilities: { image: true, nativePdf: false, maxImages: 5, maxBase64ImagePayloadBytes: 4 * 1024 * 1024 } },
    { id: "llama-3-3", name: "Llama 3.3", apiModel: "llama-3.3-70b-versatile", provider: "groq", icon: "∞", bestFor: "Broad open-model text analysis and instruction following", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },

    { id: "grok-4", name: "Grok 4", apiModel: "grok-4", provider: "xai", icon: "𝕏", bestFor: "Current-events discussion and broad advanced analysis", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "grok-4-5", name: "Grok 4.5", apiModel: "grok-4.5", provider: "xai", icon: "𝕏", bestFor: "Deep reasoning on complex technical and analytical tasks", minimumPlan: "Pro", usageClass: "premium-reasoning", enabled: true, status: "enabled", reasoning: "high" },
    { id: "grok-3", name: "Grok 3", apiModel: "grok-3", provider: "xai", icon: "𝕏", bestFor: "General analysis with a direct conversational style", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "grok-3-mini", name: "Grok 3 Mini", apiModel: "grok-3-mini", provider: "xai", icon: "𝕏", bestFor: "Fast, concise everyday answers", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4 Flash", apiModel: "deepseek-v4-flash", provider: "deepseek", icon: "DS", bestFor: "Fast coding help and technical questions", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4 Pro", apiModel: "deepseek-v4-pro", provider: "deepseek", icon: "DS", bestFor: "Cost-efficient technical analysis and coding", minimumPlan: "Free", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "deepseek-r1", name: "DeepSeek R1 Reasoning", apiModel: "deepseek-reasoner", provider: "deepseek", icon: "DS", bestFor: "Math, code, and problems requiring explicit reasoning", minimumPlan: "Free", usageClass: "reasoning", enabled: true, status: "enabled", reasoning: "high" },
    { id: "mistral-small-4", name: "Mistral Small 4", apiModel: "mistral-small-latest", provider: "mistral", icon: "M", bestFor: "Efficient multilingual writing and everyday tasks", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "mistral-large-3", name: "Mistral Large 3", apiModel: "mistral-large-latest", provider: "mistral", icon: "M", bestFor: "High-quality multilingual analysis and long-form work", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "mistral-medium-3-1", name: "Mistral Medium 3.1", apiModel: "mistral-medium-latest", provider: "mistral", icon: "M", bestFor: "Balanced multilingual drafting and analysis", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "codestral", name: "Codestral", apiModel: "codestral-latest", provider: "mistral", icon: "M", bestFor: "Code generation, completion, and repository questions", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7", apiModel: "kimi-k2.7-code", provider: "moonshot", icon: "KM", bestFor: "Coding tasks and long technical context", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max", apiModel: "qwen3.7-max", provider: "qwen", icon: "QW", bestFor: "Demanding multilingual reasoning and complex instructions", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", apiModel: "qwen3.7-plus", provider: "qwen", icon: "QW", bestFor: "Balanced multilingual analysis and business writing", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "qwen3.6-flash", name: "Qwen 3.6", apiModel: "qwen3.6-flash", provider: "qwen", icon: "QW", bestFor: "Fast multilingual questions and translation", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "glm-5.2", name: "GLM 5.2", apiModel: "glm-5.2", provider: "zhipu", icon: "Z", bestFor: "General multilingual chat and concise task support", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "perplexity/sonar", name: "Perplexity Sonar", apiModel: "sonar", provider: "perplexity", icon: "P", bestFor: "Quick web searches with cited answers", minimumPlan: "Free", usageClass: "research", enabled: true, status: "enabled" },
    { id: "perplexity/sonar-pro", name: "Perplexity Sonar Pro", apiModel: "sonar-pro", provider: "perplexity", icon: "P", bestFor: "Thorough web research with stronger source coverage", minimumPlan: "Free", usageClass: "research", enabled: true, status: "enabled" },
    { id: "perplexity/sonar-reasoning-pro", name: "Perplexity Sonar Reasoning Pro", apiModel: "sonar-reasoning-pro", provider: "perplexity", icon: "P", bestFor: "Source-backed research that also requires reasoning", minimumPlan: "Pro", usageClass: "research", enabled: true, status: "enabled", reasoning: "high" },
    { id: "perplexity/sonar-deep-research", name: "Perplexity Sonar Deep Research", apiModel: "sonar-deep-research", provider: "perplexity", icon: "P", bestFor: "Extended research across many web sources", minimumPlan: "Pro", usageClass: "deep-research", enabled: true, status: "enabled", reasoning: "high" },
] as const satisfies readonly AiModel[];

export type ModelId = (typeof AVAILABLE_MODELS)[number]["id"];

const uniqueModelIds = new Set(AVAILABLE_MODELS.map((model) => model.id));
if (uniqueModelIds.size !== AVAILABLE_MODELS.length) {
    throw new Error("Model registry contains duplicate IDs.");
}
for (const model of AVAILABLE_MODELS) {
    if (!model.apiModel.trim()) {
        throw new Error(`Model "${model.id}" is missing apiModel.`);
    }
    if (model.enabled !== (model.status === "enabled")) {
        throw new Error(`Model "${model.id}" has inconsistent enabled status.`);
    }
}

const modelMap = new Map<string, AiModel>(
    AVAILABLE_MODELS.map((model) => [model.id, model])
);

export const ENABLED_MODELS = AVAILABLE_MODELS.filter(
    (model) => model.enabled
);

export const PUBLIC_MODELS: readonly AiModel[] = AVAILABLE_MODELS.filter(
    (model) => (model as AiModel).publiclyListed !== false
);

export const getModel = (modelId: string) => modelMap.get(modelId);

export const modelSupportsImageInput = (
    model: Pick<AiModel, "id" | "inputCapabilities">
) => model.inputCapabilities?.image === true;

export const modelSupportsNativePdfInput = (
    model: Pick<AiModel, "id" | "inputCapabilities">
) => model.inputCapabilities?.nativePdf === true;

export const getEnabledModel = (modelId: string) => {
    const model = getModel(modelId);
    return model?.enabled ? model : undefined;
};

const MODEL_ACCESS_RANK: Record<ModelMinimumPlan | ModelTier, number> = {
    Guest: 0,
    Free: 1,
    Pro: 2,
    Max: 2,
};

export const canUseModelWithPlan = (
    plan: ModelTier | "Guest",
    model: Pick<AiModel, "minimumPlan">
) => MODEL_ACCESS_RANK[plan] >= MODEL_ACCESS_RANK[model.minimumPlan];

export const getModelUsageProfile = (
    model: Pick<AiModel, "usageClass" | "creditWeight">
): { category: ModelUsageCategory; credits: number } => {
    const explicitCredits =
        Number.isInteger(model.creditWeight) && (model.creditWeight || 0) > 0
            ? model.creditWeight
            : undefined;
    switch (model.usageClass) {
        case "standard":
            return { category: "Standard", credits: explicitCredits ?? MODEL_USAGE_CREDIT_WEIGHTS.standard };
        case "advanced":
            return { category: "Advanced", credits: explicitCredits ?? MODEL_USAGE_CREDIT_WEIGHTS.advanced };
        case "premium":
            return { category: "Premium", credits: explicitCredits ?? MODEL_USAGE_CREDIT_WEIGHTS.premium };
        case "reasoning":
            return { category: "Reasoning", credits: explicitCredits ?? MODEL_USAGE_CREDIT_WEIGHTS.reasoning };
        case "premium-reasoning":
            return { category: "Reasoning", credits: explicitCredits ?? MODEL_USAGE_CREDIT_WEIGHTS.premiumReasoning };
        case "research":
            return { category: "Research", credits: explicitCredits ?? MODEL_USAGE_CREDIT_WEIGHTS.search };
        case "deep-research":
            return { category: "Research", credits: explicitCredits ?? MODEL_USAGE_CREDIT_WEIGHTS.deepResearch };
    }
};

export const getModelUsageCredits = (
    model: Pick<AiModel, "usageClass" | "creditWeight">
) => getModelUsageProfile(model).credits;

export const getInputCreditMultiplier = (estimatedInputTokens: number) => {
    let multiplier = 1;
    for (const threshold of INPUT_CREDIT_MULTIPLIERS) {
        if (estimatedInputTokens > threshold.aboveTokens) {
            multiplier = threshold.multiplier;
        }
    }
    return multiplier;
};

export const getWeightedUsageCredits = (
    model: Pick<AiModel, "usageClass" | "creditWeight">,
    estimatedInputTokens: number
) =>
    Math.ceil(
        getModelUsageCredits(model) *
            getInputCreditMultiplier(estimatedInputTokens)
    );

export type UsageCreditOutcome =
    | "completed"
    | "cancelled"
    | "failed"
    | "empty";

export const getSettledUsageCredits = ({
    reservedCredits,
    reservedInputTokens,
    reservedOutputTokens,
    actualInputTokens,
    actualOutputTokens,
    outcome,
}: {
    reservedCredits: number;
    reservedInputTokens: number;
    reservedOutputTokens: number;
    actualInputTokens: number;
    actualOutputTokens: number;
    outcome: UsageCreditOutcome;
}) => {
    if (outcome === "completed") return reservedCredits;
    if (outcome !== "cancelled" || actualOutputTokens <= 16) return 0;

    const reservedTokens = reservedInputTokens + reservedOutputTokens;
    const actualTokens = actualInputTokens + actualOutputTokens;
    return Math.min(
        reservedCredits,
        Math.max(
            1,
            Math.ceil(
                reservedCredits * (actualTokens / Math.max(1, reservedTokens))
            )
        )
    );
};

export type ModelBillingProfile = {
    maxOutputTokens: number;
    reservationOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
};

type ModelCostClass = "standard" | "advanced" | "premium";

const BILLING_DEFAULTS: Record<ModelCostClass, ModelBillingProfile> = {
    standard: {
        maxOutputTokens: 2_048,
        reservationOutputTokens: 1_024,
        inputUsdPerMillionTokens: 0.5,
        outputUsdPerMillionTokens: 1,
        cachedInputPriceMultiplier: 1,
    },
    advanced: {
        maxOutputTokens: 4_096,
        reservationOutputTokens: 2_048,
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 12,
        cachedInputPriceMultiplier: 1,
    },
    premium: {
        maxOutputTokens: 8_192,
        reservationOutputTokens: 2_048,
        inputUsdPerMillionTokens: 15,
        outputUsdPerMillionTokens: 60,
        cachedInputPriceMultiplier: 1,
    },
};

const getModelCostClass = (usageClass: ModelUsageClass): ModelCostClass => {
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

const MODEL_BILLING_DEFAULTS: Partial<
    Record<string, Partial<ModelBillingProfile>>
> = {
    "llama-4-scout": {
        maxOutputTokens: 8_192,
        reservationOutputTokens: 2_048,
        inputUsdPerMillionTokens: 0.11,
        outputUsdPerMillionTokens: 0.34,
        cachedInputPriceMultiplier: 1,
    },
    "deepseek-v4-flash": {
        inputUsdPerMillionTokens: 0.14,
        outputUsdPerMillionTokens: 0.28,
        cachedInputPriceMultiplier: 0.02,
    },
    "deepseek-v4-pro": {
        maxOutputTokens: 4_096,
        reservationOutputTokens: 2_048,
        inputUsdPerMillionTokens: 0.435,
        outputUsdPerMillionTokens: 0.87,
        cachedInputPriceMultiplier: 1 / 120,
    },
    "deepseek-r1": {
        inputUsdPerMillionTokens: 0.14,
        outputUsdPerMillionTokens: 0.28,
        cachedInputPriceMultiplier: 0.02,
    },
};

const modelEnvKey = (modelId: string, suffix: string) =>
    `CHAT_MODEL_${modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${suffix}`;

const positiveNumber = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const priceMultiplier = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
        ? parsed
        : fallback;
};

export const getModelBillingProfile = (
    model: Pick<AiModel, "id" | "usageClass" | "provider" | "maxOutputTokens" | "reservationOutputTokens" | "inputUsdPerMillionTokens" | "outputUsdPerMillionTokens" | "cachedInputPriceMultiplier">
): ModelBillingProfile => {
    const defaults = {
        ...BILLING_DEFAULTS[getModelCostClass(model.usageClass)],
        ...MODEL_BILLING_DEFAULTS[model.id],
    };
    const maxOutputTokens = Math.floor(model.maxOutputTokens ?? positiveNumber(
        process.env[modelEnvKey(model.id, "MAX_OUTPUT_TOKENS")],
        defaults.maxOutputTokens
    ));
    const reservationOutputTokens = Math.min(
        maxOutputTokens,
        Math.floor(
            model.reservationOutputTokens ?? positiveNumber(
                process.env[
                    modelEnvKey(model.id, "RESERVATION_OUTPUT_TOKENS")
                ],
                defaults.reservationOutputTokens
            )
        )
    );
    return {
        maxOutputTokens,
        reservationOutputTokens,
        inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? positiveNumber(
            process.env[modelEnvKey(model.id, "INPUT_USD_PER_MILLION")],
            defaults.inputUsdPerMillionTokens
        ),
        outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? positiveNumber(
            process.env[modelEnvKey(model.id, "OUTPUT_USD_PER_MILLION")],
            defaults.outputUsdPerMillionTokens
        ),
        cachedInputPriceMultiplier: model.cachedInputPriceMultiplier ?? priceMultiplier(
            process.env[
                modelEnvKey(model.id, "CACHED_INPUT_PRICE_MULTIPLIER")
            ],
            model.provider === "mistral"
                ? 0.1
                : model.provider === "zhipu"
                  ? 0.2
                  : defaults.cachedInputPriceMultiplier
        ),
    };
};

export const isEnabledModelId = (modelId: string) =>
    getEnabledModel(modelId) !== undefined;

if (!isEnabledModelId(DEFAULT_MODEL_ID)) {
    throw new Error(`Default model "${DEFAULT_MODEL_ID}" must be enabled.`);
}
