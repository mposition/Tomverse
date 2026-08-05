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
 * The two drivers that make a run advance (policy §11.1).
 *
 * They are deliberately unequal, and only one of them is load-bearing:
 *
 *  - `kickMemoryExtractionRun` is a **latency optimisation**. It runs inside
 *    `after()`, bound to the request that created the run, and dies with the
 *    process. It is not a queue and nothing may depend on it.
 *  - `dispatchPendingMemoryExtractionRuns` is the **durable driver**. Every
 *    fifteen minutes it re-drives whatever is still pending, so a run finishes
 *    whether or not any kick ever ran. The database is the queue; this is the
 *    consumer, and without it reclaiming an orphaned lease only makes a run
 *    claimable by nobody.
 *
 * Both go through the same `driveMemoryExtractionRunSlice`, so claiming,
 * fencing, per-chunk re-checks, the abort deadline and lease release have one
 * implementation rather than two that drift.
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
    chunkTimeoutMs?: number;
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

const driveOne = (
    runId: string,
    owner: string,
    options: ExtractionDispatchOptions
) =>
    driveMemoryExtractionRunSlice({
        runId,
        owner,
        handler: createExtractionChunkHandler({
            register: options.register,
            environment: options.environment,
            adapterFactory: options.adapterFactory,
        }),
        register: options.register,
        environment: options.environment,
        maxChunks: options.maxChunks,
        budgetMs: options.budgetMs,
        chunkTimeoutMs: options.chunkTimeoutMs,
        now: options.now,
    });

/**
 * Drives one slice of a specific run, now.
 *
 * Never throws: a kick that fails must not turn the request that scheduled it
 * into an error, and the dispatcher picks the run up regardless.
 */
export async function kickMemoryExtractionRun(
    runId: string,
    options: ExtractionDispatchOptions = {}
): Promise<ExtractionSliceResult> {
    try {
        if (!(await isMemoryExtractionEnabled())) {
            return {
                chunksProcessed: 0,
                outcome: "blocked",
                reason: "feature_disabled",
            };
        }
        const result = await driveOne(runId, `kick:${runId}`, options);
        logSlice("memory_extraction_dispatch_kick", runId, result);
        return result;
    } catch (error) {
        console.error("memory extraction kick failed", error);
        return { chunksProcessed: 0, outcome: "failed", reason: "kick_error" };
    }
}

/**
 * Re-drives pending runs — the recovery half of §11.1.
 *
 * Oldest first, so a run that has waited longest is not starved by newer ones,
 * and capped per tick so one account's long run cannot consume the window.
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
            const result = await driveOne(
                run.id,
                `dispatch:${run.id}`,
                options
            );
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
