import "server-only";

import { CHAT_IMAGE_TURN_CONTENT_PREFIX, chatImageTurnGroupKey } from "@/lib/chatImageTurnCore";
import { prisma } from "@/lib/prisma";

/**
 * The image groups that answer these transcript messages, by message id
 * (lib/chatImageTurn.ts): an image turn's group is keyed by its assistant
 * message id. Only answers whose text marks them as image turns are looked
 * up, so a transcript with none makes no query.
 */
export async function attachChatImageTurns<
    T extends { id: string; role: string; content: string },
>(
    userId: string,
    conversationId: string,
    messages: T[]
): Promise<Array<T & { imageTurn?: { groupId: string; modelIds: string[] } }>> {
    const ids = messages
        .filter(
            (message) =>
                message.role === "assistant" &&
                message.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX)
        )
        .map((message) => message.id);
    if (ids.length === 0) return messages;
    const groups = await prisma.imageGenerationGroup.findMany({
        where: { userId, conversationId, groupIdempotencyKey: { in: [...new Set(ids.flatMap(id => [id, chatImageTurnGroupKey(id)]))] } },
        select: {
            id: true,
            groupIdempotencyKey: true,
            targets: { select: { modelId: true }, orderBy: { createdAt: "asc" } },
        },
    });
    const byMessage = new Map(
        groups.map((group) => [
            group.groupIdempotencyKey,
            { groupId: group.id, modelIds: group.targets.map((target) => target.modelId) },
        ])
    );
    return messages.map((message) => {
        const key = chatImageTurnGroupKey(message.id);
        const direct = byMessage.get(message.id);
        let imageTurn = direct ?? byMessage.get(key);
        if (imageTurn && !direct && key !== message.id) {
            // Review's suffix is the target's index in the sorted, immutable
            // model ids. History survives catalogue changes and target retries.
            const index = Number(message.id.slice(message.id.lastIndexOf("_") + 1));
            imageTurn = { ...imageTurn, modelIds: [...imageTurn.modelIds].sort().slice(index, index + 1) };
        }
        return imageTurn ? { ...message, imageTurn } : message;
    });
}
