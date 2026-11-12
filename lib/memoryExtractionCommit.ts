import "server-only";

import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import { persistExtractionChunkDecisions } from "@/lib/memoryExtractionPersistence";
import {
    memoryDuplicatesEnabled,
    prepareMemoryDuplicateContext,
    sendableCandidateStatements,
} from "@/lib/memorySemanticDuplicates";
import { prisma } from "@/lib/prisma";
import type { MemoryExtractionLease } from "@/lib/memoryExtractionService";

/**
 * Committing one chunk's result (policy §11).
 *
 * Separated from the handler on purpose, and the separation is the safety
 * property. The handler analyses; it holds no database write. This does the
 * writing, and it re-verifies the fence **inside the same transaction** as the
 * write.
 *
 * Two failures that shape it:
 *
 *  - the slice's chunk timeout is a bounded race, not a cancellation. A
 *    handler that ignored its signal can still return afterwards, and a
 *    handler that wrote candidates itself would land them for a chunk the
 *    slice already recorded as timed out. It cannot, because it has no write.
 *  - `persistExtractionChunkDecisions` takes a `tx` but checks no lease. A
 *    worker that was superseded while calling would otherwise commit over the
 *    work its replacement is doing. The fence check here is what stops that,
 *    and it has to be in the same transaction — checked before opening one, it
 *    is a read that a concurrent claim can invalidate before the write lands.
 *
 * What is deliberately NOT here: user credits. Those are reserved per run and
 * settled at a terminal state by `completeExtractionChunk`
 * (lib/memoryExtractionCredits.ts). And operational provider cost, which is
 * settled by the handler's caller whether or not this commit is allowed —
 * money spent does not depend on the right to write.
 */

export type ExtractionCommitResult =
    | {
          committed: true;
          stored: number;
          superseded: number;
          withheld: number;
          outranked: number;
          discarded: number;
          /**
           * Candidates whose evidence no longer verified at write time (§8.4).
           * Reported rather than swallowed: nothing else records that they
           * existed, and a run where this is not zero is a run whose sources
           * moved underneath it.
           */
          unsourced: number;
      }
    | { committed: false; reason: "fenced_out" | "memory_off" };

/**
 * Whether this worker still owns the run and the chunk, read without a lock.
 *
 * Not the fence -- that is the locking read inside the transaction, and it
 * still decides what is written. This is the same question asked early, so a
 * worker that has already been superseded sends nothing on its way to being
 * refused. Exported for the database test.
 */
export async function leaseStillHolds(input: {
    lease: Pick<MemoryExtractionLease, "runId" | "userId" | "leaseGeneration">;
    chunkIndex: number;
}): Promise<boolean> {
    try {
        const run = await prisma.memoryExtractionRun.findFirst({
            where: { id: input.lease.runId, userId: input.lease.userId, status: "running" },
            select: { leaseGeneration: true },
        });
        if (run?.leaseGeneration !== input.lease.leaseGeneration) return false;
        const chunk = await prisma.memoryExtractionChunk.findUnique({
            where: {
                runId_chunkIndex: { runId: input.lease.runId, chunkIndex: input.chunkIndex },
            },
            select: { status: true, leaseGeneration: true },
        });
        return (
            chunk?.status === "running" && chunk.leaseGeneration === input.lease.leaseGeneration
        );
    } catch {
        return false;
    }
}

/**
 * Writes a chunk's memories under the lease that produced them.
 *
 * The fence is a locking read on the run row: a concurrent claim has to update
 * that row, so it waits for this transaction and then supersedes, rather than
 * interleaving with the inserts.
 */
export async function commitExtractionChunk(input: {
    lease: Pick<MemoryExtractionLease, "runId" | "userId" | "leaseGeneration">;
    chunkIndex: number;
    extractionModelId: string;
    promptVersion: string;
    decisions: readonly ExtractionDecision[];
    now?: Date;
}): Promise<ExtractionCommitResult> {
    // Before the transaction, never inside it: this may call an external
    // provider, and the transaction below holds the run row and the account's
    // memory lock. Null while the operator's switch is off, and on any
    // failure -- the chunk is then stored by exact-match rules alone.
    //
    // Everything the transaction will refuse is checked first, because the
    // refusal comes too late for a statement that has already been sent: a
    // lease this worker no longer holds, an account that turned memory off,
    // a source that was deleted or locked while the extraction call ran.
    const semanticDuplicates =
        (await memoryDuplicatesEnabled()) && (await leaseStillHolds(input))
        ? await prepareMemoryDuplicateContext({
              userId: input.lease.userId,
              statements: await sendableCandidateStatements({
                  userId: input.lease.userId,
                  decisions: input.decisions,
              }),
          })
        : null;

    return prisma.$transaction(async (tx) => {
        const runs = await tx.$queryRaw<Array<{ leaseGeneration: number }>>`
            SELECT "leaseGeneration"
            FROM "MemoryExtractionRun"
            WHERE "id" = ${input.lease.runId}
              AND "userId" = ${input.lease.userId}
              AND "status" = 'running'
            FOR UPDATE
        `;
        if (runs[0]?.leaseGeneration !== input.lease.leaseGeneration) {
            // Superseded, cancelled or already finished. Whatever this worker
            // produced belongs to a run somebody else is driving now, and its
            // provider cost is settled regardless by the caller.
            return { committed: false as const, reason: "fenced_out" as const };
        }

        // The chunk must still be the one this lease claimed. Without this a
        // replayed commit could write into a chunk that has since been
        // reclaimed and re-run by the same generation.
        const chunk = await tx.memoryExtractionChunk.findUnique({
            where: {
                runId_chunkIndex: {
                    runId: input.lease.runId,
                    chunkIndex: input.chunkIndex,
                },
            },
            select: { status: true, leaseGeneration: true },
        });
        if (
            !chunk ||
            chunk.status !== "running" ||
            chunk.leaseGeneration !== input.lease.leaseGeneration
        ) {
            return { committed: false as const, reason: "fenced_out" as const };
        }

        const persisted = await persistExtractionChunkDecisions(tx, {
            userId: input.lease.userId,
            runId: input.lease.runId,
            chunkIndex: input.chunkIndex,
            extractionModelId: input.extractionModelId,
            promptVersion: input.promptVersion,
            decisions: input.decisions,
            now: input.now,
            semanticDuplicates,
        });
        if (persisted.memoryOff) {
            // Nothing was written, and the chunk must not be reported done:
            // the account turned memory off while this call was answering.
            return { committed: false as const, reason: "memory_off" as const };
        }
        return {
            committed: true as const,
            stored: persisted.stored,
            superseded: persisted.superseded,
            withheld: persisted.withheld,
            outranked: persisted.outranked,
            discarded: persisted.discarded,
            unsourced: persisted.unsourced,
        };
    });
}
