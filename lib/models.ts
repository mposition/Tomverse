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

export type AiModel = {
    id: string;
    name: string;
    apiModel: string;
    provider: AiProvider;
    icon: string;
    tier: ModelTier;
    enabled: boolean;
    status: ModelStatus;
    reasoning?: "none" | "low" | "medium" | "high";
};

export const DEFAULT_MODEL_ID = "gpt-5-4-mini";

export const AVAILABLE_MODELS = [
    { id: "gpt-5-5", name: "GPT-5.5", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", tier: "Max", enabled: true, status: "enabled" },
    { id: "gpt-5-5-thinking", name: "GPT-5.5 Thinking", apiModel: "gpt-5.5", provider: "openai", icon: "🤖", tier: "Max", enabled: true, status: "enabled", reasoning: "high" },
    { id: "gpt-5-4-mini", name: "GPT-5.4 mini", apiModel: "gpt-5.4-mini", provider: "openai", icon: "🤖", tier: "Free", enabled: true, status: "enabled" },

    { id: "claude-fable-5", name: "Claude Fable 5", apiModel: "claude-fable-5", provider: "anthropic", icon: "🧠", tier: "Max", enabled: true, status: "enabled" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", apiModel: "claude-opus-4-8", provider: "anthropic", icon: "🧠", tier: "Max", enabled: true, status: "enabled" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", apiModel: "claude-sonnet-5", provider: "anthropic", icon: "🧠", tier: "Pro", enabled: true, status: "enabled" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", apiModel: "claude-haiku-4-5-20251001", provider: "anthropic", icon: "🧠", tier: "Free", enabled: true, status: "enabled" },

    { id: "gemini-3-5-flash", name: "Gemini 3.5 Flash", apiModel: "gemini-3.5-flash", provider: "google", icon: "✨", tier: "Pro", enabled: true, status: "enabled" },
    { id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", apiModel: "gemini-3.1-pro-preview", provider: "google", icon: "✨", tier: "Max", enabled: true, status: "enabled" },
    { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", apiModel: "gemini-2.5-pro", provider: "google", icon: "✨", tier: "Pro", enabled: true, status: "enabled" },
    { id: "gemini-2-5-flash", name: "Gemini 3.1 Flash-Lite", apiModel: "gemini-3.1-flash-lite", provider: "google", icon: "✨", tier: "Free", enabled: true, status: "enabled" },

    { id: "llama-3-1", name: "Llama 3.1", apiModel: "llama-3.1-8b-instant", provider: "groq", icon: "∞", tier: "Free", enabled: true, status: "enabled" },
    { id: "llama-3-3", name: "Llama 3.3", apiModel: "llama-3.3-70b-versatile", provider: "groq", icon: "∞", tier: "Pro", enabled: true, status: "enabled" },

    { id: "grok-4", name: "Grok 4", apiModel: "grok-4", provider: "xai", icon: "𝕏", tier: "Max", enabled: true, status: "enabled" },
    { id: "grok-4-5", name: "Grok 4.5", apiModel: "grok-4.5", provider: "xai", icon: "𝕏", tier: "Max", enabled: true, status: "enabled", reasoning: "high" },
    { id: "grok-3", name: "Grok 3", apiModel: "grok-3", provider: "xai", icon: "𝕏", tier: "Pro", enabled: true, status: "enabled" },
    { id: "grok-3-mini", name: "Grok 3 Mini", apiModel: "grok-3-mini", provider: "xai", icon: "𝕏", tier: "Free", enabled: true, status: "enabled" },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4 Flash", apiModel: "deepseek-v4-flash", provider: "deepseek", icon: "DS", tier: "Free", enabled: true, status: "enabled" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4 Pro", apiModel: "deepseek-v4-pro", provider: "deepseek", icon: "DS", tier: "Pro", enabled: true, status: "enabled" },
    { id: "deepseek-r1", name: "DeepSeek R1 Reasoning", apiModel: "deepseek-reasoner", provider: "deepseek", icon: "DS", tier: "Pro", enabled: true, status: "enabled", reasoning: "high" },
    { id: "mistral-small-4", name: "Mistral Small 4", apiModel: "mistral-small-latest", provider: "mistral", icon: "M", tier: "Free", enabled: true, status: "enabled" },
    { id: "mistral-large-3", name: "Mistral Large 3", apiModel: "mistral-large-latest", provider: "mistral", icon: "M", tier: "Max", enabled: true, status: "enabled" },
    { id: "mistral-medium-3-1", name: "Mistral Medium 3.1", apiModel: "mistral-medium-latest", provider: "mistral", icon: "M", tier: "Pro", enabled: true, status: "enabled" },
    { id: "codestral", name: "Codestral", apiModel: "codestral-latest", provider: "mistral", icon: "M", tier: "Pro", enabled: true, status: "enabled" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7", apiModel: "kimi-k2.7-code", provider: "moonshot", icon: "KM", tier: "Pro", enabled: true, status: "enabled" },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max", apiModel: "qwen3.7-max", provider: "qwen", icon: "QW", tier: "Max", enabled: true, status: "enabled" },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", apiModel: "qwen3.7-plus", provider: "qwen", icon: "QW", tier: "Pro", enabled: true, status: "enabled" },
    { id: "qwen3.6-flash", name: "Qwen 3.6", apiModel: "qwen3.6-flash", provider: "qwen", icon: "QW", tier: "Free", enabled: true, status: "enabled" },
    { id: "glm-5.2", name: "GLM 5.2", apiModel: "glm-5.2", provider: "zhipu", icon: "Z", tier: "Free", enabled: false, status: "disabled" },
    { id: "perplexity/sonar", name: "Perplexity Sonar", apiModel: "sonar", provider: "perplexity", icon: "P", tier: "Pro", enabled: true, status: "enabled" },
    { id: "perplexity/sonar-pro", name: "Perplexity Sonar Pro", apiModel: "sonar-pro", provider: "perplexity", icon: "P", tier: "Pro", enabled: true, status: "enabled" },
    { id: "perplexity/sonar-reasoning-pro", name: "Perplexity Sonar Reasoning Pro", apiModel: "sonar-reasoning-pro", provider: "perplexity", icon: "P", tier: "Max", enabled: true, status: "enabled", reasoning: "high" },
    { id: "perplexity/sonar-deep-research", name: "Perplexity Sonar Deep Research", apiModel: "sonar-deep-research", provider: "perplexity", icon: "P", tier: "Max", enabled: true, status: "enabled", reasoning: "high" },
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

export const getModel = (modelId: string) => modelMap.get(modelId);

export const getEnabledModel = (modelId: string) => {
    const model = getModel(modelId);
    return model?.enabled ? model : undefined;
};

export type ModelBillingProfile = {
    maxOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
};

const BILLING_DEFAULTS: Record<ModelTier, ModelBillingProfile> = {
    Free: {
        maxOutputTokens: 2_048,
        inputUsdPerMillionTokens: 0.5,
        outputUsdPerMillionTokens: 1,
    },
    Pro: {
        maxOutputTokens: 4_096,
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 12,
    },
    Max: {
        maxOutputTokens: 8_192,
        inputUsdPerMillionTokens: 15,
        outputUsdPerMillionTokens: 60,
    },
};

const modelEnvKey = (modelId: string, suffix: string) =>
    `CHAT_MODEL_${modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${suffix}`;

const positiveNumber = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getModelBillingProfile = (
    model: Pick<AiModel, "id" | "tier">
): ModelBillingProfile => {
    const defaults = BILLING_DEFAULTS[model.tier];
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
    };
};

export const isEnabledModelId = (modelId: string) =>
    getEnabledModel(modelId) !== undefined;

if (!isEnabledModelId(DEFAULT_MODEL_ID)) {
    throw new Error(`Default model "${DEFAULT_MODEL_ID}" must be enabled.`);
}
