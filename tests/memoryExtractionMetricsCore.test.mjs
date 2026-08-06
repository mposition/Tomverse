import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { summarizeMemoryExtraction } from "../lib/memoryExtractionMetricsCore.ts";

/**
 * The shaping half of memory extraction observability (§22, the B list).
 *
 * Two things are under test. The arithmetic, because a rate that flatters the
 * thing it measures is worse than no rate. And the content-free rule, which is
 * a property of the *query* rather than of the response shape -- so it is
 * asserted against the source of the query layer, not against an object.
 */

const run = (overrides = {}) => ({
    status: "completed",
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    chunkTotal: 2,
    chunkCompleted: 2,
    createdAt: new Date("2026-08-05T00:00:00Z"),
    completedAt: new Date("2026-08-05T00:00:30Z"),
    leaseExpiresAt: null,
    ...overrides,
});

const chunk = (overrides = {}) => ({
    status: "completed",
    attemptCount: 1,
    failureCode: null,
    ...overrides,
});

const reservation = (overrides = {}) => ({
    status: "settled",
    outcome: "completed",
    chunkTotal: 2,
    chunksCharged: 2,
    reservedCredits: 2,
    settledCredits: 2,
    ...overrides,
});

const EMPTY_QUEUE = {
    pendingRuns: 0,
    runningRuns: 0,
    oldestPendingAgeSeconds: null,
    expiredLeases: 0,
};

const summarize = (input) =>
    summarizeMemoryExtraction({
        windowDays: 7,
        runs: [],
        chunks: [],
        reservations: [],
        queue: EMPTY_QUEUE,
        ...input,
    });

test("a pair's failure rate excludes runs that have not decided yet", () => {
    // A rate that improves while a run is merely unfinished would say the pair
    // is getting better as the queue backs up.
    const summary = summarize({
        runs: [
            run({ status: "completed" }),
            run({ status: "failed", completedAt: null }),
            run({ status: "running", completedAt: null }),
            run({ status: "pending", completedAt: null }),
        ],
    });
    const pair = summary.pairs[0];
    assert.equal(pair.runs, 4);
    assert.equal(pair.completed, 1);
    assert.equal(pair.failed, 1);
    assert.equal(pair.failureRate, 0.5);
});

test("a cancelled run is not counted against the pair", () => {
    // The user stopped it. That says nothing about the model.
    const summary = summarize({
        runs: [run({ status: "completed" }), run({ status: "cancelled" })],
    });
    assert.equal(summary.pairs[0].cancelled, 1);
    assert.equal(summary.pairs[0].failureRate, 0);
});

test("a pair with nothing decided reports null, not zero", () => {
    const summary = summarize({
        runs: [run({ status: "pending", completedAt: null })],
    });
    assert.equal(summary.pairs[0].failureRate, null);
});

test("pairs are reported separately", () => {
    const summary = summarize({
        runs: [
            run({ extractionModelId: "gpt-5-6-luna", status: "failed" }),
            run({ extractionModelId: "gpt-5-4-mini", status: "completed" }),
        ],
    });
    assert.equal(summary.pairs.length, 2);
    assert.deepEqual(
        summary.pairs.map((entry) => entry.extractionModelId),
        ["gpt-5-4-mini", "gpt-5-6-luna"]
    );
});

test("chunk failures are broken down by code", () => {
    // A provider outage and a deleted source look identical in a success rate
    // and call for different responses.
    const summary = summarize({
        chunks: [
            chunk({ status: "failed", failureCode: "provider_error" }),
            chunk({ status: "failed", failureCode: "provider_error" }),
            chunk({ status: "failed", failureCode: "no_conversations" }),
            chunk({ status: "failed", failureCode: null }),
            chunk(),
        ],
    });
    assert.equal(summary.chunks.failed, 4);
    assert.equal(summary.chunks.completed, 1);
    assert.deepEqual(summary.chunks.failureCodes, {
        provider_error: 2,
        no_conversations: 1,
        unknown: 1,
    });
});

test("the retry rate counts attempted chunks, not planned ones", () => {
    const summary = summarize({
        chunks: [
            chunk({ attemptCount: 1 }),
            chunk({ attemptCount: 3 }),
            // Never claimed: it is not evidence either way.
            chunk({ status: "pending", attemptCount: 0 }),
        ],
    });
    assert.equal(summary.chunks.retryRate, 0.5);
});

test("credits report what was given back, and flag what cannot happen", () => {
    const summary = summarize({
        reservations: [
            reservation(),
            reservation({
                outcome: "cancelled",
                chunksCharged: 0,
                settledCredits: 0,
            }),
            // The invariant restated as a metric. The database CHECK refuses
            // this row, so a non-zero count here is a release blocker rather
            // than a trend.
            reservation({ reservedCredits: 2, settledCredits: 5 }),
        ],
    });
    assert.equal(summary.credits.reservations, 3);
    assert.equal(summary.credits.reservedCredits, 6);
    assert.equal(summary.credits.settledCredits, 7);
    assert.equal(summary.credits.partiallySettled, 1);
    assert.equal(summary.credits.overSettled, 1);
});

test("refunded credits never go negative", () => {
    const summary = summarize({
        reservations: [reservation({ reservedCredits: 1, settledCredits: 4 })],
    });
    assert.equal(summary.credits.refundedCredits, 0);
});

test("completion percentiles come from runs that finished", () => {
    const base = new Date("2026-08-05T00:00:00Z");
    const summary = summarize({
        runs: [10, 20, 30, 40, 100].map((seconds) =>
            run({
                createdAt: base,
                completedAt: new Date(base.getTime() + seconds * 1_000),
            })
        ),
    });
    assert.equal(summary.runs.completionSecondsP50, 30);
    assert.equal(summary.runs.completionSecondsP95, 100);
});

test("an empty window reports null percentiles rather than zero", () => {
    const summary = summarize({});
    assert.equal(summary.runs.completionSecondsP50, null);
    assert.equal(summary.runs.completionSecondsP95, null);
    assert.equal(summary.chunks.retryRate, null);
    assert.equal(summary.truncated, false);
});

test("queue health passes through untouched", () => {
    const queue = {
        pendingRuns: 4,
        runningRuns: 1,
        oldestPendingAgeSeconds: 900,
        expiredLeases: 2,
    };
    assert.deepEqual(summarize({ queue }).queue, queue);
});

test("the query layer selects no content column", () => {
    // The rule §22 states is about what is read, not about what is returned.
    // A field that is never selected cannot be leaked by a later change to the
    // response shape, so this asserts against the query source.
    const source = readFileSync(
        new URL("../lib/memoryExtractionMetrics.ts", import.meta.url),
        "utf8"
    );
    const forbidden = [
        "sourceSelection",
        "conversationIds",
        "statement",
        "title",
        "content",
        "Digest",
        "userId",
        "externalMessageId",
    ];
    for (const field of forbidden) {
        assert.ok(
            !new RegExp(`${field}:\\s*true`).test(source),
            `${field} must not be selected by the metrics queries`
        );
    }
});

// ---------------------------------------------------------------------------
// Review outcomes (§22, §12.3). What humans did with what a pair proposed --
// the input to the approval decision that currently keeps extraction closed.

const item = (overrides = {}) => ({
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    status: "active",
    sensitivity: "standard",
    userEdited: false,
    ...overrides,
});

const review = (items) => summarize({ reviewItems: items }).review;

test("the approval rate excludes proposals nobody has reviewed yet", () => {
    // A rate that climbs while a queue of unreviewed candidates builds is
    // measuring the user's attention, not the model's precision.
    const summary = review([
        item({ status: "active" }),
        item({ status: "rejected" }),
        item({ status: "candidate" }),
        item({ status: "manual_review_required" }),
    ]);
    assert.equal(summary.proposed, 4);
    assert.equal(summary.awaitingReview, 2);
    assert.equal(summary.approvalRate, 0.5);
});

test("an item accepted long ago still counts as approved", () => {
    // Superseded and expired were accepted once. Counting them as anything
    // else makes a pair look worse the longer its output has been in use.
    const summary = review([
        item({ status: "superseded" }),
        item({ status: "expired" }),
        item({ status: "suspended_by_source_delete" }),
    ]);
    assert.equal(summary.approved, 3);
    assert.equal(summary.rejected, 0);
    assert.equal(summary.approvalRate, 1);
});

test("the edit rate is measured over approvals, not over proposals", () => {
    // A pair whose output is always accepted but always rewritten is not the
    // same as one accepted as-is, and an approval rate cannot tell them apart.
    const summary = review([
        item({ status: "active", userEdited: true }),
        item({ status: "active", userEdited: false }),
        item({ status: "rejected", userEdited: true }),
        item({ status: "candidate", userEdited: true }),
    ]);
    assert.equal(summary.approved, 2);
    assert.equal(summary.editRate, 0.5);
});

test("individual review and sensitivity are counted per pair", () => {
    const summary = review([
        item({ status: "manual_review_required", sensitivity: "sensitive" }),
        item({ status: "active" }),
    ]);
    assert.equal(summary.byPair[0].individualReview, 1);
    assert.equal(summary.byPair[0].sensitive, 1);
});

test("pairs are judged separately", () => {
    const summary = review([
        item({ extractionModelId: "gpt-5-6-luna", status: "active" }),
        item({ extractionModelId: "gpt-5-4-mini", status: "rejected" }),
    ]);
    assert.equal(summary.byPair.length, 2);
    const mini = summary.byPair.find(
        (entry) => entry.extractionModelId === "gpt-5-4-mini"
    );
    assert.equal(mini.approvalRate, 0);
    const luna = summary.byPair.find(
        (entry) => entry.extractionModelId === "gpt-5-6-luna"
    );
    assert.equal(luna.approvalRate, 1);
});

test("a pair with nothing decided reports null rates", () => {
    const summary = review([item({ status: "candidate" })]);
    assert.equal(summary.approvalRate, null);
    assert.equal(summary.editRate, null);
    assert.equal(summary.byPair[0].approvalRate, null);
    assert.equal(summary.byPair[0].editRate, null);
});

test("no review items reports zeroes and null rates", () => {
    const summary = review([]);
    assert.deepEqual(summary.byPair, []);
    assert.equal(summary.proposed, 0);
    assert.equal(summary.approvalRate, null);
});
