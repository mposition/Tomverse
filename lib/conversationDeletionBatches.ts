/**
 * "Delete all conversations" in bounded transactions.
 *
 * The owner's whole-account delete used to be one interactive transaction over
 * every conversation: queueing every object key, removing every research job
 * and deleting every row inside Prisma's default five-second window. An
 * account with a few hundred conversations timed out, rolled all of it back
 * and answered 500 -- the one account that most needed the delete was the one
 * that could not have it.
 *
 * So the ids are cut into batches and each batch is its own transaction
 * (lib/conversationDeletion.ts, which queues the object tombstones in that
 * same transaction -- a batch is never half-queued). A batch that commits is
 * final; a batch that fails rolls back alone. The outcome therefore says
 * exactly what happened: how many rows went, how many of the requested ids
 * were handled by committed batches, and the failure that stopped the rest.
 * Stopping at the first failure is deliberate: carrying on past an error
 * would hide it behind a partial success the person never asked for.
 *
 * Pure and dependency-free so it is unit-testable without a database.
 */

/** Conversations deleted per transaction. */
export const CONVERSATION_DELETE_BATCH_SIZE = 50;

export type ConversationDeleteOutcome = {
    /** Rows actually deleted by committed batches. */
    deleted: number;
    /** Requested ids covered by committed batches (including ones already gone). */
    processed: number;
    /** Requested ids not covered by a committed batch. Zero on success. */
    remaining: number;
    /** The error that stopped the run, or null when every batch committed. */
    failure: unknown | null;
};

export const chunkConversationIds = (ids: readonly string[], size = CONVERSATION_DELETE_BATCH_SIZE): string[][] => {
    const unique = [...new Set(ids)];
    const batches: string[][] = [];
    for (let index = 0; index < unique.length; index += size) {
        batches.push(unique.slice(index, index + size));
    }
    return batches;
};

export async function deleteConversationsInBatches(
    ids: readonly string[],
    deleteBatch: (batch: string[]) => Promise<{ count: number }>,
    size = CONVERSATION_DELETE_BATCH_SIZE
): Promise<ConversationDeleteOutcome> {
    const batches = chunkConversationIds(ids, size);
    const total = batches.reduce((sum, batch) => sum + batch.length, 0);
    let deleted = 0;
    let processed = 0;
    for (const batch of batches) {
        try {
            const result = await deleteBatch(batch);
            deleted += result.count;
            processed += batch.length;
        } catch (failure) {
            return { deleted, processed, remaining: total - processed, failure };
        }
    }
    return { deleted, processed, remaining: 0, failure: null };
}
