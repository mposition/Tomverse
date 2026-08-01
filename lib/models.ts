import { resolveModelPricing } from "@/lib/modelPricing";

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
    // Flat surcharge reserved when webSearchMode === "always" enables a
    // provider-native search tool (OpenAI/Anthropic/Google). Refunded at
    // settlement if the provider didn't actually execute a search that
    // turn -- see getSettledUsageCredits' searchExecuted parameter. Read
    // this via lib/webSearchCredits.ts rather than referencing the raw
    // number so every caller (UI estimate, preflight, reservation) shares
    // one definition.
    webSearchSurcharge: 8,
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
    /**
     * Whether, and how strongly, this model reasons -- a catalogue fact, not
     * a request parameter. It drives the picker's reasoning badge, the
     * reasoning filter and the usage class; the only place it becomes a
     * provider field is Perplexity's deep-research submit
     * (lib/perplexityDeepResearch.ts). Every other provider is asked with no
     * `reasoning_effort`, so its own default applies. Set it to what the
     * model actually does, and never expose a per-request effort control for
     * a provider this app does not send the field to.
     */
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

// Every model carries three separate identifiers. They are not
// interchangeable, and support/incident work needs all three to line up:
//
//   id       -- the Tomverse model ID. Appears in chat request bodies, stored
//               conversations, the credit ledger and the admin registry. It is
//               a stable primary key, so it is NOT renamed when the underlying
//               model is upgraded.
//   name     -- the display name shown in the picker and comparison panels.
//               Tracks whatever the provider currently calls the model.
//   apiModel -- the provider's own model ID, sent upstream. Tracks provider
//               naming and changes whenever the mapped upstream model changes.
//
// Because `id` is pinned and the other two follow the provider, an entry can
// legitimately look mismatched. As of this writing two do, and both are
// intentional -- the upstream model behind a stable ID was replaced in place:
//
//   id "gemini-2-5-flash"  -> "Gemini 3.1 Flash-Lite" (apiModel gemini-3.1-flash-lite)
//   id "deepseek-r1"       -> "DeepSeek R1 Reasoning" (apiModel deepseek-reasoner)
//
// So when a log line, trace or ledger row says `gemini-2-5-flash`, the user
// saw "Gemini 3.1 Flash-Lite" and Google was asked for
// `gemini-3.1-flash-lite`. Do not "fix" such a row by renaming the ID:
// migrating IDs would break stored conversations and billing history. Retiring
// a model instead uses `replacementModelId` plus the disabled lifecycle
// fields, which `lib/modelRegistry.ts` replays onto the runtime registry.
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

    // STANDING DECISION -- openai/gpt-oss-* is not added to this catalogue.
    //
    // Groq's deprecation notice recommends the open-weight openai/gpt-oss-20b
    // and openai/gpt-oss-120b as the successors to the Llama models below, so
    // "just point Llama at GPT-OSS" is the obvious-looking fix and has been
    // proposed twice. It is declined for two reasons that do not expire:
    //
    //   * GPT-OSS is an open-weight line, not OpenAI's hosted GPT models.
    //     Listing it beside gpt-5-5 / gpt-5-4-mini implies a lineage it does
    //     not have.
    //   * Adding it to stop a provider's public model count reaching zero is
    //     not a product reason. Groq having no listed model is an accurate
    //     description of what Tomverse currently offers.
    //
    // If it is ever wanted, it needs its own product review and its own
    // category ("Groq" or "Open Models") -- not a replacement pointer. Pinned
    // by "GPT-OSS is absent from the catalogue entirely" in
    // tests/model-lifecycle, which fails on any entry whose id, name or
    // apiModel matches, so it cannot be smuggled in as a hidden row either.
    //
    // Llama itself is retired because Tomverse never self-hosted it -- every
    // Llama answer was served through Groq -- and Groq is ending public
    // hosting for the three models mapped here
    // (https://console.groq.com/docs/deprecations).
    //
    // The three entries stay in the catalogue as historical rows so stored
    // conversations, the credit ledger and admin history keep resolving their
    // ids. Each names the closest ACTIVE model for its role and plan tier --
    // never another retired model, which is why llama-4-scout no longer
    // points at llama-3-3. A replacement is only ever offered, never applied
    // on the user's behalf, so it cannot hand out a tier the user has not
    // paid for.
    { id: "llama-3-1", name: "Llama 3.1", apiModel: "llama-3.1-8b-instant", provider: "groq", icon: "∞", bestFor: "Legacy fast, lightweight text questions", minimumPlan: "Guest", usageClass: "standard", replacementModelId: "deepseek-v4-flash", publiclyListed: false, enabled: false, status: "disabled" },
    // Was already retired ahead of the rest: the catalog monitor first
    // recorded it missing from Groq on 2026-07-21 and escalated it to
    // likely_deprecated after seven consecutive absences, while live calls
    // returned HTTP 404. Its replacement moves to Gemini 3.5 Flash, the
    // closest active model that keeps native image input.
    { id: "llama-4-scout", name: "Llama 4 Scout", apiModel: "meta-llama/llama-4-scout-17b-16e-instruct", provider: "groq", icon: "∞", bestFor: "Legacy fast visual questions and long-context exploration", minimumPlan: "Guest", usageClass: "standard", replacementModelId: "gemini-3-5-flash", publiclyListed: false, enabled: false, status: "disabled", contextWindowTokens: 131_072, inputCapabilities: { image: true, nativePdf: false, maxImages: 5, maxBase64ImagePayloadBytes: 4 * 1024 * 1024 } },
    { id: "llama-3-3", name: "Llama 3.3", apiModel: "llama-3.3-70b-versatile", provider: "groq", icon: "∞", bestFor: "Legacy open-model text analysis and instruction following", minimumPlan: "Free", usageClass: "advanced", replacementModelId: "mistral-medium-3-1", publiclyListed: false, enabled: false, status: "disabled" },

    // xAI text models are consolidated on Grok 4.5. This is a Tomverse
    // catalogue-simplification decision, not a claim that xAI has switched
    // the older endpoints off: one clearly-positioned Grok is easier to
    // choose than four overlapping ones. The older ids stay resolvable for
    // stored conversations and all point at grok-4-5, which is Pro-only --
    // callers must offer it, not force it, and must fall back to an
    // accessible active model for users without Pro.
    { id: "grok-4", name: "Grok 4", apiModel: "grok-4", provider: "xai", icon: "𝕏", bestFor: "Legacy current-events discussion and broad advanced analysis", minimumPlan: "Pro", usageClass: "premium", replacementModelId: "grok-4-5", publiclyListed: false, enabled: false, status: "disabled" },
    { id: "grok-4-5", name: "Grok 4.5", apiModel: "grok-4.5", provider: "xai", icon: "𝕏", bestFor: "Deep reasoning on complex technical and analytical tasks", minimumPlan: "Pro", usageClass: "premium-reasoning", enabled: true, status: "enabled", reasoning: "high" },
    { id: "grok-3", name: "Grok 3", apiModel: "grok-3", provider: "xai", icon: "𝕏", bestFor: "Legacy general analysis with a direct conversational style", minimumPlan: "Free", usageClass: "advanced", replacementModelId: "grok-4-5", publiclyListed: false, enabled: false, status: "disabled" },
    { id: "grok-3-mini", name: "Grok 3 Mini", apiModel: "grok-3-mini", provider: "xai", icon: "𝕏", bestFor: "Legacy fast, concise everyday answers", minimumPlan: "Guest", usageClass: "standard", replacementModelId: "grok-4-5", publiclyListed: false, enabled: false, status: "disabled" },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4 Flash", apiModel: "deepseek-v4-flash", provider: "deepseek", icon: "DS", bestFor: "Fast coding help and technical questions", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4 Pro", apiModel: "deepseek-v4-pro", provider: "deepseek", icon: "DS", bestFor: "Cost-efficient technical analysis and coding", minimumPlan: "Free", usageClass: "standard", enabled: true, status: "enabled" },
    // Retired: DeepSeek stopped serving `deepseek-reasoner`. Confirmed by this
    // app's own provider catalog monitor rather than by a release note -- the
    // 2026-08-01 report recorded it absent from 12 consecutive *successful*
    // DeepSeek catalog scans. Replacement is deepseek-v4-flash, the same
    // provider's remaining general model.
    //
    // Note for whoever picks up the catalogue next: this leaves no
    // reasoning-class model below Pro. gpt-5-5-thinking and grok-4-5 are both
    // Pro, so Free and Guest users now have no explicit-reasoning option at
    // all. That is a product gap this retirement creates, not one it inherits.
    { id: "deepseek-r1", name: "DeepSeek R1 Reasoning", apiModel: "deepseek-reasoner", provider: "deepseek", icon: "DS", bestFor: "Legacy math, code, and explicit-reasoning problems", minimumPlan: "Free", usageClass: "reasoning", replacementModelId: "deepseek-v4-flash", publiclyListed: false, enabled: false, status: "disabled", reasoning: "high" },
    { id: "mistral-small-4", name: "Mistral Small 4", apiModel: "mistral-small-latest", provider: "mistral", icon: "M", bestFor: "Efficient multilingual writing and everyday tasks", minimumPlan: "Guest", usageClass: "standard", enabled: true, status: "enabled" },
    { id: "mistral-large-3", name: "Mistral Large 3", apiModel: "mistral-large-latest", provider: "mistral", icon: "M", bestFor: "High-quality multilingual analysis and long-form work", minimumPlan: "Pro", usageClass: "premium", enabled: true, status: "enabled" },
    { id: "mistral-medium-3-1", name: "Mistral Medium 3.1", apiModel: "mistral-medium-latest", provider: "mistral", icon: "M", bestFor: "Balanced multilingual drafting and analysis", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "codestral", name: "Codestral", apiModel: "codestral-latest", provider: "mistral", icon: "M", bestFor: "Code generation, completion, and repository questions", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7", apiModel: "kimi-k2.7-code", provider: "moonshot", icon: "KM", bestFor: "Coding tasks and long technical context", minimumPlan: "Free", usageClass: "advanced", enabled: true, status: "enabled" },
    // Kimi K3 is a separate model from kimi-k2.7-code, not a rename of it:
    // K2.7 stays listed as the coding-specialised Free model.
    //
    // NOT LAUNCHED. The entry exists so the id is registered and reviewable,
    // but it is delisted, disabled and status "coming-soon" -- never offered,
    // never callable -- because its unit economics are not established. Only
    // the capability fields below are confirmed by Moonshot's own model
    // documentation (github.com/MoonshotAI/Kimi-K3): the API model id
    // `kimi-k3`, the 1,048,576-token context window, native image input, and
    // always-on thinking. Token prices, cached-input price and the output cap
    // are NOT published there, so nothing here may be read as a price.
    //
    // Do not set enabled/status to "enabled" until all of these are done:
    //
    //  1. Official Moonshot price profile registered in MODEL_BILLING_DEFAULTS
    //     (input, cached input, output), the way grok-4-5 is.
    //  2. The reasoning effort ordinary chat sends is explicit. Today the
    //     chat route sends none, so Moonshot's default ("max") applies to a
    //     model that always thinks -- see the AiModel.reasoning note.
    //  3. maxOutputTokens set from the published cap instead of the premium
    //     cost class's 8_192.
    //  4. `reasoning_content` handling verified end to end. It is currently
    //     neither captured nor stored: the chat route consumes only
    //     result.textStream, and Message has no column for it, so thinking
    //     tokens are paid for and discarded, and follow-up turns cannot
    //     carry them.
    //  5. Real Korean-language requests measured for cache hit/miss and
    //     reasoning-token cost.
    //  6. Economics checked against Max, annual and the 50% promotion, not
    //     Pro list price alone.
    //  7. Long inputs charged from real reserved cost. INPUT_CREDIT_MULTIPLIERS
    //     tops out at a flat 3x above 100K tokens, which on a 1M-token context
    //     window charges a 900K-token request exactly what it charges a 101K
    //     one.
    //
    // `usageClass: "premium-reasoning"` (16 credits) is a placeholder that is
    // only defensible for a short, low-effort Pro request. Splitting the SKU
    // by effort, or pricing long context dynamically, is the open product
    // decision -- see the task report.
    { id: "kimi-k3", name: "Kimi K3", apiModel: "kimi-k3", provider: "moonshot", icon: "KM", bestFor: "Long-context reasoning across text and images", minimumPlan: "Pro", usageClass: "premium-reasoning", publiclyListed: false, enabled: false, status: "coming-soon", reasoning: "high", contextWindowTokens: 1_048_576, inputCapabilities: { image: true, nativePdf: false } },
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

// Distinct providers a visitor can actually reach today. Derived rather than
// counted by hand so marketing copy cannot drift from the catalogue the way
// the landing FAQ's fixed provider list did.
export const PUBLIC_MODEL_PROVIDERS: readonly AiProvider[] = Array.from(
    new Set(
        PUBLIC_MODELS.filter((model) => model.enabled).map(
            (model) => model.provider
        )
    )
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
    searchSurchargeCredits = 0,
    searchExecuted = true,
}: {
    reservedCredits: number;
    reservedInputTokens: number;
    reservedOutputTokens: number;
    actualInputTokens: number;
    actualOutputTokens: number;
    outcome: UsageCreditOutcome;
    /** Extra credits reserved on top of the base weight for a native web search attempt. */
    searchSurchargeCredits?: number;
    /** Whether the provider actually executed a search this turn -- refund the surcharge if not. */
    searchExecuted?: boolean;
}) => {
    // A search that never executed never earns its surcharge, in either
    // outcome -- fold it out of the reserved amount once, up front, so
    // neither branch below can accidentally charge for a search that didn't
    // happen.
    const surchargeAdjustedReservedCredits = searchExecuted
        ? reservedCredits
        : Math.max(0, reservedCredits - searchSurchargeCredits);

    if (outcome === "completed") {
        return surchargeAdjustedReservedCredits;
    }
    if (outcome !== "cancelled" || actualOutputTokens <= 16) return 0;

    const reservedTokens = reservedInputTokens + reservedOutputTokens;
    const actualTokens = actualInputTokens + actualOutputTokens;
    return Math.min(
        surchargeAdjustedReservedCredits,
        Math.max(
            1,
            Math.ceil(
                surchargeAdjustedReservedCredits *
                    (actualTokens / Math.max(1, reservedTokens))
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

type BillableModel = Pick<
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
 * Full pricing decision for one request, including which price tier applied and
 * where the number came from. Reservation and settlement both go through this
 * so a stored snapshot can always be traced back to a pricing version.
 *
 * `estimatedPromptTokens` selects the long-context tier for models that price
 * large prompts differently (Gemini 3.1 Pro's 200K step, today). Callers that
 * do not know the prompt size get the first (cheapest-context) tier, which is
 * only correct for flat-priced models -- so anything that reserves budget must
 * pass the estimate.
 */
export const resolveModelRequestPricing = (
    model: BillableModel,
    options?: { estimatedPromptTokens?: number }
) => resolveModelPricing(model, options);

/**
 * Backwards-compatible narrow view used by callers that only need the five
 * numbers the reservation math consumes.
 */
export const getModelBillingProfile = (
    model: BillableModel,
    options?: { estimatedPromptTokens?: number }
): ModelBillingProfile => {
    const pricing = resolveModelPricing(model, options);
    return {
        maxOutputTokens: pricing.maxOutputTokens,
        reservationOutputTokens: pricing.reservationOutputTokens,
        inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
    };
};

export const isEnabledModelId = (modelId: string) =>
    getEnabledModel(modelId) !== undefined;

// ---------------------------------------------------------------------------
// Model lifecycle
//
// One definition of "retired" and one definition of "offer this to users",
// shared by the runtime registry (lib/modelRegistry.ts) and the client catalog
// (components/ModelCatalogProvider.tsx). They used to be spelled out
// separately at each site and had drifted: the picker's public filter checked
// only `publiclyListed`/`catalogDeleted` and never `enabled`/`status`, so a
// model the registry had disabled stayed selectable.
// ---------------------------------------------------------------------------

/**
 * A model this catalog has retired: delisted, disabled and (normally) pointed
 * at a replacement, because the provider stopped serving it. Distinct from
 * `catalogDeleted`, which stays a human-controlled admin action.
 */
export const isRetiredModel = (
    model: Pick<AiModel, "enabled" | "publiclyListed" | "status">
) =>
    model.enabled === false &&
    model.publiclyListed === false &&
    model.status === "disabled";

/**
 * A model registered but never launched: the id is reserved and reviewable,
 * but the model has not cleared whatever gate it needs (unit economics,
 * provider verification) and must not be offered or called. The mirror image
 * of retirement -- not yet, rather than no longer.
 */
export const isPreLaunchModel = (
    model: Pick<AiModel, "enabled" | "publiclyListed" | "status">
) =>
    model.enabled === false &&
    model.publiclyListed === false &&
    model.status === "coming-soon";

/**
 * A model the checked-in catalogue says must not be offered, whichever end of
 * its life that is. `lib/modelRegistry.ts` replays exactly this set onto the
 * runtime registry on every bootstrap, so a row that already exists cannot
 * keep offering a model the catalogue has since withdrawn -- the defect that
 * kept a retired model selectable, which a pre-launch model would hit the same
 * way if a build that had it enabled reached an environment first.
 */
export const isWithdrawnFromOfferModel = (
    model: Pick<AiModel, "enabled" | "publiclyListed" | "status">
) => isRetiredModel(model) || isPreLaunchModel(model);

/**
 * Whether a model may be offered to users -- listed in the picker and
 * selectable. Requires every lifecycle signal to agree that it can actually be
 * called, so a delisted, disabled, retired or catalog-deleted model can never
 * be presented as a choice.
 */
export const isPubliclySelectableModel = (
    model: Pick<
        AiModel,
        "enabled" | "publiclyListed" | "status" | "catalogDeleted"
    >
) =>
    model.publiclyListed !== false &&
    !model.catalogDeleted &&
    model.enabled &&
    model.status !== "disabled" &&
    model.status !== "coming-soon";

if (!isEnabledModelId(DEFAULT_MODEL_ID)) {
    throw new Error(`Default model "${DEFAULT_MODEL_ID}" must be enabled.`);
}

// A retirement is only useful if the model it points at can actually be
// reached. Pointing one retired model at another (as llama-4-scout once
// pointed at llama-3-3) leaves the picker, the status route and the chat
// route's 410 all naming something nobody can select, so the whole catalogue
// is checked at import time rather than only in tests.
for (const model of AVAILABLE_MODELS as readonly AiModel[]) {
    if (!model.replacementModelId) continue;
    if (model.replacementModelId === model.id) {
        throw new Error(`Model "${model.id}" names itself as its replacement.`);
    }
    const replacement = modelMap.get(model.replacementModelId);
    if (!replacement || !isPubliclySelectableModel(replacement)) {
        throw new Error(
            `Model "${model.id}" names replacement "${model.replacementModelId}", which is not publicly selectable.`
        );
    }
}
