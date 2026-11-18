import type { AiModel, ModelTier } from "@/lib/models";
import { canUseModelWithPlan } from "@/lib/models";
import { protocolsForProvider, type ExternalApiProtocol } from "@/lib/externalApiProtocols";

/**
 * Which models the external API exposes, and the client configuration built
 * from them. Pure: the caller supplies the runtime registry rows, the plan and
 * the environment. See docs/policy/external-api.md.
 *
 * The model catalogue is the only list: a model the runtime registry serves
 * to this plan is exposed, with no second list to keep in step. Client
 * configurations carry Smart Adaptive by default, so a catalogue change never
 * needs a customer to recopy theirs.
 */

export type ExternalApiEnv = Record<string, string | undefined>;

export const externalApiEnabled = (env: ExternalApiEnv) =>
    env.EXTERNAL_API_ENABLED === "true";

/** Exact user IDs, or `*` for every account. Empty means nobody. */
export const externalApiUserAllowed = (env: ExternalApiEnv, userId: string) => {
    const list = (env.EXTERNAL_API_ALLOWED_USER_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    return list.includes("*") || list.includes(userId);
};

/**
 * Usage classes the stateless API can serve. Research classes depend on the
 * application's own search loop and are never exposed, even if listed.
 */
const EXPOSABLE_USAGE_CLASSES = new Set<AiModel["usageClass"]>([
    "standard",
    "advanced",
    "premium",
    "reasoning",
    "premium-reasoning",
]);

export const isExternalApiServableModel = (model: AiModel, plan: ModelTier) =>
    model.enabled &&
    !model.catalogDeleted &&
    (model.status === "enabled" || model.status === "limited") &&
    EXPOSABLE_USAGE_CLASSES.has(model.usageClass) &&
    canUseModelWithPlan(plan, model);

export type ExternalApiModelCapabilities = {
    id: string;
    name: string;
    provider: string;
    tools: true;
    vision: boolean;
    reasoning: boolean;
    contextWindowTokens: number;
    maxOutputTokens: number;
    creditWeight: number;
    /**
     * Wire protocols that carry this model. Chat Completions for every model;
     * the native protocols only for the provider that speaks them, so signed
     * or encrypted model state is never translated between providers.
     */
    protocols: ExternalApiProtocol[];
    /**
     * The provider's own model id, for a client that keys behaviour on it
     * (Codex picks its patch tool by model). Absent for Smart Adaptive.
     */
    providerModelId?: string;
};

export const externalApiModelCapabilities = (
    model: AiModel,
    limits: { maxInputTokens: number; maxOutputTokens: number; creditWeight: number }
): ExternalApiModelCapabilities => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    tools: true,
    vision: model.inputCapabilities?.image === true,
    reasoning: Boolean(model.reasoning && model.reasoning !== "none"),
    // What this API will accept, which can be less than the provider's own
    // window: the account input ceiling applies here as it does in Chat.
    contextWindowTokens: Math.min(
        model.contextWindowTokens ?? limits.maxInputTokens + limits.maxOutputTokens,
        limits.maxInputTokens + limits.maxOutputTokens
    ),
    maxOutputTokens: limits.maxOutputTokens,
    creditWeight: limits.creditWeight,
    protocols: protocolsForProvider(model.provider),
    providerModelId: model.apiModel,
});

/**
 * Smart Adaptive: the one model id a client configuration needs. Tomverse
 * picks, per request, which catalogue model answers. The id is stable while
 * the catalogue changes, which is why it is the default configuration.
 *
 * It is always offered while any model is. The paid router call that makes
 * the pick is behind EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED (default off);
 * without it every request goes to the default model.
 */
export const SMART_ADAPTIVE_MODEL_ID = "smart-adaptive";

export const smartAdaptiveRouterEnabled = (env: ExternalApiEnv) =>
    env.EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED === "true";

/**
 * What a client may assume of Smart Adaptive. Each request is routed only
 * among candidates that fit it (images, input length, requested output), so
 * the window is the largest any candidate offers. The output limit is the
 * default model's: clients send it back as `max_tokens`, so the largest would
 * leave a single candidate to route to, and the smallest would cut a coding
 * tool's long edits short (VS Code also subtracts it from the window to size
 * the input). A candidate that cannot give it is only left out of requests
 * that ask for that much. Without the default model, the smallest. Credits are
 * the most a request can cost.
 */
export const smartAdaptiveCapabilities = (
    candidates: readonly ExternalApiModelCapabilities[],
    defaultModelId?: string
): ExternalApiModelCapabilities | null =>
    candidates.length === 0
        ? null
        : {
              id: SMART_ADAPTIVE_MODEL_ID,
              name: "Smart Adaptive",
              provider: "tomverse",
              tools: true,
              vision: candidates.some((candidate) => candidate.vision),
              reasoning: false,
              contextWindowTokens: Math.max(...candidates.map((candidate) => candidate.contextWindowTokens)),
              maxOutputTokens:
                  candidates.find((candidate) => candidate.id === defaultModelId)?.maxOutputTokens ??
                  Math.min(...candidates.map((candidate) => candidate.maxOutputTokens)),
              creditWeight: Math.max(...candidates.map((candidate) => candidate.creditWeight)),
              // Routing is a Chat Completions feature: a native request keeps
              // the model that produced its signed or encrypted state.
              protocols: ["chat_completions"],
          };

/** OpenAI-shaped `GET /models` entry. Tomverse fields sit under `tomverse`. */
export const toOpenAiModelEntry = (model: ExternalApiModelCapabilities) => ({
    id: model.id,
    object: "model" as const,
    created: 0,
    owned_by: "tomverse",
    tomverse: {
        name: model.name,
        provider: model.provider,
        capabilities: { tools: model.tools, vision: model.vision, reasoning: model.reasoning },
        protocols: model.protocols,
        context_window_tokens: model.contextWindowTokens,
        max_output_tokens: model.maxOutputTokens,
        credits_per_request: model.creditWeight,
    },
});

export const KEY_PLACEHOLDER = "<YOUR_TOMVERSE_API_KEY>";

/**
 * Aside custom provider JSON (Pi `models.json` provider shape). The key is a
 * placeholder unless the caller passes the one just created -- the server
 * never stores a key it could put here later.
 */
export const asideProviderConfig = (
    baseUrl: string,
    models: readonly ExternalApiModelCapabilities[],
    apiKey: string = KEY_PLACEHOLDER
) => ({
    providers: {
        tomverse: {
            name: "Tomverse",
            api: "openai-completions",
            baseUrl,
            apiKey,
            authHeader: true,
            models: models.map((model) => ({
                id: model.id,
                name: `${model.name} (Tomverse)`,
                reasoning: model.reasoning,
                input: model.vision ? ["text", "image"] : ["text"],
                contextWindow: model.contextWindowTokens,
                maxTokens: model.maxOutputTokens,
            })),
        },
    },
});

/**
 * VS Code Custom Endpoint provider, as one entry of the provider array in
 * `chatLanguageModels.json` (Chat: Manage Language Models > Add Models >
 * Custom Endpoint). The key is an `${input:...}` variable VS Code stores in its
 * secret storage, so no secret is ever written into the file.
 */
export const vscodeCustomEndpointConfig = (
    baseUrl: string,
    models: readonly ExternalApiModelCapabilities[]
) => [
    {
        name: "Tomverse",
        vendor: "customendpoint",
        apiKey: "${input:tomverseApiKey}",
        apiType: "chat-completions",
        models: models.map((model) => ({
            id: model.id,
            name: `${model.name} (Tomverse)`,
            url: `${baseUrl}/chat/completions`,
            apiType: "chat-completions",
            toolCalling: true,
            vision: model.vision,
            streaming: true,
            // The two must sum to no more than the window this API accepts.
            maxInputTokens: Math.max(1, model.contextWindowTokens - model.maxOutputTokens),
            maxOutputTokens: model.maxOutputTokens,
        })),
    },
];
