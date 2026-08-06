import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_COUNTER_KINDS,
    MEMORY_METRICS_UNAVAILABLE,
    emptyMemoryCounters,
    injectedTokenBucket,
    summarizeMemoryMetrics,
} from "../lib/memoryMetricsCore.ts";

/**
 * §22 B memory metrics.
 *
 * Two kinds of assertion here. The arithmetic ones are about denominators —
 * an unworked review queue is not a low approval rate — and the rest are
 * about honesty: a metric with no source has to say so rather than report a
 * zero that reads as "nothing is happening".
 */

const memory = (overrides = {}) => ({
    status: "active",
    sensitivity: "standard",
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    userEdited: false,
    createdAtMs: Date.parse("2026-08-01T00:00:00.000Z"),
    approvedAtMs: Date.parse("2026-08-02T00:00:00.000Z"),
    ...overrides,
});

const run = (overrides = {}) => ({
    status: "completed",
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    chunkTotal: 4,
    chunkCompleted: 4,
    ...overrides,
});

const summarize = (memories = [], runs = [], counters = emptyMemoryCounters()) =>
    summarizeMemoryMetrics({ memories, runs, counters });

/* --------------------------------------------------------------- reviews -- */

test("the approval rate counts only memories that left review", () => {
    // Three approved, one rejected, two still waiting. The waiting two are not
    // evidence of anything yet; including them would report 50% approval for
    // a queue nobody has worked through.
    const summary = summarize([
        memory(),
        memory(),
        memory(),
        memory({ status: "rejected" }),
        memory({ status: "candidate" }),
        memory({ status: "manual_review_required" }),
    ]);
    assert.equal(summary.memories.approvalRate, 0.75);
    assert.equal(summary.memories.rejectionRate, 0.25);
    assert.equal(summary.memories.total, 6);
});

test("rates are null rather than zero when nothing has been decided", () => {
    // Null says "no data"; 0 would say "everything was rejected".
    const summary = summarize([memory({ status: "candidate" })]);
    assert.equal(summary.memories.approvalRate, null);
    assert.equal(summary.memories.rejectionRate, null);
    assert.equal(summary.memories.editedRate, null);
});

test("the edited rate is of approvals, not of everything", () => {
    const summary = summarize([
        memory({ userEdited: true }),
        memory(),
        memory({ status: "rejected", userEdited: true }),
    ]);
    assert.equal(summary.memories.editedRate, 0.5);
});

test("sensitive share is of every memory, since bulk approval always skips them", () => {
    const summary = summarize([
        memory({ sensitivity: "sensitive", status: "candidate" }),
        memory(),
        memory(),
        memory(),
    ]);
    assert.equal(summary.memories.sensitiveRate, 0.25);
});

test("hand-written memories are counted by their absent provenance", () => {
    const summary = summarize([
        memory({ extractionModelId: null, promptVersion: null }),
        memory(),
    ]);
    assert.equal(summary.memories.userAuthored, 1);
});

test("statuses are tallied as given, including ones added later", () => {
    const summary = summarize([
        memory({ status: "suspended_by_source_delete" }),
        memory({ status: "expired" }),
        memory(),
    ]);
    assert.equal(summary.memories.byStatus.suspended_by_source_delete, 1);
    assert.equal(summary.memories.byStatus.expired, 1);
    assert.equal(summary.memories.byStatus.active, 1);
});

/* ------------------------------------------------------------------ runs -- */

test("runs break down per approved pair", () => {
    const summary = summarize(
        [],
        [
            run(),
            run({ status: "failed" }),
            run({ extractionModelId: "gpt-5-4-mini" }),
        ]
    );
    assert.equal(summary.runs.total, 3);
    assert.equal(summary.runs.byPair.length, 2);
    const luna = summary.runs.byPair.find(
        (entry) => entry.extractionModelId === "gpt-5-6-luna"
    );
    assert.equal(luna.runs, 2);
    assert.equal(luna.failureRate, 0.5);
});

test("the same model on a different prompt version is a different pair", () => {
    const summary = summarize(
        [],
        [run(), run({ promptVersion: "mem-extract-v2" })]
    );
    assert.equal(summary.runs.byPair.length, 2);
});

test("a cancelled run counts against the pair rather than being excluded", () => {
    // Excluding cancellations would flatter a pair users keep giving up on.
    const summary = summarize([], [run(), run({ status: "cancelled" }), run({ status: "failed" })]);
    assert.equal(summary.runs.byPair[0].failureRate, Math.round((1 / 3) * 10_000) / 10_000);
    assert.equal(summary.runs.byPair[0].cancelled, 1);
});

test("runs still in flight are not a failure rate denominator", () => {
    const summary = summarize([], [run({ status: "running" }), run({ status: "pending" })]);
    assert.equal(summary.runs.byPair[0].failureRate, null);
    assert.equal(summary.runs.byStatus.running, 1);
});

test("pair order is stable so two identical windows render identically", () => {
    const forward = summarize([], [run({ extractionModelId: "b" }), run({ extractionModelId: "a" })]);
    const reversed = summarize([], [run({ extractionModelId: "a" }), run({ extractionModelId: "b" })]);
    assert.deepEqual(
        forward.runs.byPair.map((entry) => entry.extractionModelId),
        reversed.runs.byPair.map((entry) => entry.extractionModelId)
    );
});

/* -------------------------------------------------------------- honesty  -- */

test("every unavailable metric carries a reason", () => {
    assert.ok(MEMORY_METRICS_UNAVAILABLE.length > 0);
    for (const entry of MEMORY_METRICS_UNAVAILABLE) {
        assert.ok(entry.metric.length > 0);
        assert.ok(
            entry.reason.length > 10,
            `${entry.metric} needs a reason a reader can act on`
        );
    }
});

test("the summary always carries the unavailable list, even when empty", () => {
    // The list is what stops a reader treating a missing metric as a zero.
    assert.deepEqual(summarize().unavailable, MEMORY_METRICS_UNAVAILABLE);
});

test("a follow-up proxy still needs answers nothing has attributed yet", () => {
    const declared = MEMORY_METRICS_UNAVAILABLE.map((entry) => entry.metric);
    assert.ok(declared.includes("followup_repair_proxy"));
});

test("a metric that gained a source is no longer declared unavailable", () => {
    // The reasons are a contract, not decoration: the source-lock slice,
    // extraction settlement and the §10 chat counters all landed, so claiming
    // these have no source would be the same lie in the other direction -- a
    // reader told nothing measures something that now does.
    const declared = MEMORY_METRICS_UNAVAILABLE.map((entry) => entry.metric);
    for (const metric of [
        "lock_suspension_restore",
        "credit_per_chunk_percentiles",
        "batch_subbudget_exhaustion",
        "injection_ratio",
        "injected_token_buckets",
        "stale_bundle_ratio",
    ]) {
        assert.equal(
            declared.includes(metric),
            false,
            `${metric} has a source now and must not be declared unavailable`
        );
    }
});

/* ------------------------------------------------------------- counters  -- */

test("counters pass through and start at zero", () => {
    const zero = emptyMemoryCounters();
    for (const kind of MEMORY_COUNTER_KINDS) {
        assert.equal(zero[kind], 0, `${kind} starts at zero`);
    }
    const summary = summarize([], [], { ...zero, validator_rejected: 7 });
    assert.equal(summary.counters.validator_rejected, 7);
});

test("an empty window summarizes without dividing by zero", () => {
    const summary = summarize();
    assert.equal(summary.memories.total, 0);
    assert.equal(summary.memories.sensitiveRate, null);
    assert.deepEqual(summary.runs.byPair, []);
});

/* ------------------------------------------------- credits per chunk  -- */

test("credits per chunk are reported at the median and the 90th", () => {
    const summary = summarizeMemoryMetrics({
        memories: [],
        runs: [],
        counters: emptyMemoryCounters(),
        settlements: [
            { chunksCharged: 1, settledCredits: 1 },
            { chunksCharged: 2, settledCredits: 4 },
            { chunksCharged: 4, settledCredits: 4 },
            { chunksCharged: 5, settledCredits: 25 },
        ],
    });
    // Per-chunk: 1, 2, 1, 5 -> sorted 1, 1, 2, 5.
    assert.equal(summary.creditPerChunk.samples, 4);
    assert.equal(summary.creditPerChunk.p50, 1);
    assert.equal(summary.creditPerChunk.p90, 5);
});

test("a run that charged nothing is excluded, not counted as zero", () => {
    // Cancelled before its first chunk. Averaging it in would drag the
    // reported cost of a chunk toward zero exactly when runs are failing.
    const summary = summarizeMemoryMetrics({
        memories: [],
        runs: [],
        counters: emptyMemoryCounters(),
        settlements: [
            { chunksCharged: 0, settledCredits: 0 },
            { chunksCharged: 2, settledCredits: 6 },
        ],
    });
    assert.equal(summary.creditPerChunk.samples, 1);
    assert.equal(summary.creditPerChunk.p50, 3);
});

test("no settled run reports null rather than zero", () => {
    const summary = summarizeMemoryMetrics({
        memories: [],
        runs: [],
        counters: emptyMemoryCounters(),
        settlements: [],
    });
    assert.deepEqual(summary.creditPerChunk, { samples: 0, p50: null, p90: null });
});

test("percentiles land on a run someone actually had", () => {
    // Nearest-rank, not interpolation: these are credits, and "1.5 credits per
    // chunk" describes nobody.
    const summary = summarizeMemoryMetrics({
        memories: [],
        runs: [],
        counters: emptyMemoryCounters(),
        settlements: [
            { chunksCharged: 1, settledCredits: 1 },
            { chunksCharged: 1, settledCredits: 2 },
        ],
    });
    assert.equal(summary.creditPerChunk.p50, 1);
    assert.equal(summary.creditPerChunk.p90, 2);
});

/* ------------------------------------------------------------- injection -- */

const withCounters = (overrides) =>
    summarize([], [], { ...emptyMemoryCounters(), ...overrides });

test("a fail-closed deployment reports 0 of N, not a bare zero", () => {
    // The reason this metric left the unavailable list. "0%" alone cannot be
    // told apart from a feature nobody uses; "0 of 12" is a measurement.
    const summary = withCounters({ chat_memory_eligible: 12 });
    assert.equal(summary.injection.eligible, 12);
    assert.equal(summary.injection.injected, 0);
    assert.equal(summary.injection.ratio, 0);
});

test("no eligible request reports null rather than a zero ratio", () => {
    assert.equal(withCounters({}).injection.ratio, null);
});

test("truncation is measured over injected contexts, not eligible requests", () => {
    // Dividing by eligible requests would make the §9 budget look generous on
    // any deployment where most requests carry no memory at all.
    const summary = withCounters({
        chat_memory_eligible: 100,
        chat_memory_injected: 4,
        injected_context_truncated: 1,
    });
    assert.equal(summary.injection.ratio, 0.04);
    assert.equal(summary.injection.truncationRatio, 0.25);
});

test("token buckets are reported as a distribution, not a total", () => {
    const summary = withCounters({
        injected_tokens_le_256: 5,
        injected_tokens_le_1024: 2,
        injected_tokens_gt_4096: 1,
    });
    assert.deepEqual(summary.injection.tokenBuckets, {
        le256: 5,
        le1024: 2,
        le4096: 0,
        gt4096: 1,
    });
});

test("a block lands in the bucket named for the budget it exactly fills", () => {
    assert.equal(injectedTokenBucket(1), "injected_tokens_le_256");
    assert.equal(injectedTokenBucket(256), "injected_tokens_le_256");
    assert.equal(injectedTokenBucket(257), "injected_tokens_le_1024");
    assert.equal(injectedTokenBucket(1_024), "injected_tokens_le_1024");
    assert.equal(injectedTokenBucket(4_096), "injected_tokens_le_4096");
    assert.equal(injectedTokenBucket(4_097), "injected_tokens_gt_4096");
});

test("no block is no bucket", () => {
    // Zero is what the injection ratio measures. Repeating it as a bucket
    // would make the distribution of injected contexts look tiny on every
    // account that mostly does not use memory.
    assert.equal(injectedTokenBucket(0), null);
    assert.equal(injectedTokenBucket(-1), null);
    assert.equal(injectedTokenBucket(Number.NaN), null);
});

test("every bucket the function can return is a declared counter kind", () => {
    for (const tokens of [1, 256, 257, 1_024, 4_096, 4_097]) {
        assert.ok(MEMORY_COUNTER_KINDS.includes(injectedTokenBucket(tokens)));
    }
});

/* --------------------------------------------------------- context bundle -- */

test("the stale ratio is drawn from bundles presented, not from requests", () => {
    const summary = withCounters({
        chat_memory_eligible: 1_000,
        context_bundle_presented: 20,
        context_bundle_stale: 5,
    });
    assert.equal(summary.contextBundle.staleRatio, 0.25);
});

test("a replay is counted beside the stale ratio, never inside it", () => {
    // Both are refused with CHAT_CONTEXT_BUNDLE_STALE, but only one of them
    // says the context drifted.
    const summary = withCounters({
        context_bundle_presented: 10,
        context_bundle_stale: 1,
        context_bundle_replayed: 4,
        context_bundle_rejected: 2,
    });
    assert.equal(summary.contextBundle.staleRatio, 0.1);
    assert.equal(summary.contextBundle.replayed, 4);
    assert.equal(summary.contextBundle.rejected, 2);
});

test("no bundle presented reports null rather than a clean stale rate", () => {
    assert.equal(withCounters({}).contextBundle.staleRatio, null);
});
