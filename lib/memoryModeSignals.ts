import "server-only";

import { recordMemoryCounter } from "@/lib/memoryMetrics";
import { prisma } from "@/lib/prisma";

/**
 * §22's memory-off half of the follow-up / repair proxy.
 *
 * Turning memory off for a conversation is the most direct dissatisfaction
 * signal in the §22 list — far more pointed than a follow-up question, which
 * often means the answer was good. But it is only a signal about *memory*
 * when it happens right after an answer memory actually shaped. Someone who
 * opens a conversation and turns memory off before saying anything is
 * expressing a preference, not a complaint, and counting the two together
 * would bury the one that matters.
 *
 * So the counter fires on a narrow conjunction: the mode moved to `off`, it
 * was not already off, and the conversation's most recent answer was
 * memory-shaped and recent. Everything else is a mode change and nothing
 * more.
 *
 * `Conversation.memoryMode` keeps no history, which is why this is recorded
 * as it happens rather than derived later — the previous value is gone the
 * moment the update commits.
 */

/** §22's window, the same 120 seconds the follow-up proxy uses. */
const RECENT_ANSWER_WINDOW_MS = 120_000;

export async function recordConversationMemoryOff(input: {
    conversationId: string;
    previousMode: string | null;
    nextMode: string;
    now?: Date;
}) {
    if (input.nextMode !== "off" || input.previousMode === "off") return;

    const now = input.now ?? new Date();
    try {
        const lastAnswer = await prisma.message.findFirst({
            where: { conversationId: input.conversationId, role: "assistant" },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { createdAt: true, memoryUsedCount: true },
        });
        if (!lastAnswer || (lastAnswer.memoryUsedCount ?? 0) <= 0) return;
        if (
            now.getTime() - lastAnswer.createdAt.getTime() >
            RECENT_ANSWER_WINDOW_MS
        ) {
            return;
        }
        await recordMemoryCounter("memory_off_after_injection", 1, now);
    } catch (error) {
        // Same rule as every other counter: observing something must never
        // turn into a second failure for the user, whose mode change has
        // already been saved by the time this runs.
        console.warn(
            JSON.stringify({
                event: "memory_off_signal_failed",
                errorName: error instanceof Error ? error.name : "UnknownError",
            })
        );
    }
}
