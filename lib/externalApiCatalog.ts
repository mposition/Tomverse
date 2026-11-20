import "server-only";
import { chatUserMaxInputTokens } from "@/lib/chatInputLimits";
import { externalChannelAllowlist, type ExternalCodingChannel } from "@/lib/codingCatalogChannels";
import {
    externalApiModelCapabilities,
    isExternalApiServableModel,
    isSmartAdaptiveOnlyModel,
    smartAdaptiveCapabilities,
    type ExternalApiModelCapabilities,
} from "@/lib/externalApiCatalogCore";
import { isProviderApiKeyConfigured } from "@/lib/modelRegistryShared";
import { DEFAULT_MODEL_ID, getModelUsageProfile, resolveModelRequestPricing, type AiModel, type ModelTier } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { ExternalApiProtocol } from "@/lib/externalApiProtocols";

/**
 * The models this plan can run through the external API right now, read from
 * the runtime registry on every call -- the same source the request is
 * validated against, so the list and execution cannot disagree. A model whose
 * provider has no credential on this deployment could only fail, so it is not
 * offered.
 *
 * `smartAdaptive` adds the classes only Smart Adaptive routes to (frontier and
 * apex, lib/externalApiCatalogCore.ts); a client naming one of those directly
 * is still refused.
 *
 * With CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED on, only the chat models the
 * newest coding snapshot lists for this channel and the coding judge still
 * admits now (lib/codingCatalogChannels.ts); off, the allow-list is null and
 * nothing else is read.
 */
export const externalApiRunnableModels = async (
    plan: ModelTier,
    options: { channel?: ExternalCodingChannel; smartAdaptive?: boolean } = {}
): Promise<{ model: AiModel; capabilities: ExternalApiModelCapabilities }[]> => {
    const runtime = await getRuntimeModels();
    const allowed = await externalChannelAllowlist(options.channel ?? "api", plan, { runtime });
    const servable = runtime.filter(
        (model) =>
            isExternalApiServableModel(model, plan, { smartAdaptive: options.smartAdaptive }) &&
            isProviderApiKeyConfigured(model.provider) &&
            (allowed === null || allowed.has(model.id))
    );
    // A router-only model joins only beside a model of its provider a client
    // can name, so it is never the default, never the one model left, and a
    // native protocol never offers Smart Adaptive over router-only models alone.
    const nameableProviders = new Set(
        servable.filter((model) => !isSmartAdaptiveOnlyModel(model)).map((model) => model.provider)
    );
    return servable
        .filter((model) => !isSmartAdaptiveOnlyModel(model) || nameableProviders.has(model.provider))
        .map((model) => ({
            model,
            capabilities: externalApiModelCapabilities(model, {
                maxInputTokens: chatUserMaxInputTokens(),
                maxOutputTokens: resolveModelRequestPricing(model, { estimatedPromptTokens: 1 }).maxOutputTokens,
                creditWeight: getModelUsageProfile(model).credits,
            }),
        }));
};

/**
 * What `GET /models` and the settings page offer: Smart Adaptive first, then
 * every runnable model. Smart Adaptive's limits and credits are over its own
 * candidates, which include the classes only it routes to.
 */
export const externalApiOfferedModels = async (
    plan: ModelTier,
    options: { channel?: ExternalCodingChannel } = {}
): Promise<ExternalApiModelCapabilities[]> => {
    const pool = await externalApiRunnableModels(plan, { ...options, smartAdaptive: true });
    const runnable = pool
        .filter((entry) => isExternalApiServableModel(entry.model, plan))
        .map((entry) => entry.capabilities);
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
    options: { channel?: ExternalCodingChannel } = {}
): Promise<ExternalApiModelCapabilities[]> =>
    (await externalApiRunnableModels(plan, options))
        .map((entry) => entry.capabilities)
        .filter((capabilities) => capabilities.protocols.includes(protocol));
