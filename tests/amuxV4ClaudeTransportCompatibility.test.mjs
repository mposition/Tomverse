import assert from "node:assert/strict";
import test from "node:test";
import { inspectAmuxV4AnalysisCliResult,
  planAmuxV4AnalysisCliInvocation } from "../lib/amux/ideaLocalCliContract.mjs";
import { inspectAmuxV4ClaudePassiveEvent } from
  "../lib/amux/ideaLocalClaudeTransportCore.mjs";

const modelId = "frontier-anthropic";
const plan = planAmuxV4AnalysisCliInvocation({ provider: "anthropic", modelId,
  reasoningEffort: "high" });
const init = { type: "system", subtype: "init", tools: [] };
const answer = { type: "assistant", message: { role: "assistant",
  content: [{ type: "text", text: "{}" }] } };
const result = { type: "result", subtype: "success", is_error: false,
  num_turns: 1, result: "{}", modelUsage: { [modelId]: { inputTokens: 10,
    outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
const encode = (events) => Buffer.from(events.map((event) =>
  JSON.stringify(event)).join("\n"));
const inspect = (events) => inspectAmuxV4AnalysisCliResult(plan,
  encode(events), 0, { diagnostic: true });
const notices = [
  { type: "system", subtype: "status", status: "requesting" },
  { type: "system", subtype: "ui_invalidate", event: "ui.render", instances: [] },
  { type: "system", subtype: "thinking_tokens", estimated_tokens: 50,
    estimated_tokens_delta: 10 },
  { type: "system", subtype: "turn_duration", durationMs: 100,
    messageCount: 1, pendingBackgroundAgentCount: 0, pendingWorkflowCount: 0 },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
];

for (const notice of notices) {
  test(`passive ${notice.subtype ?? notice.type} accepts neutral extensions at every post-init position`, () => {
    const extended = { ...notice, progress: 0.5, timestamp: "synthetic-time",
      telemetry: { version: 2, counters: [1, 2], nested: { value: null } } };
    for (const position of [1, 2, 3]) {
      assert.deepEqual(inspect([init, answer, result].toSpliced(position, 0,
        extended)), { kind: "verified_success", rawModelOutput: "{}",
        inputTokens: 10, outputTokens: 2 });
    }
  });

  test(`passive ${notice.subtype ?? notice.type} cannot conceal security or answer fields`, () => {
    for (const extra of [
      { tools: [] }, { tool_use: {} }, { command: "synthetic-command" },
      { content: "private-marker" }, { model: modelId }, { retry_count: 1 },
      { hook_result: {} }, { metadata: { nested: { permissionMode: "auto" } } },
      { metadata: [{ task_id: "child" }] }, { permission_mode: "bypassPermissions" },
      { permissionMode: "manual", permission_mode: "default" },
      { metadata: JSON.parse('{"__proto__":{}}') },
    ]) {
      const rejected = inspect([init, { ...notice, ...extra }, answer, result]);
      assert.equal(rejected.kind, "outcome_unknown");
      assert.equal(JSON.stringify(rejected).includes("private-marker"), false);
      assert.equal(JSON.stringify(rejected).includes("synthetic-command"), false);
    }
  });
}

test("estimated token telemetry never substitutes for terminal usage or model evidence", () => {
  for (const envelope of [
    { ...result, modelUsage: {} },
    { ...result, num_turns: 2 },
    { ...result, subtype: "error_during_execution", is_error: true },
    { ...result, modelUsage: { other_model: result.modelUsage[modelId] } },
  ]) {
    assert.equal(inspect([init, ...notices, answer, envelope]).kind,
      "outcome_unknown");
  }
  assert.equal(inspect([init, ...notices, answer]).kind, "outcome_unknown");
});

test("metadata cannot hide an active event before or after a valid terminal result", () => {
  for (const event of [
    { type: "system", subtype: "api_retry" },
    { type: "system", subtype: "permission_retry" },
    { type: "system", subtype: "hook_started" },
    { type: "system", subtype: "model_fallback" },
    { type: "system", subtype: "task_started" },
    { type: "system", subtype: "session_state_changed" },
    { type: "system", subtype: "future_system_event", progress: 1 },
    { type: "control_request" }, { type: "user" },
  ]) {
    for (const position of [1, 2, 3]) {
      assert.equal(inspect([init, answer, result].toSpliced(position, 0,
        event, notices[0])).kind, "outcome_unknown");
    }
  }
  assert.equal(inspect([init, ...notices, answer, result, result]).kind,
    "outcome_unknown");
  assert.equal(inspect([init, ...notices, init, answer, result]).kind,
    "outcome_unknown");
  assert.equal(inspect([init, ...notices, { ...answer, message: {
    role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
  result]).failureReason, "security_no_tools_violation");
});

test("passive metadata is bounded and malformed instrumentation cannot become evidence", () => {
  let nested = { value: 1 };
  for (let i = 0; i < 7; i++) nested = { nested };
  for (const event of [
    { ...notices[0], telemetry: nested },
    { ...notices[0], progress: "x".repeat(4_097) },
    { ...notices[0], counters: Array(65).fill(0) },
    { ...notices[0], progress: "x".repeat(8_192) },
    { ...notices[2], estimated_tokens: -1 },
    { ...notices[2], estimated_tokens_delta: 51 },
    { ...notices[3], durationMs: "100" },
    { ...notices[3], pendingBackgroundAgentCount: 1 },
    { ...notices[3], pendingWorkflowCount: 1 },
  ]) assert.equal(inspect([init, event, answer, result]).kind, "outcome_unknown");
  for (const event of notices.filter((event) => event.subtype !== "ui_invalidate")) {
    assert.equal(inspect([event, init, answer, result]).kind, "outcome_unknown");
  }
});

test("many progress notifications are compatible but do not create extra usage", () => {
  assert.deepEqual(inspect([init, ...Array.from({ length: 64 }, () =>
    notices[2]), answer, result]), { kind: "verified_success",
    rawModelOutput: "{}", inputTokens: 10, outputTokens: 2 });
  const privateText = "private marker in inert telemetry";
  assert.deepEqual(inspectAmuxV4ClaudePassiveEvent({ ...notices[0],
    extra_annotation: privateText }, { initSeen: true }), { kind: "passive" });
});
