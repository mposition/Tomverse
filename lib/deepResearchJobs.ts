import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * Remove the deep research job rows belonging to conversations being deleted.
 *
 * `PerplexityAsyncJob` names a `conversationId` but declares no relation to
 * `Conversation`, so no cascade reaches it. Deleting a conversation -- or a
 * whole account -- left the job row behind holding `resultText`: the full deep
 * research report, written into `Message.content` at the same time and now the
 * only surviving copy, with nothing anywhere still pointing at it.
 *
 * The retention sweep would take it eventually. "Eventually" is the wrong
 * answer to an account deletion: the point of deleting an account is that the
 * content goes when the user says so, not thirty days later on a cadence.
 *
 * One function, called from all three delete paths (single conversation, bulk
 * conversations, account deletion), because three inline `deleteMany` calls
 * are three things to keep in step and the one that gets missed is the one
 * nobody tests.
 *
 * Takes the transaction client on purpose: this has to commit with the
 * conversation delete, or a failure between them is exactly the orphan it
 * exists to prevent.
 */
export const deleteDeepResearchJobsForConversations = async (
    tx: Prisma.TransactionClient,
    conversationIds: string[]
) => {
    if (conversationIds.length === 0) return 0;
    const { count } = await tx.perplexityAsyncJob.deleteMany({
        where: { conversationId: { in: conversationIds } },
    });
    return count;
};
