import assert from "node:assert/strict";
import test from "node:test";
import {
    MAX_CONTEXT_BUNDLE_RETRIES,
    decideContextBundleRetry,
    isContextBundleStale,
} from "../lib/chatContextBundleRetry.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §10.
 *
 * Three rules, each with a failure mode worth naming:
 *   * retry once, or a stale-loop bills the user for every attempt;
 *   * never retry one panel of a comparison, or its answer stops being
 *     comparable to its siblings while still being shown beside them;
 *   * never retry after output is visible, or the user sees a turn duplicated
 *     or silently replaced.
 */

const decide = (overrides = {}) =>
    decideContextBundleRetry({
        isComparison: false,
        staleRetries: 0,
        outputVisible: false,
        ...overrides,
    });

test("a single-model turn re-prepares its context and retries once", () => {
    assert.deepEqual(decide(), { action: "reprepare_and_retry" });
});

test("a second stale on the same turn is shown to the user", () => {
    assert.deepEqual(decide({ staleRetries: MAX_CONTEXT_BUNDLE_RETRIES }), {
        action: "surface",
        reason: "retry_exhausted",
    });
});

test("a comparison panel never retries alone", () => {
    // Panels are comparable because they share one snapshot. A panel that
    // re-prepared its own context would answer a different question from its
    // siblings while appearing to answer the same one.
    assert.deepEqual(decide({ isComparison: true }), {
        action: "repreflight_comparison",
    });
});

test("no automatic retry once any output has been shown", () => {
    for (const isComparison of [false, true]) {
        assert.deepEqual(decide({ isComparison, outputVisible: true }), {
            action: "surface",
            reason: "output_visible",
        });
    }
});

test("visible output outranks the retry budget, not the other way round", () => {
    // Even on the first attempt: re-sending would duplicate or replace what
    // the user already read.
    assert.deepEqual(
        decide({ staleRetries: 0, outputVisible: true }),
        { action: "surface", reason: "output_visible" }
    );
});

test("only the §10 code triggers the policy", () => {
    assert.ok(isContextBundleStale({ code: "CHAT_CONTEXT_BUNDLE_STALE" }));
    assert.ok(!isContextBundleStale({ code: "TURNSTILE_REQUIRED" }));
    assert.ok(!isContextBundleStale(null));
    assert.ok(!isContextBundleStale("CHAT_CONTEXT_BUNDLE_STALE"));
});
