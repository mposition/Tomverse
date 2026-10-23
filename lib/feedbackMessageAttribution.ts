import "server-only";
import type { Prisma } from "@prisma/client";

/** An optional link never changes report acceptance or authenticates a trace. */
export async function resolveFeedbackMessageId(tx: Prisma.TransactionClient, userId: string | null, messageId?: string): Promise<string | null> {
    if (!userId || !messageId) return null;
    // Hold the referenced row through insertion. Concurrent deletion then clears
    // the link through SET NULL instead of making the whole report fail its FK.
    const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT m."id" FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
        WHERE m."id" = ${messageId} AND m."role" = 'assistant' AND c."userId" = ${userId}
        FOR KEY SHARE OF m
    `;
    return rows[0]?.id ?? null;
}
