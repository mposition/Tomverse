import "server-only";

import type { Prisma } from "@prisma/client";
import {
    ASSISTANT_KNOWLEDGE_KEY_PREFIX,
    ASSISTANT_KNOWLEDGE_RETENTION,
    type KnowledgeCleanupReason,
} from "@/lib/assistantKnowledgeLimits";
import type { KnowledgeProcessingSweepResult } from "@/lib/assistantKnowledgeProcessor";
import { prisma } from "@/lib/prisma";
import { deleteR2Object, listExpiredR2Objects } from "@/lib/r2";

/**
 * Storage lifecycle for assistant knowledge files (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §14.2, as approved on
 * 2026-08-13. Two decisions are load-bearing here:
 *
 * 1. **An active knowledge file has no expiry.** There is no TTL sweep over
 *    files that belong to a profile, and its absence is the decision rather
 *    than an omission: a profile is a tool its owner keeps using, and a file
 *    that quietly expires produces a profile that gets worse for reasons no
 *    user can tell apart from a bug. Deletion happens because somebody deleted
 *    something.
 *
 * 2. **No R2 bucket lifecycle rule.** Deletion is DB-first: the rows go and
 *    the object keys become tombstones in the same transaction, and only then
 *    does a sweep delete the bytes. A bucket rule cannot see the database, so
 *    it would delete an object a chunk still points at; it does not retry; and
 *    it leaves no audit trail. This mirrors `lib/imageAssetLifecycle.ts`.
 *
 * The one time-based sweep is for objects that never got a row — an upload
 * that was authorised and then abandoned. That is orphan collection, not
 * retention.
 */

export type { KnowledgeCleanupReason };

/**
 * Enqueues the object keys of the files about to be deleted.
 *
 * Call this inside the SAME transaction that removes the rows. Order matters:
 * R2 is never deleted ahead of the database, so a partial failure retries from
 * the tombstone rather than leaving a chunk pointing at bytes that are gone.
 *
 * `skipDuplicates` because a re-deleted profile or a retried request must
 * converge on the one tombstone instead of failing on the unique key.
 */
export const enqueueKnowledgeCleanupForFiles = async (
    tx: Prisma.TransactionClient,
    where: Prisma.AssistantKnowledgeFileWhereInput,
    reason: KnowledgeCleanupReason
): Promise<number> => {
    const files = await tx.assistantKnowledgeFile.findMany({
        where,
        select: { r2Key: true },
    });
    if (files.length === 0) return 0;
    await tx.assistantKnowledgeCleanup.createMany({
        data: files.map((file) => ({ r2Key: file.r2Key, reason })),
        skipDuplicates: true,
    });
    return files.length;
};

export type KnowledgeCleanupSweepResult = {
    examined: number;
    deleted: number;
    failed: number;
    /** Past the attempt ceiling: no longer retried, still not deleted. */
    exhausted: number;
};

/**
 * Drains pending tombstones.
 *
 * S3 DeleteObject succeeds for a key that is already gone, so two overlapping
 * sweeps racing on one row both converge on "object gone, row completed" — the
 * operation is idempotent and needs no claim. Rows past the attempt ceiling
 * are left for an operator and reported as `exhausted` rather than retried
 * forever.
 *
 * Failures are recorded, never thrown: a storage outage must not take the rest
 * of the maintenance run down with it.
 */
export const drainKnowledgeCleanupQueue = async (
    limit = 200,
    now = new Date()
): Promise<KnowledgeCleanupSweepResult> => {
    const pending = await prisma.assistantKnowledgeCleanup.findMany({
        where: {
            completedAt: null,
            attempts: { lt: ASSISTANT_KNOWLEDGE_RETENTION.cleanupMaxAttempts },
        },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true, r2Key: true },
    });

    let deleted = 0;
    let failed = 0;
    for (const item of pending) {
        try {
            await deleteR2Object(item.r2Key);
            await prisma.assistantKnowledgeCleanup.update({
                where: { id: item.id },
                data: {
                    completedAt: now,
                    attempts: { increment: 1 },
                    lastError: null,
                },
            });
            deleted += 1;
        } catch (error) {
            failed += 1;
            await prisma.assistantKnowledgeCleanup
                .update({
                    where: { id: item.id },
                    data: {
                        attempts: { increment: 1 },
                        lastError:
                            error instanceof Error
                                ? `${error.name}: ${error.message}`.slice(0, 1_000)
                                : String(error).slice(0, 1_000),
                    },
                })
                .catch(() => undefined);
        }
    }

    const exhausted = await prisma.assistantKnowledgeCleanup.count({
        where: {
            completedAt: null,
            attempts: { gte: ASSISTANT_KNOWLEDGE_RETENTION.cleanupMaxAttempts },
        },
    });

    return { examined: pending.length, deleted, failed, exhausted };
};

export type AbandonedKnowledgeSweepResult = {
    deleted: number;
    failed: number;
    /** False when the object store could not be listed at all. */
    listed: boolean;
};

/**
 * Deletes objects under the knowledge prefix that no row claims.
 *
 * An upload is authorised, the object lands, and the request that would have
 * written the row never arrives — a closed tab, a crash, a refused quota
 * check that came after the write. Nothing references those bytes and no
 * tombstone was ever created for them, so this is the only thing that will
 * ever take them.
 *
 * The 24-hour window is longer than the guest attachment sweep's hour because
 * a failed extraction is retried from the stored object; a short window would
 * let a retry lose its own source.
 *
 * Every key is checked against the database before it is deleted. Listing by
 * age alone would take the object of a file whose row exists and whose upload
 * simply predates the cutoff.
 */
export const sweepAbandonedKnowledgeObjects = async (
    now = new Date(),
    limit = 200
): Promise<AbandonedKnowledgeSweepResult> => {
    const cutoff = new Date(
        now.getTime() - ASSISTANT_KNOWLEDGE_RETENTION.abandonedObjectTtlMs
    );
    let deleted = 0;
    let failed = 0;
    let keys: string[];
    try {
        keys = await listExpiredR2Objects(
            ASSISTANT_KNOWLEDGE_KEY_PREFIX,
            cutoff,
            limit
        );
    } catch (error) {
        console.error("Assistant knowledge sweep could not list objects:", error);
        return { deleted, failed, listed: false };
    }
    if (keys.length === 0) return { deleted, failed, listed: true };

    const claimed = new Set(
        (
            await prisma.assistantKnowledgeFile.findMany({
                where: { r2Key: { in: keys } },
                select: { r2Key: true },
            })
        ).map((file) => file.r2Key)
    );
    // A key already queued for deletion is left to the tombstone sweep, which
    // records the outcome. Deleting it here would report success for a row
    // that still says pending.
    const queued = new Set(
        (
            await prisma.assistantKnowledgeCleanup.findMany({
                where: { r2Key: { in: keys }, completedAt: null },
                select: { r2Key: true },
            })
        ).map((row) => row.r2Key)
    );

    for (const key of keys) {
        if (claimed.has(key) || queued.has(key)) continue;
        try {
            await deleteR2Object(key);
            deleted += 1;
        } catch (error) {
            failed += 1;
            // Nothing about the file's contents is logged -- only the opaque key.
            console.error("Assistant knowledge sweep could not delete one object:", {
                key,
                error,
            });
        }
    }

    return { deleted, failed, listed: true };
};


export type KnowledgeMaintenanceResult = {
    cleanup: KnowledgeCleanupSweepResult;
    processing: KnowledgeProcessingSweepResult;
};

/**
 * The ride-along for the fifteen-minute maintenance cron.
 *
 * §14.2 says knowledge follows the image asset pattern -- DB-first tombstone
 * plus the fifteen-minute sweep -- and for a while it followed only half of
 * that. The tombstone shape was right and the drain was wired to the daily
 * `cleanupExpiredData()` instead, so a deleted file kept its bytes for up to
 * twenty-four hours and a stalled extraction stayed stalled for the same,
 * despite a ten-minute staleness threshold that only makes sense against a
 * much shorter cadence. See
 * `.github/audits/knowledge-sweep-cadence-2026-08-23.md`.
 *
 * Two of the three knowledge arms belong here. The third does not:
 * `sweepAbandonedKnowledgeObjects()` lists a bucket prefix, which is the
 * expensive one and answers a question -- "is there an object no row ever
 * claimed" -- that nobody is waiting on. It stays daily.
 *
 * Never throws, the same contract every other ride-along on this route holds:
 * a failure here cannot turn a successful credit reconciliation into a failed
 * one.
 */
export const runKnowledgeMaintenanceQuietly = async (
    now = new Date()
): Promise<KnowledgeMaintenanceResult> => {
    const empty = {
        cleanup: { examined: 0, deleted: 0, failed: 0, exhausted: 0 },
        processing: { reclaimed: 0, processed: 0, ready: 0, failed: 0 },
    };
    try {
        const cleanup = await drainKnowledgeCleanupQueue(200, now);
        // Bounded well below the drain, for the reason the image thumbnail
        // repair is: each one reads a whole object and extracts its text, so
        // this is the expensive arm and must not stretch the cadence it runs
        // on. The daily job keeps its own larger pass.
        const { processPendingKnowledgeFiles } = await import(
            "@/lib/assistantKnowledgeProcessor"
        );
        const processing = await processPendingKnowledgeFiles(now, 5).catch(
            () => empty.processing
        );
        return { cleanup, processing };
    } catch (error) {
        console.error("Assistant knowledge maintenance failed:", error);
        return empty;
    }
};
