import "server-only";

import type { Prisma } from "@prisma/client";

import { ChatAccessError } from "@/lib/chatSecurity";
import { scopedMessageId } from "@/lib/messageRequestIdentity";
import { prisma } from "@/lib/prisma";

/**
 * "Regenerate" and "edit your last message" replace the newest turn without a
 * conversation tree: the replaced question and answer stay, and the new
 * question is saved as an ordinary new turn. `Message.supersededAt` is the one
 * fact that turns them into "replaced", and it is the server's, so every
 * device, browser and client draws the same turn dimmed and leaves it out of
 * the model's context.
 *
 * Two writers, one rule (written only once the new answer is finished):
 *
 *  - the chat route, in the transaction that saves the replacing answer, for
 *    the ids the request named (`supersedesMessageIds`). That is what records
 *    a durable regeneration that finishes after the page was reloaded or
 *    closed: nobody is left in the browser to report it.
 *  - PUT /api/conversations/[conversationId]/superseded, which the browser
 *    calls where it sees the answer finished. Idempotent with the first.
 *
 * Ids arrive as the browser holds them: the request id of a message sent in
 * this page, or the stored id of one loaded from history. A stored id is
 * `scopedMessageId(conversationId, requestId)`, so both spellings are matched
 * and both are scoped to the one conversation: an id copied from another
 * conversation hashes to a row that conversation does not have.
 */

/** The chat request's own message id shape (lib/chatSecurity.ts). */
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A turn is a question and its answer; a little room, never a list. */
export const MAX_SUPERSEDED_IDS_PER_WRITE = 4;

export const isSupersededMessageIdList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_SUPERSEDED_IDS_PER_WRITE &&
  value.every((id) => typeof id === "string" && MESSAGE_ID.test(id));

/** The chat request's optional `supersedesMessageIds`; absent means none. */
export function readSupersedesMessageIds(body: unknown): string[] {
  const value = (body as { supersedesMessageIds?: unknown } | null)?.supersedesMessageIds;
  if (value === undefined) return [];
  if (!isSupersededMessageIdList(value)) {
    throw new ChatAccessError(400, "INVALID_SUPERSEDED_MESSAGES", "Invalid replaced messages.");
  }
  return [...new Set(value)];
}

const bothSpellings = (conversationId: string, ids: readonly string[]) => [
  ...new Set(ids.flatMap((id) => [id, scopedMessageId(conversationId, id)])),
];

type MessageWriter = Pick<Prisma.TransactionClient, "message">;

/**
 * Marks the named messages of one conversation replaced. Rows already marked
 * keep their first time, and an id that names nothing here matches nothing.
 * The caller has already established that the conversation is the caller's.
 */
export async function markMessagesSuperseded(
  db: MessageWriter,
  conversationId: string,
  ids: readonly string[],
  now: Date = new Date()
): Promise<number> {
  if (ids.length === 0) return 0;
  const { count } = await db.message.updateMany({
    where: { conversationId, id: { in: bothSpellings(conversationId, ids) }, supersededAt: null },
    data: { supersededAt: now },
  });
  return count;
}

/**
 * The request transcript without the turns this conversation has replaced,
 * whatever the client sent: a client that never heard of the replacement (an
 * older bundle, another device, the native apps) gets the same context as the
 * one that did. The last message is the one being answered and always stays.
 * `replacing` is the turn this very request replaces, left out at once.
 */
export async function withoutSupersededChatMessages<T extends { id?: string }>(input: {
  userId: string | null | undefined;
  conversationId: string | null | undefined;
  messages: T[];
  replacing: readonly string[];
}): Promise<T[]> {
  const { userId, conversationId, messages, replacing } = input;
  if (!userId || !conversationId || messages.length < 2) return messages;
  const rows = await prisma.message.findMany({
    where: { conversationId, supersededAt: { not: null }, conversation: { userId } },
    select: { id: true },
  });
  const excluded = new Set([...rows.map((row) => row.id), ...bothSpellings(conversationId, replacing)]);
  if (excluded.size === 0) return messages;
  const last = messages.length - 1;
  const kept = messages.filter(
    (message, index) =>
      index === last ||
      !message.id ||
      !(excluded.has(message.id) || excluded.has(scopedMessageId(conversationId, message.id)))
  );
  return kept.length === messages.length ? messages : kept;
}
