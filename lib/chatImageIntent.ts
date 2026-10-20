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
    CHAT_IMAGE_INTENT_FOLLOW_UP_MAX_OUTPUT_TOKENS,
    CHAT_IMAGE_INTENT_FOLLOW_UP_TIMEOUT_MS,
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
import { CHAT_IMAGE_TURN_CONTENT_PREFIX } from "@/lib/chatImageTurnCore";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { prisma } from "@/lib/prisma";
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
/** How far back a follow-up may reach for "the previous image". */
const FOLLOW_UP_LOOKBACK_MESSAGES = 6;

/**
 * The prompt that made the latest image in this conversation, when one of
 * its last few messages is an image answer -- what a follow-up such as "make
 * it bluer" changes. Null when there is none or it cannot be read; the call
 * then judges the message on its own. Scoped to the caller's conversation.
 */
export async function readPreviousImagePrompt(
    userId: string,
    conversationId: string
): Promise<string | null> {
    try {
        const recent = await prisma.message.findMany({
            where: { conversationId, conversation: { userId } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: FOLLOW_UP_LOOKBACK_MESSAGES,
            select: { id: true, role: true, content: true },
        });
        const answer = recent.find(
            (message) =>
                message.role === "assistant" &&
                message.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX)
        );
        if (!answer) return null;
        const group = await prisma.imageGenerationGroup.findFirst({
            where: { userId, conversationId, groupIdempotencyKey: answer.id },
            select: { id: true },
        });
        if (!group) return null;
        const generation = await prisma.imageGeneration.findFirst({
            where: { userId, groupId: group.id },
            orderBy: { createdAt: "asc" },
            select: { prompt: true },
        });
        return generation?.prompt.trim() || null;
    } catch {
        return null;
    }
}

export async function detectChatImageRequest(input: {
    text: string;
    traceId: string;
    /** The Chat conversation the message is sent in, for follow-ups. */
    userId?: string;
    conversationId?: string | null;
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
    const previous =
        input.userId && input.conversationId
            ? await readPreviousImagePrompt(input.userId, input.conversationId)
            : null;
    const prompt = chatImageIntentUserMessage(input.text, candidates, previous);
    // A follow-up writes a whole prompt, not just a decision.
    const maxOutputTokens = previous
        ? CHAT_IMAGE_INTENT_FOLLOW_UP_MAX_OUTPUT_TOKENS
        : CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS;
    const timeoutMs = previous
        ? CHAT_IMAGE_INTENT_FOLLOW_UP_TIMEOUT_MS
        : CHAT_IMAGE_INTENT_TIMEOUT_MS;
    const worstCase = autoLlmRouterWorstCaseMicroUsd({
        system: CHAT_IMAGE_INTENT_SYSTEM,
        prompt,
        maxOutputTokens,
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
            maxOutputTokens,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(timeoutMs),
            output: Output.object({
                schema: jsonSchema(
                    chatImageIntentOutputSchema(candidates) as unknown as JSONSchema7
                ),
                name: "chat_image_intent",
            }),
            providerOptions: autoLlmRouterProviderOptions(model.provider),
        });
        decision = parseChatImageIntentOutput(generated.output, candidates, previous !== null);
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
            followUp: decision.image ? decision.prompt !== null : false,
            candidateCount: candidates.length,
            latencyMs: Date.now() - startedAt,
        })
    );
    return decision;
}
