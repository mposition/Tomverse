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
export type ModelStatus = "enabled" | "disabled" | "coming-soon";
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
    minimumPlan: ModelMinimumPlan;
    usageClass: ModelUsageClass;
    replacementModelId?: string;
    /** Keep historical IDs resolvable while omitting retired models from user catalogues. */
    publiclyListed?: boolean;
    enabled: boolean;
    status: ModelStatus;
    reasoning?: "none" | "low" | "medium" | "high";
};

export const DEFAULT_MODEL_ID = "gpt-5-4-mini";

export const AVAILABLE_MODELS = [
    { id: "gpt-5-5", name: "GPT-5.5", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "gpt-5-5-thinking", name: "GPT-5.5 Thinking", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", minimumPlan: "Pro", usageClass: "premium-reasoning", enabled: true, status: "enabled", reasoning: "high" },
    { id: "gpt-5-4-mini", name: "GPT-5.4 mini", apiModel: "gpt-5.4-mini", provider: "openai", icon: "🤖", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },

    { id: "claude-fable-5", name: "Claude Fable 5", apiModel: "claude-fable-5", provider: "anthropic", icon: "🧠", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", apiModel: "claude-opus-4-8", provider: "anthropic", icon: "🧠", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", apiModel: "claude-sonnet-5", provider: "anthropic", icon: "🧠", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", apiModel: "claude-haiku-4-5-20251001", provider: "anthropic", icon: "🧠", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },

    { id: "gemini-3-5-flash", name: "Gemini 3.5 Flash", apiModel: "gemini-3.5-flash", provider: "google", icon: "✨", minimumPlan: "Free", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", apiModel: "gemini-3.1-pro-preview", provider: "google", icon: "✨", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", apiModel: "gemini-2.5-pro", provider: "google", icon: "✨", minimumPlan: "Free", usageClass: "advanced", replacementModelId: "gemini-3-1-pro", publiclyListed: false, enabled: false, status: "disabled" },
    { id: "gemini-2-5-flash", name: "Gemini 3.1 Flash-Lite", apiModel: "gemini-3.1-flash-lite", provider: "google", icon: "✨", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },

    { id: "llama-3-1", name: "Llama 3.1", apiModel: "llama-3.1-8b-instant", provider: "groq", icon: "∞", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "llama-3-3", name: "Llama 3.3", apiModel: "llama-3.3-70b-versatile", provider: "groq", icon: "∞", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },

    { id: "grok-4", name: "Grok 4", apiModel: "grok-4", provider: "xai", icon: "𝕏", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "grok-4-5", name: "Grok 4.5", apiModel: "grok-4.5", provider: "xai", icon: "𝕏", minimumPlan: "Pro", usageClass: "premium-reasoning", enabled: true, status: "enabled", reasoning: "high" },
    { id: "grok-3", name: "Grok 3", apiModel: "grok-3", provider: "xai", icon: "𝕏", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "grok-3-mini", name: "Grok 3 Mini", apiModel: "grok-3-mini", provider: "xai", icon: "𝕏", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4 Flash", apiModel: "deepseek-v4-flash", provider: "deepseek", icon: "DS", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4 Pro", apiModel: "deepseek-v4-pro", provider: "deepseek", icon: "DS", minimumPlan: "Free", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "deepseek-r1", name: "DeepSeek R1 Reasoning", apiModel: "deepseek-reasoner", provider: "deepseek", icon: "DS", minimumPlan: "Free", usageClass: "reasoning", enabled: true, status: "enabled", reasoning: "high" },
    { id: "mistral-small-4", name: "Mistral Small 4", apiModel: "mistral-small-latest", provider: "mistral", icon: "M", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "mistral-large-3", name: "Mistral Large 3", apiModel: "mistral-large-latest", provider: "mistral", icon: "M", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "mistral-medium-3-1", name: "Mistral Medium 3.1", apiModel: "mistral-medium-latest", provider: "mistral", icon: "M", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "codestral", name: "Codestral", apiModel: "codestral-latest", provider: "mistral", icon: "M", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7", apiModel: "kimi-k2.7-code", provider: "moonshot", icon: "KM", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max", apiModel: "qwen3.7-max", provider: "qwen", icon: "QW", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", apiModel: "qwen3.7-plus", provider: "qwen", icon: "QW", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "qwen3.6-flash", name: "Qwen 3.6", apiModel: "qwen3.6-flash", provider: "qwen", icon: "QW", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "glm-5.2", name: "GLM 5.2", apiModel: "glm-5.2", provider: "zhipu", icon: "Z", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "perplexity/sonar", name: "Perplexity Sonar", apiModel: "sonar", provider: "perplexity", icon: "P", minimumPlan: "Free", usageClass: "research", enabled: true, status: "enabled" },
    { id: "perplexity/sonar-pro", name: "Perplexity Sonar Pro", apiModel: "sonar-pro", provider: "perplexity", icon: "P", minimumPlan: "Free", usageClass: "research", enabled: true, status: "enabled" },
    { id: "perplexity/sonar-reasoning-pro", name: "Perplexity Sonar Reasoning Pro", apiModel: "sonar-reasoning-pro", provider: "perplexity", icon: "P", minimumPlan: "Pro", usageClass: "research", enabled: true, status: "enabled", reasoning: "high" },
    { id: "perplexity/sonar-deep-research", name: "Perplexity Sonar Deep Research", apiModel: "sonar-deep-research", provider: "perplexity", icon: "P", minimumPlan: "Pro", usageClass: "deep-research", enabled: true, status: "enabled", reasoning: "high" },
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
    model: Pick<AiModel, "usageClass">
): { category: ModelUsageCategory; credits: number } => {
    switch (model.usageClass) {
        case "standard":
            return { category: "Standard", credits: MODEL_USAGE_CREDIT_WEIGHTS.standard };
        case "advanced":
            return { category: "Advanced", credits: MODEL_USAGE_CREDIT_WEIGHTS.advanced };
        case "premium":
            return { category: "Premium", credits: MODEL_USAGE_CREDIT_WEIGHTS.premium };
        case "reasoning":
            return { category: "Reasoning", credits: MODEL_USAGE_CREDIT_WEIGHTS.reasoning };
        case "premium-reasoning":
            return { category: "Reasoning", credits: MODEL_USAGE_CREDIT_WEIGHTS.premiumReasoning };
        case "research":
            return { category: "Research", credits: MODEL_USAGE_CREDIT_WEIGHTS.search };
        case "deep-research":
            return { category: "Research", credits: MODEL_USAGE_CREDIT_WEIGHTS.deepResearch };
    }
};

export const getModelUsageCredits = (
    model: Pick<AiModel, "usageClass">
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
    model: Pick<AiModel, "usageClass">,
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
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
};

type ModelCostClass = "standard" | "advanced" | "premium";

const BILLING_DEFAULTS: Record<ModelCostClass, ModelBillingProfile> = {
    standard: {
        maxOutputTokens: 2_048,
        inputUsdPerMillionTokens: 0.5,
        outputUsdPerMillionTokens: 1,
        cachedInputPriceMultiplier: 1,
    },
    advanced: {
        maxOutputTokens: 4_096,
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 12,
        cachedInputPriceMultiplier: 1,
    },
    premium: {
        maxOutputTokens: 8_192,
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
    "deepseek-v4-flash": {
        inputUsdPerMillionTokens: 0.14,
        outputUsdPerMillionTokens: 0.28,
        cachedInputPriceMultiplier: 0.02,
    },
    "deepseek-v4-pro": {
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
    model: Pick<AiModel, "id" | "usageClass" | "provider">
): ModelBillingProfile => {
    const defaults = {
        ...BILLING_DEFAULTS[getModelCostClass(model.usageClass)],
        ...MODEL_BILLING_DEFAULTS[model.id],
    };
    return {
        maxOutputTokens: Math.floor(
            positiveNumber(
                process.env[modelEnvKey(model.id, "MAX_OUTPUT_TOKENS")],
                defaults.maxOutputTokens
            )
        ),
        inputUsdPerMillionTokens: positiveNumber(
            process.env[modelEnvKey(model.id, "INPUT_USD_PER_MILLION")],
            defaults.inputUsdPerMillionTokens
        ),
        outputUsdPerMillionTokens: positiveNumber(
            process.env[modelEnvKey(model.id, "OUTPUT_USD_PER_MILLION")],
            defaults.outputUsdPerMillionTokens
        ),
        cachedInputPriceMultiplier: priceMultiplier(
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
