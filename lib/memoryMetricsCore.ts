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
 * that changes one, the reason has to be re-checked, and the answer is as
 * often "this metric can be measured now" as "the reason has moved on".
 * Injection went through both — "no caller yet" stopped being true when the
 * §10 chat wiring merged and the reason became "nothing counts it", and the
 * metric left this list once something did.
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
    // §8.4's evidence re-verification at write time. A candidate whose source
    // was deleted between the chunk being read and its result being stored is
    // dropped, and dropping it is exactly why no row records that it existed.
    "extraction_evidence_unverified",
    // §22's injection ratio. Policy §7 forbids storing the injected context as
    // a Message row, so an answered request leaves nothing behind that says
    // whether it carried memory. Both halves of the ratio therefore have to be
    // counted as they happen, and both are counted in the same place — the
    // chat route, once per answered request — so the numerator can never be
    // measured over a different population than the denominator.
    "chat_memory_eligible",
    "chat_memory_injected",
    // Of the injected contexts, those the §9 budget had to cut something from.
    "injected_context_truncated",
    // §22's injected token buckets. Closed labels rather than a sum: the
    // question is the shape of the distribution, and a total plus a count
    // would report one long context and many short ones as a middling average.
    "injected_tokens_le_256",
    "injected_tokens_le_1024",
    "injected_tokens_le_4096",
    "injected_tokens_gt_4096",
    // §22's stale bundle ratio, over the requests that actually presented a
    // bundle. The three refusals are separate because they mean different
    // things to an operator: drift is expected and self-healing, a replay is a
    // client retrying something it may not, and a rejected bundle never
    // described the request at all.
    "context_bundle_presented",
    "context_bundle_stale",
    "context_bundle_replayed",
    "context_bundle_rejected",
] as const;

export type MemoryCounterKind = (typeof MEMORY_COUNTER_KINDS)[number];

export type MemoryDayCounters = Record<MemoryCounterKind, number>;

export const emptyMemoryCounters = (): MemoryDayCounters =>
    Object.fromEntries(
        MEMORY_COUNTER_KINDS.map((kind) => [kind, 0])
    ) as MemoryDayCounters;

/**
 * Which bucket a memory block's input-token count belongs to, or null when
 * there is no block.
 *
 * Zero is not a bucket. "No memory was injected" is what the injection ratio
 * measures, and repeating it here as a zero-token bucket would make the
 * distribution of *injected* contexts look overwhelmingly tiny on every
 * account that mostly does not use memory.
 *
 * Boundaries are inclusive upper bounds, so a block that exactly fills the
 * §9 default token budget lands in the bucket named for that budget rather
 * than in the overflow one.
 */
export const INJECTED_TOKEN_BUCKET_LIMITS = [
    { limit: 256, kind: "injected_tokens_le_256" },
    { limit: 1_024, kind: "injected_tokens_le_1024" },
    { limit: 4_096, kind: "injected_tokens_le_4096" },
] as const satisfies ReadonlyArray<{ limit: number; kind: MemoryCounterKind }>;

export function injectedTokenBucket(tokens: number): MemoryCounterKind | null {
    if (!Number.isFinite(tokens) || tokens <= 0) return null;
    for (const bucket of INJECTED_TOKEN_BUCKET_LIMITS) {
        if (tokens <= bucket.limit) return bucket.kind;
    }
    return "injected_tokens_gt_4096";
}

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
        metric: "followup_repair_proxy",
        reason:
            "requires answers attributed to the memories they used; injection is wired but fail-closed, so no answer has been attributed yet",
    },
] as const;

export type MemoryInjectionRates = {
    /** Authenticated chat requests that reached prompt assembly. */
    eligible: number;
    /** Of those, the ones that carried a memory block. */
    injected: number;
    /** Null when nothing was eligible. */
    ratio: number | null;
    /** Injected contexts the §9 budget cut something from. */
    truncated: number;
    /** Over injected contexts, not over eligible ones. Null when none. */
    truncationRatio: number | null;
    tokenBuckets: {
        le256: number;
        le1024: number;
        le4096: number;
        gt4096: number;
    };
};

export type ContextBundleRates = {
    presented: number;
    stale: number;
    replayed: number;
    rejected: number;
    /** Null when no bundle was presented. */
    staleRatio: number | null;
};

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
    /** §22's injection ratio, truncation ratio and token buckets. */
    injection: MemoryInjectionRates;
    /** §22's stale bundle ratio and the refusals it is drawn from. */
    contextBundle: ContextBundleRates;
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

/**
 * §22's injection ratio, read off the day counters.
 *
 * The denominator is every authenticated chat request, not every request that
 * was *permitted* memory. Injection is fail-closed until §12.4's procedure has
 * been completed, so a denominator of "requests where injection was allowed"
 * would be zero and the ratio undefined — which is the state the `unavailable`
 * list exists to describe, and it is no longer this metric's state. Counted
 * this way a fail-closed deployment reports a truthful "0 of N", which is a
 * measurement; the confusion §22 warns about is a bare 0% with no N beside it.
 *
 * A guest is left out entirely rather than counted as a non-injection: they
 * have no account memory to inject, so including them would make the ratio
 * track the guest/member mix instead of injection.
 */
export function injectionRates(
    counters: MemoryDayCounters
): MemoryInjectionRates {
    return {
        eligible: counters.chat_memory_eligible,
        injected: counters.chat_memory_injected,
        ratio: rate(counters.chat_memory_injected, counters.chat_memory_eligible),
        truncated: counters.injected_context_truncated,
        truncationRatio: rate(
            counters.injected_context_truncated,
            counters.chat_memory_injected
        ),
        tokenBuckets: {
            le256: counters.injected_tokens_le_256,
            le1024: counters.injected_tokens_le_1024,
            le4096: counters.injected_tokens_le_4096,
            gt4096: counters.injected_tokens_gt_4096,
        },
    };
}

/**
 * §22's stale bundle ratio.
 *
 * The denominator is bundles presented, not chat requests: a deployment where
 * most requests carry no bundle at all would otherwise report a vanishing
 * stale rate no matter how often drift actually happened.
 *
 * Expiry is counted as staleness because the route refuses both with
 * CHAT_CONTEXT_BUNDLE_STALE and both are repaired the same way. A replay is
 * not — it is the client presenting a bundle twice, which says nothing about
 * whether the context drifted — so it is counted beside the ratio rather than
 * inside it.
 */
export function contextBundleRates(
    counters: MemoryDayCounters
): ContextBundleRates {
    return {
        presented: counters.context_bundle_presented,
        stale: counters.context_bundle_stale,
        replayed: counters.context_bundle_replayed,
        rejected: counters.context_bundle_rejected,
        staleRatio: rate(
            counters.context_bundle_stale,
            counters.context_bundle_presented
        ),
    };
}

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
        injection: injectionRates(input.counters),
        contextBundle: contextBundleRates(input.counters),
        unavailable: MEMORY_METRICS_UNAVAILABLE,
    };
}
