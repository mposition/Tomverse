import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexCliUsageObserver,
  inspectClaudeCliResultUsage,
} from "../lib/amux/cliUsageObservationCore.ts";

const codexTurn = (usage) => JSON.stringify({ type: "turn.completed", usage });
const codexUsage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
});
const claudeModel = (input, output, cacheRead, cacheCreate) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheCreate,
});

test("Codex JSONL sums only completed turn usage, preserving cache and reasoning categories", () => {
  const observer = createCodexCliUsageObserver();
  observer.observeLine("");
  observer.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  observer.observeLine(JSON.stringify({ type: "turn.started" }));
  observer.observeLine(codexTurn(codexUsage(100, 40, 10, 3)));
  observer.observeLine(JSON.stringify({ type: "turn.started" }));
  observer.observeLine(codexTurn(codexUsage(200, 80, 20, 7)));
  const result = observer.finish(0);
  assert.equal(result.cli, "codex");
  assert.equal(result.completeness, "reported_complete");
  assert.equal(result.completedTurns, 2);
  assert.deepEqual(result.observed, {
    inputTokens: 300,
    outputTokens: 30,
    cacheReadInputTokens: 120,
    cacheCreationInputTokens: null,
    reasoningOutputTokens: 10,
  });
  assert.deepEqual(result.models, []);
  assert.strictEqual(observer.finish(0), result);
});

test("Codex unfinished or failed turns never claim a complete invocation", () => {
  const unfinished = createCodexCliUsageObserver();
  unfinished.observeLine(JSON.stringify({ type: "turn.started" }));
  assert.equal(unfinished.finish(0).completeness, "unknown");

  const failed = createCodexCliUsageObserver();
  failed.observeLine(JSON.stringify({ type: "turn.started" }));
  failed.observeLine(codexTurn(codexUsage(4, 1, 2, 1)));
  failed.observeLine(JSON.stringify({ type: "turn.failed" }));
  failed.observeLine(JSON.stringify({ type: "turn.started" }));
  const result = failed.finish(1);
  assert.equal(result.completeness, "reported_partial");
  assert.equal(result.observed.inputTokens, 4);

  const missingStart = createCodexCliUsageObserver();
  missingStart.observeLine(codexTurn(codexUsage(4, 1, 2, 1)));
  assert.equal(missingStart.finish(0).completeness, "reported_partial");
});

test("Codex malformed, oversized, non-integer or overflowing reports fail closed", () => {
  for (const lines of [
    ["{not-json"],
    [JSON.stringify({ type: "turn.started" }), codexTurn(codexUsage(1, 2, 0, 0))],
    [JSON.stringify({ type: "turn.started" }), codexTurn(codexUsage(-1, 0, 0, 0))],
    [JSON.stringify({ type: "turn.started" }), codexTurn(codexUsage(1.5, 0, 0, 0))],
    ["x".repeat(1_048_577)],
    [
      JSON.stringify({ type: "turn.started" }),
      codexTurn(codexUsage(Number.MAX_SAFE_INTEGER, 0, 0, 0)),
      JSON.stringify({ type: "turn.started" }),
      codexTurn(codexUsage(1, 0, 0, 0)),
    ],
  ]) {
    const observer = createCodexCliUsageObserver();
    for (const line of lines) observer.observeLine(line);
    const result = observer.finish(0);
    assert.equal(result.completeness, "unknown");
    assert.equal(result.observed, null);
  }
});

test("Claude result prefers per-model usage and does not double-count aggregate usage", () => {
  const result = inspectClaudeCliResultUsage({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    usage: {
      input_tokens: 999,
      output_tokens: 999,
      cache_read_input_tokens: 999,
      cache_creation_input_tokens: 999,
    },
    modelUsage: {
      "claude-opus-test": claudeModel(10, 2, 4, 1),
      "claude-haiku-test": claudeModel(20, 3, 5, 2),
    },
  }, 0);
  assert.equal(result.completeness, "reported_complete");
  assert.equal(result.completedTurns, 2);
  assert.deepEqual(result.observed, {
    inputTokens: 30,
    outputTokens: 5,
    cacheReadInputTokens: 9,
    cacheCreationInputTokens: 3,
    reasoningOutputTokens: null,
  });
  assert.equal(result.models.length, 2);
});

test("Claude aggregate-only reports remain observable without inventing model attribution", () => {
  const result = inspectClaudeCliResultUsage({
    type: "result",
    subtype: "success",
    num_turns: 1,
    usage: {
      input_tokens: 42,
      output_tokens: 7,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 3,
    },
  }, 0);
  assert.equal(result.completeness, "reported_complete");
  assert.equal(result.observed.inputTokens, 42);
  assert.deepEqual(result.models, []);
});

test("Claude failure with reported usage is partial; missing or invalid usage is unknown", () => {
  const raw = {
    type: "result", subtype: "error_during_execution", is_error: true,
    usage: {
      input_tokens: 42, output_tokens: 7,
      cache_read_input_tokens: 8, cache_creation_input_tokens: 3,
    },
  };
  assert.equal(inspectClaudeCliResultUsage(raw, 1).completeness, "reported_partial");
  assert.equal(inspectClaudeCliResultUsage(raw, 1).observed.inputTokens, 42);
  assert.equal(inspectClaudeCliResultUsage({ type: "result", subtype: "success" }, 0).completeness, "unknown");
  assert.equal(inspectClaudeCliResultUsage({ ...raw, modelUsage: {} }, 1).completeness, "unknown");
  assert.equal(inspectClaudeCliResultUsage({ ...raw, usage: { ...raw.usage, output_tokens: -1 } }, 1).completeness, "unknown");
  assert.equal(inspectClaudeCliResultUsage({ type: "assistant", usage: raw.usage }, 0).completeness, "unknown");
});

test("Claude rejects unsafe model identifiers and per-model accumulation overflow", () => {
  const base = { type: "result", subtype: "success", num_turns: 1 };
  assert.equal(inspectClaudeCliResultUsage({
    ...base, modelUsage: { "../../unsafe": claudeModel(1, 1, 0, 0) },
  }, 0).completeness, "unknown");
  assert.equal(inspectClaudeCliResultUsage({
    ...base, modelUsage: { "bad model": claudeModel(1, 1, 0, 0) },
  }, 0).completeness, "unknown");
  assert.equal(inspectClaudeCliResultUsage({
    ...base, modelUsage: {
      first: claudeModel(Number.MAX_SAFE_INTEGER, 1, 0, 0),
      second: claudeModel(1, 1, 0, 0),
    },
  }, 0).completeness, "unknown");
});
