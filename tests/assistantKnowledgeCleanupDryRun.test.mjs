import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { describeKnowledgeCleanupQueue } from "../lib/assistantKnowledgeCleanupDryRunCore.ts";

/**
 * What the retention dry run may say about the knowledge tombstone queue.
 *
 * The dry run used to report one merged number that counted *completed*
 * cleanup rows aging out -- nothing about the bytes still in R2. The
 * `227be331` staging round had to reconstruct the sweep from a cron log and a
 * Cloudflare console because of it.
 *
 * These are mostly about numbers that must not disagree with each other. A
 * dry run is read once, by an operator about to type RUN CLEANUP, and a figure
 * that does not add up costs more than a missing one.
 */

const counts = (over = {}) => ({
    retryable: 0,
    exhausted: 0,
    oldestPendingAt: null,
    executionLimit: 200,
    ...over,
});

test("pending is the sum of its parts, so the three can never disagree", () => {
    const result = describeKnowledgeCleanupQueue(
        counts({ retryable: 7, exhausted: 3 })
    );
    assert.equal(result.pendingTombstones, 10);
    assert.equal(result.retryable, 7);
    assert.equal(result.exhausted, 3);
});

test("truncation is about the rows the run will take, not the ones it won't", () => {
    // Exhausted rows are past the attempt ceiling, so the drain's `attempts <
    // max` filter never selects them. Counting them toward the cap would warn
    // about a backlog this run was never going to touch.
    const stuck = describeKnowledgeCleanupQueue(
        counts({ retryable: 5, exhausted: 500 })
    );
    assert.equal(stuck.truncated, false);
    assert.equal(stuck.pendingTombstones, 505);

    const backlog = describeKnowledgeCleanupQueue(counts({ retryable: 201 }));
    assert.equal(backlog.truncated, true);
});

test("a queue exactly the size of one run is not truncated", () => {
    assert.equal(
        describeKnowledgeCleanupQueue(counts({ retryable: 200 })).truncated,
        false
    );
});

test("the oldest pending time is an ISO string, or null when nothing is pending", () => {
    const at = new Date("2026-08-23T04:58:00.000Z");
    assert.equal(
        describeKnowledgeCleanupQueue(counts({ retryable: 1, oldestPendingAt: at }))
            .oldestPendingAt,
        "2026-08-23T04:58:00.000Z"
    );
    assert.equal(describeKnowledgeCleanupQueue(counts()).oldestPendingAt, null);
});

test("the orphan scan is reported as not run rather than left out", () => {
    // Omitting it would read as "there is nothing to collect" -- a claim about
    // the bucket, made by a dry run that deliberately does not list it.
    const result = describeKnowledgeCleanupQueue(counts());
    assert.equal(result.orphanScan.status, "not_run");
    assert.match(result.orphanScan.reason, /does not list the object store/);
});

test("nothing in the result can carry a key, a name, or file content", () => {
    const result = describeKnowledgeCleanupQueue(
        counts({ retryable: 2, exhausted: 1, oldestPendingAt: new Date(0) })
    );
    assert.deepEqual(Object.keys(result).sort(), [
        "executionLimit",
        "exhausted",
        "oldestPendingAt",
        "orphanScan",
        "pendingTombstones",
        "retryable",
        "truncated",
    ]);
    // Counts and one timestamp. The reader's `select` names `createdAt` alone,
    // which is what keeps an object key out of `AdminRetentionRun.result` and
    // the audit log even if this shape grows a field later.
    const reader = readFileSync("lib/assistantKnowledgeLifecycle.ts", "utf8");
    const dryRunReader = reader.slice(
        reader.indexOf("readKnowledgeCleanupQueueDryRun"),
        reader.indexOf("AbandonedKnowledgeSweepResult")
    );
    assert.ok(dryRunReader.length > 0);
    assert.match(dryRunReader, /select: \{ createdAt: true \}/);
    assert.doesNotMatch(dryRunReader, /r2Key/);
});

test("the cap the dry run quotes is the cap both executions pass", () => {
    // The call, not the import: a first version of the sweep-cadence test
    // matched a name the import line still carried and passed with the call
    // deleted.
    const lifecycle = readFileSync("lib/assistantKnowledgeLifecycle.ts", "utf8");
    const maintenance = readFileSync("lib/maintenance.ts", "utf8");

    assert.match(lifecycle, /export const KNOWLEDGE_CLEANUP_EXECUTION_LIMIT = \d+;/);
    // The fifteen-minute ride-along and the daily job, and the dry run's own
    // `executionLimit`, all name the constant.
    assert.match(
        lifecycle,
        /drainKnowledgeCleanupQueue\(\s*KNOWLEDGE_CLEANUP_EXECUTION_LIMIT/
    );
    assert.match(
        maintenance,
        /drainKnowledgeCleanupQueue\(KNOWLEDGE_CLEANUP_EXECUTION_LIMIT/
    );
    assert.match(lifecycle, /executionLimit: KNOWLEDGE_CLEANUP_EXECUTION_LIMIT/);
    // No literal left behind to drift from it.
    assert.doesNotMatch(lifecycle, /drainKnowledgeCleanupQueue\(\s*200/);
    assert.doesNotMatch(maintenance, /drainKnowledgeCleanupQueue\(200/);
});
