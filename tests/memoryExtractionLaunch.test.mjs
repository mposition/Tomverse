import assert from "node:assert/strict";
import test from "node:test";
import { runProgress } from "../lib/memoryExtractionLaunch.ts";

/** How a run's progress reads on screen, checked without a browser. */

test("progress reports a percentage and whether to keep polling", () => {
    assert.deepEqual(
        runProgress({ status: "running", chunkTotal: 4, chunkCompleted: 1 }),
        {
            status: "running",
            percent: 25,
            terminal: false,
            cancellable: true,
            polling: true,
            stalled: false,
        }
    );
});

test("a stalled run stays running, keeps polling and keeps cancel", () => {
    // The progress bar has not moved and will not for up to fifteen minutes.
    // The screen has to say why, without claiming the run failed: the chunks
    // already done are kept and the reclaim sweep hands it to a new worker.
    const progress = runProgress({
        status: "running",
        chunkTotal: 4,
        chunkCompleted: 1,
        stalled: true,
    });
    assert.equal(progress.stalled, true);
    assert.equal(progress.status, "running");
    assert.equal(progress.terminal, false);
    // Polling is what ends the stall on screen -- the recovery is server-side,
    // so stopping would freeze the page on the one state that resolves itself.
    assert.equal(progress.polling, true);
    assert.equal(progress.cancellable, true);
});

test("a response without the field is not reported as stalled", () => {
    // An older server, or a cached response, must leave the screen saying
    // exactly what it said before this field existed.
    assert.equal(
        runProgress({ status: "running", chunkTotal: 4, chunkCompleted: 1 })
            .stalled,
        false
    );
});

test("a terminal run is never described as paused", () => {
    // A run that finished between two polls can still be reported stalled by
    // the response in flight; "paused, resuming shortly" beside "Finished"
    // would be the screen contradicting itself.
    for (const status of ["completed", "failed", "cancelled"]) {
        const progress = runProgress({
            status,
            chunkTotal: 4,
            chunkCompleted: 4,
            stalled: true,
        });
        assert.equal(progress.stalled, false, `${status} is not paused`);
    }
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

