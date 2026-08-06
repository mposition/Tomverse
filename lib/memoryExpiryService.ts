import "server-only";

import { recordMemoryCounter } from "@/lib/memoryMetrics";
import { prisma } from "@/lib/prisma";

/**
 * The §8.6 expiry sweep.
 *
 * Expiry has two halves and they are not redundant. Retrieval already refuses
 * a memory whose `expiresAt` has passed, whatever its status — that is the
 * lazy half, and it is the one that actually guarantees an expired memory is
 * never injected. This is the other half: moving the row's status so the user
 * sees it as expired rather than as still in use, and so the account's memory
 * fingerprint moves and any §10 context bundle priced against the old set
 * stops verifying.
 *
 * The ordering matters for what a failure means. If this sweep never ran, no
 * expired memory would reach a prompt; the account's review screen would just
 * be showing a row as active for longer than it should. That is why the sweep
 * rides along with the other maintenance work rather than gating anything,
 * and why it never throws into the reconciliation it shares a request with.
 *
 * Idempotent by construction: a swept row no longer matches the predicate, so
 * a repeat run finds nothing. Bounded and restartable: rows are taken in
 * capped batches, and an interrupted sweep simply finds the remainder next
 * time.
 */

/**
 * Statuses expiry may move. Archived rows keep the status that says why they
 * left — the same rule the source-delete path follows (§13.1): they are out
 * of retrieval either way, and overwriting would replace the true reason.
 */
const EXPIRABLE_STATUSES = [
    "active",
    "candidate",
    "manual_review_required",
] as const;

const EXPIRED_STATUS = "expired";

/** Rows per batch, and the ceiling on batches in one sweep. */
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

export async function reconcileExpiredMemories(now = new Date()): Promise<{
    expiredMemories: number;
    /** True when the cap was hit, so the next sweep still has work. */
    truncated: boolean;
}> {
    let expiredMemories = 0;
    let truncated = false;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const due = await prisma.memoryItem.findMany({
            where: {
                status: { in: [...EXPIRABLE_STATUSES] },
                expiresAt: { not: null, lte: now },
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: BATCH_SIZE,
        });
        if (due.length === 0) break;

        // Re-stated in the update rather than trusting the ids alone: another
        // request may have rejected or deleted one of these between the read
        // and the write, and expiry must not resurrect a decision.
        const updated = await prisma.memoryItem.updateMany({
            where: {
                id: { in: due.map((row) => row.id) },
                status: { in: [...EXPIRABLE_STATUSES] },
                expiresAt: { not: null, lte: now },
            },
            data: { status: EXPIRED_STATUS },
        });
        expiredMemories += updated.count;

        if (due.length < BATCH_SIZE) break;
        if (batch === MAX_BATCHES - 1) truncated = true;
    }

    if (expiredMemories > 0) {
        await recordMemoryCounter("memory_expired", expiredMemories, now);
    }
    if (expiredMemories > 0 || truncated) {
        // Content-free (§22): a count and a flag, never a statement or an id.
        console.info(
            JSON.stringify({
                event: "memory_expiry_swept",
                expiredMemories,
                truncated,
            })
        );
    }
    return { expiredMemories, truncated };
}
