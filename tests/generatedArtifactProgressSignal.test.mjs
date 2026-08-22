import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_PROGRESS_MARKER,
  buildArtifactProgressChunk,
  splitArtifactProgressSignal,
} from "../lib/generatedArtifactProgressSignal.ts";

// docs/policy/generated-artifacts.md section 5.

test("a stream with no marker is returned untouched", () => {
  const result = splitArtifactProgressSignal("Here is the summary.");
  assert.equal(result.text, "Here is the summary.");
  assert.equal(result.signal, null);
});

test("build and split round-trip without touching the visible text", () => {
  const raw = `${buildArtifactProgressChunk("xlsx")}Done. The file is attached.`;
  const result = splitArtifactProgressSignal(raw);
  assert.equal(result.text, "Done. The file is attached.");
  assert.deepEqual(result.signal, { state: "generating", format: "xlsx" });
});

test("the marker starts with NUL, which providers do not emit", () => {
  assert.equal(ARTIFACT_PROGRESS_MARKER.codePointAt(0), 0);
});

test("a marker reassembled from two reads is still removed", () => {
  // A stream is not delivered in the pieces it was written in, so the client
  // re-splits the whole accumulation on every pass.
  const chunk = buildArtifactProgressChunk("csv");
  const raw = `${chunk}tail`;
  const half = raw.slice(0, chunk.length - 6);
  // Mid-marker: nothing yet, and crucially no marker text rendered.
  assert.equal(splitArtifactProgressSignal(half).text, "");
  assert.equal(splitArtifactProgressSignal(raw).text, "tail");
  assert.equal(splitArtifactProgressSignal(raw).signal.format, "csv");
});

test("an unparseable payload is still removed, only its content is dropped", () => {
  // The failure that must never happen is the marker appearing as the first
  // words of an answer.
  const raw = `${ARTIFACT_PROGRESS_MARKER}{not json}visible`;
  const result = splitArtifactProgressSignal(raw);
  assert.ok(!result.text.includes("TOMVERSE_ARTIFACT_PROGRESS"));
  assert.equal(result.text, "visible");
  assert.equal(result.signal, null);
});

test("a payload naming a format with no generator is refused", () => {
  const raw = `${ARTIFACT_PROGRESS_MARKER}{"state":"generating","format":"psd"}x`;
  const result = splitArtifactProgressSignal(raw);
  assert.equal(result.signal, null);
  assert.equal(result.text, "x");
});

test("two markers leave the last signal and none of the text", () => {
  const raw =
    `${buildArtifactProgressChunk("xlsx")}first ` +
    `${buildArtifactProgressChunk("csv")}second`;
  const result = splitArtifactProgressSignal(raw);
  assert.equal(result.text, "first second");
  assert.equal(result.signal.format, "csv");
});
