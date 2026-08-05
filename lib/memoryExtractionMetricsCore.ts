/**
 * Content-free observability for memory extraction (policy §22, the B list).
 *
 * The pure half: rows in, counts out. It never sees a statement, a title, a
 * conversation id or a digest, because the query layer
 * (lib/memoryExtractionMetrics.ts) does not select them. Keeping the shaping
 * here means the rule "no content in metrics" is checkable by reading one
 * short file rather than by trusting a response shape.
 *
 * What an operator actually needs from this, now that runs execute in the
 * background and spend credits doing it:
 *
 * - is the dispatcher keeping up, or is a queue building behind it
 * - is one approved pair failing where the others are not
 * - what are chunks failing *of* -- a provider outage and a deleted source
 *   look identical in a success rate and need different responses
 * - are runs being charged for work they did not do
 */

export type ExtractionRunSample = {
    status: string;
    extractionModelId: string;
    promptVersion: string;
    chunkTotal: number;
    chunkCompleted: number;
    createdAt: Date;
    completedAt: Date | null;
    leaseExpiresAt: Date | null;
};

export type ExtractionChunkSample = {
    status: string;
    attemptCount: number;
    failureCode: string | null;
};

export type ExtractionReservationSample = {
    status: string;
    outcome: string | null;
    chunkTotal: number;
    chunksCharged: number;
    reservedCredits: number;
    settledCredits: number;
};

export type ExtractionPairBreakdown = {
    extractionModelId: string;
    promptVersion: string;
    runs: number;
    completed: number;
    failed: number;
    cancelled: number;
    /**
     * Of the runs that reached a terminal state. Runs still in flight are
     * excluded rather than counted as successes -- a rate that improves while
     * a run is merely unfinished is worse than no rate.
     */
    failureRate: number | null;
};

export type ExtractionQueueHealth = {
    pendingRuns: number;
    runningRuns: number;
    /** Seconds the oldest pending run has been waiting, or null if none is. */
    oldestPendingAgeSeconds: number | null;
    /**
     * Running runs whose lease has already lapsed. These are what the next
     * maintenance pass reclaims; a number that keeps growing means the pass is
     * not keeping up, which no success rate would show.
     */
    expiredLeases: number;
};

export type ExtractionMetricsSummary = {
    windowDays: number;
    runs: {
        total: number;
        byStatus: Record<string, number>;
        /** Median and p95 seconds from creation to a terminal state. */
        completionSecondsP50: number | null;
        completionSecondsP95: number | null;
    };
    pairs: ExtractionPairBreakdown[];
    chunks: {
        total: number;
        completed: number;
        failed: number;
        /** Why chunks failed. A provider outage and a deleted source differ. */
        failureCodes: Record<string, number>;
        /** Chunks that needed more than one attempt, over chunks attempted. */
        retryRate: number | null;
    };
    queue: ExtractionQueueHealth;
    credits: {
        reservations: number;
        reservedCredits: number;
        settledCredits: number;
        refundedCredits: number;
        /**
         * Reservations settled for fewer chunks than they reserved. Expected
         * to be non-zero -- cancellation is a feature -- but a jump means runs
         * are dying rather than being cancelled.
         */
        partiallySettled: number;
        /**
         * The invariant, restated as a metric: no reservation may settle for
         * more credits than it reserved. Non-zero is a release blocker, not a
         * trend to watch.
         */
        overSettled: number;
    };
    /** True when a cap was hit, so a low count is not read as a quiet window. */
    truncated: boolean;
};

const percentile = (values: number[], fraction: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(fraction * sorted.length) - 1)
    );
    return sorted[index];
};

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function summarizeMemoryExtraction(input: {
    windowDays: number;
    runs: readonly ExtractionRunSample[];
    chunks: readonly ExtractionChunkSample[];
    reservations: readonly ExtractionReservationSample[];
    /** Queue health is a live count, not a windowed one. */
    queue: ExtractionQueueHealth;
    truncated?: boolean;
}): ExtractionMetricsSummary {
    const byStatus: Record<string, number> = {};
    const completionSeconds: number[] = [];
    const pairs = new Map<string, ExtractionPairBreakdown>();

    for (const run of input.runs) {
        byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
        if (run.completedAt) {
            completionSeconds.push(
                Math.max(
                    0,
                    (run.completedAt.getTime() - run.createdAt.getTime()) / 1_000
                )
            );
        }
        const key = `${run.extractionModelId}\u0000${run.promptVersion}`;
        const pair =
            pairs.get(key) ??
            {
                extractionModelId: run.extractionModelId,
                promptVersion: run.promptVersion,
                runs: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
                failureRate: null,
            };
        pair.runs += 1;
        if (run.status === "completed") pair.completed += 1;
        if (run.status === "failed") pair.failed += 1;
        if (run.status === "cancelled") pair.cancelled += 1;
        pairs.set(key, pair);
    }

    for (const pair of pairs.values()) {
        // A cancelled run says nothing about the pair -- the user stopped it --
        // so the denominator is completed plus failed, and it is null when
        // neither has happened yet rather than a flattering zero.
        const decided = pair.completed + pair.failed;
        pair.failureRate = decided === 0 ? null : pair.failed / decided;
    }

    const failureCodes: Record<string, number> = {};
    let chunksCompleted = 0;
    let chunksFailed = 0;
    let chunksAttempted = 0;
    let chunksRetried = 0;
    for (const chunk of input.chunks) {
        if (chunk.status === "completed") chunksCompleted += 1;
        if (chunk.status === "failed") {
            chunksFailed += 1;
            const code = chunk.failureCode ?? "unknown";
            failureCodes[code] = (failureCodes[code] ?? 0) + 1;
        }
        if (chunk.attemptCount > 0) {
            chunksAttempted += 1;
            if (chunk.attemptCount > 1) chunksRetried += 1;
        }
    }

    let reservedCredits = 0;
    let settledCredits = 0;
    let partiallySettled = 0;
    let overSettled = 0;
    for (const reservation of input.reservations) {
        reservedCredits += reservation.reservedCredits;
        settledCredits += reservation.settledCredits;
        if (reservation.settledCredits > reservation.reservedCredits) {
            overSettled += 1;
        }
        if (
            reservation.status === "settled" &&
            reservation.chunksCharged < reservation.chunkTotal
        ) {
            partiallySettled += 1;
        }
    }

    return {
        windowDays: input.windowDays,
        runs: {
            total: input.runs.length,
            byStatus,
            completionSecondsP50: percentile(completionSeconds, 0.5),
            completionSecondsP95: percentile(completionSeconds, 0.95),
        },
        pairs: [...pairs.values()].sort((left, right) =>
            left.extractionModelId < right.extractionModelId ? -1 : 1
        ),
        chunks: {
            total: input.chunks.length,
            completed: chunksCompleted,
            failed: chunksFailed,
            failureCodes,
            retryRate:
                chunksAttempted === 0 ? null : chunksRetried / chunksAttempted,
        },
        queue: input.queue,
        credits: {
            reservations: input.reservations.length,
            reservedCredits,
            settledCredits,
            refundedCredits: Math.max(0, reservedCredits - settledCredits),
            partiallySettled,
            overSettled,
        },
        truncated: input.truncated ?? false,
    };
}

/** Whether a run status is one the window's rates should judge a pair on. */
export const isTerminalRunStatus = (status: string) =>
    TERMINAL_RUN_STATUSES.has(status);
