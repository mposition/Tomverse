import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
    SOURCE_LOCK_EXPIRED_STATUS,
    SOURCE_LOCK_RESTORED_STATUS,
    SOURCE_LOCK_SUSPENDED_REASON,
    SOURCE_LOCK_SUSPENDED_STATUS,
    planSourceLockTransition,
    summarizeSourceLockImpact,
    type MemoryLockFacts,
    type SourceLockImpact,
} from "@/lib/memorySourceLock";
import { prisma } from "@/lib/prisma";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Server side of the imported-snapshot lock (policy §7, §7.1).
 *
 * "Locked" here means a password is stored on the snapshot, not that the
 * browser is missing an unlock cookie. The distinction decides which state the
 * memory transition keys off, and only one of the two answers is coherent:
 * memory retrieval happens server-side on behalf of an account, so if the
 * suspension followed the cookie grant, the same account would have different
 * memories in two tabs, and clearing cookies would silently suspend memories.
 * The stored password is the account's own durable decision, so that is what
 * §7.1 tracks. The cookie is what lets the owner *read* the snapshot.
 *
 * §7.1 requires the lock and the memory transition to be atomic, so both live
 * inside one transaction. Anything that still drifts — a crash between the two
 * statements is impossible, but a memory whose evidence changed by some other
 * path is not — is picked up by `reconcileSourceLockedMemories()`.
 */

export type ExternalConversationLockResult = {
    conversationId: string;
    locked: boolean;
    memoriesSuspended: number;
    memoriesRestored: number;
    memoriesExpired: number;
};

/**
 * The memories that this set of snapshots is evidence for, each carrying the
 * lock state of *all* of its evidence.
 *
 * Every evidence row is loaded, not just the ones inside the given snapshots,
 * because the question §7.1 asks is whether anything reachable is left — which
 * cannot be answered from the changed source alone.
 */
async function memoriesTouchingSources(
    tx: Prisma.TransactionClient,
    userId: string,
    conversationIds: string[],
    treatAsLocked?: ReadonlySet<string>
): Promise<MemoryLockFacts[]> {
    if (conversationIds.length === 0) return [];

    const affected = await tx.memoryEvidence.findMany({
        where: {
            userId,
            externalMessage: {
                externalConversationId: { in: conversationIds },
            },
        },
        select: { memoryItemId: true },
        distinct: ["memoryItemId"],
    });
    if (affected.length === 0) return [];

    return memoryLockFacts(
        tx,
        userId,
        affected.map((row) => row.memoryItemId),
        treatAsLocked
    );
}

/**
 * `treatAsLocked` names snapshots to count as locked whatever the database
 * says, which is what lets the preview answer "if I locked this, then what"
 * with the same code that answers "what is true now".
 */
async function memoryLockFacts(
    tx: Prisma.TransactionClient,
    userId: string,
    memoryIds: string[],
    treatAsLocked?: ReadonlySet<string>
): Promise<MemoryLockFacts[]> {
    if (memoryIds.length === 0) return [];

    const items = await tx.memoryItem.findMany({
        where: { id: { in: memoryIds }, userId },
        select: {
            id: true,
            status: true,
            expiresAt: true,
            evidences: {
                select: {
                    externalMessage: {
                        select: {
                            externalConversationId: true,
                            conversation: { select: { password: true } },
                        },
                    },
                },
            },
        },
    });

    return items.map((item) => ({
        id: item.id,
        status: item.status,
        expiresAt: item.expiresAt,
        evidences: item.evidences.map((evidence) => {
            const external = evidence.externalMessage;
            // No external message means manual grounds (or, later, a Tomverse
            // message): nothing a source lock hides.
            if (!external) return { sourceLocked: false };
            return {
                sourceLocked:
                    external.conversation.password != null ||
                    (treatAsLocked?.has(external.externalConversationId) ??
                        false),
            };
        }),
    }));
}

async function applySourceLockPlan(
    tx: Prisma.TransactionClient,
    userId: string,
    memories: readonly MemoryLockFacts[],
    now: Date
) {
    const plan = planSourceLockTransition({ memories, now });

    // Each update re-states the status it expects rather than trusting the ids
    // it read: another request may have rejected, deleted or superseded one of
    // these in between, and a lock transition must not overwrite a decision.
    let memoriesSuspended = 0;
    if (plan.suspendIds.length > 0) {
        const updated = await tx.memoryItem.updateMany({
            where: {
                id: { in: plan.suspendIds },
                userId,
                status: SOURCE_LOCK_RESTORED_STATUS,
            },
            data: {
                status: SOURCE_LOCK_SUSPENDED_STATUS,
                suspendedReason: SOURCE_LOCK_SUSPENDED_REASON,
            },
        });
        memoriesSuspended = updated.count;
    }

    let memoriesRestored = 0;
    if (plan.restoreIds.length > 0) {
        const updated = await tx.memoryItem.updateMany({
            where: {
                id: { in: plan.restoreIds },
                userId,
                status: SOURCE_LOCK_SUSPENDED_STATUS,
            },
            data: {
                status: SOURCE_LOCK_RESTORED_STATUS,
                suspendedReason: null,
            },
        });
        memoriesRestored = updated.count;
    }

    let memoriesExpired = 0;
    if (plan.expireIds.length > 0) {
        const updated = await tx.memoryItem.updateMany({
            where: {
                id: { in: plan.expireIds },
                userId,
                status: SOURCE_LOCK_SUSPENDED_STATUS,
            },
            data: {
                status: SOURCE_LOCK_EXPIRED_STATUS,
                suspendedReason: null,
            },
        });
        memoriesExpired = updated.count;
    }

    return { memoriesSuspended, memoriesRestored, memoriesExpired };
}

/**
 * Sets or clears the lock on one finalized snapshot and moves the memories it
 * backs, atomically (§7.1).
 *
 * `passwordHash` is already hashed by `hashConversationPassword()`; this
 * function never sees a plaintext password, so an accidental log of its input
 * cannot leak one.
 */
export async function setExternalConversationLock(input: {
    userId: string;
    conversationId: string;
    /** A stored hash to lock with, or `null` to remove the lock. */
    passwordHash: string | null;
    request?: Request;
    now?: Date;
}): Promise<ExternalConversationLockResult> {
    const now = input.now ?? new Date();

    const result = await prisma.$transaction(async (tx) => {
        const row = await tx.externalConversation.findUnique({
            where: { id: input.conversationId },
            select: { id: true, userId: true, finalized: true, password: true },
        });
        // Same answer for "not yours" as for "not there": the owner of an id
        // is not something a non-owner gets to learn from a status code.
        if (!row || row.userId !== input.userId || !row.finalized) {
            throw new ApiSecurityError(
                404,
                "NOT_FOUND",
                "Conversation not found."
            );
        }

        await tx.externalConversation.update({
            where: { id: row.id },
            data: { password: input.passwordHash },
        });

        // Read after the write, so the evidence facts already reflect the new
        // lock state and one plan covers both directions.
        const memories = await memoriesTouchingSources(tx, input.userId, [
            row.id,
        ]);
        const applied = await applySourceLockPlan(
            tx,
            input.userId,
            memories,
            now
        );

        return {
            conversationId: row.id,
            wasLocked: row.password != null,
            locked: input.passwordHash != null,
            ...applied,
        };
    });

    const event = result.locked
        ? result.wasLocked
            ? "external_conversation.lock.change"
            : "external_conversation.lock.set"
        : "external_conversation.lock.remove";
    logSecurityAuditEvent(event, {
        userId: input.userId,
        resourceId: result.conversationId,
        request: input.request,
        outcome: "success",
    });
    logMemoryLockTransitions("source_lock_applied", result);

    return {
        conversationId: result.conversationId,
        locked: result.locked,
        memoriesSuspended: result.memoriesSuspended,
        memoriesRestored: result.memoriesRestored,
        memoriesExpired: result.memoriesExpired,
    };
}

/**
 * What locking this snapshot would do to the account's memories, so the
 * confirmation states it before the user commits (the §13.1 pattern, applied
 * to a reversible action).
 */
export async function previewExternalConversationLock(
    userId: string,
    conversationId: string
): Promise<SourceLockImpact> {
    const owned = await prisma.externalConversation.findFirst({
        where: { id: conversationId, userId, finalized: true },
        select: { id: true },
    });
    if (!owned) return { blockedCount: 0, backedCount: 0 };

    // The snapshot is not locked yet, so its own evidence would read as
    // unlocked. Counting the state the lock *would* produce is the point.
    const memories = await memoriesTouchingSources(
        prisma,
        userId,
        [owned.id],
        new Set([owned.id])
    );
    return summarizeSourceLockImpact(memories);
}

/** Rows per batch, and the ceiling on batches in one sweep. */
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

/**
 * The §7.1 reconciliation: finds memories whose status disagrees with the lock
 * state of their evidence and converges them.
 *
 * Two populations, and both are needed. A memory that is `active` while all of
 * its evidence is locked is the dangerous half — it is still being injected —
 * and a memory left in `suspended_by_source_lock` after its sources came back
 * is the half the user notices, because their memory silently stopped working.
 *
 * Idempotent and restartable in the same way as the §8.6 expiry sweep: a
 * converged row no longer matches, so a repeat run finds nothing.
 */
export async function reconcileSourceLockedMemories(now = new Date()): Promise<{
    memoriesSuspended: number;
    memoriesRestored: number;
    memoriesExpired: number;
    /** True when the cap was hit, so the next sweep still has work. */
    truncated: boolean;
}> {
    const totals = {
        memoriesSuspended: 0,
        memoriesRestored: 0,
        memoriesExpired: 0,
    };
    let truncated = false;
    let cursor: string | null = null;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const rows: Array<{ id: string; userId: string }> =
            await prisma.memoryItem.findMany({
                where: {
                    ...(cursor ? { id: { gt: cursor } } : {}),
                    OR: [
                        // Active, yet nothing reachable is behind it. The
                        // `none` form states exactly that: not one evidence row
                        // that is manual or in an unlocked snapshot.
                        {
                            status: SOURCE_LOCK_RESTORED_STATUS,
                            evidences: {
                                some: {
                                    externalMessage: {
                                        conversation: {
                                            password: { not: null },
                                        },
                                    },
                                },
                                none: {
                                    OR: [
                                        { externalMessageId: null },
                                        {
                                            externalMessage: {
                                                conversation: {
                                                    password: null,
                                                },
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                        // Every lock-suspended row is re-examined rather than
                        // filtered here: the restore condition also covers
                        // expiry, and a status filter alone is cheap.
                        { status: SOURCE_LOCK_SUSPENDED_STATUS },
                    ],
                },
                select: { id: true, userId: true },
                orderBy: { id: "asc" },
                take: BATCH_SIZE,
            });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;

        // Grouped by owner because every write is scoped to one, which is what
        // keeps a bug here from reaching across accounts.
        const byUser = new Map<string, string[]>();
        for (const row of rows) {
            byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id]);
        }
        for (const [userId, memoryIds] of byUser) {
            const applied = await prisma.$transaction(async (tx) => {
                const facts = await memoryLockFacts(tx, userId, memoryIds);
                return applySourceLockPlan(tx, userId, facts, now);
            });
            totals.memoriesSuspended += applied.memoriesSuspended;
            totals.memoriesRestored += applied.memoriesRestored;
            totals.memoriesExpired += applied.memoriesExpired;
        }

        if (rows.length < BATCH_SIZE) break;
        if (batch === MAX_BATCHES - 1) truncated = true;
    }

    logMemoryLockTransitions("source_lock_reconciled", { ...totals, truncated });
    return { ...totals, truncated };
}

/**
 * Content-free (§22): counts and a flag, never a statement, an id or which
 * snapshot was involved. The audit trail §7.1 asks for is the hashed-subject
 * event above; this is the metric.
 */
function logMemoryLockTransitions(
    event: "source_lock_applied" | "source_lock_reconciled",
    counts: {
        memoriesSuspended: number;
        memoriesRestored: number;
        memoriesExpired: number;
        truncated?: boolean;
    }
) {
    if (
        counts.memoriesSuspended === 0 &&
        counts.memoriesRestored === 0 &&
        counts.memoriesExpired === 0 &&
        !counts.truncated
    ) {
        return;
    }
    console.info(
        JSON.stringify({
            event: `memory_${event}`,
            memoriesSuspended: counts.memoriesSuspended,
            memoriesRestored: counts.memoriesRestored,
            memoriesExpired: counts.memoriesExpired,
            ...(counts.truncated === undefined
                ? {}
                : { truncated: counts.truncated }),
        })
    );
}
