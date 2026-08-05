import assert from "node:assert/strict";
import test from "node:test";
import {
  isChatCompletionStatus,
  isLengthRawFinishReason,
  resolveChatCompletionOutcome,
} from "../lib/chatCompletionStatus.ts";

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
