import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSearchMetadataTrailerChunk,
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
