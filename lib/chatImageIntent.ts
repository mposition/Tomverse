import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { reserveRouterCost, settleRouterCost } from "@/lib/autoLlmRouter";
import {
    autoLlmRouterProviderOptions,
    autoLlmRouterWorstCaseMicroUsd,
    resolveAutoLlmRouterModel,
} from "@/lib/autoLlmRouterCore";
import { callCostMicroUsd } from "@/lib/autoRouterOptimizerCore";
import {
    CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS,
    CHAT_IMAGE_INTENT_SYSTEM,
    CHAT_IMAGE_INTENT_TIMEOUT_MS,
    chatImageIntentModelId,
    chatImageIntentOutputSchema,
    chatImageIntentPrompt,
    parseChatImageIntentOutput,
} from "@/lib/chatImageIntentCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";

/**
 * Whether a chat message asks for a new image, decided by one small model call.
 *
 * False -- and the message goes to chat as before -- when the feature is off,
 * the configured model is unavailable or unpriced, the provider's operational
 * budget is spent, or the call fails, times out or answers malformed. Never
 * throws: routing must not be the reason a send fails.
 *
 * The call's worst case is held under the same provider day/month budget as
 * the Auto router before it leaves, and settled to the reported usage after.
 * The log line carries ids, outcome and timing only, never the message.
 */
export async function detectChatImageRequest(input: {
    text: string;
    traceId: string;
}): Promise<boolean> {
    const configured = chatImageIntentModelId();
    const prompt = chatImageIntentPrompt(input.text);
    if (!configured || !prompt) return false;

    let models;
    try {
        models = (await getRuntimeModels()).filter(
            (model) => model.enabled && !model.catalogDeleted
        );
    } catch {
        return false;
    }
    const model = resolveAutoLlmRouterModel(models, configured);
    if (!model) return false;

    let prices: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
    try {
        const pricing = resolveModelPricing(model);
        prices = {
            inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
        };
    } catch {
        return false;
    }
    const worstCase = autoLlmRouterWorstCaseMicroUsd({
        system: CHAT_IMAGE_INTENT_SYSTEM,
        prompt,
        maxOutputTokens: CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS,
        ...prices,
    });
    const reservedAt = new Date();
    if (worstCase === null || !(await reserveRouterCost(model.provider, worstCase, reservedAt))) {
        console.info(
            JSON.stringify({
                event: "chat_image_intent_skipped",
                traceId: input.traceId,
                modelId: model.id,
                reason: worstCase === null ? "unpriced" : "provider_budget",
            })
        );
        return false;
    }

    const startedAt = Date.now();
    let outcome: "image" | "chat" | "error" = "error";
    try {
        const generated = await generateText({
            model: getActiveAiModel(model),
            system: CHAT_IMAGE_INTENT_SYSTEM,
            prompt,
            maxOutputTokens: CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(CHAT_IMAGE_INTENT_TIMEOUT_MS),
            output: Output.object({
                schema: jsonSchema(chatImageIntentOutputSchema() as unknown as JSONSchema7),
                name: "chat_image_intent",
            }),
            providerOptions: autoLlmRouterProviderOptions(model.provider),
        });
        outcome = parseChatImageIntentOutput(generated.output) ? "image" : "chat";
        const usage = generated.usage as
            | { inputTokens?: number; outputTokens?: number }
            | undefined;
        if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
            const actual = callCostMicroUsd({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                ...prices,
            });
            void settleRouterCost(model.provider, actual - worstCase, reservedAt);
        }
    } catch {
        // A failed or timed-out call keeps its whole hold: it may still have
        // been billed.
        outcome = "error";
    }
    console.info(
        JSON.stringify({
            event: "chat_image_intent",
            traceId: input.traceId,
            modelId: model.id,
            outcome,
            latencyMs: Date.now() - startedAt,
        })
    );
    return outcome === "image";
}
