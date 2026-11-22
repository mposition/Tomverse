import type { AiModel, ModelTier } from "@/lib/models";
import { canUseModelWithPlan } from "@/lib/models";
import { EXTERNAL_API_PROTOCOLS, protocolsForProvider, type ExternalApiProtocol } from "@/lib/externalApiProtocols";

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

/**
 * The two external APIs, decided by the request's address (owner decision
 * 2026-11-21): general (/api/v1, /api/anthropic) and coding (/api/code/v1,
 * /api/code/anthropic). Also the values ExternalApiRequest.surface may hold
 * (its CHECK constraint, scripts/check-enum-constraints.mjs).
 */
export const EXTERNAL_API_SURFACES = ["general", "coding"] as const;
export type ExternalApiSurface = (typeof EXTERNAL_API_SURFACES)[number];

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
 * The API is a paid-plan feature (owner decision 2026-11-19): a Free account
 * can neither make a key nor use one it made on a paid plan. Read from the
 * account's effective plan, so a lapsed subscription counts as Free.
 */
export const externalApiPlanAllowed = (tier: ModelTier) => tier === "Pro" || tier === "Max";

export const EXTERNAL_API_PLAN_REQUIRED_MESSAGE = "The Tomverse API needs a paid plan.";

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

/**
 * Usage classes Smart Adaptive may route to but no client may name directly on
 * the general API (owner decision 2026-11-20): the coding guidance sends only
 * the hardest work to them (AUTO_LLM_ROUTER_CODING_GUIDANCE), each request is
 * charged that model's own credits, and the key's cap and the account's
 * credits still refuse what they do not cover. On the coding catalogue (the
 * coding API while CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED is on) a client
 * may name them too (owner decision 2026-11-22), at the same credits.
 */
const SMART_ADAPTIVE_ONLY_USAGE_CLASSES = new Set<AiModel["usageClass"]>(["frontier", "apex"]);

/**
 * A model of a class only Smart Adaptive routes to on the general API. Never a
 * Smart Adaptive default on either API: the model a request takes when the
 * router does not pick is chosen among the others.
 */
export const isSmartAdaptiveOnlyModel = (model: Pick<AiModel, "usageClass">) =>
    SMART_ADAPTIVE_ONLY_USAGE_CLASSES.has(model.usageClass);

/**
 * The credits the chat registry holds for a model: a positive whole number,
 * or none. A frontier or apex model is offered on the coding catalogue only
 * with them, so a request is never charged a class default nobody set.
 */
export const hasRegistryCredits = (model: Pick<AiModel, "creditWeight">) =>
    Number.isInteger(model.creditWeight) && (model.creditWeight ?? 0) > 0;

export const isExternalApiServableModel = (
    model: AiModel,
    plan: ModelTier,
    options: {
        smartAdaptive?: boolean;
        /**
         * The coding catalogue serves this request: the classes only Smart
         * Adaptive routes to elsewhere may be named too, and are offered only
         * with their registry credits (owner decision 2026-11-22).
         */
        routerClassesNameable?: boolean;
    } = {}
) =>
    model.enabled &&
    !model.catalogDeleted &&
    (model.status === "enabled" || model.status === "limited") &&
    (EXPOSABLE_USAGE_CLASSES.has(model.usageClass) ||
        (SMART_ADAPTIVE_ONLY_USAGE_CLASSES.has(model.usageClass) &&
            (options.routerClassesNameable === true ? hasRegistryCredits(model) : options.smartAdaptive === true))) &&
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
    /**
     * Smart Adaptive only: the most one request can cost on each protocol. A
     * native protocol routes among its own provider's models only.
     */
    creditWeightByProtocol?: Partial<Record<ExternalApiProtocol, number>>;
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
              // Every protocol a candidate speaks. Chat Completions routes over
              // all of them; a native protocol only over its own provider's
              // models (lib/externalApiNativeSmartAdaptive.ts), so signed or
              // encrypted state never crosses providers.
              protocols: EXTERNAL_API_PROTOCOLS.filter((protocol) =>
                  candidates.some((candidate) => (candidate.protocols ?? ["chat_completions"]).includes(protocol))
              ),
              creditWeightByProtocol: Object.fromEntries(
                  EXTERNAL_API_PROTOCOLS.flatMap((protocol) => {
                      const weights = candidates
                          .filter((candidate) => (candidate.protocols ?? ["chat_completions"]).includes(protocol))
                          .map((candidate) => candidate.creditWeight);
                      return weights.length ? [[protocol, Math.max(...weights)]] : [];
                  })
              ),
          };

/**
 * The model a native Smart Adaptive request takes when the router does not
 * pick (switch off, no answer, a conversation already under way): the
 * catalogue default when this provider has it, otherwise the lower-median
 * model by credits -- the middle of the line-up, not its cheapest or dearest.
 */
export const nativeSmartAdaptiveDefaultId = (
    candidates: readonly Pick<ExternalApiModelCapabilities, "id" | "creditWeight">[],
    defaultModelId?: string
): string | null => {
    if (candidates.length === 0) return null;
    if (defaultModelId && candidates.some((candidate) => candidate.id === defaultModelId)) return defaultModelId;
    const sorted = [...candidates].sort((a, b) => a.creditWeight - b.creditWeight || a.id.localeCompare(b.id));
    return sorted[Math.floor((sorted.length - 1) / 2)].id;
};

/**
 * Smart Adaptive as one native protocol sees it: only that provider's models.
 * A native conversation keeps the model it started on, so a coding tool must
 * plan for the smallest window any of them offers, not the largest; the
 * output limit is the provider default's (the gateway clamps a larger
 * request to the model's own).
 */
export const nativeSmartAdaptiveCapabilities = (
    providerModels: readonly ExternalApiModelCapabilities[],
    defaultModelId?: string
): ExternalApiModelCapabilities | null => {
    const fixed = providerModels.filter((model) => model.id !== SMART_ADAPTIVE_MODEL_ID);
    const smart = smartAdaptiveCapabilities(fixed, nativeSmartAdaptiveDefaultId(fixed, defaultModelId) ?? undefined);
    return smart && { ...smart, contextWindowTokens: Math.min(...fixed.map((model) => model.contextWindowTokens)) };
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
