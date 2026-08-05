/**
 * What happens to a memory when the source it came from is locked
 * (policy §7.1).
 *
 * Locking differs from deleting (§13.1) in one way that decides the whole
 * design: it is reversible. A deleted source is gone and the memory's fate is
 * a user decision made once; a locked source comes back, and the memory has to
 * come back with it — without a human being asked twice, and without the
 * restore inventing a state the memory was never in.
 *
 * That is why this module suspends `active` and nothing else. §7.1 says
 * `active`, and the reason it can say so is that `suspended_by_source_lock` is
 * then a status only this path ever writes and only ever writes over `active`.
 * The status *is* the record of what to go back to, so no prior-status column
 * is needed and no restore can promote a `candidate` the user never approved.
 * Suspending the wider set the source-delete path suspends would break that
 * the moment the first `candidate` was restored as `active`.
 *
 * A memory keeps working while *any* of its evidence is reachable: another
 * imported conversation that is not locked, or grounds the user typed
 * themselves. Only when every piece of evidence sits behind a lock does the
 * statement have nothing the user can still see standing behind it.
 *
 * Pure — the caller supplies the facts and applies the plan. The same plan
 * serves all three callers, because lock, unlock and the reconciliation sweep
 * are not three transitions: they are one convergence, run over different sets
 * of rows.
 */

/** The §8.3 status a lock-suspended memory takes. */
export const SOURCE_LOCK_SUSPENDED_STATUS = "suspended_by_source_lock";

/** Recorded in `suspendedReason` so the review screen can say why. */
export const SOURCE_LOCK_SUSPENDED_REASON = "suspended_by_source_lock";

/** The status a memory returns to when its sources are reachable again. */
export const SOURCE_LOCK_RESTORED_STATUS = "active";

/**
 * The status a memory returns to instead when it expired while suspended.
 * §7.1 restores "if no other blocking reason applies", and an elapsed
 * `expiresAt` is one: restoring it to `active` would put an expired memory
 * back in retrieval for however long it takes the §8.6 sweep to notice.
 */
export const SOURCE_LOCK_EXPIRED_STATUS = "expired";

export type MemoryLockEvidence = {
    /**
     * True when this evidence sits inside a locked source. Manual grounds and
     * evidence from unlocked conversations are both `false` — neither is
     * hidden from the user, which is the only thing that matters here.
     */
    sourceLocked: boolean;
};

export type MemoryLockFacts = {
    id: string;
    status: string;
    expiresAt: Date | null;
    evidences: readonly MemoryLockEvidence[];
};

/**
 * A memory has nothing visible behind it exactly when it has evidence and all
 * of it is locked.
 *
 * The empty case is deliberately *not* blocked. A memory with no evidence rows
 * at all is a §13.1 concern (its source was deleted, and that path already
 * decided its fate) — a lock somewhere else in the account must not be allowed
 * to claim it.
 */
export function memoryIsBlockedBySourceLock(
    evidences: readonly MemoryLockEvidence[]
): boolean {
    return (
        evidences.length > 0 &&
        evidences.every((evidence) => evidence.sourceLocked)
    );
}

export type SourceLockPlan = {
    /** `active` memories whose every source is now locked. */
    suspendIds: string[];
    /** Lock-suspended memories with a reachable source again. */
    restoreIds: string[];
    /** Lock-suspended memories that expired while they were suspended. */
    expireIds: string[];
    /** Already in the right state. */
    unchangedIds: string[];
};

export function planSourceLockTransition(input: {
    memories: readonly MemoryLockFacts[];
    now?: Date;
}): SourceLockPlan {
    const now = input.now ?? new Date();
    const plan: SourceLockPlan = {
        suspendIds: [],
        restoreIds: [],
        expireIds: [],
        unchangedIds: [],
    };

    for (const memory of input.memories) {
        const blocked = memoryIsBlockedBySourceLock(memory.evidences);

        if (memory.status === SOURCE_LOCK_RESTORED_STATUS && blocked) {
            plan.suspendIds.push(memory.id);
            continue;
        }
        if (memory.status === SOURCE_LOCK_SUSPENDED_STATUS && !blocked) {
            if (memory.expiresAt && memory.expiresAt.getTime() <= now.getTime()) {
                plan.expireIds.push(memory.id);
            } else {
                plan.restoreIds.push(memory.id);
            }
            continue;
        }
        plan.unchangedIds.push(memory.id);
    }

    return plan;
}

/**
 * Content-free counts (§22) for telling the user what locking this source
 * would take out of their memory before they commit to it, in the same shape
 * the source-delete confirmation uses.
 *
 * For a preview the caller marks the candidate source as locked when building
 * the facts, so this counts the state the lock *would* produce rather than the
 * state it is in.
 */
export type SourceLockImpact = {
    /** Memories that would lose their last reachable evidence. */
    blockedCount: number;
    /** Memories that keep at least one reachable source. */
    backedCount: number;
};

export function summarizeSourceLockImpact(
    memories: readonly MemoryLockFacts[]
): SourceLockImpact {
    const impact: SourceLockImpact = { blockedCount: 0, backedCount: 0 };
    for (const memory of memories) {
        if (memoryIsBlockedBySourceLock(memory.evidences)) {
            impact.blockedCount += 1;
        } else {
            impact.backedCount += 1;
        }
    }
    return impact;
}
