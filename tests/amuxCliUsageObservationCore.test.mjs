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
const finishCodex = (observer, exitCode = 0, overrides = {}) => observer.finish({
  exitCode, stdoutComplete: true, freshEphemeralSession: true, ...overrides,
});
const inspectClaude = (raw, exitCode = 0, overrides = {}) =>
  inspectClaudeCliResultUsage(raw, {
    exitCode, stdoutComplete: true, freshPrintInvocation: true, ...overrides,
  });

test("Codex 0.155.1 single fresh turn preserves cache-write and reasoning categories", () => {
  const observer = createCodexCliUsageObserver();
  observer.observeLine("");
  observer.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  // A rollout turn_context names the configured model, not the provider's
  // served model. Even if it appears in the event stream, it is not proof.
  observer.observeLine(JSON.stringify({ type: "turn_context",
    payload: { model: "gpt-6-astra" } }));
  observer.observeLine(JSON.stringify({ type: "turn.started" }));
  observer.observeLine(codexTurn({
    ...codexUsage(100, 40, 10, 3), cache_write_input_tokens: 12,
  }));
  const result = finishCodex(observer);
  assert.equal(result.cli, "codex");
  assert.equal(result.completeness, "reported_complete");
  assert.equal(result.completedTurns, 1);
  assert.deepEqual(result.observed, {
    inputTokens: 100,
    outputTokens: 10,
    cacheReadInputTokens: 40,
    cacheCreationInputTokens: 12,
    reasoningOutputTokens: 3,
  });
  assert.equal(result.inputTokensIncludeCacheRead, true);
  assert.equal(result.inputTokensIncludeCacheWrite, null);
  assert.equal(result.reasoningOutputIncludedInOutput, true);
  assert.deepEqual(result.models, []);
  assert.strictEqual(finishCodex(observer), result);
});

test("Codex cannot confuse reverse order, duplicate completion or cumulative second turn with complete usage", () => {
  const reverse = createCodexCliUsageObserver();
  reverse.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  reverse.observeLine(codexTurn(codexUsage(100, 40, 10, 3)));
  reverse.observeLine(JSON.stringify({ type: "turn.started" }));
  assert.equal(finishCodex(reverse).completeness, "unknown");

  const duplicate = createCodexCliUsageObserver();
  duplicate.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  duplicate.observeLine(JSON.stringify({ type: "turn.started" }));
  duplicate.observeLine(codexTurn(codexUsage(100, 40, 10, 3)));
  duplicate.observeLine(codexTurn(codexUsage(100, 40, 10, 3)));
  assert.equal(finishCodex(duplicate).completeness, "unknown");

  const cumulative = createCodexCliUsageObserver();
  cumulative.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  cumulative.observeLine(JSON.stringify({ type: "turn.started" }));
  cumulative.observeLine(codexTurn(codexUsage(100, 40, 10, 3)));
  cumulative.observeLine(JSON.stringify({ type: "turn.started" }));
  cumulative.observeLine(codexTurn(codexUsage(300, 120, 30, 10)));
  const result = finishCodex(cumulative);
  assert.equal(result.completeness, "unknown");
  assert.equal(result.observed, null);
});

test("Codex unfinished or failed turns never claim a complete invocation", () => {
  const unfinished = createCodexCliUsageObserver();
  unfinished.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  unfinished.observeLine(JSON.stringify({ type: "turn.started" }));
  assert.equal(finishCodex(unfinished).completeness, "unknown");

  const failed = createCodexCliUsageObserver();
  failed.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  failed.observeLine(JSON.stringify({ type: "turn.started" }));
  failed.observeLine(codexTurn(codexUsage(4, 1, 2, 1)));
  failed.observeLine(JSON.stringify({ type: "error", message: "late failure" }));
  const result = finishCodex(failed, 1);
  assert.equal(result.completeness, "reported_partial");
  assert.equal(result.observed.inputTokens, 4);

  const missingStart = createCodexCliUsageObserver();
  missingStart.observeLine(codexTurn(codexUsage(4, 1, 2, 1)));
  assert.equal(finishCodex(missingStart).completeness, "unknown");

  const failedWithoutUsage = createCodexCliUsageObserver();
  failedWithoutUsage.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  failedWithoutUsage.observeLine(JSON.stringify({ type: "turn.started" }));
  failedWithoutUsage.observeLine(JSON.stringify({ type: "turn.failed" }));
  assert.equal(finishCodex(failedWithoutUsage, 1).completeness, "unknown");

  const retried = createCodexCliUsageObserver();
  retried.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
  retried.observeLine(JSON.stringify({ type: "turn.started" }));
  retried.observeLine(JSON.stringify({ type: "turn.failed" }));
  retried.observeLine(JSON.stringify({ type: "turn.started" }));
  retried.observeLine(codexTurn(codexUsage(4, 1, 2, 1)));
  assert.equal(finishCodex(retried).completeness, "reported_partial");
});

test("Codex malformed, oversized, negative, fractional or unsafe integer reports fail closed", () => {
  for (const lines of [
    ["{not-json"],
    [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.started" }), codexTurn(codexUsage(1, 2, 0, 0))],
    [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.started" }), codexTurn(codexUsage(1, 0, 1, 2))],
    [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.started" }), codexTurn(codexUsage(-1, 0, 0, 0))],
    [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.started" }), codexTurn(codexUsage(1.5, 0, 0, 0))],
    ["x".repeat(1_048_577)],
    [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.started" }),
      codexTurn(codexUsage(Number.MAX_SAFE_INTEGER + 1, 0, 0, 0))],
  ]) {
    const observer = createCodexCliUsageObserver();
    for (const line of lines) observer.observeLine(line);
    const result = finishCodex(observer);
    assert.equal(result.completeness, "unknown");
    assert.equal(result.observed, null);
  }
});

test("Codex zero/default, resumed or truncated reports cannot certify per-invocation tokens", () => {
  const makeObserver = (usage) => {
    const observer = createCodexCliUsageObserver();
    observer.observeLine(JSON.stringify({ type: "thread.started", thread_id: "opaque" }));
    observer.observeLine(JSON.stringify({ type: "turn.started" }));
    observer.observeLine(codexTurn(usage));
    return observer;
  };
  assert.equal(finishCodex(makeObserver(codexUsage(0, 0, 0, 0))).completeness, "unknown");
  assert.equal(finishCodex(makeObserver(codexUsage(9, 0, 2, 0)), 0, {
    freshEphemeralSession: false,
  }).observed, null);
  assert.equal(finishCodex(makeObserver(codexUsage(9, 0, 2, 0)), 0, {
    stdoutComplete: false,
  }).observed, null);
});

test("Claude result prefers per-model usage and does not double-count aggregate usage", () => {
  const result = inspectClaude({
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
  });
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
  assert.equal(result.inputTokensIncludeCacheRead, false);
  assert.equal(result.inputTokensIncludeCacheWrite, false);
});

test("Claude aggregate-only reports remain observable without inventing model attribution", () => {
  const result = inspectClaude({
    type: "result",
    subtype: "success",
    num_turns: 1,
    usage: {
      input_tokens: 42,
      output_tokens: 7,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 3,
    },
  });
  assert.equal(result.completeness, "reported_partial");
  assert.equal(result.observed.inputTokens, 42);
  assert.deepEqual(result.models, []);
});

test("Claude all-zero defaults never certify zero spend, while cache-only usage is observed", () => {
  const base = { type: "result", subtype: "success", num_turns: 1 };
  const zeroByModel = inspectClaude({
    ...base, modelUsage: { "claude-opus-test": claudeModel(0, 0, 0, 0) },
  });
  assert.equal(zeroByModel.completeness, "unknown");
  assert.equal(zeroByModel.observed, null);
  const zeroAggregate = inspectClaude({
    ...base,
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    },
  });
  assert.equal(zeroAggregate.completeness, "unknown");
  assert.equal(zeroAggregate.observed, null);
  const cacheOnly = inspectClaude({
    ...base, modelUsage: { "claude-opus-test": claudeModel(0, 0, 1, 0) },
  });
  assert.equal(cacheOnly.completeness, "reported_complete");
  assert.equal(cacheOnly.observed.cacheReadInputTokens, 1);
  assert.equal(inspectClaude({
    type: "result", subtype: "success",
    modelUsage: { "claude-opus-test": claudeModel(1, 1, 0, 0) },
  }).completeness, "reported_partial");
  assert.equal(inspectClaude({
    ...base, num_turns: 129,
    modelUsage: { "claude-opus-test": claudeModel(1, 1, 0, 0) },
  }).completeness, "reported_partial");
});

test("Claude failure with reported usage is partial; missing or invalid usage is unknown", () => {
  const raw = {
    type: "result", subtype: "error_during_execution", is_error: true,
    usage: {
      input_tokens: 42, output_tokens: 7,
      cache_read_input_tokens: 8, cache_creation_input_tokens: 3,
    },
  };
  assert.equal(inspectClaude(raw, 1).completeness, "reported_partial");
  assert.equal(inspectClaude(raw, 1).observed.inputTokens, 42);
  assert.equal(inspectClaude({ type: "result", subtype: "success" }).completeness, "unknown");
  assert.equal(inspectClaude({ ...raw, modelUsage: {} }, 1).completeness, "unknown");
  assert.equal(inspectClaude({ ...raw, usage: { ...raw.usage, output_tokens: -1 } }, 1).completeness, "unknown");
  assert.equal(inspectClaude({ type: "assistant", usage: raw.usage }).completeness, "unknown");
  assert.equal(inspectClaude(raw, 1, { stdoutComplete: false }).completeness, "unknown");
  assert.equal(inspectClaude(raw, 1, { freshPrintInvocation: false }).completeness, "unknown");
});

test("Claude rejects unsafe model identifiers and per-model accumulation overflow", () => {
  const base = { type: "result", subtype: "success", num_turns: 1 };
  assert.equal(inspectClaude({
    ...base, modelUsage: { "../../unsafe": claudeModel(1, 1, 0, 0) },
  }).completeness, "unknown");
  assert.equal(inspectClaude({
    ...base, modelUsage: { "bad model": claudeModel(1, 1, 0, 0) },
  }).completeness, "unknown");
  assert.equal(inspectClaude({
    ...base, modelUsage: {
      first: claudeModel(Number.MAX_SAFE_INTEGER, 1, 0, 0),
      second: claudeModel(1, 1, 0, 0),
    },
  }).completeness, "unknown");
});
