import "server-only";
import { chatUserMaxInputTokens } from "@/lib/chatInputLimits";
import {
    externalApiModelCapabilities,
    isExternalApiServableModel,
    smartAdaptiveCapabilities,
    type ExternalApiModelCapabilities,
} from "@/lib/externalApiCatalogCore";
import { isProviderApiKeyConfigured } from "@/lib/modelRegistryShared";
import { DEFAULT_MODEL_ID, getModelUsageProfile, resolveModelRequestPricing, type AiModel, type ModelTier } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { ExternalApiProtocol } from "@/lib/externalApiNativeCore";

/**
 * The models this plan can run through the external API right now, read from
 * the runtime registry on every call -- the same source the request is
 * validated against, so the list and execution cannot disagree. A model whose
 * provider has no credential on this deployment could only fail, so it is not
 * offered.
 */
export const externalApiRunnableModels = async (
    plan: ModelTier
): Promise<{ model: AiModel; capabilities: ExternalApiModelCapabilities }[]> => {
    const runtime = await getRuntimeModels();
    return runtime
        .filter((model) => isExternalApiServableModel(model, plan) && isProviderApiKeyConfigured(model.provider))
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
 * every runnable model.
 */
export const externalApiOfferedModels = async (plan: ModelTier): Promise<ExternalApiModelCapabilities[]> => {
    const runnable = (await externalApiRunnableModels(plan)).map((entry) => entry.capabilities);
    const smart = smartAdaptiveCapabilities(runnable, DEFAULT_MODEL_ID);
    return smart ? [smart, ...runnable] : runnable;
};

/** The runnable models one wire protocol carries, for its model list and settings. */
export const externalApiProtocolModels = async (
    plan: ModelTier,
    protocol: ExternalApiProtocol
): Promise<ExternalApiModelCapabilities[]> =>
    (await externalApiRunnableModels(plan))
        .map((entry) => entry.capabilities)
        .filter((capabilities) => capabilities.protocols.includes(protocol));
