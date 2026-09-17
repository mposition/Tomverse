import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_TURN_TIMING_EVENT, chatTurnTimingEvent } from "../lib/chatTurnTiming.ts";

/**
 * CHAT-LATENCY-01. The timing line is the one latency record written on every
 * turn, so what it may and may not say is pinned here: durations from the
 * server's own start, a first-chunk time only when a visible chunk was sent,
 * and nothing that could carry the user's words.
 */

const base = {
    traceId: "trace-1",
    modelId: "gpt-5-6-luna",
    provider: "openai",
    requestReceivedAt: 1_000,
    endedAt: 4_500,
};

test("a completed turn reports both server durations from the request start", () => {
    const event = chatTurnTimingEvent({ ...base, outcome: "completed", firstVisibleChunkAt: 1_800 });
    assert.equal(event.event, CHAT_TURN_TIMING_EVENT);
    assert.equal(event.outcome, "completed");
    assert.equal(event.firstVisibleChunkSent, true);
    assert.equal(event.serverMsToFirstVisibleChunk, 800);
    assert.equal(event.serverMsToSettlement, 3_500);
    assert.equal(event.timestamp, new Date(4_500).toISOString());
});

test("a turn that never sent a visible chunk has no first-chunk time, not zero", () => {
    for (const outcome of ["failed", "cancelled", "empty", "failed_before_stream"]) {
        const event = chatTurnTimingEvent({ ...base, outcome, firstVisibleChunkAt: null });
        assert.equal(event.firstVisibleChunkSent, false, outcome);
        assert.equal(event.serverMsToFirstVisibleChunk, null, outcome);
        assert.equal(event.serverMsToSettlement, 3_500, outcome);
    }
});

test("a clock that stepped backwards never produces a negative duration", () => {
    const event = chatTurnTimingEvent({ ...base, outcome: "completed", firstVisibleChunkAt: 900, endedAt: 950 });
    assert.equal(event.serverMsToFirstVisibleChunk, 0);
    assert.equal(event.serverMsToSettlement, 0);
});

test("the event carries only identifiers and durations", () => {
    const event = chatTurnTimingEvent({ ...base, outcome: "completed", firstVisibleChunkAt: 1_800 });
    assert.deepEqual(Object.keys(event).sort(), [
        "event",
        "firstVisibleChunkSent",
        "modelId",
        "outcome",
        "provider",
        "serverMsToFirstVisibleChunk",
        "serverMsToSettlement",
        "timestamp",
        "traceId",
    ]);
});
