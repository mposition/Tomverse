/**
 * A failed run says why, on screen.
 *
 * The harness stops after five consecutive unscoreable answers and tells the
 * reader the pair is "broken, not unlucky" -- and used to stop there, leaving
 * the reason inside the artifact. The first live run of
 * `(gpt-5-6-luna, mem-extract-v1)` hit exactly that: five failures, no cost,
 * and nothing on screen about what went wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFailures } from "../lib/memoryExtractionEvalCore.ts";

test("repeats collapse into one line with a count", () => {
    const summary = summarizeFailures([
        { failure: "model not found" },
        { failure: "model not found" },
        { failure: null },
        { failure: "unparseable answer: empty" },
    ]);
    assert.deepEqual(summary, [
        { reason: "model not found", count: 2 },
        { reason: "unparseable answer: empty", count: 1 },
    ]);
});

test("the most common reason comes first", () => {
    const summary = summarizeFailures([
        { failure: "rare" },
        ...Array.from({ length: 3 }, () => ({ failure: "common" })),
    ]);
    assert.equal(summary[0].reason, "common");
});

test("distinct messages are not merged", () => {
    // Normalising would fold together errors that differ in the part that
    // decides what to do next -- a 404 on the model and a 401 on the key read
    // the same after enough smoothing.
    const summary = summarizeFailures([
        { failure: "404 model_not_found: gpt-5.6-luna" },
        { failure: "401 invalid_api_key" },
    ]);
    assert.equal(summary.length, 2);
});

test("a clean run summarises nothing", () => {
    assert.deepEqual(summarizeFailures([{ failure: null }, { failure: null }]), []);
    assert.deepEqual(summarizeFailures([]), []);
});
