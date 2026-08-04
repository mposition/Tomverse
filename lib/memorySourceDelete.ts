import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * What happens to a memory when the conversation it rests on is deleted
 * (Release B, §13.1).
 *
 * docs/policy/external-conversation-import-and-memory.md §13.1, §8.3.
 *
 * The schema cascades `MemoryEvidence` away with its `ExternalMessage`, which
 * is right for the evidence rows and wrong for the memories: a cascade alone
 * leaves an `active` memory with **no grounds at all**, still served by
 * retrieval, when §8.4 says a memory without evidence is not a memory. So the
 * memories have to be decided *before* the delete, while it is still possible
 * to tell which ones rested on what.
 *
 * §13.1 fixes the decision:
 *
 *  - the default is that a memory derived **only** from the deleted source
 *    goes with it (`deleted`), because that is what a person deleting a
 *    conversation means;
 *  - keeping such a memory is an explicit choice, and produces
 *    `suspended_by_source_delete` — retrieval excludes it immediately, and
 *    only the user rewriting and re-approving its evidence brings it back;
 *  - a memory the user wrote or edited themselves is never transitioned
 *    automatically. Their own words are not collateral of deleting an import;
 *  - a memory with any other surviving evidence stays exactly as it is.
 *
 * `manual_review_required` is deliberately NOT used here. That state means
 * "the §8.4 validator demoted this", and reusing it would make a deletion
 * consequence indistinguishable from a content judgement in the review queue.
 */

export type MemorySourceDeletePlan = {
    /** Derived only from the deleted sources, no user authorship. */
    derivedOnly: string[];
    /** Derived only from the deleted sources, but user-written or edited. */
    userAuthored: string[];
};

const hasManualEvidence = (evidences: ReadonlyArray<{ sourceType: string }>) =>
    evidences.some((evidence) => evidence.sourceType === "manual");

/**
 * Finds the memories a source delete would strand.
 *
 * Runs in the caller's transaction and BEFORE the delete: afterwards the
 * evidence rows are gone and "which memories rested on this conversation" has
 * no answer left.
 */
export async function planMemorySourceDelete(
    tx: Prisma.TransactionClient,
    userId: string,
    conversationIds: readonly string[]
): Promise<MemorySourceDeletePlan> {
    if (conversationIds.length === 0) {
        return { derivedOnly: [], userAuthored: [] };
    }
    const affected = await tx.memoryItem.findMany({
        where: {
            userId,
            evidences: {
                some: {
                    externalMessage: {
                        externalConversationId: { in: [...conversationIds] },
                    },
                },
            },
        },
        select: {
            id: true,
            userEdited: true,
            evidences: {
                select: {
                    sourceType: true,
                    externalMessage: {
                        select: { externalConversationId: true },
                    },
                },
            },
        },
    });

    const doomed = new Set(conversationIds);
    const plan: MemorySourceDeletePlan = { derivedOnly: [], userAuthored: [] };
    for (const item of affected) {
        const survivingEvidence = item.evidences.filter((evidence) => {
            const source = evidence.externalMessage?.externalConversationId;
            // Manual grounds and any not-yet-supported source type survive a
            // conversation delete: they never rested on it.
            return !source || !doomed.has(source);
        });
        if (survivingEvidence.length > 0) continue;

        if (item.userEdited || hasManualEvidence(item.evidences)) {
            plan.userAuthored.push(item.id);
        } else {
            plan.derivedOnly.push(item.id);
        }
    }
    return plan;
}

export type MemorySourceDeleteOutcome = {
    deletedMemories: number;
    suspendedMemories: number;
    /** Left untouched because the user authored or edited them (§13.1). */
    preservedUserAuthored: number;
};

/**
 * Applies §13.1 to the memories a plan identified.
 *
 * Must be called in the SAME transaction as the source delete. Split across
 * two, a crash between them leaves either memories referring to a source that
 * is gone or memories deleted for a source that still exists — and the user
 * cannot tell which happened.
 */
export async function applyMemorySourceDelete(
    tx: Prisma.TransactionClient,
    input: {
        plan: MemorySourceDeletePlan;
        /**
         * True only when the user explicitly chose to keep memories whose
         * source is being deleted. The default is the destructive-looking one
         * on purpose: it is what deleting a conversation means, and §13.1
         * makes the confirmation dialog say so.
         */
        keepDerivedMemories: boolean;
    }
): Promise<MemorySourceDeleteOutcome> {
    const { derivedOnly, userAuthored } = input.plan;
    if (derivedOnly.length === 0) {
        return {
            deletedMemories: 0,
            suspendedMemories: 0,
            preservedUserAuthored: userAuthored.length,
        };
    }

    if (input.keepDerivedMemories) {
        const suspended = await tx.memoryItem.updateMany({
            where: { id: { in: derivedOnly } },
            data: {
                status: "suspended_by_source_delete",
                suspendedReason: "source_deleted",
            },
        });
        return {
            deletedMemories: 0,
            suspendedMemories: suspended.count,
            preservedUserAuthored: userAuthored.length,
        };
    }

    const deleted = await tx.memoryItem.deleteMany({
        where: { id: { in: derivedOnly } },
    });
    return {
        deletedMemories: deleted.count,
        suspendedMemories: 0,
        preservedUserAuthored: userAuthored.length,
    };
}

/**
 * Convenience for the common case: plan and apply in one call, inside the
 * caller's transaction, immediately before the source rows are removed.
 */
export const handleMemorySourceDelete = async (
    tx: Prisma.TransactionClient,
    input: {
        userId: string;
        conversationIds: readonly string[];
        keepDerivedMemories: boolean;
    }
): Promise<MemorySourceDeleteOutcome> =>
    applyMemorySourceDelete(tx, {
        plan: await planMemorySourceDelete(
            tx,
            input.userId,
            input.conversationIds
        ),
        keepDerivedMemories: input.keepDerivedMemories,
    });

/**
 * Catches memories whose evidence disappeared without this module running.
 *
 * §13.1 requires reconciliation for exactly this: a partial failure, an
 * account-deletion cascade, or a delete path nobody remembered to wire up all
 * leave the same footprint — an active memory with no evidence rows, which
 * §8.4 says cannot exist and which retrieval would otherwise keep serving.
 *
 * Suspends rather than deletes. The strand happened by accident, and the
 * conservative repair is to stop using the memory while leaving the user able
 * to see and re-ground it; deleting on a code path that already misbehaved
 * would destroy data on the strength of a bug.
 */
export async function reconcileStrandedMemories(
    limit = 500
): Promise<{ suspended: number }> {
    const stranded = await prisma.memoryItem.findMany({
        where: { status: "active", evidences: { none: {} } },
        take: limit,
        select: { id: true },
    });
    if (stranded.length === 0) return { suspended: 0 };

    const suspended = await prisma.memoryItem.updateMany({
        where: { id: { in: stranded.map((row) => row.id) }, status: "active" },
        data: {
            status: "suspended_by_source_delete",
            suspendedReason: "evidence_missing",
        },
    });
    console.warn(
        JSON.stringify({
            event: "memory_stranded_evidence_reconciled",
            suspended: suspended.count,
        })
    );
    return { suspended: suspended.count };
}
