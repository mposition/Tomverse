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
import {
    readAutoLlmRouterImageTriage,
    readAutoLlmRouterModelId,
} from "@/lib/autoLlmRouterSettings";
import { callCostMicroUsd } from "@/lib/autoRouterOptimizerCore";
import {
    CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS,
    CHAT_IMAGE_INTENT_SYSTEM,
    CHAT_IMAGE_INTENT_TIMEOUT_MS,
    chatImageIntentOutputSchema,
    chatImageIntentPrompt,
    chatImageIntentUserMessage,
    chatImageModelCandidates,
    parseChatImageIntentOutput,
    type ChatImageDecision,
} from "@/lib/chatImageIntentCore";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";

const NOT_IMAGE: ChatImageDecision = { image: false };

/**
 * The router model id when image triage is on (Admin Console › Routing: a
 * router model and the image triage switch), otherwise null. Never throws.
 */
export async function chatImageTriageModelId(): Promise<string | null> {
    const [on, modelId] = await Promise.all([
        readAutoLlmRouterImageTriage(),
        readAutoLlmRouterModelId(),
    ]);
    return on ? modelId : null;
}

/**
 * Whether a chat message asks for a new image and, if so, which image model
 * and preset it needs -- one call to the Auto router's model, which triages
 * image requests the way it triages chat ones.
 *
 * `{ image: false }` -- and the message goes to chat as before -- when image
 * triage is off or no router model is set, it is unavailable or unpriced, no image model is
 * enabled, the provider's operational budget is spent, or the call fails,
 * times out or answers malformed. Never throws: routing must not be the
 * reason a send fails.
 *
 * The call's worst case is held under the same provider day/month budget as
 * the Auto router before it leaves, and settled to the reported usage after.
 * The log line carries ids, outcome and timing only, never the message.
 */
export async function detectChatImageRequest(input: {
    text: string;
    traceId: string;
}): Promise<ChatImageDecision> {
    if (!chatImageIntentPrompt(input.text)) return NOT_IMAGE;
    const configured = await chatImageTriageModelId();
    if (!configured) return NOT_IMAGE;

    let model;
    let candidates;
    try {
        const [runtimeModels, imageModels] = await Promise.all([
            getRuntimeModels(),
            refreshImageModelCatalog(),
        ]);
        model = resolveAutoLlmRouterModel(
            runtimeModels.filter((entry) => entry.enabled && !entry.catalogDeleted),
            configured
        );
        candidates = chatImageModelCandidates(imageModels);
    } catch {
        return NOT_IMAGE;
    }
    if (!model || candidates.length === 0) return NOT_IMAGE;

    let prices: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
    try {
        const pricing = resolveModelPricing(model);
        prices = {
            inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
        };
    } catch {
        return NOT_IMAGE;
    }
    const prompt = chatImageIntentUserMessage(input.text, candidates);
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
        return NOT_IMAGE;
    }

    const startedAt = Date.now();
    let decision: ChatImageDecision = NOT_IMAGE;
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
                schema: jsonSchema(
                    chatImageIntentOutputSchema(candidates) as unknown as JSONSchema7
                ),
                name: "chat_image_intent",
            }),
            providerOptions: autoLlmRouterProviderOptions(model.provider),
        });
        decision = parseChatImageIntentOutput(generated.output, candidates);
        outcome = decision.image ? "image" : "chat";
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
        decision = NOT_IMAGE;
        outcome = "error";
    }
    console.info(
        JSON.stringify({
            event: "chat_image_intent",
            traceId: input.traceId,
            modelId: model.id,
            outcome,
            imageModelId: decision.image ? decision.modelId : null,
            preset: decision.image ? decision.preset : null,
            candidateCount: candidates.length,
            latencyMs: Date.now() - startedAt,
        })
    );
    return decision;
}
