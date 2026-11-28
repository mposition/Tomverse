import "server-only";

import type { Prisma } from "@prisma/client";

import { DESKTOP_APP_ORIGIN } from "@/lib/nativeBearerGate";

/**
 * Archiving a conversation: out of the default list, its date groups and the
 * pinned section, and listed only under the sidebar's "Archived" filter.
 *
 * `Conversation.archivedAt` is the only thing it changes. Sharing, the lock,
 * export, deletion and delete-all behave exactly as they did; the pin columns
 * are left alone, so a pinned conversation comes back pinned and the pin
 * sequence (lib/conversationPinStore.ts) is never written from here.
 *
 * Raw SQL for the same reason as the pin route: `updatedAt` is `@updatedAt`
 * and the sidebar groups by it, so a Prisma update would file an archived
 * conversation under 오늘 when it is restored.
 *
 * Who reads it:
 *   - GET /api/conversations leaves archived rows out unless asked
 *     (`?archived=include` or `only`); app clients keep their full list;
 *   - the account's own message search returns archived hits, marked;
 *   - the model's past-chat search (lib/chatHistoryReference.ts) never does.
 */

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/**
 * Which archived conversations a list request gets.
 *
 * The web asks: `?archived=include` for every row, each marked, or `only`.
 * Without a value it gets the default list, which leaves them out. The mobile
 * and desktop apps have no archive screen yet, so they keep the full list they
 * always had -- an archived conversation must not look deleted on a device
 * that cannot show where it went.
 */
export function archivedListWhere(request: Request): Prisma.ConversationWhereInput {
    const appClient =
        request.headers.get("origin") === DESKTOP_APP_ORIGIN || request.headers.has("authorization");
    const requested = new URL(request.url).searchParams.get("archived");
    if (appClient || requested === "include") return {};
    if (requested === "only") return { archivedAt: { not: null } };
    return { archivedAt: null };
}

/**
 * Archive or restore the account's own conversations, by id.
 *
 * Scoped by `userId` in the statement: another account's id matches no row.
 * A temporary Chat is never archived -- it is not in the list to begin with.
 * Archiving keeps the first moment (`COALESCE`), like a re-pin.
 */
export async function setConversationsArchived(
    db: Db,
    input: { userId: string; conversationIds: readonly string[]; archived: boolean }
): Promise<string[]> {
    if (input.conversationIds.length === 0) return [];
    const rows = await db.$queryRaw<Array<{ id: string }>>`
        UPDATE "Conversation"
        SET "archivedAt" = CASE WHEN ${input.archived} THEN COALESCE("archivedAt", NOW()) ELSE NULL END
        WHERE "id" = ANY(${[...input.conversationIds]}::text[])
          AND "userId" = ${input.userId}
          AND "temporaryExpiresAt" IS NULL
        RETURNING "id"
    `;
    return rows.map((row) => row.id);
}

/**
 * A new message brings an archived conversation back. Touches nothing else,
 * and nothing at all when the conversation is not archived.
 */
export async function restoreArchivedConversationOnMessage(db: Db, conversationId: string): Promise<void> {
    await db.$executeRaw`
        UPDATE "Conversation" SET "archivedAt" = NULL
        WHERE "id" = ${conversationId} AND "archivedAt" IS NOT NULL
    `;
}
