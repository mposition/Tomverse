import "server-only";
import { chatUserMaxInputTokens } from "@/lib/chatInputLimits";
import { codingApiModels, type CodingCatalogPricing } from "@/lib/codingCatalogChannels";
import {
    externalApiModelCapabilities,
    isExternalApiServableModel,
    isSmartAdaptiveOnlyModel,
    smartAdaptiveCapabilities,
    type ExternalApiModelCapabilities,
    type ExternalApiSurface,
} from "@/lib/externalApiCatalogCore";
import { isProviderApiKeyConfigured } from "@/lib/modelRegistryShared";
import { DEFAULT_MODEL_ID, getModelUsageProfile, resolveModelRequestPricing, type AiModel, type ModelTier } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { ExternalApiProtocol } from "@/lib/externalApiProtocols";

/**
 * Which of the two external APIs a request came through (owner decision
 * 2026-11-21), decided by its address alone:
 * - "general": /api/v1 and /api/anthropic, for AI browsers such as Aside and
 *   other apps. Always the chat registry's models.
 * - "coding": /api/code/v1 and /api/code/anthropic, for Claude Code, Codex,
 *   Cursor and the tomverse CLI. The coding catalogue's models while
 *   CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED is on; the general API's otherwise.
 * The same key, plan check, ledger and limits serve both.
 */
export type { ExternalApiSurface };

export type ExternalApiRunnableEntry = {
    model: AiModel;
    capabilities: ExternalApiModelCapabilities;
    /**
     * Whether a client may name this model (it is not one only Smart Adaptive
     * routes to here). Absent reads as nameable.
     */
    nameable?: boolean;
    /** A dedicated coding row's snapshot pricing, for its reservation (createChatBudget). */
    catalogPricing?: CodingCatalogPricing;
};

/**
 * The models this plan can run through one external API right now, read on
 * every call -- the same source the request is validated against, so the list
 * and execution cannot disagree. A model whose provider has no credential on
 * this deployment could only fail, so it is not offered.
 *
 * `smartAdaptive` adds the classes only Smart Adaptive routes to (frontier and
 * apex, lib/externalApiCatalogCore.ts); a client naming one of those directly
 * is still refused.
 */
export const externalApiRunnableModels = async (
    plan: ModelTier,
    options: { surface: ExternalApiSurface; smartAdaptive?: boolean }
): Promise<ExternalApiRunnableEntry[]> => {
    const runtime = await getRuntimeModels();
    const coding = options.surface === "coding" ? await codingApiModels(plan, { runtime }) : null;
    const pool: { model: AiModel; pricing?: CodingCatalogPricing }[] = coding ?? runtime.map((model) => ({ model }));
    // On the coding catalogue a client may name frontier and apex models too
    // (owner decision 2026-11-22); on the general API, and on the coding API
    // while it serves the general API's models, only Smart Adaptive routes to them.
    const routerClassesNameable = coding !== null;
    const nameable = (model: AiModel) => routerClassesNameable || !isSmartAdaptiveOnlyModel(model);
    const servable = pool.filter(
        ({ model }) =>
            isExternalApiServableModel(model, plan, { smartAdaptive: options.smartAdaptive, routerClassesNameable }) &&
            isProviderApiKeyConfigured(model.provider)
    );
    // A router-only model joins only beside a model of its provider a client
    // can name, so it is never the one model left. A model a client can name
    // is offered on its own. On either API Smart Adaptive never defaults to the
    // frontier and apex classes, and is offered on a protocol only beside a
    // model of another class (smartAdaptiveCapabilities,
    // lib/externalApiSmartAdaptive.ts, lib/externalApiNativeSmartAdaptive.ts).
    const nameableProviders = new Set(servable.filter(({ model }) => nameable(model)).map(({ model }) => model.provider));
    return servable
        .filter(({ model }) => nameable(model) || nameableProviders.has(model.provider))
        .map(({ model, pricing }) => ({
            model,
            nameable: nameable(model),
            capabilities: externalApiModelCapabilities(model, {
                maxInputTokens: chatUserMaxInputTokens(),
                maxOutputTokens: resolveModelRequestPricing(model, { estimatedPromptTokens: 1 }).maxOutputTokens,
                creditWeight: getModelUsageProfile(model).credits,
            }),
            ...(pricing ? { catalogPricing: pricing } : {}),
        }));
};

/**
 * The runtime models and any candidate that is not one -- a dedicated coding
 * row on the coding API -- for the router, which describes each candidate from
 * the model list it is given (lib/autoLlmRouterCore.ts autoLlmRouterCandidates).
 */
export const withCandidateModels = (
    runtime: readonly AiModel[],
    candidates: readonly Pick<ExternalApiRunnableEntry, "model">[]
): AiModel[] => {
    const known = new Set(runtime.map((model) => model.id));
    return [...runtime, ...candidates.map((entry) => entry.model).filter((model) => !known.has(model.id))];
};

/**
 * What `GET /models` and the settings page offer: Smart Adaptive first, then
 * every runnable model. Smart Adaptive's limits and credits are over its own
 * candidates, which include the classes only it routes to; it is listed only
 * while one of them is a model it may default to (not frontier or apex).
 */
export const externalApiOfferedModels = async (
    plan: ModelTier,
    options: { surface: ExternalApiSurface }
): Promise<ExternalApiModelCapabilities[]> => {
    const pool = await externalApiRunnableModels(plan, { ...options, smartAdaptive: true });
    const runnable = pool.filter((entry) => entry.nameable !== false).map((entry) => entry.capabilities);
    const smart = smartAdaptiveCapabilities(
        pool.map((entry) => entry.capabilities),
        DEFAULT_MODEL_ID
    );
    return smart ? [smart, ...runnable] : runnable;
};

/** The runnable models one wire protocol carries, for its model list and settings. */
export const externalApiProtocolModels = async (
    plan: ModelTier,
    protocol: ExternalApiProtocol,
    options: { surface: ExternalApiSurface }
): Promise<ExternalApiModelCapabilities[]> =>
    (await externalApiRunnableModels(plan, options))
        .map((entry) => entry.capabilities)
        .filter((capabilities) => capabilities.protocols.includes(protocol));
