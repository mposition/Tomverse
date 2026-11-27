import "server-only";

import { CHAT_RESPONSE_ATTEMPT_ACTIVE_STATUSES } from "@/lib/chatResponseAttemptCore";
import { lockChatRecoveryConversation } from "@/lib/chatResponseAttemptPersistence";
import { deleteOwnedConversations } from "@/lib/conversationDeletion";
import { prisma } from "@/lib/prisma";
import { temporaryConversationSweepWhere, temporarySweepCutoff } from "@/lib/temporaryChatAccess";

/**
 * Conversations one batch examines, and how many batches one run may take.
 * A run keeps going while batches come back full, so a backlog is worked off
 * in the same run instead of adding fifteen minutes per hundred; past the
 * last batch the rest wait for the next run.
 */
export const TEMPORARY_CHAT_SWEEP_BATCH = 100;
export const TEMPORARY_CHAT_SWEEP_MAX_BATCHES = 20;

export type TemporaryConversationSweepResult = {
    examined: number;
    deleted: number;
    /** Still answering: a live durable attempt holds the conversation. */
    deferred: number;
    failed: number;
};

/**
 * Deletes temporary Chats past their expiry (lib/temporaryChatAccess.ts),
 * through the same deletion path the owner's own delete uses.
 *
 * Only `temporaryExpiresAt` selects a conversation, and the deletion re-reads
 * the id through the same predicate inside its own transaction, so an
 * ordinary conversation cannot be chosen here at either step.
 *
 * One transaction per conversation, under the conversation's recovery lock --
 * the lock a durable answer's claim takes. A conversation with a live attempt
 * lease is left for a later pass: the send path stopped admitting answers at
 * the expiry, so only one admitted just before it can be running, and it is
 * deleted once it ends or its lease lapses. A claim that comes after the
 * delete finds no conversation and is refused.
 *
 * Runs whether or not `feature.temporaryChatEnabled` is on: turning the
 * switch off stops new temporary Chats, never the deletion promised to the
 * ones that exist.
 */
export async function sweepExpiredTemporaryConversations(
    now = new Date(),
    limit = TEMPORARY_CHAT_SWEEP_BATCH,
    maxBatches = TEMPORARY_CHAT_SWEEP_MAX_BATCHES
): Promise<TemporaryConversationSweepResult> {
    const cutoff = temporarySweepCutoff(now);
    const result: TemporaryConversationSweepResult = { examined: 0, deleted: 0, deferred: 0, failed: 0 };
    // A conversation deferred or failed in this run is not examined again in it.
    const seen: string[] = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
        const candidates = await prisma.conversation.findMany({
            where: { ...temporaryConversationSweepWhere(cutoff), ...(seen.length ? { id: { notIn: seen } } : {}) },
            select: { id: true, userId: true },
            orderBy: [{ temporaryExpiresAt: "asc" }, { id: "asc" }],
            take: limit,
        });
        result.examined += candidates.length;
        for (const candidate of candidates) {
            seen.push(candidate.id);
            await sweepOne(candidate, { now, cutoff, result });
        }
        if (candidates.length < limit) break;
    }
    if (result.examined > 0) {
        console.info(JSON.stringify({ event: "temporary_chat_sweep", ...result }));
    }
    return result;
}

async function sweepOne(
    candidate: { id: string; userId: string },
    { now, cutoff, result }: { now: Date; cutoff: Date; result: TemporaryConversationSweepResult }
) {
    try {
        const outcome = await prisma.$transaction(async (tx) => {
            await lockChatRecoveryConversation(tx, candidate.userId, candidate.id);
            const live = await tx.chatResponseAttempt.findFirst({
                where: {
                    userId: candidate.userId,
                    conversationId: candidate.id,
                    status: { in: [...CHAT_RESPONSE_ATTEMPT_ACTIVE_STATUSES] },
                    leaseExpiresAt: { gt: now },
                },
                select: { assistantMessageId: true },
            });
            if (live) return "deferred" as const;
            const deleted = await deleteOwnedConversations(tx, {
                userId: candidate.userId,
                conversationIds: [candidate.id],
                temporaryExpiredBefore: cutoff,
            });
            return deleted.count === 1 ? ("deleted" as const) : ("gone" as const);
        });
        if (outcome === "deleted") result.deleted += 1;
        else if (outcome === "deferred") result.deferred += 1;
    } catch (error) {
        result.failed += 1;
        console.error(JSON.stringify({
            event: "temporary_chat_sweep_failed",
            // Content-free: the error class only, never the conversation.
            error: error instanceof Error ? error.name : "unknown",
        }));
    }
}

/** For the fifteen-minute maintenance run: never throws. */
export async function runTemporaryConversationSweepQuietly(): Promise<TemporaryConversationSweepResult> {
    try {
        return await sweepExpiredTemporaryConversations();
    } catch (error) {
        console.error("Temporary chat sweep failed:", error);
        return { examined: 0, deleted: 0, deferred: 0, failed: 1 };
    }
}
