import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTING_RETRY_MARKER,
  buildRoutingRetryChunk,
  splitRoutingRetrySignal,
} from "../lib/routingRetrySignal.ts";

// §7's non-terminal state, carried in the stream because the headers are
// already gone by the time a fallback is decided. The failure that must not
// happen is the marker rendering as the first words of somebody's answer.

test("a stream with no signal is returned unchanged", () => {
  const split = splitRoutingRetrySignal("Hello, here is your answer.");
  assert.equal(split.text, "Hello, here is your answer.");
  assert.equal(split.signal, null);
});

test("the signal is removed and reported, and the answer survives whole", () => {
  const raw = `${buildRoutingRetryChunk("deepseek-v4-flash")}Here is the answer.`;
  const split = splitRoutingRetrySignal(raw);

  assert.equal(split.text, "Here is the answer.");
  assert.deepEqual(split.signal, {
    state: "retrying_with_another_model",
    modelId: "deepseek-v4-flash",
  });
});

// A stream is not delivered in the pieces it was written in, so the payload's
// end is the matching brace rather than a chunk boundary.
test("the answer is found even when it starts with a brace", () => {
  const raw = `${buildRoutingRetryChunk("m")}{"json": "answers are text too"}`;
  const split = splitRoutingRetrySignal(raw);
  assert.equal(split.text, '{"json": "answers are text too"}');
  assert.equal(split.signal.modelId, "m");
});

test("a brace inside a string in the payload does not end it early", () => {
  const raw = `${ROUTING_RETRY_MARKER}{"state":"retrying_with_another_model","modelId":"a}b"}tail`;
  const split = splitRoutingRetrySignal(raw);
  assert.equal(split.text, "tail");
  assert.equal(split.signal.modelId, "a}b");
});

// A client running against a newer server may meet a marker it cannot parse.
// Dropping the content is fine; showing it is not.
test("an unparseable signal is still removed rather than displayed", () => {
  const raw = `${ROUTING_RETRY_MARKER}{"state":"something-else"}the answer`;
  const split = splitRoutingRetrySignal(raw);

  assert.equal(split.text, "the answer");
  assert.equal(split.signal, null);
  assert.equal(split.text.includes("TOMVERSE_ROUTING_RETRY"), false);
});

test("a signal still arriving is dropped, not shown half-written", () => {
  const raw = `${ROUTING_RETRY_MARKER}{"state":"retrying_with`;
  const split = splitRoutingRetrySignal(raw);
  assert.equal(split.text, "");
  assert.equal(split.signal, null);
});

test("text before a signal is kept, so nothing already shown is lost", () => {
  const split = splitRoutingRetrySignal(`before${buildRoutingRetryChunk("m")}after`);
  assert.equal(split.text, "beforeafter");
});

// §7: the retry is announced "without exposing internal provider errors".
test("the chunk carries a model id and nothing about the failure", () => {
  const chunk = buildRoutingRetryChunk("deepseek-v4-flash");
  for (const leak of ["error", "stack", "429", "openai", "timeout", "ECONN"]) {
    assert.equal(
      chunk.toLowerCase().includes(leak.toLowerCase()),
      false,
      `the signal leaked "${leak}"`
    );
  }
});

// The marker starts with a NUL code point, which providers do not emit in
// normal completions, so real model output cannot collide with it.
test("the marker cannot be produced by ordinary model output", () => {
  assert.equal(ROUTING_RETRY_MARKER.charCodeAt(0), 0);
  const innocent = "TOMVERSE_ROUTING_RETRY is a string I am writing about.";
  assert.equal(splitRoutingRetrySignal(innocent).text, innocent);
  assert.equal(splitRoutingRetrySignal(innocent).signal, null);
});

test("the last signal wins when a stream carries more than one", () => {
  const raw =
    buildRoutingRetryChunk("first") + buildRoutingRetryChunk("second") + "answer";
  const split = splitRoutingRetrySignal(raw);
  assert.equal(split.signal.modelId, "second");
  assert.equal(split.text, "answer");
});
