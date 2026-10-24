import "server-only";

import { Prisma } from "@prisma/client";
import { chatImageTriageModelId } from "@/lib/chatImageIntent";
import { CHAT_IMAGE_TURN_CONTENT_PREFIX, chatImageTurnGroupKey } from "@/lib/chatImageTurnCore";
import { ChatAccessError } from "@/lib/chatSecurity";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import {
    IMAGE_QUALITY_BY_PRESET,
    type ImagePreset,
} from "@/lib/imageGenerationPricing";
import { requestImageGeneration } from "@/lib/imageGenerationService";
import { prisma } from "@/lib/prisma";

/**
 * One Chat or Review turn answered with an image instead of text
 * (docs/policy/image-generation.md §13 ⑥, owner decision 2026-10-20: in
 * Chat the image appears in the conversation; Review follows it on 2026-10-23).
 *
 * The user's message is already saved by the ordinary send. This reserves
 * the image through `requestImageGeneration` -- the same gates, reservation,
 * settlement and provider budget as the image workspace -- attached to the
 * chat conversation itself, and writes the assistant message the image
 * answers with. The group's idempotency key is the assistant message id, so
 * a retry replays the same group rather than paying twice, and a transcript
 * read finds the group from the message without a new column.
 */
export type ChatImageTurnInput = {
    userId: string;
    conversationId: string;
    sourceUserMessageId: string;
    assistantMessageId: string;
    /** The panel's chat model, stored on the answer like any other. */
    modelId: string;
    imageModelIds: string[];
    imageGroupModelIds?: string[];
    preset: ImagePreset | null;
    /** A follow-up's rewritten prompt; the saved question otherwise. */
    prompt?: string;
    request?: Request;
};

export type ChatImageTurnResult = {
    groupId: string;
    /** The image models in the group, in target order. */
    imageModelIds: string[];
    content: string;
    /**
     * Generations still waiting to start; the route drives them after
     * responding. A replay included: if the first request's executor never
     * ran (its answer write failed, or the response was lost before after()),
     * the retry is what starts them. The claim in processImageGeneration lets
     * only one runner take each.
     */
    pendingGenerationIds: string[];
};

/** What the answer's text says: read by later turns and by exports. */
export const chatImageTurnContent = (prompt: string) =>
    `${CHAT_IMAGE_TURN_CONTENT_PREFIX} ${prompt.trim().slice(0, 500)}`;

export async function startChatImageTurn(
    input: ChatImageTurnInput
): Promise<ChatImageTurnResult> {
    const conversation = await prisma.conversation.findFirst({
        where: { id: input.conversationId, userId: input.userId },
        select: {
            kind: true,
            productKey: true,
            password: true,
            continuationBridge: { select: { id: true } },
        },
    });
    if (!conversation) {
        throw new ChatAccessError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    }
    // Only explicit product identities grant the in-conversation image host.
    // Continued conversations and image-workspace rows are still excluded.
    if (
        !isChatConversationKind(conversation.kind) ||
        !["chat", "review"].includes(conversation.productKey ?? "") ||
        conversation.continuationBridge !== null
    ) {
        throw new ChatAccessError(
            409,
            "CONVERSATION_KIND_NOT_SUPPORTED",
            "This conversation does not support chat image turns."
        );
    }
    if (conversation.productKey === "chat" && !(await chatImageTriageModelId())) {
        throw new ChatAccessError(403, "CHAT_IMAGE_TURN_DISABLED", "Images in chat are not enabled.");
    }
    if (conversation.password &&
        (!input.request || !hasConversationUnlockGrant(input.request, input.userId, input.conversationId, conversation.password))) {
        throw new ChatAccessError(403, "CONVERSATION_LOCKED", "Unlock this conversation before generating images.");
    }

    const source = await prisma.message.findFirst({
        where: {
            id: input.sourceUserMessageId,
            conversationId: input.conversationId,
            role: "user",
        },
        select: { content: true },
    });
    // The question is the saved one, never text the request carries; a
    // follow-up's rewrite (input.prompt) only changes what the image is made
    // from, not what the answer says was asked.
    const prompt = source?.content.trim() ?? "";
    if (!prompt) {
        throw new ChatAccessError(404, "SOURCE_MESSAGE_NOT_FOUND", "The question was not found.");
    }

    const existing = await prisma.message.findUnique({
        where: { id: input.assistantMessageId },
        select: { conversationId: true, role: true, content: true },
    });
    // A replay is only of an image answer: reusing a text answer's id would
    // reserve an image the transcript can never show.
    if (
        existing &&
        (existing.conversationId !== input.conversationId ||
            existing.role !== "assistant" ||
            !existing.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX))
    ) {
        throw new ChatAccessError(409, "ASSISTANT_MESSAGE_CONFLICT", "That answer id is taken.");
    }

    const isReview = conversation.productKey === "review";
    if (input.imageGroupModelIds && (!isReview || input.imageModelIds.length !== 1 ||
        [...input.imageGroupModelIds].sort()[Number(input.assistantMessageId.split("_").at(-1))] !== input.imageModelIds[0] ||
        chatImageTurnGroupKey(input.assistantMessageId) === input.assistantMessageId)) {
        throw new ChatAccessError(400, "IMAGE_MODEL_SELECTION_INVALID", "Invalid comparison image selection.");
    }
    const result = await requestImageGeneration({
        userId: input.userId,
        // The answer's text still names the question that was asked.
        prompt: input.prompt?.trim() || prompt,
        size: "1024x1024",
        quality: IMAGE_QUALITY_BY_PRESET[input.preset ?? "standard"],
        conversationId: input.conversationId,
        idempotencyKey: input.imageGroupModelIds ? chatImageTurnGroupKey(input.assistantMessageId) : input.assistantMessageId,
        modelIds: input.imageGroupModelIds ?? (input.imageModelIds.length > 0 ? input.imageModelIds : undefined),
        chatTurnHost: true,
    });

    if (result.conversationId !== input.conversationId || (input.imageGroupModelIds &&
        [...result.targets.map(target => target.modelId)].sort().join("\n") !== [...input.imageGroupModelIds].sort().join("\n"))) {
        throw new ChatAccessError(409, "ASSISTANT_MESSAGE_CONFLICT", "That image request belongs to another turn.");
    }
    const content = existing?.content ?? chatImageTurnContent(prompt);
    if (!existing) {
        try {
            await prisma.message.create({
                data: {
                    id: input.assistantMessageId,
                    conversationId: input.conversationId,
                    role: "assistant",
                    content,
                    modelId: input.modelId,
                },
            });
        } catch (error) {
            // A concurrent replay wrote it first; the group is the same one.
            if (
                !(error instanceof Prisma.PrismaClientKnownRequestError) ||
                error.code !== "P2002"
            ) {
                throw error;
            }
        }
        await prisma.conversation.update({
            where: { id: input.conversationId },
            data: { updatedAt: new Date() },
        });
    }

    return {
        groupId: result.groupId,
        imageModelIds: result.targets.map((target) => target.modelId)
            .filter(id => !input.imageGroupModelIds || input.imageModelIds.includes(id)),
        content,
        pendingGenerationIds: result.targets
            .filter((target) => target.status === "pending")
            .map((target) => target.generationId),
    };
}
