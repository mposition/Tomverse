import "server-only";

import { memoryExtractionChunkHandler } from "@/lib/memoryExtractionChunkHandler";
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
    deps: DispatchDeps = {}
): Promise<ExtractionSliceResult | null> {
    const handler = deps.handler ?? memoryExtractionChunkHandler();
    try {
        return await driveMemoryExtractionRunSlice({
            runId,
            owner,
            handler,
            register: deps.register,
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
 * The low-latency kick, called from `after()` once the creation response has
 * been sent.
 *
 * Deliberately fire-and-forget from the route's point of view: the run is
 * already durable when the response goes out, so nothing here can make the
 * creation fail, and nothing the user sees depends on it finishing.
 */
export async function kickMemoryExtractionRun(
    runId: string,
    deps: DispatchDeps = {}
): Promise<void> {
    await dispatchMemoryExtractionRun(runId, workerId("kick"), deps);
}

export type MaintenanceDispatchResult = {
    reclaimedRuns: number;
    dispatched: number;
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
    deps: DispatchDeps & { maxRuns?: number; now?: Date } = {}
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

    const outcomes: Record<string, number> = {};
    let dispatched = 0;
    for (const run of pending) {
        const result = await dispatchMemoryExtractionRun(
            run.id,
            workerId("maintenance"),
            deps
        );
        dispatched += 1;
        const key = result?.outcome ?? "error";
        outcomes[key] = (outcomes[key] ?? 0) + 1;
    }

    if (reclaimedRuns > 0 || dispatched > 0) {
        // Reported under its own event name so extraction latency is never
        // read as credit or notification maintenance being slow (§11.1).
        console.info(
            JSON.stringify({
                event: "memory_extraction_dispatch",
                reclaimedRuns,
                dispatched,
                outcomes,
                at: now.toISOString(),
            })
        );
    }

    return { reclaimedRuns, dispatched, outcomes };
}
