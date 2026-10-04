import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { inspectAmuxV4AnalysisCliResult,
  planAmuxV4AnalysisCliInvocation } from "../lib/amux/ideaLocalCliContract.mjs";
import { amuxV4CodexNoToolsCatalogJson,
  amuxV4CodexNoToolsConfigArgs } from
  "../lib/amux/ideaLocalCodexNoToolsCore.mjs";

const openai = { provider: "openai", modelId: "frontier-openai",
  reasoningEffort: "high" };
const anthropic = { provider: "anthropic", modelId: "frontier-anthropic",
  reasoningEffort: "high" };

test("provider-to-command plan is exact, shell-free and never infers a fallback model", () => {
  const codex = planAmuxV4AnalysisCliInvocation(openai);
  const claude = planAmuxV4AnalysisCliInvocation(anthropic);
  assert.equal(codex.command[0], "/run/amux-cli/codex");
  assert.deepEqual(codex.command.slice(1, 3), ["--ask-for-approval", "never"]);
  const pinnedPrefix = ["/run/amux-cli/codex", "--ask-for-approval", "never",
    ...amuxV4CodexNoToolsConfigArgs(),
    "-c", 'model_reasoning_effort="high"',
    "-c", 'shell_environment_policy.inherit="none"', "exec"];
  assert.deepEqual(codex.command.slice(0, pinnedPrefix.length), pinnedPrefix);
  assert.ok(codex.command.includes("exec"));
  assert.ok(codex.command.includes("model_catalog_json=\"/run/amux-cli/model-catalog.json\""));
  assert.ok(codex.command.includes("tools.experimental_request_user_input.enabled=false"));
  assert.ok(codex.command.includes("shell_tool"));
  assert.ok(codex.command.includes("--ephemeral"));
  assert.ok(codex.command.includes("--ignore-user-config"));
  assert.ok(codex.command.includes("--ignore-rules"));
  assert.deepEqual(codex.command.slice(-1), ["-"]);
  assert.ok(codex.command.includes(openai.modelId));
  assert.equal(claude.command[0], "/run/amux-cli/claude");
  assert.ok(claude.command.includes("--safe-mode"));
  assert.ok(claude.command.includes("--restricted"));
  assert.ok(claude.command.includes("--no-session-persistence"));
  assert.ok(claude.command.includes("stream-json"));
  assert.ok(claude.command.includes("--verbose"));
  assert.equal(claude.command.includes("--max-turns"), false);
  assert.deepEqual(claude.command.slice(-4), ["--model", anthropic.modelId,
    "--effort", anthropic.reasoningEffort]);
  assert.equal(planAmuxV4AnalysisCliInvocation({ ...openai,
    modelId: "model; curl example.com" }), null);
  assert.equal(planAmuxV4AnalysisCliInvocation({ ...openai,
    provider: "xai" }), null);
  assert.equal(planAmuxV4AnalysisCliInvocation({ ...openai,
    extra: "fallback" }), null);
  assert.equal(planAmuxV4AnalysisCliInvocation({ ...openai,
    reasoningEffort: "unverified" }), null);
  assert.throws(() => codex.command.push("bad"), TypeError);
  const catalog = JSON.parse(amuxV4CodexNoToolsCatalogJson(openai.modelId));
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].slug, openai.modelId);
  assert.equal(catalog.models[0].shell_type, "disabled");
  assert.equal(catalog.models[0].apply_patch_tool_type, null);
  assert.deepEqual(catalog.models[0].experimental_supported_tools, []);
  assert.equal(catalog.models[0].tool_mode, "direct");
});

const claudeEnvelope = (modelId = anthropic.modelId) => ({
  type: "result", subtype: "success", is_error: false, num_turns: 1,
  result: '{"schemaVersion":2,"previewId":"preview_1"}',
  modelUsage: { [modelId]: { inputTokens: 10, outputTokens: 2,
    cacheReadInputTokens: 3, cacheCreationInputTokens: 1 } },
});
const claudeStream = (envelope = claudeEnvelope(), tools = [],
  content = [{ type: "text", text: envelope.result }]) => Buffer.from([
  { type: "system", subtype: "init", tools },
  { type: "assistant", message: { role: "assistant", content } },
  envelope,
].map((event) => JSON.stringify(event)).join("\n"));

test("Claude result needs exact served model and complete usage", () => {
  const plan = planAmuxV4AnalysisCliInvocation(anthropic);
  const completed = inspectAmuxV4AnalysisCliResult(plan,
    claudeStream(), 0);
  assert.deepEqual(completed, { kind: "verified_success",
    rawModelOutput: claudeEnvelope().result, inputTokens: 14, outputTokens: 2 });
  for (const sample of [
    claudeEnvelope("different-model"),
    { ...claudeEnvelope(), num_turns: 2 },
    { ...claudeEnvelope(), modelUsage: { [anthropic.modelId]:
      claudeEnvelope().modelUsage[anthropic.modelId], helper: {
        inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0 } } },
    { ...claudeEnvelope(), result: "x".repeat(65_537) },
    { ...claudeEnvelope(), modelUsage: {} },
  ]) {
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
      claudeStream(sample), 0), { kind: "outcome_unknown" });
  }
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    claudeStream(), 1), { kind: "outcome_unknown" });
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from([0xff]), 0), { kind: "outcome_unknown" });
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    claudeStream(claudeEnvelope(), ["Bash"]), 0), { kind: "outcome_unknown" });
  for (const initOverride of [
    { mcp_servers: [{ name: "external" }] },
    { mcp_servers: "not-an-array" },
    { skills: [{ name: "project-skill" }] },
    { plugins: [{ name: "external-plugin" }] },
    { agents: [{ name: "helper" }] },
    { permissionMode: "bypassPermissions" },
    { permission_mode: "bypassPermissions" },
  ]) {
    const events = [
      { type: "system", subtype: "init", tools: [], ...initOverride },
      { type: "assistant", message: { role: "assistant",
        content: [{ type: "text", text: "answer" }] } },
      claudeEnvelope(),
    ];
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
      Buffer.from(events.map((event) => JSON.stringify(event)).join("\n")), 0),
    { kind: "outcome_unknown" });
  }
  const unsafeStop = [
    { type: "system", subtype: "init", tools: [] },
    { type: "assistant", message: { role: "assistant",
      stop_reason: "tool_use", content: [{ type: "text", text: "answer" }] } },
    claudeEnvelope(),
  ];
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from(unsafeStop.map((event) => JSON.stringify(event)).join("\n")), 0),
  { kind: "outcome_unknown" });
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    claudeStream(claudeEnvelope(), [], [{ type: "tool_use", name: "Read" }]), 0),
  { kind: "outcome_unknown" });
  const multiAssistant = Buffer.from([
    { type: "system", subtype: "init", tools: [] },
    { type: "assistant", message: { role: "assistant",
      content: [{ type: "redacted_thinking", data: "opaque" }] } },
    { type: "assistant", message: { role: "assistant",
      content: [{ type: "text", text: "answer" }] } },
    claudeEnvelope(),
  ].map((event) => JSON.stringify(event)).join("\n"));
  assert.equal(inspectAmuxV4AnalysisCliResult(plan, multiAssistant, 0).kind,
    "verified_success");
});

test("Claude parser diagnostic separates safe failure reasons without raw text", () => {
  const plan = planAmuxV4AnalysisCliInvocation(anthropic);
  const maxTokens = Buffer.from([
    { type: "system", subtype: "init", tools: [] },
    { type: "assistant", message: { role: "assistant",
      stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] } },
    claudeEnvelope(),
  ].map((event) => JSON.stringify(event)).join("\n"));
  const duplicateInit = Buffer.from([
    { type: "system", subtype: "init", tools: [] },
    { type: "system", subtype: "init", tools: [] },
    { type: "assistant", message: { role: "assistant",
      content: [{ type: "text", text: "answer" }] } }, claudeEnvelope(),
  ].map((event) => JSON.stringify(event)).join("\n"));
  const samples = [
    [claudeStream(claudeEnvelope(), ["Bash"]), "security_no_tools_violation"],
    [claudeStream(claudeEnvelope("different-model")), "served_model_mismatch"],
    [claudeStream({ ...claudeEnvelope(), modelUsage: {} }), "usage_unverified"],
    [Buffer.from("not-json"), "incomplete_output"],
    [claudeStream({ ...claudeEnvelope(), num_turns: 2 }),
      "output_contract_mismatch", "turn_count"],
    [maxTokens, "output_contract_mismatch", "assistant_stop"],
    [duplicateInit, "output_contract_mismatch", "init_shape"],
    [Buffer.from(JSON.stringify({ type: "rate_limit_event" })),
      "output_contract_mismatch", "unexpected_event"],
  ];
  for (const [stdout, failureReason, rejectionPoint] of samples) {
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0,
      { diagnostic: true }), { kind: "outcome_unknown", failureReason,
      ...(rejectionPoint ? { rejectionPoint } : {}) });
  }
});

test("Claude S0 diagnostic reports only bounded unexpected event type and phase", () => {
  const plan = planAmuxV4AnalysisCliInvocation(anthropic);
  const init = { type: "system", subtype: "init", tools: [] };
  const assistant = { type: "assistant", message: { role: "assistant",
    content: [{ type: "text", text: "S0_OK" }] } };
  for (const [events, expectedType, expectedPhase] of [
    [[{ type: "rate_limit_event", secret: "must not leak" }],
      "rate_limit_event", "before_init"],
    [[init, { type: "stream_event" }], "stream_event", "after_init"],
    [[init, assistant, { type: "user" }], "user", "after_assistant"],
    [[init, assistant, claudeEnvelope(), { type: "future_secret_type" }],
      "other", "after_result"],
  ]) {
    const stdout = Buffer.from(events.map((event) => JSON.stringify(event))
      .join("\n"));
    const expected = { kind: "outcome_unknown",
      failureReason: "output_contract_mismatch",
      rejectionPoint: "unexpected_event",
      unexpectedEventType: expectedType,
      unexpectedEventPhase: expectedPhase };
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0,
      { diagnostic: true, syntheticEventType: true }), expected);
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0,
      { diagnostic: true }), { kind: "outcome_unknown",
      failureReason: "output_contract_mismatch",
      rejectionPoint: "unexpected_event" });
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0),
      { kind: "outcome_unknown" });
  }
});

test("Claude S0 pre-init system diagnostic exposes no free-form event data", () => {
  const plan = planAmuxV4AnalysisCliInvocation(anthropic);
  for (const [event, subtype, capabilities, freeText] of [
    [{ type: "system", subtype: "status", status: "compacting" },
      "status", false, false],
    [{ type: "system", subtype: "secret_credential_value", tools: ["Bash"],
      message: "must not leak" }, "other", true, true],
    [{ type: "system", subtype: "hook_started", mcp_servers: [] },
      "hook_started", true, false],
  ]) {
    const stdout = Buffer.from(JSON.stringify(event));
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0,
      { diagnostic: true, syntheticEventType: true }), {
      kind: "outcome_unknown", failureReason: "output_contract_mismatch",
      rejectionPoint: "unexpected_event", unexpectedEventType: "system",
      unexpectedEventPhase: "before_init",
      unexpectedSystemSubtype: subtype,
      unexpectedSystemSubtypeDigest: createHash("sha256")
        .update(event.subtype).digest("hex"),
      unexpectedSystemHasCapabilities: capabilities,
      unexpectedSystemHasFreeText: freeText,
    });
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0,
      { diagnostic: true }), { kind: "outcome_unknown",
      failureReason: "output_contract_mismatch",
      rejectionPoint: "unexpected_event" });
  }
});

test("Codex parser diagnostic distinguishes tools, incomplete usage and failed turns", () => {
  const plan = planAmuxV4AnalysisCliInvocation(openai);
  const prefix = [{ type: "thread.started", thread_id: "fresh" },
    { type: "turn.started" }];
  const answer = { type: "item.completed",
    item: { type: "agent_message", text: "answer" } };
  const complete = { type: "turn.completed", usage: { input_tokens: 10,
    cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } };
  const samples = [
    [[...prefix, { type: "item.completed",
      item: { type: "command_execution", command: "true" } }, answer, complete],
    "security_no_tools_violation"],
    [[...prefix, answer], "usage_unverified"],
    [[...prefix, { type: "turn.failed" }], "output_contract_mismatch"],
  ];
  for (const [events, failureReason] of samples) {
    const stdout = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n"));
    assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0,
      { diagnostic: true }), { kind: "outcome_unknown", failureReason });
  }
});

test("Codex usage without served-model attestation cannot certify success", () => {
  const plan = planAmuxV4AnalysisCliInvocation(openai);
  const events = [
    { type: "thread.started", thread_id: "fresh" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message",
      text: "{}" } },
    { type: "turn.completed", usage: { input_tokens: 10,
      cached_input_tokens: 0, output_tokens: 2,
      reasoning_output_tokens: 0 } },
  ];
  const stdout = Buffer.from(events.map((value) => JSON.stringify(value)).join("\n"));
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan, stdout, 0),
    { kind: "model_unverified", inputTokens: 10, outputTokens: 2 });
  const withReasoning = [events[0], events[1],
    { type: "item.completed", item: { type: "reasoning", text: "private" } },
    events[2], events[3]];
  assert.equal(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from(withReasoning.map((value) => JSON.stringify(value)).join("\n")), 0).kind,
  "model_unverified");
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from(events.slice(0, -1).map((value) =>
      JSON.stringify(value)).join("\n")), 0), { kind: "outcome_unknown" });
  const withTool = [events[0], events[1],
    { type: "item.completed", item: { type: "command_execution",
      command: "true", exit_code: 0 } }, events[2], events[3]];
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from(withTool.map((value) => JSON.stringify(value)).join("\n")), 0),
  { kind: "outcome_unknown" });
});
