import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxV4AnalysisCliResult,
  planAmuxV4AnalysisCliInvocation } from "../lib/amux/ideaLocalCliContract.mjs";

const openai = { provider: "openai", modelId: "frontier-openai",
  reasoningEffort: "high" };
const anthropic = { provider: "anthropic", modelId: "frontier-anthropic",
  reasoningEffort: "high" };

test("provider-to-command plan is exact, shell-free and never infers a fallback model", () => {
  const codex = planAmuxV4AnalysisCliInvocation(openai);
  const claude = planAmuxV4AnalysisCliInvocation(anthropic);
  assert.equal(codex.command[0], "/run/amux-cli/codex");
  assert.ok(codex.command.includes("--ephemeral"));
  assert.ok(codex.command.includes("--ignore-user-config"));
  assert.ok(codex.command.includes("--ignore-rules"));
  assert.deepEqual(codex.command.slice(-1), ["-"]);
  assert.ok(codex.command.includes(openai.modelId));
  assert.equal(claude.command[0], "/run/amux-cli/claude");
  assert.ok(claude.command.includes("--safe-mode"));
  assert.ok(claude.command.includes("--no-session-persistence"));
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
});

const claudeEnvelope = (modelId = anthropic.modelId) => ({
  type: "result", subtype: "success", is_error: false, num_turns: 1,
  result: '{"schemaVersion":2,"previewId":"preview_1"}',
  modelUsage: { [modelId]: { inputTokens: 10, outputTokens: 2,
    cacheReadInputTokens: 3, cacheCreationInputTokens: 1 } },
});

test("Claude result needs exact served model and complete usage", () => {
  const plan = planAmuxV4AnalysisCliInvocation(anthropic);
  const completed = inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from(JSON.stringify(claudeEnvelope())), 0);
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
      Buffer.from(JSON.stringify(sample)), 0), { kind: "outcome_unknown" });
  }
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from(JSON.stringify(claudeEnvelope())), 1), { kind: "outcome_unknown" });
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from([0xff]), 0), { kind: "outcome_unknown" });
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
    { kind: "model_unverified" });
  assert.deepEqual(inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from(events.slice(0, -1).map((value) =>
      JSON.stringify(value)).join("\n")), 0), { kind: "outcome_unknown" });
});
