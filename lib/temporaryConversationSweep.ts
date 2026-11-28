import "server-only";

import type { Prisma } from "@prisma/client";

import { CHAT_RESPONSE_ATTEMPT_ACTIVE_STATUSES } from "@/lib/chatResponseAttemptCore";
import { lockChatRecoveryConversation } from "@/lib/chatResponseAttemptPersistence";
import { deleteOwnedConversations } from "@/lib/conversationDeletion";
import { STALE_IMAGE_GENERATION_AFTER_MS, STALE_IMAGE_SETTLING_AFTER_MS } from "@/lib/imageGenerationStateCore";
import { prisma } from "@/lib/prisma";
import {
    TEMPORARY_SWEEP_LIVE_IMAGE_CALL_STATUSES,
    TEMPORARY_SWEEP_LIVE_RESEARCH_STATUSES,
    temporaryConversationSweepWhere,
    temporarySweepCutoff,
    temporarySweepMayDefer,
} from "@/lib/temporaryChatAccess";

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
    /**
     * Still working: a live durable attempt, an executing Research run or an
     * image generation in flight holds the conversation.
     */
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
 * The same wait covers an executing Research run and an image generation in
 * flight: their rows cascade with the conversation, so a delete would throw
 * the paid work away mid-call. The wait is bounded
 * (TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS after the expiry) so a stuck run cannot
 * keep a temporary Chat alive past the deletion promise, and an image row the
 * reconciliation sweep would already call abandoned
 * (STALE_IMAGE_GENERATION_AFTER_MS) does not count as in flight.
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
            select: { id: true, userId: true, temporaryExpiresAt: true },
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
    candidate: { id: string; userId: string; temporaryExpiresAt: Date | null },
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
            if (
                candidate.temporaryExpiresAt &&
                temporarySweepMayDefer(candidate.temporaryExpiresAt, now) &&
                (await hasWorkInFlight(tx, candidate.id, now))
            ) {
                return "deferred" as const;
            }
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

/** An executing Research run, or an image generation still inside its worst-case run time. */
async function hasWorkInFlight(
    tx: Prisma.TransactionClient,
    conversationId: string,
    now: Date
): Promise<boolean> {
    const research = await tx.researchPreviewRun.findFirst({
        where: { conversationId, status: { in: [...TEMPORARY_SWEEP_LIVE_RESEARCH_STATUSES] } },
        select: { id: true },
    });
    if (research) return true;
    // Each status counts as in flight for as long as its own recovery waits before it calls the row
    // abandoned (lib/imageGenerationService.ts reconcileStaleImageGenerations): a provider call that
    // has not started or finished (pending, processing) after the 12-minute window, a settlement
    // (settling) after its own 15-minute one. A single window would let the sweep delete a
    // settlement the recovery still treats as running, and lose the paid work's result.
    const image = await tx.imageGeneration.findFirst({
        where: {
            conversationId,
            OR: [
                {
                    status: { in: [...TEMPORARY_SWEEP_LIVE_IMAGE_CALL_STATUSES] },
                    updatedAt: { gt: new Date(now.getTime() - STALE_IMAGE_GENERATION_AFTER_MS) },
                },
                {
                    status: "settling",
                    updatedAt: { gt: new Date(now.getTime() - STALE_IMAGE_SETTLING_AFTER_MS) },
                },
            ],
        },
        select: { id: true },
    });
    return image !== null;
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
