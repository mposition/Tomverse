import "server-only";
import { chatUserMaxInputTokens } from "@/lib/chatInputLimits";
import {
    externalApiModelCapabilities,
    externalApiModelIds,
    isExternalApiServableModel,
    smartAdaptiveCapabilities,
    smartAdaptiveEnabled,
    type ExternalApiModelCapabilities,
} from "@/lib/externalApiCatalogCore";
import { getModelUsageProfile, resolveModelRequestPricing, type AiModel, type ModelTier } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";

/**
 * The models this plan can run through the external API right now, read from
 * the runtime registry on every call -- the same source the request is
 * validated against, so the list and execution cannot disagree.
 */
export const externalApiRunnableModels = async (
    plan: ModelTier
): Promise<{ model: AiModel; capabilities: ExternalApiModelCapabilities }[]> => {
    const listed = externalApiModelIds(process.env);
    if (listed.length === 0) return [];
    const runtime = await getRuntimeModels();
    return runtime
        .filter((model) => isExternalApiServableModel(model, plan, listed))
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
 * What `GET /models` and the settings page offer: the runnable models, plus
 * Smart Adaptive first when it is switched on and has two models to choose
 * between.
 */
export const externalApiOfferedModels = async (plan: ModelTier): Promise<ExternalApiModelCapabilities[]> => {
    const runnable = (await externalApiRunnableModels(plan)).map((entry) => entry.capabilities);
    const smart = smartAdaptiveEnabled(process.env) ? smartAdaptiveCapabilities(runnable) : null;
    return smart ? [smart, ...runnable] : runnable;
};
