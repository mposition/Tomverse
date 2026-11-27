import assert from "node:assert/strict";
import test from "node:test";
import {
  isChatCompletionStatus,
  isChatIncompleteReason,
  isLengthRawFinishReason,
  resolveChatCompletionOutcome,
} from "@tomverse/chat-core";

test("a normal stop is a normal completion", () => {
  assert.deepEqual(
    resolveChatCompletionOutcome({ finishReason: "stop", rawFinishReason: "stop" }),
    { status: "normal" }
  );
});

test("the unified length finish reason marks the answer incomplete", () => {
  assert.deepEqual(
    resolveChatCompletionOutcome({ finishReason: "length" }),
    { status: "incomplete", incompleteReason: "length" }
  );
});

test("a provider raw limit reason counts even when the unified reason does not", () => {
  // The generic OpenAI-compatible adapter several providers run through can
  // report a limit the unified mapper renders as "other"/"unknown"; that must
  // never be presented as a finished answer.
  for (const raw of [
    "length",
    "max_tokens",
    "MAX_TOKENS",
    "max-output-tokens",
    "max_completion_tokens",
    "model_length",
  ]) {
    assert.equal(isLengthRawFinishReason(raw), true, raw);
    assert.deepEqual(
      resolveChatCompletionOutcome({ finishReason: "other", rawFinishReason: raw }),
      { status: "incomplete", incompleteReason: "length" },
      raw
    );
  }
});

test("unrelated finish reasons are never mistaken for a length cut-off", () => {
  for (const raw of [
    "stop",
    "tool_calls",
    "content_filter",
    "end_turn",
    "STOP",
    "",
    undefined,
    null,
  ]) {
    assert.equal(isLengthRawFinishReason(raw), false, String(raw));
  }
  assert.deepEqual(
    resolveChatCompletionOutcome({
      finishReason: "content-filter",
      rawFinishReason: "content_filter",
    }),
    { status: "normal" }
  );
});

test("a missing finish reason stays a normal completion", () => {
  assert.deepEqual(resolveChatCompletionOutcome({}), { status: "normal" });
});

test("only the two persisted completion statuses are recognised", () => {
  assert.equal(isChatCompletionStatus("normal"), true);
  assert.equal(isChatCompletionStatus("incomplete"), true);
  // cancelled/error/pending are decided elsewhere and keep their own meaning.
  for (const value of ["cancelled", "error", "pending", "", null, undefined, 1]) {
    assert.equal(isChatCompletionStatus(value), false, String(value));
  }
});

// S2. The AI SDK (7.0.176) does not throw from `textStream` when a provider
// sends an error part mid-stream: the text stream closes, and the finish
// reason resolves as `error` -- or `interrupted` for a stream that ended
// without its completion signal. A later step with no output rejects the
// finish metadata instead (`streamFailed`). None of these is a finished answer.
test("a stream that ended on an error part is an interrupted answer", () => {
  assert.deepEqual(resolveChatCompletionOutcome({ finishReason: "error" }), {
    status: "incomplete",
    incompleteReason: "interrupted",
  });
  assert.deepEqual(resolveChatCompletionOutcome({ finishReason: "interrupted" }), {
    status: "incomplete",
    incompleteReason: "interrupted",
  });
});

test("rejected finish metadata is an interrupted answer", () => {
  assert.deepEqual(
    resolveChatCompletionOutcome({ finishReason: "unknown", streamFailed: true }),
    { status: "incomplete", incompleteReason: "interrupted" }
  );
});

test("the output ceiling wins over an interruption, and ordinary ends stay normal", () => {
  assert.deepEqual(
    resolveChatCompletionOutcome({ finishReason: "error", rawFinishReason: "max_tokens", streamFailed: true }),
    { status: "incomplete", incompleteReason: "length" }
  );
  for (const finishReason of ["stop", "tool-calls", "content-filter", "other", "unknown"]) {
    assert.deepEqual(resolveChatCompletionOutcome({ finishReason }), { status: "normal" }, finishReason);
  }
});

test("only the two incomplete reasons are recognised", () => {
  assert.equal(isChatIncompleteReason("length"), true);
  assert.equal(isChatIncompleteReason("interrupted"), true);
  for (const value of ["error", "cancelled", "", null, undefined]) {
    assert.equal(isChatIncompleteReason(value), false, String(value));
  }
});
