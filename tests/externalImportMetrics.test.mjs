import assert from "node:assert/strict";
import test from "node:test";
import {
    EXTERNAL_IMPORT_BYTE_BUCKETS,
    EXTERNAL_IMPORT_CONVERSATION_BUCKETS,
    EXTERNAL_IMPORT_FINALIZE_LATENCY_BUCKETS,
    summarizeExternalImports,
} from "../lib/externalImportMetricsCore.ts";

const at = (iso) => new Date(iso);

const sample = (overrides = {}) => ({
    provider: "chatgpt",
    status: "completed",
    parserVersion: "chatgpt-v1",
    digestVersion: 1,
    conversationCount: 3,
    messageCount: 30,
    normalizedBytes: 10_000,
    truncationCount: 0,
    duplicateCount: 0,
    failureCode: null,
    createdAt: at("2026-08-01T00:00:00.000Z"),
    completedAt: at("2026-08-01T00:00:05.000Z"),
    ...overrides,
});

test("empty input produces zero counts and null shares", () => {
    const summary = summarizeExternalImports([]);
    assert.equal(summary.imports, 0);
    assert.equal(summary.completed, 0);
    assert.equal(summary.duplicateShare, null);
    assert.equal(summary.truncationShare, null);
    assert.deepEqual(summary.byProvider, []);
    assert.deepEqual(summary.byParserVersion, []);
    for (const bucket of EXTERNAL_IMPORT_BYTE_BUCKETS) {
        assert.equal(summary.byteBuckets[bucket.label], 0);
    }
});

test("provider breakdown separates statuses and sums finalized figures", () => {
    const summary = summarizeExternalImports([
        sample(),
        sample({
            provider: "claude",
            status: "failed",
            parserVersion: "claude-v1",
            failureCode: "EXTERNAL_IMPORT_STAGING_EXPIRED",
            completedAt: null,
        }),
        sample({ provider: "claude", status: "cancelled", completedAt: null }),
        sample({ provider: "claude", status: "staging", completedAt: null }),
        sample({ provider: "chatgpt", conversationCount: 7, messageCount: 70 }),
    ]);

    assert.equal(summary.imports, 5);
    assert.equal(summary.completed, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.cancelled, 1);
    assert.equal(summary.active, 1);

    const claude = summary.byProvider.find(
        (entry) => entry.provider === "claude"
    );
    assert.equal(claude.imports, 3);
    assert.equal(claude.failed, 1);
    assert.equal(claude.cancelled, 1);
    assert.equal(claude.active, 1);
    assert.equal(claude.finalizedConversations, 0);

    const chatgpt = summary.byProvider.find(
        (entry) => entry.provider === "chatgpt"
    );
    assert.equal(chatgpt.completed, 2);
    assert.equal(chatgpt.finalizedConversations, 10);
    assert.equal(chatgpt.finalizedMessages, 100);

    assert.deepEqual(summary.failureCodes, {
        EXTERNAL_IMPORT_STAGING_EXPIRED: 1,
    });
});

test("parser version failure rate uses its own denominator", () => {
    const summary = summarizeExternalImports([
        sample({ parserVersion: "chatgpt-v1" }),
        sample({
            parserVersion: "chatgpt-v1",
            status: "failed",
            failureCode: null,
            completedAt: null,
        }),
        sample({ parserVersion: "chatgpt-v2" }),
    ]);
    const v1 = summary.byParserVersion.find(
        (entry) => entry.parserVersion === "chatgpt-v1"
    );
    assert.equal(v1.imports, 2);
    assert.equal(v1.failed, 1);
    assert.equal(v1.failureRate, 0.5);
    const v2 = summary.byParserVersion.find(
        (entry) => entry.parserVersion === "chatgpt-v2"
    );
    assert.equal(v2.failureRate, 0);
    // A failed row without a failure code is still counted, as "unknown".
    assert.deepEqual(summary.failureCodes, { unknown: 1 });
});

test("duplicate and truncation shares use examined and stored denominators", () => {
    const summary = summarizeExternalImports([
        sample({ conversationCount: 6, duplicateCount: 2, messageCount: 40 }),
        sample({
            conversationCount: 2,
            duplicateCount: 0,
            messageCount: 10,
            truncationCount: 5,
        }),
    ]);
    // 2 duplicates skipped over (6 + 2) stored + 2 skipped = 10 examined.
    assert.equal(summary.duplicateShare, 2 / 10);
    // 5 truncated of 50 stored messages.
    assert.equal(summary.truncationShare, 5 / 50);
});

test("completed imports land in count, byte and latency buckets", () => {
    const summary = summarizeExternalImports([
        sample({
            conversationCount: 1,
            normalizedBytes: 1_000,
            createdAt: at("2026-08-01T00:00:00.000Z"),
            completedAt: at("2026-08-01T00:00:04.000Z"),
        }),
        sample({
            conversationCount: 250,
            normalizedBytes: 30 * 1024 * 1024,
            createdAt: at("2026-08-01T00:00:00.000Z"),
            completedAt: at("2026-08-01T02:00:00.000Z"),
        }),
        // Failed rows must not contribute to completion buckets.
        sample({ status: "failed", completedAt: null }),
    ]);
    assert.equal(summary.conversationBuckets["le-9"], 1);
    assert.equal(summary.conversationBuckets["le-999"], 1);
    assert.equal(summary.byteBuckets["le-64kb"], 1);
    assert.equal(summary.byteBuckets["le-50mb"], 1);
    assert.equal(summary.finalizeLatencyBuckets["le-10s"], 1);
    assert.equal(summary.finalizeLatencyBuckets["gt-1h"], 1);
    const bucketTotal = Object.values(summary.finalizeLatencyBuckets).reduce(
        (total, count) => total + count,
        0
    );
    assert.equal(bucketTotal, 2);
});

test("bucket definitions stay ordered so labelling is deterministic", () => {
    for (const buckets of [
        EXTERNAL_IMPORT_BYTE_BUCKETS,
        EXTERNAL_IMPORT_CONVERSATION_BUCKETS,
        EXTERNAL_IMPORT_FINALIZE_LATENCY_BUCKETS,
    ]) {
        const bounds = buckets.map(
            (bucket) => bucket.max ?? bucket.maxBytes ?? bucket.maxMs
        );
        for (let index = 1; index < bounds.length; index += 1) {
            assert.ok(bounds[index] > bounds[index - 1]);
        }
        assert.equal(bounds[bounds.length - 1], Number.POSITIVE_INFINITY);
    }
});

test("the sample type has no field that could carry content or identifiers", () => {
    // The privacy posture is structural: the summary is computed from a
    // sample containing only these keys, so a title, filename, digest or
    // fingerprint has nowhere to travel (policy §22).
    const allowed = [
        "provider",
        "status",
        "parserVersion",
        "digestVersion",
        "conversationCount",
        "messageCount",
        "normalizedBytes",
        "truncationCount",
        "duplicateCount",
        "failureCode",
        "createdAt",
        "completedAt",
    ];
    assert.deepEqual(Object.keys(sample()).sort(), [...allowed].sort());
});
