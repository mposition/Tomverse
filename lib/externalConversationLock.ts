import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
    createResourceUnlockCookie,
    clearResourceUnlockCookie,
    hasResourceUnlockGrant,
    hashConversationPassword,
    verifyConversationPassword,
} from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Locking an imported conversation, and what that does to memory (§7, §7.1).
 *
 * docs/policy/external-conversation-import-and-memory.md §7.1.
 *
 * A lock is a statement about *reading*, but a memory extracted from a locked
 * conversation would keep speaking its contents into every answer — quoting a
 * source the user just decided to put behind a password. So §7.1 makes locking
 * and suspending one act:
 *
 *  - a memory whose only remaining evidence is locked becomes
 *    `suspended_by_source_lock` and leaves retrieval immediately;
 *  - a memory with any unlocked evidence left stays active, because it still
 *    has grounds the user has not hidden;
 *  - unlocking re-verifies the evidence and restores what nothing else blocks.
 *
 * The transition is in the **same transaction** as the lock. Split apart, a
 * crash between them leaves a locked conversation whose memories are still
 * being quoted — the exact outcome the rule exists to prevent — and the user
 * has no way to see that it happened.
 *
 * `suspended_by_source_lock` is deliberately not `suspended_by_source_delete`:
 * the source still exists here and the memory comes back by itself, whereas a
 * deleted source needs the user to write new grounds (§13.1). Collapsing them
 * would tell a user their memory needs rescuing when it needs a password.
 */

const SUSPENDED_BY_LOCK = "suspended_by_source_lock" as const;
const LOCK_SUSPENSION_REASON = "source_locked" as const;

export type ExternalLockOutcome = {
    suspendedMemories: number;
    restoredMemories: number;
};

const loadOwnedSnapshot = async (
    tx: Prisma.TransactionClient,
    userId: string,
    conversationId: string
) => {
    const row = await tx.externalConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, userId: true, password: true, finalized: true },
    });
    if (!row || row.userId !== userId || !row.finalized) {
        // A cross-account probe learns nothing it did not already know: an id
        // that is not yours reads the same as one that does not exist.
        throw new ApiSecurityError(404, "NOT_FOUND", "Conversation not found.");
    }
    return row;
};

/**
 * Suspends the memories a newly locked conversation would otherwise keep
 * speaking.
 *
 * Runs inside the caller's transaction. "Only evidence" is computed per
 * memory over its *whole* evidence set against every locked source the account
 * has, not just the one being locked — otherwise locking a second source for a
 * memory that rests on two would leave it active with everything it cites now
 * hidden.
 */
async function suspendMemoriesForLockedSources(
    tx: Prisma.TransactionClient,
    userId: string
): Promise<number> {
    const lockedIds = (
        await tx.externalConversation.findMany({
            where: { userId, password: { not: null } },
            select: { id: true },
        })
    ).map((row) => row.id);
    if (lockedIds.length === 0) return 0;

    const candidates = await tx.memoryItem.findMany({
        where: {
            userId,
            status: "active",
            evidences: {
                some: {
                    externalMessage: {
                        externalConversationId: { in: lockedIds },
                    },
                },
            },
        },
        select: {
            id: true,
            evidences: {
                select: {
                    externalMessage: {
                        select: { externalConversationId: true },
                    },
                },
            },
        },
    });

    const locked = new Set(lockedIds);
    const doomed = candidates
        .filter((item) =>
            item.evidences.every((evidence) => {
                const source = evidence.externalMessage?.externalConversationId;
                // Manual grounds are never locked by a conversation password:
                // they are the user's own text, held on the memory itself.
                return source ? locked.has(source) : false;
            })
        )
        .map((item) => item.id);
    if (doomed.length === 0) return 0;

    const suspended = await tx.memoryItem.updateMany({
        where: { id: { in: doomed }, status: "active" },
        data: {
            status: SUSPENDED_BY_LOCK,
            suspendedReason: LOCK_SUSPENSION_REASON,
        },
    });
    return suspended.count;
}

/**
 * Restores memories that a lock suspended and nothing else blocks.
 *
 * Evidence is re-verified rather than trusted: between the lock and the unlock
 * a source may have been deleted, so a memory can come out of this holding
 * nothing. Those are left suspended — for the §13.1 sweep to reclassify —
 * instead of being restored to an active state they cannot support.
 */
async function restoreMemoriesForUnlockedSources(
    tx: Prisma.TransactionClient,
    userId: string
): Promise<number> {
    const suspended = await tx.memoryItem.findMany({
        where: {
            userId,
            status: SUSPENDED_BY_LOCK,
            suspendedReason: LOCK_SUSPENSION_REASON,
        },
        select: {
            id: true,
            evidences: {
                select: {
                    externalMessage: {
                        select: {
                            conversation: {
                                select: { id: true, password: true },
                            },
                        },
                    },
                },
            },
        },
    });
    if (suspended.length === 0) return 0;

    const restorable = suspended
        .filter((item) =>
            item.evidences.some((evidence) => {
                const source = evidence.externalMessage?.conversation ?? null;
                // Manual evidence counts as unlocked grounds; an external one
                // counts only while its source has no password.
                return source ? source.password === null : true;
            })
        )
        .map((item) => item.id);
    if (restorable.length === 0) return 0;

    const restored = await tx.memoryItem.updateMany({
        where: { id: { in: restorable }, status: SUSPENDED_BY_LOCK },
        data: { status: "active", suspendedReason: null },
    });
    return restored.count;
}

/** Sets or replaces the password on an imported conversation (§7). */
export async function lockExternalConversation(input: {
    userId: string;
    conversationId: string;
    password: string;
}): Promise<ExternalLockOutcome> {
    const hashed = await hashConversationPassword(input.password);
    const outcome = await prisma.$transaction(async (tx) => {
        const row = await loadOwnedSnapshot(
            tx,
            input.userId,
            input.conversationId
        );
        await tx.externalConversation.update({
            where: { id: row.id },
            data: { password: hashed },
        });
        // Same transaction as the lock, deliberately: apart, a crash between
        // them leaves a locked conversation whose memories are still quoted.
        const suspendedMemories = await suspendMemoriesForLockedSources(
            tx,
            input.userId
        );
        return { suspendedMemories, restoredMemories: 0 };
    });

    logSecurityAuditEvent("external_conversation.lock.set", {
        userId: input.userId,
        resourceId: input.conversationId,
    });
    return outcome;
}

/**
 * Verifies the password and removes the lock (§7).
 *
 * Attempt limiting is the caller's, through the same
 * `consumeLockVerificationAttempt` the native path uses — one password
 * implementation and one limiter, rather than a second one that drifts.
 */
export async function unlockExternalConversation(input: {
    userId: string;
    conversationId: string;
    password: string;
}): Promise<ExternalLockOutcome> {
    const row = await prisma.externalConversation.findUnique({
        where: { id: input.conversationId },
        select: { id: true, userId: true, password: true, finalized: true },
    });
    if (!row || row.userId !== input.userId || !row.finalized) {
        throw new ApiSecurityError(404, "NOT_FOUND", "Conversation not found.");
    }
    if (!row.password) {
        // Already unlocked. Idempotent rather than an error: the user asked
        // for a state that already holds.
        return { suspendedMemories: 0, restoredMemories: 0 };
    }
    // Destructured deliberately: the verifier returns `{ matches,
    // needsUpgrade }`, and testing the object for truthiness — which
    // TypeScript accepts — would accept every password.
    const { matches } = await verifyConversationPassword(
        input.password,
        row.password
    );
    if (!matches) {
        throw new ApiSecurityError(
            403,
            "INVALID_LOCK_PASSWORD",
            "Incorrect password."
        );
    }

    const outcome = await prisma.$transaction(async (tx) => {
        await tx.externalConversation.update({
            where: { id: row.id },
            data: { password: null },
        });
        const restoredMemories = await restoreMemoriesForUnlockedSources(
            tx,
            input.userId
        );
        return { suspendedMemories: 0, restoredMemories };
    });

    logSecurityAuditEvent("external_conversation.lock.remove", {
        userId: input.userId,
        resourceId: input.conversationId,
    });
    return outcome;
}

/** Grant helpers, bound to the external resource namespace (B5a). */
export const createExternalUnlockCookie = (
    userId: string,
    conversationId: string,
    storedPassword: string
) =>
    createResourceUnlockCookie({
        resourceType: "external_conversation",
        userId,
        resourceId: conversationId,
        storedPassword,
    });

export const clearExternalUnlockCookie = (conversationId: string) =>
    clearResourceUnlockCookie("external_conversation", conversationId);

export const hasExternalUnlockGrant = (
    request: Request,
    userId: string,
    conversationId: string,
    storedPassword: string | null
) =>
    hasResourceUnlockGrant(request, {
        resourceType: "external_conversation",
        userId,
        resourceId: conversationId,
        storedPassword,
    });

/**
 * Repairs a disagreement between lock state and memory state (§7.1).
 *
 * A partial failure can leave either half stranded, and the two halves fail in
 * opposite directions: an unsuspended memory keeps quoting a locked source,
 * and a memory suspended for a source that is no longer locked stays silently
 * unavailable. Both are fixed here, per account, by recomputing from the lock
 * state — the only source of truth once the two have diverged.
 */
export async function reconcileLockedSourceMemories(
    userId: string
): Promise<ExternalLockOutcome> {
    return prisma.$transaction(async (tx) => ({
        suspendedMemories: await suspendMemoriesForLockedSources(tx, userId),
        restoredMemories: await restoreMemoriesForUnlockedSources(tx, userId),
    }));
}
