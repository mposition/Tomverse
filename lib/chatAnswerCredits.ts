import "server-only";

import { settledAnswerCredits } from "@/lib/chatAnswerCreditsCore";
import { prisma } from "@/lib/prisma";

/**
 * Credits charged for these answers, read from the owner's own reservations.
 *
 * The caller proves the answers belong to a conversation this user owns and
 * has unlocked. The `userId` filter is the second half of that: a reservation
 * another account made while naming one of these ids (the id comes from the
 * request) is never counted against this owner's answer.
 *
 * Read-only. No lock, no write: the rows were finished by settlement, and an
 * unfinished one only withholds its answer (lib/chatAnswerCreditsCore.ts).
 */
export async function readSettledAnswerCredits(
  userId: string,
  messageIds: readonly string[]
): Promise<Map<string, number>> {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.chatCreditReservation.findMany({
    where: { userId, assistantMessageId: { in: ids } },
    select: { assistantMessageId: true, status: true, settledCredits: true },
  });
  return settledAnswerCredits(rows);
}

/**
 * The transcript page with each charged answer's credits on it, for an
 * owner-authorized Chat read. Answers with no final, non-zero figure are
 * returned unchanged.
 */
export async function attachSettledAnswerCredits<T extends { id: string; role: string }>(
  userId: string,
  messages: T[]
): Promise<Array<T & { settledCredits?: number }>> {
  const answerIds = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.id);
  if (answerIds.length === 0) return messages;
  const credits = await readSettledAnswerCredits(userId, answerIds);
  if (credits.size === 0) return messages;
  return messages.map((message) => {
    const settledCredits =
      message.role === "assistant" ? credits.get(message.id) : undefined;
    return settledCredits === undefined ? message : { ...message, settledCredits };
  });
}
