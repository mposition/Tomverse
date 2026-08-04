import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_COUNTER_KINDS,
    MEMORY_METRICS_UNAVAILABLE,
    emptyMemoryCounters,
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

test("injection metrics are declared unavailable while nothing injects", () => {
    const declared = MEMORY_METRICS_UNAVAILABLE.map((entry) => entry.metric);
    for (const metric of [
        "injection_ratio",
        "injected_token_buckets",
        "stale_bundle_ratio",
    ]) {
        assert.ok(declared.includes(metric), `${metric} must be declared`);
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
