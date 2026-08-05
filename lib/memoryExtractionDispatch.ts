import "server-only";

import { memoryExtractionChunkHandler } from "@/lib/memoryExtractionChunkHandler";
import { MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS } from "@/lib/memoryExtractionCore";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import {
    driveMemoryExtractionRunSlice,
    reconcileExpiredMemoryExtractionRuns,
    type ExtractionSliceResult,
} from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * What actually makes an extraction run run (policy §11.1).
 *
 * Two drivers, different jobs, one slice processor.
 *
 * - **`after()` post-response kick**, for latency. Next.js `after()` is bound
 *   to its request's execution and to the process lifetime, and on shutdown it
 *   depends on a graceful drain, so it is *not* a durable queue -- the same
 *   conclusion image generation §7 reached. It exists only so a user who just
 *   confirmed a run does not wait up to fifteen minutes to see it move.
 * - **The fifteen-minute maintenance dispatcher**, for recovery. §11.1 is
 *   explicit that reclaiming an expired lease is not enough: a reclaimed run
 *   goes back to `pending` and, with nothing to re-drive it, sits there
 *   forever unless a request happens to arrive. So this sweep reclaims *and*
 *   dispatches.
 *
 * Both call `driveMemoryExtractionRunSlice()`, which owns claiming, fencing,
 * the per-chunk boundary re-checks and lease release. Two copies of that
 * logic would drift, and the failure when they drift is duplicate provider
 * calls billed to the user.
 *
 * The durable source of truth is the run and chunk rows. Neither driver is
 * more authoritative than the other; they are occasions to start work, not
 * ways to record it.
 */

/**
 * How many runs one maintenance pass will drive.
 *
 * Bounded because the sweep shares a request with the rest of maintenance and
 * an extraction provider must not delay credit reconciliation, refunds or
 * notification delivery (§11.1). Runs left over are picked up by the next
 * pass -- their state is durable, so nothing is lost by waiting.
 */
export const MEMORY_EXTRACTION_DISPATCH_MAX_RUNS = 3;

/**
 * And a wall-clock ceiling for the whole pass, because a run count is not a
 * time bound.
 *
 * One slice is allowed `MEMORY_EXTRACTION_SLICE_BUDGET_MS` (90s), so three
 * runs driven back to back is four and a half minutes inside a request that
 * also reconciles credits, drains the notification queue and sweeps refunds.
 * §11.1 requires extraction latency not to delay that work, and bounding the
 * number of runs does not bound the time they take.
 *
 * The remaining budget is passed down as each run's own slice budget, so a run
 * cannot keep starting chunks after the pass is out of time. Work not reached
 * is durable and waits for the next pass, fifteen minutes later.
 *
 * Two minutes, and it has to exceed one chunk timeout by enough for a second
 * run to qualify -- a ceiling equal to the timeout would silently cap every
 * pass at one run. The bound is not exact: a chunk already claimed is always
 * allowed to finish and report, so a pass can overrun by at most one chunk
 * timeout. That is the reason this step is ordered last in the maintenance
 * route -- an overrun then delays only the response, never the credit, refund
 * and notification work §11.1 is protecting.
 */
export const MEMORY_EXTRACTION_DISPATCH_BUDGET_MS = 120_000;

/**
 * Below this there is no point starting *another* run: a slice that begins
 * with less time than one chunk's timeout can only stop at its first boundary,
 * having claimed and released a lease for nothing.
 *
 * It gates continuing, never starting. The first pending run is always
 * dispatched, whatever the ceiling says, so a pass makes progress rather than
 * deferring the same run forever -- and its slice still cannot outlive the
 * pass, because the remaining time is handed down as its own budget.
 */
const MIN_CONTINUE_BUDGET_MS = MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS;

const workerId = (prefix: string) =>
    `${prefix}:${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;

export type DispatchDeps = {
    /** Injected by the tests so no provider is contacted. */
    handler?: ReturnType<typeof memoryExtractionChunkHandler>;
    /**
     * Overrides the approved-pair register the chunk boundary re-check reads.
     * Production passes nothing and gets the shipped register, which is
     * fail-closed by design; the tests inject an approved pair so the run
     * lifecycle can be exercised without one being approved for real.
     */
    register?: ReadonlyArray<MemoryExtractionEvalEntry>;
};

/**
 * Drives one run for as long as its slice budget allows.
 *
 * Never throws. Both callers are background paths where an exception is
 * either swallowed by `after()` or would fail an unrelated maintenance job,
 * so a failure is reported as a structured event and the run stays durable
 * for the next dispatch.
 */
export async function dispatchMemoryExtractionRun(
    runId: string,
    owner: string,
    deps: DispatchDeps & { budgetMs?: number; maxChunks?: number } = {}
): Promise<ExtractionSliceResult | null> {
    const handler = deps.handler ?? memoryExtractionChunkHandler();
    try {
        return await driveMemoryExtractionRunSlice({
            runId,
            owner,
            handler,
            register: deps.register,
            budgetMs: deps.budgetMs,
            maxChunks: deps.maxChunks,
        });
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "memory_extraction_dispatch_failed",
                runId,
                owner,
                reason: error instanceof Error ? error.name : "unknown",
                at: new Date().toISOString(),
            })
        );
        return null;
    }
}

/**
 * How much of a run the post-response kick attempts: one chunk.
 *
 * Next's `after` reference states the callback "will run for the platform's
 * default or configured max duration of your route", so this is not a
 * background worker with its own lifetime -- it is time borrowed from a
 * request that has already answered. A kick that tried to finish the run
 * would routinely be killed part-way, and a kick killed mid-chunk leaves the
 * run `running` under a lease that has to lapse before the maintenance
 * dispatcher can reclaim it. The driver meant to reduce latency would then be
 * adding a lease TTL to it.
 *
 * One chunk is the useful amount: the user sees the run move immediately, and
 * finishing it is the fifteen-minute dispatcher's job, which is the division
 * of labour §11.1 describes.
 */
const KICK_MAX_CHUNKS = 1;

/**
 * The low-latency kick, called from `after()` once the creation response has
 * been sent.
 *
 * Deliberately fire-and-forget from the route's point of view: the run is
 * already durable when the response goes out, so nothing here can make the
 * creation fail, and nothing the user sees depends on it finishing.
 */
export async function kickMemoryExtractionRun(
    runId: string,
    deps: DispatchDeps & { maxChunks?: number } = {}
): Promise<void> {
    await dispatchMemoryExtractionRun(runId, workerId("kick"), {
        maxChunks: KICK_MAX_CHUNKS,
        ...deps,
    });
}

export type MaintenanceDispatchResult = {
    reclaimedRuns: number;
    dispatched: number;
    /** Pending runs this pass had no time left for; the next pass takes them. */
    skippedForTime: number;
    outcomes: Record<string, number>;
};

/**
 * The recovery half: reclaim expired leases, then actually re-drive what is
 * pending.
 *
 * Order matters. Reclaiming first returns orphaned runs to `pending`, and the
 * dispatch that follows is what §11.1 says the sweep must do beyond
 * reclaiming -- otherwise a run whose worker died is parked correctly and
 * still never finishes.
 */
export async function dispatchPendingMemoryExtractionRuns(
    deps: DispatchDeps & { maxRuns?: number; budgetMs?: number; now?: Date } = {}
): Promise<MaintenanceDispatchResult> {
    const now = deps.now ?? new Date();
    const { reclaimedRuns } = await reconcileExpiredMemoryExtractionRuns(now);

    const pending = await prisma.memoryExtractionRun.findMany({
        where: { status: "pending" },
        // Oldest first: a run that has been waiting longest is the one whose
        // owner has been watching a stalled progress bar longest.
        orderBy: { createdAt: "asc" },
        take: Math.max(1, deps.maxRuns ?? MEMORY_EXTRACTION_DISPATCH_MAX_RUNS),
        select: { id: true },
    });

    const deadline =
        now.getTime() +
        Math.max(1, deps.budgetMs ?? MEMORY_EXTRACTION_DISPATCH_BUDGET_MS);

    const outcomes: Record<string, number> = {};
    let dispatched = 0;
    let skippedForTime = 0;
    for (const run of pending) {
        const remaining = deadline - Date.now();
        if (dispatched > 0 && remaining < MIN_CONTINUE_BUDGET_MS) {
            // Reported rather than silently dropped: a pass that keeps running
            // out of time is a signal that the interval, the run count or the
            // slice budget is wrong, and a silent skip reads as "there was
            // nothing to do".
            skippedForTime += pending.length - dispatched;
            break;
        }
        const result = await dispatchMemoryExtractionRun(
            run.id,
            workerId("maintenance"),
            // The run's slice may not outlive the pass that started it.
            // The run's slice may not outlive the pass that started it. The
            // first run gets whatever is left even if that is little: a slice
            // that stops at its first boundary parks the run cleanly, which is
            // still better than never starting it.
            { ...deps, budgetMs: Math.max(1, remaining) }
        );
        dispatched += 1;
        const key = result?.outcome ?? "error";
        outcomes[key] = (outcomes[key] ?? 0) + 1;
    }

    if (reclaimedRuns > 0 || dispatched > 0 || skippedForTime > 0) {
        // Reported under its own event name so extraction latency is never
        // read as credit or notification maintenance being slow (§11.1).
        console.info(
            JSON.stringify({
                event: "memory_extraction_dispatch",
                reclaimedRuns,
                dispatched,
                skippedForTime,
                outcomes,
                at: now.toISOString(),
            })
        );
    }

    return { reclaimedRuns, dispatched, skippedForTime, outcomes };
}
