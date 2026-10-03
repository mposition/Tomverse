import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxV4AnalysisCliResult,
  planAmuxV4AnalysisCliInvocation } from "../lib/amux/ideaLocalCliContract.mjs";
import { amuxV4CodexNoToolsCatalogJson } from
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
