/**
 * Release B memory observability, pure half (policy §22 B).
 *
 * §22 lists more than this release can honestly report. Rather than emitting
 * zeros that read as "nothing is happening", the summary carries an explicit
 * `unavailable` list naming each metric that has no source yet and why — an
 * injection ratio of 0% would be a measurement of nothing, and a dashboard
 * cannot tell that apart from a feature nobody uses.
 *
 * The reasons are part of the contract, not decoration: when a feature lands
 * that changes one, the reason has to be re-checked. "No caller yet" stopped
 * being true for injection the moment the §10 chat wiring merged, even though
 * the metric is still unavailable — for a different reason, which is that
 * nothing counts it.
 *
 * Everything here is a count, a rate or a closed enum label. Statements,
 * evidence text, conversation titles and ids never reach this module — they
 * are excluded by the query in lib/memoryMetrics.ts, not merely left out of
 * the response shape.
 */

/** One memory row, reduced to what §22 permits. */
export type MemoryMetricSample = {
    status: string;
    sensitivity: string;
    /** Null for user-authored memories. */
    extractionModelId: string | null;
    promptVersion: string | null;
    userEdited: boolean;
    createdAtMs: number;
    approvedAtMs: number | null;
};

/** One extraction run, likewise reduced. */
export type MemoryRunMetricSample = {
    status: string;
    extractionModelId: string;
    promptVersion: string;
    chunkTotal: number;
    chunkCompleted: number;
};

export type MemoryDayCounters = {
    validator_rejected: number;
    source_delete_memory_deleted: number;
    source_delete_memory_suspended: number;
    memory_expired: number;
    source_lock_memory_suspended: number;
    source_lock_memory_restored: number;
    source_lock_memory_expired: number;
    extraction_subbudget_exhausted: number;
};

export const MEMORY_COUNTER_KINDS = [
    "validator_rejected",
    "source_delete_memory_deleted",
    "source_delete_memory_suspended",
    "memory_expired",
    // §7.1 lock transitions. Deliberately separate from the source-*delete*
    // counters above: a lock is reversible and a delete is not, so folding
    // them together would report a temporary suspension as data loss.
    "source_lock_memory_suspended",
    "source_lock_memory_restored",
    "source_lock_memory_expired",
    // §22's batch sub-budget exhaustion. A refusal leaves no row of its own —
    // the run is never created, or the dispatch simply stops — so the counter
    // is the only record that it happened.
    "extraction_subbudget_exhausted",
] as const;

export type MemoryCounterKind = (typeof MEMORY_COUNTER_KINDS)[number];

export const emptyMemoryCounters = (): MemoryDayCounters => ({
    validator_rejected: 0,
    source_delete_memory_deleted: 0,
    source_delete_memory_suspended: 0,
    memory_expired: 0,
    source_lock_memory_suspended: 0,
    source_lock_memory_restored: 0,
    source_lock_memory_expired: 0,
    extraction_subbudget_exhausted: 0,
});

/** One settled extraction reservation, reduced to what §22 permits. */
export type ExtractionSettlementSample = {
    chunksCharged: number;
    settledCredits: number;
};

export type CreditPerChunkPercentiles = {
    /** Settled runs that charged at least one chunk. */
    samples: number;
    p50: number | null;
    p90: number | null;
};

/**
 * Credits per charged chunk, at the median and the 90th percentile.
 *
 * A settled run that charged nothing — cancelled before its first chunk,
 * failed on chunk one — contributes no per-chunk figure and is excluded
 * rather than counted as zero: dividing by no chunks is not a cheap run, it
 * is an absent measurement, and averaging it in would drag the reported cost
 * of a chunk toward zero exactly when runs are failing.
 *
 * Nearest-rank rather than interpolation: the numbers are credits, and a
 * percentile that reports 1.5 credits describes a run nobody had.
 */
export function creditPerChunkPercentiles(
    samples: readonly ExtractionSettlementSample[]
): CreditPerChunkPercentiles {
    const perChunk = samples
        .filter((sample) => sample.chunksCharged > 0)
        .map((sample) => sample.settledCredits / sample.chunksCharged)
        .sort((left, right) => left - right);
    if (perChunk.length === 0) return { samples: 0, p50: null, p90: null };
    const at = (fraction: number) =>
        perChunk[
            Math.min(
                perChunk.length - 1,
                Math.max(0, Math.ceil(fraction * perChunk.length) - 1)
            )
        ];
    return { samples: perChunk.length, p50: at(0.5), p90: at(0.9) };
}

/**
 * Metrics §22 asks for that nothing can supply yet. Named, with the reason,
 * so a reader is told the difference between "zero happened" and "nothing
 * measures this".
 */
export const MEMORY_METRICS_UNAVAILABLE = [
    {
        metric: "injection_ratio",
        reason:
            "chat builds a memory context but records no counter for it, and answers are not counted either — there is neither a numerator nor a denominator",
    },
    {
        metric: "injected_token_buckets",
        reason:
            "the bundle carries the memory token count, but no request persists it",
    },
    {
        metric: "stale_bundle_ratio",
        reason:
            "CHAT_CONTEXT_BUNDLE_STALE refusals are returned but not counted",
    },
    {
        metric: "followup_repair_proxy",
        reason:
            "requires answers attributed to the memories they used; injection is wired but fail-closed, so no answer has been attributed yet",
    },
] as const;

export type MemoryPairBreakdown = {
    extractionModelId: string;
    promptVersion: string;
    runs: number;
    completed: number;
    failed: number;
    cancelled: number;
    /** Of the runs that reached a terminal state. Null when none did. */
    failureRate: number | null;
};

export type MemorySummary = {
    memories: {
        total: number;
        byStatus: Record<string, number>;
        /** Of memories that left review. Null when none has. */
        approvalRate: number | null;
        rejectionRate: number | null;
        /** Approved after the user rewrote the statement. */
        editedRate: number | null;
        /** Share flagged sensitive, which bulk approval always excludes. */
        sensitiveRate: number | null;
        /** Share with no extraction provenance, i.e. hand-written. */
        userAuthored: number;
    };
    runs: {
        total: number;
        byStatus: Record<string, number>;
        byPair: MemoryPairBreakdown[];
    };
    counters: MemoryDayCounters;
    /** §22's credit-per-chunk distribution, over settled runs. */
    creditPerChunk: CreditPerChunkPercentiles;
    unavailable: typeof MEMORY_METRICS_UNAVAILABLE;
};

/** Statuses that mean the user has finished deciding about a memory. */
const DECIDED_ACTIVE = "active";
const DECIDED_REJECTED = "rejected";
const UNDECIDED = ["candidate", "manual_review_required"];

const rate = (part: number, whole: number) =>
    whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

const tally = (values: readonly string[]) => {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
};

export function summarizeMemoryMetrics(input: {
    memories: readonly MemoryMetricSample[];
    runs: readonly MemoryRunMetricSample[];
    counters: MemoryDayCounters;
    settlements?: readonly ExtractionSettlementSample[];
}): MemorySummary {
    const byStatus = tally(input.memories.map((row) => row.status));

    // The denominator is memories that left review, not every memory: a
    // review queue that has not been worked through is not a low approval
    // rate, and dividing by everything would report it as one.
    const decided = input.memories.filter(
        (row) => !UNDECIDED.includes(row.status)
    );
    const approved = decided.filter((row) => row.status === DECIDED_ACTIVE);
    const rejected = decided.filter((row) => row.status === DECIDED_REJECTED);

    const runsByPair = new Map<string, MemoryPairBreakdown>();
    for (const run of input.runs) {
        const key = `${run.extractionModelId} ${run.promptVersion}`;
        const entry = runsByPair.get(key) ?? {
            extractionModelId: run.extractionModelId,
            promptVersion: run.promptVersion,
            runs: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            failureRate: null,
        };
        entry.runs += 1;
        if (run.status === "completed") entry.completed += 1;
        else if (run.status === "failed") entry.failed += 1;
        else if (run.status === "cancelled") entry.cancelled += 1;
        runsByPair.set(key, entry);
    }
    const byPair = [...runsByPair.values()]
        .map((entry) => ({
            ...entry,
            // Cancelled runs are in the denominator: a user cancelling is an
            // outcome of the run, and excluding it would flatter the pair.
            failureRate: rate(
                entry.failed,
                entry.completed + entry.failed + entry.cancelled
            ),
        }))
        // Stable order, so two identical windows render identically.
        .sort((left, right) =>
            `${left.extractionModelId} ${left.promptVersion}` <
            `${right.extractionModelId} ${right.promptVersion}`
                ? -1
                : 1
        );

    return {
        memories: {
            total: input.memories.length,
            byStatus,
            approvalRate: rate(approved.length, decided.length),
            rejectionRate: rate(rejected.length, decided.length),
            editedRate: rate(
                approved.filter((row) => row.userEdited).length,
                approved.length
            ),
            sensitiveRate: rate(
                input.memories.filter((row) => row.sensitivity === "sensitive")
                    .length,
                input.memories.length
            ),
            userAuthored: input.memories.filter(
                (row) => row.extractionModelId === null
            ).length,
        },
        runs: {
            total: input.runs.length,
            byStatus: tally(input.runs.map((row) => row.status)),
            byPair,
        },
        counters: input.counters,
        creditPerChunk: creditPerChunkPercentiles(input.settlements ?? []),
        unavailable: MEMORY_METRICS_UNAVAILABLE,
    };
}
