import assert from "node:assert/strict";
import test from "node:test";

import {
  STREAM_KEEPALIVE_MARKER,
  buildStreamKeepaliveChunk,
  splitStreamKeepaliveSignal,
} from "../lib/chatStreamKeepalive.ts";
import { buildRoutingRetryChunk } from "../lib/routingRetrySignal.ts";
import { buildChatStreamTrailerChunk } from "../lib/webSearchStreamTrailer.ts";

// The chunk that keeps a high-reasoning turn's connection alive while the
// provider thinks. It is written into the same stream the answer is written
// into, so the failure that must never happen is any part of it being read as
// an answer.

test("a stream with no keepalive is returned unchanged", () => {
  const split = splitStreamKeepaliveSignal("Here is the answer.");
  assert.equal(split.text, "Here is the answer.");
  assert.equal(split.signal, null);
});

test("the keepalive is removed and reported, and the answer survives whole", () => {
  const raw = `${buildStreamKeepaliveChunk({
    state: "awaiting_first_token",
    elapsedMs: 20_000,
  })}Here is the answer.`;

  const split = splitStreamKeepaliveSignal(raw);
  assert.equal(split.text, "Here is the answer.");
  assert.deepEqual(split.signal, {
    state: "awaiting_first_token",
    elapsedMs: 20_000,
  });
});

test("many keepalives leave nothing behind and the last one is reported", () => {
  const raw =
    buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 20_000 }) +
    buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 40_000 }) +
    buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 60_000 }) +
    "First words.";

  const split = splitStreamKeepaliveSignal(raw);
  assert.equal(split.text, "First words.");
  assert.equal(split.signal.elapsedMs, 60_000);
});

/*
  The reason the splitter finds a matching brace instead of trusting a chunk
  boundary. A `ReadableStream` is not delivered in the pieces it was written
  in, and this is the shape the delivery actually takes: the marker torn in
  half, the payload torn in half, the answer arriving in a third read.

  What this function owns is that a *recognised* marker never contributes to
  the text -- neither its name nor a payload it could not finish reading. A
  read that stops partway through the name is not a keepalive yet, so the
  leading NUL survives here; holding that back is
  `lib/chatStreamConsumer.ts`'s job and `tests/chatStreamConsumer.test.mjs`
  is where it is pinned.
*/
test("a keepalive split across reads never shows a recognisable fragment", () => {
  const whole = `${buildStreamKeepaliveChunk({
    state: "awaiting_first_token",
    elapsedMs: 20_000,
  })}Answer text.`;

  for (let cut = 1; cut < whole.length; cut += 1) {
    const partial = splitStreamKeepaliveSignal(whole.slice(0, cut));
    assert.equal(
      partial.text.includes("TOMVERSE_STREAM_KEEPALIVE"),
      false,
      `the marker name leaked when the stream was cut at ${cut}`
    );
    assert.equal(
      partial.text.includes("elapsedMs"),
      false,
      `payload JSON leaked when the stream was cut at ${cut}`
    );
  }

  // The whole accumulation is re-split on every pass, so the settled state is
  // always the clean answer however it was torn up on the way.
  assert.equal(splitStreamKeepaliveSignal(whole).text, "Answer text.");
});

test("the terminal stall carries its code and is reported as stalled", () => {
  const raw = buildStreamKeepaliveChunk({
    state: "stalled",
    elapsedMs: 540_000,
    code: "CHAT_FIRST_RESPONSE_TIMEOUT",
  });

  const split = splitStreamKeepaliveSignal(raw);
  assert.equal(split.text, "");
  assert.equal(split.signal.state, "stalled");
  assert.equal(split.signal.code, "CHAT_FIRST_RESPONSE_TIMEOUT");
});

test("keepalives coexist with the routing retry marker and the trailer", () => {
  const raw =
    buildRoutingRetryChunk("claude-opus-4-8") +
    buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 20_000 }) +
    "The answer." +
    buildChatStreamTrailerChunk({
      searchMetadata: null,
      completion: { status: "normal" },
    });

  // Each splitter is handed the previous one's remaining text, exactly as
  // lib/chatStreamConsumer.ts chains them.
  const keepalive = splitStreamKeepaliveSignal(raw);
  assert.equal(keepalive.signal.state, "awaiting_first_token");
  assert.equal(keepalive.text.includes("TOMVERSE_STREAM_KEEPALIVE"), false);
  assert.equal(keepalive.text.includes("TOMVERSE_ROUTING_RETRY"), true);
});

/*
  A client running against a newer server. The content of a payload it cannot
  read is dropped; the marker itself is still removed, because the one thing
  that must not happen is it being rendered.
*/
test("an unparseable payload is still stripped from the answer", () => {
  const raw = `${STREAM_KEEPALIVE_MARKER}{"state":"something-new","v":2}Answer.`;

  const split = splitStreamKeepaliveSignal(raw);
  assert.equal(split.text, "Answer.");
  assert.equal(split.signal, null);
});

test("a payload with a nested object is bounded by its own matching brace", () => {
  const raw = `${STREAM_KEEPALIVE_MARKER}{"state":"awaiting_first_token","elapsedMs":1,"extra":{"a":"}"}}Answer.`;

  const split = splitStreamKeepaliveSignal(raw);
  assert.equal(split.text, "Answer.");
  assert.equal(split.signal.state, "awaiting_first_token");
});
