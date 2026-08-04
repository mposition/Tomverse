import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_EXTRACTION_MAX_SELECTION,
    estimateGate,
    pairSignature,
    runProgress,
    selectionSignature,
    startGate,
    summarizeSelection,
} from "../lib/memoryExtractionLaunch.ts";

/**
 * The launch screen's decisions, checked without a browser.
 *
 * The rules under test are the ones whose failure mode is a request the server
 * would refuse: an unapproved pair, a second concurrent run, and above all a
 * confirmed credit figure that no longer describes what is on screen.
 */

const pair = { extractionModelId: "gpt-5-6-luna", promptVersion: "mem-extract-v1" };

const ready = (overrides = {}) => ({
    featureEnabled: true,
    availablePairs: [pair],
    selectedPair: pair,
    selectedConversationIds: ["c-2", "c-1"],
    activeRunId: null,
    busy: false,
    ...overrides,
});

const estimateFor = (input, overrides = {}) => ({
    selection: selectionSignature(input.selectedConversationIds),
    pair: pairSignature(input.selectedPair),
    chunkCount: 2,
    conversationCount: input.selectedConversationIds.length,
    estimatedCredits: 4,
    ...overrides,
});

/* ------------------------------------------------------------ signatures -- */

test("a selection signature ignores order and duplicates", () => {
    assert.equal(
        selectionSignature(["b", "a", "b"]),
        selectionSignature(["a", "b"])
    );
    assert.notEqual(selectionSignature(["a"]), selectionSignature(["a", "b"]));
});

test("a pair signature separates the model from the prompt version", () => {
    assert.notEqual(
        pairSignature(pair),
        pairSignature({ ...pair, promptVersion: "mem-extract-v2" })
    );
    assert.equal(pairSignature(null), "");
});

/* ----------------------------------------------------------------- gates -- */

test("every precondition is required before an estimate may be asked for", () => {
    const cases = [
        [{ featureEnabled: false }, "feature_disabled"],
        [{ availablePairs: [], selectedPair: null }, "no_approved_pair"],
        [{ activeRunId: "run-1" }, "run_in_progress"],
        [{ selectedPair: null }, "no_pair_selected"],
        [{ selectedConversationIds: [] }, "no_selection"],
        [
            {
                selectedConversationIds: Array.from(
                    { length: MEMORY_EXTRACTION_MAX_SELECTION + 1 },
                    (_, index) => `c-${index}`
                ),
            },
            "selection_too_large",
        ],
        [{ busy: true }, "busy"],
    ];
    for (const [overrides, reason] of cases) {
        const gate = estimateGate(ready(overrides));
        assert.equal(gate.allow, false, `${reason} must block`);
        assert.equal(gate.reason, reason);
    }
    assert.deepEqual(estimateGate(ready()), { allow: true });
});

test("an account with an open run is told before it picks anything", () => {
    // Ordering matters: an open run outranks "no selection", because the user
    // cannot fix it by selecting more conversations.
    const gate = estimateGate(
        ready({ activeRunId: "run-1", selectedConversationIds: [] })
    );
    assert.equal(gate.reason, "run_in_progress");
});

/* ------------------------------------------------------- estimate freshness */

test("start carries exactly the credits the estimate showed", () => {
    const input = ready();
    const gate = startGate({ ...input, estimate: estimateFor(input) });
    assert.equal(gate.allow, true);
    assert.equal(gate.credits, 4);
});

test("start is refused with no estimate at all", () => {
    const input = ready();
    assert.deepEqual(startGate({ ...input, estimate: null }), {
        allow: false,
        reason: "estimate_missing",
    });
});

test("changing the selection makes the estimate stale", () => {
    const input = ready();
    const estimate = estimateFor(input);
    const changed = { ...input, selectedConversationIds: ["c-1"] };
    assert.deepEqual(startGate({ ...changed, estimate }), {
        allow: false,
        reason: "estimate_stale",
    });
});

test("re-ordering the same selection does not make the estimate stale", () => {
    // The server sorts before planning, so the same set in another order is
    // the same run — re-asking here would be a pointless round trip.
    const input = ready();
    const estimate = estimateFor(input);
    const reordered = { ...input, selectedConversationIds: ["c-1", "c-2"] };
    assert.equal(startGate({ ...reordered, estimate }).allow, true);
});

test("changing the model makes the estimate stale", () => {
    const input = ready();
    const estimate = estimateFor(input);
    const other = { extractionModelId: "gpt-5-4-mini", promptVersion: "mem-extract-v1" };
    const changed = {
        ...input,
        availablePairs: [pair, other],
        selectedPair: other,
    };
    assert.deepEqual(startGate({ ...changed, estimate }), {
        allow: false,
        reason: "estimate_stale",
    });
});

test("a blocked launch reports the block, not staleness", () => {
    const input = ready();
    const estimate = estimateFor(input);
    assert.deepEqual(
        startGate({ ...input, activeRunId: "run-1", estimate }),
        { allow: false, reason: "run_in_progress" }
    );
});

/* --------------------------------------------------------------- summary -- */

test("the summary counts selections the current page does not show", () => {
    const visible = [
        { id: "c-1", contentBytes: 1000 },
        { id: "c-2", contentBytes: 2000 },
    ];
    const summary = summarizeSelection(visible, ["c-1", "c-2", "c-9"]);
    assert.equal(summary.count, 3);
    assert.equal(summary.contentBytes, 3000, "only visible bytes are known");
    assert.equal(summary.hiddenCount, 1);
});

test("an empty selection summarizes to zero rather than throwing", () => {
    assert.deepEqual(summarizeSelection([], []), {
        count: 0,
        contentBytes: 0,
        hiddenCount: 0,
    });
});

/* -------------------------------------------------------------- progress -- */

test("progress reports a percentage and whether to keep polling", () => {
    assert.deepEqual(
        runProgress({ status: "running", chunkTotal: 4, chunkCompleted: 1 }),
        {
            status: "running",
            percent: 25,
            terminal: false,
            cancellable: true,
            polling: true,
        }
    );
});

test("terminal runs stop polling and stop offering cancel", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
        const progress = runProgress({
            status,
            chunkTotal: 4,
            chunkCompleted: 4,
        });
        assert.equal(progress.terminal, true, `${status} is terminal`);
        assert.equal(progress.polling, false);
        assert.equal(progress.cancellable, false);
    }
});

test("a completed run reads 100 even if its counters disagree", () => {
    // Never show "3 of 4" beside "Finished": the run is over either way, and
    // a partial bar would read as work still to do.
    const progress = runProgress({
        status: "completed",
        chunkTotal: 4,
        chunkCompleted: 3,
    });
    assert.equal(progress.percent, 100);
});

test("a run with no chunks does not divide by zero", () => {
    assert.equal(
        runProgress({ status: "pending", chunkTotal: 0, chunkCompleted: 0 })
            .percent,
        0
    );
});

test("an unknown status is treated as failed, not as still running", () => {
    // Fail towards "stop polling and stop offering cancel": a status this
    // build does not know about must not leave the page spinning forever.
    const progress = runProgress({
        status: "something_new",
        chunkTotal: 2,
        chunkCompleted: 1,
    });
    assert.equal(progress.status, "failed");
    assert.equal(progress.polling, false);
});
