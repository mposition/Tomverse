import assert from "node:assert/strict";
import test from "node:test";

import {
  chatStreamDisplayText,
  createChatStreamDisplayProjector,
} from "../packages/chat-core/src/index.ts";
import { consumeChatStream } from "../lib/chatStreamConsumer.ts";
import { buildStreamKeepaliveChunk } from "../lib/chatStreamKeepalive.ts";
import { buildMcpProgressChunk } from "../lib/mcpConnectorProgress.ts";
import { buildRoutingRetryChunk } from "../lib/routingRetrySignal.ts";
import { buildChatStreamTrailerChunk } from "../lib/webSearchStreamTrailer.ts";

const NUL = String.fromCharCode(0);
const unknown = (label, json) => `${NUL}TOMVERSE_${label}${json}`;

/* ------------------------------------------------ unknown NUL controls --- */

test("an unknown control with a complete payload is skipped and the answer continues", () => {
  const raw = `Before ${unknown("FUTURE_THING", '{"a":"}{","b":{"c":1}}')}after, and more.`;
  assert.equal(chatStreamDisplayText(raw), "Before after, and more.");
});

test("an unknown control still arriving is held back, then skipped once it completes", () => {
  const head = `Before ${unknown("FUTURE_THING", '{"a":')}`;
  assert.equal(chatStreamDisplayText(head), "Before ");
  assert.equal(chatStreamDisplayText(`Before ${NUL}TOMVERSE_FUT`), "Before ");
  assert.equal(chatStreamDisplayText(`Before ${NUL}TOM`), "Before ");
  assert.equal(chatStreamDisplayText(`Before ${NUL}`), "Before ");
  assert.equal(chatStreamDisplayText(`${head}1} after`), "Before  after");
});

test("a NUL that cannot start a control, or a label with no payload, loses only itself", () => {
  assert.equal(chatStreamDisplayText(`a${NUL}b`), "ab");
  assert.equal(chatStreamDisplayText(`a${NUL}TOMVERSE_ODD tail`), "a tail");
  assert.equal(chatStreamDisplayText(`a${NUL}${NUL}b`), "ab");
});

test("the search-metadata trailer is never shown and hides nothing before it", () => {
  const raw = `Answer.${buildChatStreamTrailerChunk({ searchMetadata: null, completion: { status: "normal" } })}`;
  assert.equal(chatStreamDisplayText(raw), "Answer.");
});

test("known controls are skipped as before", () => {
  const raw =
    buildRoutingRetryChunk("model-b") +
    "A" +
    buildStreamKeepaliveChunk({ state: "provider_active", elapsedMs: 1 }) +
    "B" +
    buildMcpProgressChunk("searching") +
    "C";
  assert.equal(chatStreamDisplayText(raw), "ABC");
});

/* ------------------------------------------------------- incrementality --- */

test("feeding a stream in any chunking yields the one-shot projection at every prefix", () => {
  const wire =
    "Intro " +
    unknown("FUTURE_THING", '{"x":[1,2,{"y":"}"}]}') +
    buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 5 }) +
    `middle${NUL}stray tail ` +
    buildMcpProgressChunk("reading") +
    "end." +
    buildChatStreamTrailerChunk({ searchMetadata: null, completion: { status: "normal" } });

  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let round = 0; round < 40; round++) {
    const projector = createChatStreamDisplayProjector();
    let raw = "";
    let offset = 0;
    while (offset < wire.length) {
      const size = 1 + (next() % 9);
      raw += wire.slice(offset, offset + size);
      offset += size;
      assert.equal(projector.project(raw), chatStreamDisplayText(raw), `prefix ${JSON.stringify(raw)}`);
    }
    assert.equal(projector.project(raw), "Intro middlestray tail end.");
  }
});

test("a raw string that is not an append of the last one restarts the projection", () => {
  const projector = createChatStreamDisplayProjector();
  projector.project("a long first answer");
  assert.equal(projector.project("short"), "short");
});

/* ------------------------------------------------------------- consumer --- */

const readerOf = (chunks) => {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    read: async () =>
      index < chunks.length
        ? { done: false, value: encoder.encode(chunks[index++]) }
        : { done: true, value: undefined },
    cancel: async () => undefined,
  };
};

const sink = () => {
  const calls = { keepalive: 0, visible: 0, server: 0 };
  return {
    calls,
    liveness: {
      noteKeepalive: () => void calls.keepalive++,
      noteVisibleChunk: () => void calls.visible++,
      noteServerSignal: () => void calls.server++,
    },
  };
};

test("the consumer shows the rest of an answer that follows an unknown control", async () => {
  const { liveness } = sink();
  const frames = [];
  const result = await consumeChatStream({
    reader: readerOf(["One ", unknown("FUTURE", '{"v":'), "1}two ", "three"]),
    liveness,
    onProgress: (progress) => frames.push(progress.displayText),
  });
  assert.equal(result.displayText, "One two three");
  assert.equal(frames.some((frame) => frame.includes("TOMVERSE")), false);
});

test("a long stream with periodic controls is consumed in linear time and reads every control once", async () => {
  const chunks = [];
  let expected = "";
  let keepalives = 0;
  for (let i = 0; i < 4000; i++) {
    const text = `chunk ${i} lorem ipsum dolor sit amet. `;
    expected += text;
    chunks.push(text);
    if (i % 40 === 0) {
      chunks.push(buildStreamKeepaliveChunk({ state: "provider_active", elapsedMs: i }));
      keepalives++;
    }
    if (i === 100) chunks.push(buildRoutingRetryChunk("model-b"));
    if (i === 200) chunks.push(buildMcpProgressChunk("searching"));
  }
  const { calls, liveness } = sink();
  let lastMcp;
  const startedAt = performance.now();
  const result = await consumeChatStream({
    reader: readerOf(chunks),
    liveness,
    onProgress: (progress) => {
      lastMcp = progress.mcpProgress ?? lastMcp;
    },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.displayText, expected);
  assert.equal(result.retryingWithModelId, "model-b");
  assert.equal(calls.keepalive, keepalives);
  assert.equal(lastMcp, "searching");
  // Re-scanning the whole accumulation on every chunk took several seconds
  // for this input; a generous bound keeps slow CI from flaking.
  assert.ok(elapsedMs < 3000, `consuming took ${elapsedMs}ms`);
});
