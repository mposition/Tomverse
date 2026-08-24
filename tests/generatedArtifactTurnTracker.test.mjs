import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactToolCallTracker } from "../lib/generatedArtifactTurnTracker.ts";
import {
  ARTIFACT_TOOL_NAMES,
  CREATE_DOCUMENT_BATCH_TOOL_NAME,
  artifactKindForToolName,
} from "../lib/generatedArtifactTool.ts";

/**
 * Which begun tool calls a truncated turn still owes the user a card for.
 *
 * docs/policy/generated-artifacts.md sections 1 and 9. The failure this
 * tracks is not hypothetical: Claude Haiku 4.5 wrote "이제 웹페이지를
 * 만들겠습니다:", began a `create_text_file` call, ran out of output tokens
 * mid-input, and the turn ended with a generic length notice and no card at
 * all. The provider says nothing about the call except that it started, so
 * that one fact is the whole of what has to be kept.
 */

const REGISTERED = [
  ...Object.values(ARTIFACT_TOOL_NAMES),
  CREATE_DOCUMENT_BATCH_TOOL_NAME,
];

const tracker = (names = REGISTERED) => new ArtifactToolCallTracker(names);

const inputStart = (toolCallId, toolName, extra = {}) => ({
  type: "tool-input-start",
  toolCallId,
  toolName,
  ...extra,
});

/* -------------------------------------------------------------------------- */
/* The case this exists for                                                     */
/* -------------------------------------------------------------------------- */

test("a call that starts and never executes is abandoned", () => {
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "create_text_file"));

  assert.equal(seen.startedAnyCall, true);
  assert.deepEqual(seen.abandonedCalls(), [
    { toolCallId: "call_1", toolName: "create_text_file" },
  ]);
});

test("a call that reaches its tool is not abandoned", () => {
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "create_text_file"));
  seen.noteExecutionStarted("call_1");

  assert.deepEqual(seen.abandonedCalls(), []);
});

test("both execution signals firing for one call is still one call", () => {
  // The SDK's `onToolExecutionStart` and the tool's own `execute` report the
  // same fact, deliberately. Two reports must not become two of anything.
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "create_spreadsheet"));
  seen.noteExecutionStarted("call_1");
  seen.noteExecutionStarted("call_1");

  assert.deepEqual(seen.abandonedCalls(), []);
});

test("an execution with no matching start frame is harmless", () => {
  // A provider that never emits `tool-input-start` still executes tools. It
  // simply has no abandoned calls to report, which is the safe direction:
  // this never invents a card, it only keeps one from going missing.
  const seen = tracker();
  seen.noteExecutionStarted("call_1");

  assert.equal(seen.startedAnyCall, false);
  assert.deepEqual(seen.abandonedCalls(), []);
});

test("one abandoned call among several executed ones is the only one reported", () => {
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "create_spreadsheet"));
  seen.noteChunk(inputStart("call_2", "create_document"));
  seen.noteChunk(inputStart("call_3", "create_text_file"));
  seen.noteExecutionStarted("call_1");
  seen.noteExecutionStarted("call_2");

  assert.deepEqual(
    seen.abandonedCalls().map((call) => call.toolName),
    ["create_text_file"]
  );
});

test("abandoned calls keep the order the model began them in", () => {
  const seen = tracker();
  seen.noteChunk(inputStart("call_a", "create_document"));
  seen.noteChunk(inputStart("call_b", "create_spreadsheet"));

  assert.deepEqual(
    seen.abandonedCalls().map((call) => call.toolCallId),
    ["call_a", "call_b"]
  );
});

/* -------------------------------------------------------------------------- */
/* What must never be counted as a missing file                                 */
/* -------------------------------------------------------------------------- */

test("a native search tool is never an abandoned artifact", () => {
  // `web_search` and `google_search` emit `tool-input-start` exactly like an
  // application tool does. A search cut off by the output ceiling is not a
  // file the user was promised, and a card claiming otherwise would be the
  // app inventing work it never offered to do.
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "web_search"));
  seen.noteChunk(inputStart("call_2", "google_search"));

  assert.equal(seen.startedAnyCall, false);
  assert.deepEqual(seen.abandonedCalls(), []);
});

test("a provider-executed tool is ignored even under a name this app uses", () => {
  const seen = tracker();
  seen.noteChunk(
    inputStart("call_1", "create_text_file", { providerExecuted: true })
  );

  assert.deepEqual(seen.abandonedCalls(), []);
});

test("a tool this request did not register is ignored", () => {
  // The allowlist is the registered set for *this* turn, so a turn without
  // the batch tool cannot report one.
  const seen = tracker(Object.values(ARTIFACT_TOOL_NAMES));
  seen.noteChunk(inputStart("call_1", CREATE_DOCUMENT_BATCH_TOOL_NAME));

  assert.deepEqual(seen.abandonedCalls(), []);
});

test("nothing but tool-input-start is read", () => {
  const seen = tracker();
  // Above all the delta frames: they carry the model's half-written
  // specification, and this tracker never looks at one.
  seen.noteChunk({
    type: "tool-input-delta",
    toolCallId: "call_1",
    inputTextDelta: '{"filename":"report.html","content":"<!doctype html>',
  });
  seen.noteChunk({ type: "text-delta", text: "이제 웹페이지를 만들겠습니다:" });
  seen.noteChunk({ type: "finish", finishReason: "length" });

  assert.equal(seen.startedAnyCall, false);
  assert.deepEqual(seen.abandonedCalls(), []);
});

test("a malformed chunk is ignored rather than thrown on", () => {
  const seen = tracker();
  for (const chunk of [
    null,
    undefined,
    "tool-input-start",
    42,
    {},
    { type: "tool-input-start" },
    { type: "tool-input-start", toolCallId: "call_1" },
    { type: "tool-input-start", toolName: "create_text_file" },
    { type: "tool-input-start", toolCallId: "", toolName: "create_text_file" },
    { type: "tool-input-start", toolCallId: 7, toolName: "create_text_file" },
  ]) {
    seen.noteChunk(chunk);
  }

  assert.equal(seen.startedAnyCall, false);
});

test("a repeated start frame describes one call, not two", () => {
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "create_text_file"));
  seen.noteChunk(inputStart("call_1", "create_text_file"));

  assert.equal(seen.abandonedCalls().length, 1);
});

test("an execution signal with no id changes nothing", () => {
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "create_text_file"));
  seen.noteExecutionStarted(undefined);
  seen.noteExecutionStarted("");

  assert.equal(seen.abandonedCalls().length, 1);
});

test("reset forgets a displaced attempt's calls", () => {
  const seen = tracker();
  seen.noteChunk(inputStart("call_1", "create_text_file"));
  seen.reset();

  assert.equal(seen.startedAnyCall, false);
  assert.deepEqual(seen.abandonedCalls(), []);
});

/* -------------------------------------------------------------------------- */
/* The kind a nameless call is labelled with                                    */
/* -------------------------------------------------------------------------- */

test("every registered tool name maps to a kind", () => {
  // A truncated call has no admitted format and no filename, so the card is
  // labelled from its kind. A name with no kind would draw no card at all.
  for (const name of REGISTERED) {
    assert.ok(artifactKindForToolName(name), name);
  }
});

test("the batch tool is labelled as the archive it would have produced", () => {
  assert.equal(
    artifactKindForToolName(CREATE_DOCUMENT_BATCH_TOOL_NAME),
    "archive"
  );
});

test("a name this build does not know has no kind", () => {
  assert.equal(artifactKindForToolName("web_search"), null);
  assert.equal(artifactKindForToolName("create_hologram"), null);
});
