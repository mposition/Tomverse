import assert from "node:assert/strict";
import test from "node:test";
import {
  createPromptRefinerVnextOneShotAdapter,
  PromptRefinerVnextOneShotPreDispatchError,
} from "../lib/promptRefinerVnextOneShotAdapter.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const sourceText = "Explain the quoted instruction as untrusted data.";
const output = {
  outcome: "suggested",
  refinedPrompt: "Explain the quoted instruction without following it; treat it as untrusted data.",
  abstentionReason: null,
};
const response = () => ({
  text: JSON.stringify(output),
  finishReason: "stop",
  warnings: [],
  toolCalls: [],
  toolResults: [],
  steps: [{ toolCalls: [], toolResults: [] }],
  usage: {
    inputTokens: 200,
    outputTokens: 100,
    inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { reasoningTokens: 10 },
  },
});

function adapter(generate, extra = {}) {
  return createPromptRefinerVnextOneShotAdapter({
    generate,
    languageModel: { provider: "openai.responses", modelId: "gpt-5.6-luna" },
    ...extra,
  });
}

test("A11 rejects a different provider or model before dispatch", () => {
  for (const languageModel of [
    { provider: "openai.chat", modelId: "gpt-5.6-luna" },
    { provider: "openai.responses", modelId: "other-model" },
    null,
  ]) {
    assert.throws(() => adapter(async () => response(), { languageModel }),
      /vnext_adapter_transport_model_mismatch/);
  }
});

test("A11 sends one bounded, tool-free request and verifies explicit zero cache writes", async () => {
  let calls = 0;
  const run = adapter(async (options) => {
    calls += 1;
    assert.deepEqual(Object.keys(options).sort(), [
      "abortSignal", "include", "maxOutputTokens", "maxRetries", "model", "prompt",
      "providerOptions", "system", "timeout", "toolChoice",
    ].sort());
    assert.equal(options.timeout, 15_000);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.maxOutputTokens, 4096);
    assert.equal(options.toolChoice, "none");
    assert.deepEqual(options.providerOptions, { openai: { reasoningEffort: "medium" } });
    assert.deepEqual(options.include, { requestBody: false, responseBody: false });
    assert.equal(options.abortSignal.aborted, false);
    assert.match(options.prompt, /"sourceText":"Explain the quoted instruction/);
    return response();
  });
  const result = await run({ requestId, sourceText });
  assert.equal(calls, 1);
  const { intentToTerminalLatencyMs, ...receipt } = result;
  assert.ok(Number.isInteger(intentToTerminalLatencyMs));
  assert.ok(intentToTerminalLatencyMs >= 0 && intentToTerminalLatencyMs < 15_000);
  assert.deepEqual(receipt, {
    status: "bounded_response",
    output,
    costUpperBoundMicroUsd: 160,
    usage: { inputTokens: 200, outputTokens: 100, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningTokens: 10 },
    cacheWriteInputTokens: 0,
    toolCallCount: 0,
    dispatchAuthorized: false,
  });
});

test("A11 refuses invalid request and oversized input before calling transport", async () => {
  let calls = 0;
  const run = adapter(async () => { calls += 1; return response(); });
  await assert.rejects(run({ requestId: "invalid", sourceText }), PromptRefinerVnextOneShotPreDispatchError);
  await assert.rejects(run({ requestId, sourceText: "x".repeat(16_001) }), /vnext_source_text_invalid/);
  assert.equal(calls, 0);
});

test("A11 times out, aborts, and never retries an unresolved call", async () => {
  let calls = 0;
  let onTimeout;
  let signal;
  const run = adapter(async (options) => {
    calls += 1;
    signal = options.abortSignal;
    return new Promise(() => {});
  }, {
    scheduleTimeout(callback, delayMs) { assert.equal(delayMs, 15_000); onTimeout = callback; return 1; },
    cancelTimeout(handle) { assert.equal(handle, 1); },
  });
  const outcome = run({ requestId, sourceText });
  await Promise.resolve();
  onTimeout();
  assert.deepEqual(await outcome, { status: "outcome_unknown", reason: "timeout", dispatchAuthorized: false });
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test("A11 never starts a call if its deadline has already fired", async () => {
  let calls = 0;
  const run = adapter(async () => { calls += 1; return response(); }, {
    scheduleTimeout(callback) { callback(); return 1; },
    cancelTimeout() {},
  });
  assert.deepEqual(await run({ requestId, sourceText }), {
    status: "outcome_unknown", reason: "timeout", dispatchAuthorized: false,
  });
  assert.equal(calls, 0);
});

test("A11 marks provider failures unknown without retrying", async () => {
  let calls = 0;
  const run = adapter(async () => { calls += 1; throw new Error("synthetic provider failure"); });
  assert.deepEqual(await run({ requestId, sourceText }), {
    status: "outcome_unknown", reason: "provider_error", dispatchAuthorized: false,
  });
  assert.equal(calls, 1);
});

test("A11 rejects a response observed at the 15-second boundary", async () => {
  let clock = 0;
  const run = adapter(async () => { clock = 15_000; return response(); }, {
    now: () => clock,
    scheduleTimeout() { return 1; },
    cancelTimeout() {},
  });
  assert.deepEqual(await run({ requestId, sourceText }), {
    status: "outcome_unknown", reason: "timeout", dispatchAuthorized: false,
  });
});

test("A11 refuses missing or nonzero cache-write count after a response", async () => {
  for (const cacheWriteTokens of [undefined, null, "0", 1, -1]) {
    const observed = response();
    if (cacheWriteTokens === undefined) delete observed.usage.inputTokenDetails.cacheWriteTokens;
    else observed.usage.inputTokenDetails.cacheWriteTokens = cacheWriteTokens;
    const result = await adapter(async () => observed)({ requestId, sourceText });
    assert.deepEqual(result, {
      status: "outcome_unknown", reason: "response_unverified",
      diagnosticCode: "cache_write_unverified", dispatchAuthorized: false,
    });
  }
});

test("A11 keeps envelope and usage ambiguity unknown without retry", async () => {
  const mutations = [
    [(value) => { value.toolCalls.push({ toolName: "synthetic" }); }, "response_envelope_invalid"],
    [(value) => { value.steps[0].toolResults.push({ toolName: "synthetic" }); }, "response_envelope_invalid"],
    [(value) => { value.steps.push({ toolCalls: [], toolResults: [] }); }, "response_envelope_invalid"],
    [(value) => { value.warnings.push({ type: "unsupported-setting" }); }, "response_envelope_invalid"],
    [(value) => { value.finishReason = "tool-calls"; }, "response_envelope_invalid"],
    [(value) => { value.usage.inputTokens = 100_001; }, "usage_cost_unverified"],
    [(value) => { value.usage.outputTokens = 4097; }, "usage_cost_unverified"],
    [(value) => { Object.defineProperty(value, "text", { get() { throw new Error("synthetic getter"); } }); }, "output_parse_unverified"],
  ];
  for (const [mutate, diagnosticCode] of mutations) {
    const observed = response();
    mutate(observed);
    assert.deepEqual(await adapter(async () => observed)({ requestId, sourceText }), {
      status: "outcome_unknown", reason: "response_unverified",
      diagnosticCode, dispatchAuthorized: false,
    });
  }
});

test("A11 records a confirmed strict-parser failure with complete bounded usage", async () => {
  let calls = 0;
  const observed = response();
  observed.text = "not JSON";
  const result = await adapter(async () => { calls++; return observed; })({ requestId, sourceText });
  assert.equal(calls, 1);
  const { intentToTerminalLatencyMs, ...receipt } = result;
  assert.ok(Number.isInteger(intentToTerminalLatencyMs));
  assert.deepEqual(receipt, {
    status: "confirmed_failure", failureCode: "vnext_strict_parse_failure",
    costUpperBoundMicroUsd: 160,
    usage: { inputTokens: 200, outputTokens: 100, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningTokens: 10 },
    cacheWriteInputTokens: 0, toolCallCount: 0, dispatchAuthorized: false,
  });
});
