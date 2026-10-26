// Owner decision 2026-10-26: Codex, Copilot and Cursor workers run v22
// one-shot Tasks. The sidecar fixes each role's tools by CLI flags and reads
// only the final answer and usage from the CLI's own JSON.

import assert from "node:assert/strict";
import test from "node:test";

import { amuxCliPricedModelId, estimateAmuxCliApiCost, makeAmuxCliUsageReceipt } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { amuxV22ChannelArgs, amuxV22ChannelEnv, parseAmuxV22ChannelOutput } from
  "../lib/amux/v22ChannelRun.mjs";
import { v22ExecutionReceiptVerified, v22ExecutionSourceForProvider } from
  "../lib/amux/v22TaskExecutionCore.ts";

const ATTEMPT = "00000000-0000-4000-8000-000000000001";
const request = (role, modelId = "gpt-6-luna") => ({ role, modelId });
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

test("a read role gets no write tool; Copilot never gets a shell; Cursor never writes", () => {
  for (const role of ["design", "investigate", "review"]) {
    const codex = amuxV22ChannelArgs("openai", request(role), "/w");
    assert.deepEqual(codex.slice(codex.indexOf("--sandbox"), codex.indexOf("--sandbox") + 2),
      ["--sandbox", "read-only"]);
    const copilot = amuxV22ChannelArgs("github-copilot", request(role), "/w");
    assert.ok(!copilot.includes("edit") && !copilot.includes("create"));
    assert.deepEqual(amuxV22ChannelArgs("cursor", request(role), "/w").slice(3, 5),
      ["--mode", "ask"]);
  }
  const codex = amuxV22ChannelArgs("openai", request("implement"), "/w");
  assert.ok(codex.includes("workspace-write") && !codex.includes("danger-full-access"));
  // Owner decision 2026-10-26: Codex's shell stays inside its OS sandbox, with
  // no network and every browser, computer-use, app and MCP tool off.
  for (const feature of ["browser_use", "browser_use_external", "browser_use_full_cdp_access",
    "computer_use", "in_app_browser", "apps"])
    assert.equal(codex[codex.indexOf(feature) - 1], "--disable", feature);
  for (const setting of ["sandbox_workspace_write.network_access=false",
    'web_search="disabled"', "mcp_servers={}"])
    assert.equal(codex[codex.indexOf(setting) - 1], "-c", setting);
  assert.ok(!codex.some((part) => /bypass|dangerously|yolo/.test(part)));
  const copilot = amuxV22ChannelArgs("github-copilot", request("implement"), "/w");
  assert.ok(copilot.includes("edit") && copilot.includes("create") &&
    !copilot.includes("shell") && !copilot.includes("bash"));
  assert.throws(() => amuxV22ChannelArgs("cursor", request("implement"), "/w"),
    /read roles only/);
  // The prompt arrives on stdin: argv carries no task text.
  for (const [provider, role] of [["openai", "implement"], ["github-copilot", "implement"],
    ["cursor", "investigate"]])
    assert.ok(!amuxV22ChannelArgs(provider, request(role), "/w").includes("Synthetic"));
  assert.throws(() => amuxV22ChannelArgs("anthropic", request("implement"), "/w"));
  assert.equal(amuxV22ChannelEnv("openai", { homePath: "/h", claudeConfigDir: "/c" }).CODEX_HOME, "/c");
  const config = { homePath: "/h", claudeConfigDir: "/c" };
  const token = `gho_${"a".repeat(36)}`;
  assert.equal(amuxV22ChannelEnv("github-copilot", config,
    { readToken: () => Buffer.from(`${token}\n`) }).COPILOT_GITHUB_TOKEN, token);
  assert.equal(amuxV22ChannelEnv("github-copilot", config,
    { readToken: () => Buffer.from("not-a-token") }).COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(amuxV22ChannelEnv("github-copilot", config,
    { readToken: () => { throw new Error("missing"); } }).COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(amuxV22ChannelEnv("cursor", config, { readToken: () => Buffer.from(token) })
    .COPILOT_GITHUB_TOKEN, undefined);
});

test("Codex: the last agent message is the answer; usage comes from its turn", () => {
  const text = jsonl({ type: "thread.started", thread_id: "opaque" }, { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "draft" } },
    { type: "item.completed", item: { type: "agent_message", text: "final" } },
    { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 400,
      output_tokens: 120, reasoning_output_tokens: 20 } });
  const run = parseAmuxV22ChannelOutput("openai", text, { exitCode: 0, role: "investigate" });
  assert.equal(run.valid, true);
  assert.equal(run.success, true);
  assert.equal(run.resultText, "final");
  assert.equal(run.observation.completeness, "reported_complete");
  const failed = parseAmuxV22ChannelOutput("openai", text.replace("turn.completed", "turn.failed"),
    { exitCode: 1, role: "investigate" });
  assert.equal(failed.success, false);
  assert.equal(parseAmuxV22ChannelOutput("openai", "not json\n", { exitCode: 0 }).valid, false);
  // Killed before its terminal event: unknown, never a failure to settle.
  for (const provider of ["openai", "github-copilot", "cursor"])
    assert.equal(parseAmuxV22ChannelOutput(provider, jsonl({ type: "turn.started" }),
      { exitCode: 0, role: "investigate" }).valid, false);
});

test("Copilot: the served model is recorded as reported; Cursor: text after the last tool call", () => {
  const copilot = (model) => jsonl(
    { type: "assistant.message", data: { model, toolRequests: [{ name: "view", arguments: {} }] } },
    { type: "model.call_final_result", data: { model, result: "success" } },
    { type: "assistant.message", data: { model, toolRequests: [], content: "done" } },
    { type: "session.usage_checkpoint", data: { providerModelMetrics: [{ modelId: model,
      metrics: { usage: { inputTokens: 5071, outputTokens: 210, cacheWriteTokens: 0 } } }] } },
    { type: "result", exitCode: 0 });
  const served = parseAmuxV22ChannelOutput("github-copilot", copilot("claude-sonnet-5-5"),
    { exitCode: 0, role: "investigate" });
  assert.equal(served.success, true);
  assert.equal(served.resultText, "done");
  assert.deepEqual(served.observation.models.map((row) => row.modelId), ["claude-sonnet-5-5"]);
  assert.equal(served.observation.observed.inputTokens, 5071);
  assert.equal(served.observation.inputTokensIncludeCacheRead, true);
  const fallback = parseAmuxV22ChannelOutput("github-copilot", copilot("gpt-5-mini"),
    { exitCode: 0, role: "investigate" });
  assert.deepEqual(fallback.observation.models.map((row) => row.modelId), ["gpt-5-mini"]);

  const cursor = jsonl({ type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading " }] } },
    { type: "tool_call", tool_call: { readToolCall: { args: { path: "a" } } } },
    { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Reading answer",
      usage: { inputTokens: 8364, outputTokens: 300, cacheReadTokens: 19968, cacheWriteTokens: 0 } });
  const run = parseAmuxV22ChannelOutput("cursor", cursor, { exitCode: 0, role: "investigate" });
  assert.equal(run.success, true);
  assert.equal(run.resultText, "answer");
  assert.equal(run.observation.observed.cacheReadInputTokens, 19968);
  assert.equal(run.observation.inputTokensIncludeCacheRead, false);
  // A cache write has no measured rule: the usage is unknown, not guessed.
  const written = parseAmuxV22ChannelOutput("cursor",
    cursor.replace('"cacheWriteTokens":0', '"cacheWriteTokens":5'), { exitCode: 0, role: "investigate" });
  assert.equal(written.observation.completeness, "unknown");
});

test("each provider's receipt settles; only Codex and Cursor may omit the served model", () => {
  const receipt = (provider, run, modelId) => makeAmuxCliUsageReceipt({
    invocationId: ATTEMPT, binding: { kind: "task_attempt", attemptId: ATTEMPT },
    worker: "w-1", selectedModelId: modelId, cliVersion: null, authentication: "unknown",
    startedAt: "2026-10-26T00:00:00.000Z", endedAt: "2026-10-26T00:01:00.000Z",
    status: "succeeded", observation: run.observation });
  const cursor = receipt("cursor", parseAmuxV22ChannelOutput("cursor", jsonl(
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
    { type: "result", subtype: "success", is_error: false, result: "ok",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    { exitCode: 0, role: "investigate" }), "composer-2.5");
  assert.equal(cursor.provider, "cursor");
  assert.equal(cursor.source, "cursor_stream");
  assert.equal(cursor.actualModelId, null);
  assert.equal(amuxCliPricedModelId(cursor), "composer-2.5");
  const verify = (event, provider) => v22ExecutionReceiptVerified({
    attemptId: ATTEMPT, invocationIds: [ATTEMPT], outcome: "succeeded",
    reservedCostMicrousd: BigInt(1), resultStored: true, budgetBound: false,
    expectedExecutionSource: v22ExecutionSourceForProvider(provider),
    events: [{ invocationId: ATTEMPT, status: "succeeded", completeness: "reported_complete",
      projectedApiCostMicrousd: null, ...event }] });
  assert.equal(verify({ cli: "cursor", source: "cursor_stream", actualModelId: null,
    selectedModelId: "composer-2.5" }, "cursor"), true);
  assert.equal(verify({ cli: "codex", source: "codex_jsonl", actualModelId: null,
    selectedModelId: "gpt-6-luna" }, "openai"), true);
  // Copilot and Claude name the served model; without it, or with another, no settlement.
  assert.equal(verify({ cli: "copilot", source: "copilot_json", actualModelId: null,
    selectedModelId: "x" }, "github-copilot"), false);
  assert.equal(verify({ cli: "copilot", source: "copilot_json", actualModelId: "y",
    selectedModelId: "x" }, "github-copilot"), false);
  assert.equal(verify({ cli: "claude", source: "claude_result", actualModelId: null,
    selectedModelId: "claude-opus-5-5" }, "anthropic"), false);
  // A receipt from another CLI than the assignment's never settles it.
  assert.equal(verify({ cli: "codex", source: "codex_jsonl", actualModelId: null,
    selectedModelId: "gpt-6-luna" }, "cursor"), false);
  assert.equal(verify({ cli: "codex", source: "codex_jsonl", actualModelId: null,
    selectedModelId: "gpt-6-luna" }, "gemini"), false);
  assert.equal(estimateAmuxCliApiCost(cursor, { provider: "cursor", modelId: "composer-2.5",
    version: "v1", uncachedInputMicroUsdPerMillion: 1_000_000, cacheReadMicroUsdPerMillion: 0,
    cacheWriteMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 1_000_000,
    reasoningOutputMicroUsdPerMillion: null }), BigInt(15));
});

test("a tool outside the role's list makes the run unknown, never trusted", () => {
  const done = { type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 0,
    output_tokens: 1, reasoning_output_tokens: 0 } };
  for (const type of ["mcp_tool_call", "web_search", "unknown_tool"]) {
    assert.equal(parseAmuxV22ChannelOutput("openai", jsonl({ type: "turn.started" },
      { type: "item.started", item: { type } }, done), { exitCode: 0, role: "implement" }).valid, false);
  }
  assert.equal(parseAmuxV22ChannelOutput("openai", jsonl({ type: "turn.started" },
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } }, done),
  { exitCode: 0, role: "investigate" }).valid, true);
  const copilot = (toolName, role) => parseAmuxV22ChannelOutput("github-copilot", jsonl(
    { type: "tool.execution_start", data: { toolName, model: "m" } },
    { type: "result", exitCode: 0 }), { exitCode: 0, role });
  assert.equal(copilot("bash", "implement").valid, false);
  assert.equal(copilot("edit", "investigate").valid, false);
  assert.equal(copilot("edit", "implement").valid, true);
  const cursor = (tool) => parseAmuxV22ChannelOutput("cursor", jsonl(
    { type: "tool_call", tool_call: { [tool]: { args: {} } } },
    { type: "result", subtype: "success", is_error: false, result: "",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
  { exitCode: 0, role: "investigate" });
  assert.equal(cursor("shellToolCall").valid, false);
  assert.equal(cursor("editToolCall").valid, false);
  assert.equal(cursor("readToolCall").valid, true);
});
