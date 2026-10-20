import "server-only";

import { Prisma } from "@prisma/client";
import { chatImageTriageModelId } from "@/lib/chatImageIntent";
import { CHAT_IMAGE_TURN_CONTENT_PREFIX } from "@/lib/chatImageTurnCore";
import { ChatAccessError } from "@/lib/chatSecurity";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import {
    IMAGE_QUALITY_BY_PRESET,
    type ImagePreset,
} from "@/lib/imageGenerationPricing";
import { requestImageGeneration } from "@/lib/imageGenerationService";
import { prisma } from "@/lib/prisma";

/**
 * One Tomverse Chat turn answered with an image instead of text
 * (docs/policy/image-generation.md §13 ⑥, owner decision 2026-10-20: in
 * Chat the image appears in the conversation, no image workspace).
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
    preset: ImagePreset | null;
    /** A follow-up's rewritten prompt; the saved question otherwise. */
    prompt?: string;
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
    // The paid path exists only while the operator has it on. Checked here,
    // not trusted from the client that decided to send an image turn.
    if (!(await chatImageTriageModelId())) {
        throw new ChatAccessError(
            403,
            "CHAT_IMAGE_TURN_DISABLED",
            "Images in chat are not enabled."
        );
    }

    const conversation = await prisma.conversation.findFirst({
        where: { id: input.conversationId, userId: input.userId },
        select: {
            kind: true,
            productKey: true,
            continuationBridge: { select: { id: true } },
        },
    });
    if (!conversation) {
        throw new ChatAccessError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    }
    // Tomverse Chat only (policy §13 ⑥): Review and continued conversations
    // are chat-kind too, and the exception does not extend to them.
    if (
        !isChatConversationKind(conversation.kind) ||
        conversation.productKey !== "chat" ||
        conversation.continuationBridge !== null
    ) {
        throw new ChatAccessError(
            409,
            "CONVERSATION_KIND_NOT_SUPPORTED",
            "This conversation does not support chat image turns."
        );
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

    const result = await requestImageGeneration({
        userId: input.userId,
        // The answer's text still names the question that was asked.
        prompt: input.prompt?.trim() || prompt,
        size: "1024x1024",
        quality: IMAGE_QUALITY_BY_PRESET[input.preset ?? "standard"],
        conversationId: input.conversationId,
        idempotencyKey: input.assistantMessageId,
        modelIds: input.imageModelIds.length > 0 ? input.imageModelIds : undefined,
        chatTurnHost: true,
    });

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
        imageModelIds: result.targets.map((target) => target.modelId),
        content,
        pendingGenerationIds: result.targets
            .filter((target) => target.status === "pending")
            .map((target) => target.generationId),
    };
}
