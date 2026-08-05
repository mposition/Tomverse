import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatStreamTrailerChunk,
  buildSearchMetadataTrailerChunk,
  parseChatStreamTrailer,
  splitSearchMetadataTrailer,
  SEARCH_METADATA_TRAILER_MARKER,
} from "../lib/webSearchStreamTrailer.ts";

test("a stream with no trailer is returned untouched", () => {
  const result = splitSearchMetadataTrailer("Just a normal answer.");
  assert.equal(result.displayText, "Just a normal answer.");
  assert.equal(result.searchMetadataJson, null);
});

test("build + split round-trips the execution payload without touching the visible text", () => {
  const execution = {
    requested: true,
    supported: true,
    executed: true,
    provider: "openai",
    citations: [{ url: "https://example.com" }],
  };
  const raw = `Here is the answer.${buildSearchMetadataTrailerChunk(execution)}`;
  const { displayText, searchMetadataJson } = splitSearchMetadataTrailer(raw);
  assert.equal(displayText, "Here is the answer.");
  assert.deepEqual(JSON.parse(searchMetadataJson), execution);
});

test("an empty AI response plus the trailer still displays as empty", () => {
  const raw = buildSearchMetadataTrailerChunk({
    requested: false,
    supported: false,
    executed: false,
    provider: "openai",
    citations: [],
  });
  const { displayText } = splitSearchMetadataTrailer(raw);
  assert.equal(displayText.trim(), "");
});

test("the marker survives being reassembled from partial chunks", () => {
  const execution = { requested: true, supported: true, executed: true, provider: "google", citations: [] };
  const full = `Partial answer text${buildSearchMetadataTrailerChunk(execution)}`;
  // Simulate the marker arriving split across two separate network reads.
  const splitPoint = full.indexOf(SEARCH_METADATA_TRAILER_MARKER) + 3;
  const firstChunk = full.slice(0, splitPoint);
  const secondChunk = full.slice(splitPoint);
  let accumulated = firstChunk;
  assert.equal(splitSearchMetadataTrailer(accumulated).searchMetadataJson, null);
  accumulated += secondChunk;
  const { displayText, searchMetadataJson } = splitSearchMetadataTrailer(accumulated);
  assert.equal(displayText, "Partial answer text");
  assert.deepEqual(JSON.parse(searchMetadataJson), execution);
});

const execution = {
  requested: true,
  supported: true,
  executed: true,
  provider: "perplexity",
  citations: [
    { url: "https://example.com/a", title: "A", referenceNumber: 1 },
    { url: "https://example.com/b", title: "B", referenceNumber: 4 },
  ],
};

test("the trailer carries search metadata and completion status together", () => {
  const raw = `Answer text${buildChatStreamTrailerChunk({
    searchMetadata: execution,
    completion: { status: "incomplete", incompleteReason: "length" },
  })}`;
  const { displayText, searchMetadataJson } = splitSearchMetadataTrailer(raw);
  assert.equal(displayText, "Answer text");
  const trailer = parseChatStreamTrailer(searchMetadataJson);
  assert.deepEqual(trailer.searchMetadata, execution);
  assert.deepEqual(trailer.completion, {
    status: "incomplete",
    incompleteReason: "length",
  });
});

test("a stop-finished turn reports a normal completion", () => {
  const trailer = parseChatStreamTrailer(
    splitSearchMetadataTrailer(
      buildChatStreamTrailerChunk({
        searchMetadata: execution,
        completion: { status: "normal" },
      })
    ).searchMetadataJson
  );
  assert.equal(trailer.completion.status, "normal");
  assert.equal(trailer.completion.incompleteReason, undefined);
});

test("a bare pre-envelope payload still yields its search metadata", () => {
  // What a client meets during a rolling deploy, or in a stored fixture.
  const trailer = parseChatStreamTrailer(
    splitSearchMetadataTrailer(buildSearchMetadataTrailerChunk(execution))
      .searchMetadataJson
  );
  assert.deepEqual(trailer.searchMetadata, execution);
  // No completion information is not the same as "it completed normally":
  // the caller decides that default, this parser never invents one.
  assert.equal(trailer.completion, undefined);
});

test("an unusable trailer never fabricates a status", () => {
  assert.equal(parseChatStreamTrailer(null), null);
  assert.equal(parseChatStreamTrailer("{not json"), null);
  assert.equal(parseChatStreamTrailer('"a string"'), null);
  const unknownStatus = parseChatStreamTrailer(
    JSON.stringify({ searchMetadata: execution, completion: { status: "weird" } })
  );
  assert.equal(unknownStatus.completion, undefined);
  assert.deepEqual(unknownStatus.searchMetadata, execution);
});
