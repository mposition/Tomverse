import "server-only";

import { isMemoryExtractionEnabled } from "@/lib/appSettings";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import type { createExtractionProviderAdapter } from "@/lib/memoryExtractionProvider";
import { createExtractionChunkHandler } from "@/lib/memoryExtractionRunner";
import {
    driveMemoryExtractionRunSlice,
    type ExtractionSliceResult,
} from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * The two drivers that make a run actually move (Release B, slice 1.6c).
 *
 * docs/policy/external-conversation-import-and-memory.md §11.
 *
 * They are deliberately unequal:
 *
 *  - `kickMemoryExtractionRun` is a **latency optimisation**. It runs in
 *    `after()`, bound to the lifetime of the request that created the run, and
 *    dies with the process. It is not a queue and nothing depends on it
 *    succeeding.
 *  - `dispatchPendingMemoryExtractionRuns` is the **durable driver**. Every
 *    fifteen minutes it re-claims and re-drives whatever is still pending, so
 *    a run finishes whether or not any kick ever ran. The database is the
 *    queue; this is the consumer.
 *
 * Both call the same `driveMemoryExtractionRunSlice`, so claiming, fencing,
 * per-chunk re-checks and lease release have exactly one implementation.
 */

/** One tick may not monopolise the fifteen-minute window. */
const MAX_RUNS_PER_DISPATCH = 3;

export type ExtractionDispatchOptions = {
    register?: readonly MemoryExtractionEvalEntry[];
    environment?: Record<string, string | undefined>;
    /** Test seam, forwarded to the handler factory. */
    adapterFactory?: typeof createExtractionProviderAdapter;
    maxChunks?: number;
    budgetMs?: number;
    now?: Date;
};

const logSlice = (
    event: string,
    runId: string,
    result: ExtractionSliceResult
) => {
    console.info(
        JSON.stringify({
            event,
            runId,
            outcome: result.outcome,
            reason: result.reason,
            chunksProcessed: result.chunksProcessed,
        })
    );
};

/**
 * Drives one slice of a specific run, now.
 *
 * Never throws: a kick that fails must not turn the request that scheduled it
 * into an error, and the dispatcher will pick the run up regardless.
 */
export async function kickMemoryExtractionRun(
    runId: string,
    options: ExtractionDispatchOptions = {}
): Promise<ExtractionSliceResult> {
    try {
        if (!(await isMemoryExtractionEnabled())) {
            return { chunksProcessed: 0, outcome: "blocked", reason: "feature_disabled" };
        }
        const result = await driveMemoryExtractionRunSlice({
            runId,
            owner: `kick:${runId}`,
            handler: createExtractionChunkHandler({
                register: options.register,
                environment: options.environment,
                adapterFactory: options.adapterFactory,
            }),
            register: options.register,
            environment: options.environment,
            maxChunks: options.maxChunks,
            budgetMs: options.budgetMs,
            now: options.now,
        });
        logSlice("memory_extraction_dispatch_kick", runId, result);
        return result;
    } catch (error) {
        console.error("memory extraction kick failed", error);
        return { chunksProcessed: 0, outcome: "failed", reason: "kick_error" };
    }
}

/**
 * Re-drives pending runs. This is the recovery half of the §11 contract:
 * reclaiming an orphaned lease only makes a run claimable again, and something
 * has to actually claim it.
 *
 * Oldest first, so a run that has been waiting longest is not starved by newer
 * ones, and capped per tick so one account's long run cannot consume the whole
 * window.
 */
export async function dispatchPendingMemoryExtractionRuns(
    options: ExtractionDispatchOptions = {}
): Promise<{ dispatched: number; outcomes: Record<string, number> }> {
    const outcomes: Record<string, number> = {};
    if (!(await isMemoryExtractionEnabled())) {
        return { dispatched: 0, outcomes };
    }

    const pending = await prisma.memoryExtractionRun.findMany({
        where: { status: "pending" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_RUNS_PER_DISPATCH,
        select: { id: true },
    });

    let dispatched = 0;
    for (const run of pending) {
        try {
            const result = await driveMemoryExtractionRunSlice({
                runId: run.id,
                owner: `dispatch:${run.id}`,
                handler: createExtractionChunkHandler({
                    register: options.register,
                    environment: options.environment,
                    adapterFactory: options.adapterFactory,
                }),
                register: options.register,
                environment: options.environment,
                maxChunks: options.maxChunks,
                budgetMs: options.budgetMs,
                now: options.now,
            });
            logSlice("memory_extraction_dispatch_recovery", run.id, result);
            outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
            dispatched += 1;
        } catch (error) {
            // One bad run must not stop the sweep for the others.
            console.error("memory extraction dispatch failed", error);
            outcomes.error = (outcomes.error ?? 0) + 1;
        }
    }
    return { dispatched, outcomes };
}

/** Maintenance-cycle wrapper: never throws, so it cannot fail the tick. */
export const dispatchPendingMemoryExtractionRunsQuietly = () =>
    dispatchPendingMemoryExtractionRuns().catch(() => ({
        dispatched: 0,
        outcomes: {} as Record<string, number>,
    }));
