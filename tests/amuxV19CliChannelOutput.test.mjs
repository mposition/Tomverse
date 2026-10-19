import assert from "node:assert/strict";
import test from "node:test";

import { createAmuxV19ChannelStreamObserver } from
  "../lib/amux/ideaV19CliChannelOutput.mjs";

// Synthetic streams shaped like the CLIs' own output measured inside the v19
// sandbox on 2026-10-20 (Copilot 1.0.91 JSON, Cursor 2026.10.01 stream-json,
// Codex 0.160.0 JSONL). No real answer, path or credential is kept here.
const directory = "/tmp/amux-v19-checkout-Ab12Cd";
const files = ["README.md", "src/a.txt"];
const complete = { kind: "complete", files: ["src/a.txt"] };

function run(provider, modelId, events, { exitCode = 0, openTrace = complete,
  chunkSize = 0 } = {}) {
  const observer = createAmuxV19ChannelStreamObserver({ provider, modelId,
    directory, files });
  const bytes = Buffer.from(events.map((event) =>
    typeof event === "string" ? event : JSON.stringify(event)).join("\n") + "\n", "utf8");
  if (chunkSize > 0) {
    for (let start = 0; start < bytes.length; start += chunkSize)
      observer.observeChunk(bytes.subarray(start, start + chunkSize));
  } else observer.observeChunk(bytes);
  const result = observer.finish({ exitCode, stdoutComplete: true, openTrace });
  return { result, reason: observer.rejectReason().code };
}

const copilotStream = (change = {}) => [
  { type: "session.info", data: { infoType: "configuration",
    message: "Disabled tools: bash, create, edit" } },
  { type: "session.mcp_servers_loaded", data: { servers: [
    { name: "github-mcp-server", status: "disabled", source: "builtin" }] } },
  { type: "user.message", data: { content: "prompt" } },
  { type: "assistant.turn_start", data: { turnId: "0" } },
  { type: "model.call_start", data: { turnId: "0", model: "gpt-5-mini" } },
  { type: "assistant.message", data: { model: change.model ?? "gpt-5-mini",
    content: "Reading the file.", toolRequests: [{ toolCallId: "c1",
      name: change.tool ?? "view", arguments: { path: change.path ?? `${directory}/src/a.txt` } }] } },
  { type: "tool.execution_start", data: { toolCallId: "c1", toolName: change.tool ?? "view",
    arguments: { path: change.path ?? `${directory}/src/a.txt` }, model: "gpt-5-mini" } },
  { type: "model.call_final_result", data: { model: "gpt-5-mini", isByok: false,
    result: "success" } },
  { type: "tool.execution_complete", data: { toolCallId: "c1", success: true,
    result: { content: "file text" } } },
  { type: "assistant.turn_end", data: { turnId: "0" } },
  { type: "assistant.message", data: { model: "gpt-5-mini",
    content: change.answer ?? "{\"units\":[]}", toolRequests: [] } },
  { type: "model.call_final_result", data: { model: "gpt-5-mini", result: "success" } },
  ...(change.noUsage ? [] : [{ type: "session.usage_checkpoint", data: {
    providerModelMetrics: [{ provider: { id: "copilot" }, modelId: change.usageModel ?? "gpt-5-mini",
      metrics: { usage: { inputTokens: 5071, outputTokens: 277, cacheReadTokens: 2560,
        cacheWriteTokens: 0, reasoningTokens: 192 } } }] } }]),
  { type: "assistant.idle", data: {} },
  { type: "result", exitCode: change.exitCode ?? 0, usage: { premiumRequests: 0 } },
];

test("a Copilot run yields its final answer, the traced reads and the served model", () => {
  for (const chunkSize of [0, 7]) {
    const { result } = run("github-copilot", "gpt-5-mini", copilotStream(), { chunkSize });
    assert.deepEqual(result, { kind: "verified_success",
      rawModelOutput: "{\"units\":[]}", readFiles: ["src/a.txt"],
      inputTokens: 5071, outputTokens: 277, modelAttestation: "served" });
  }
});

test("a Copilot run is refused on a write tool, an outside path or another model", () => {
  for (const [change, code] of [
    [{ tool: "bash" }, "tool_refused"],
    [{ tool: "edit" }, "tool_refused"],
    [{ path: "/proc/self/environ" }, "tool_path_outside"],
    [{ path: "../outside.txt" }, "tool_path_outside"],
    [{ path: `${directory}/../x` }, "tool_path_outside"],
    [{ model: "gpt-5" }, "served_model_mismatch"],
    [{ usageModel: "claude-sonnet-4.5" }, "served_model_mismatch"],
    [{ noUsage: true }, "usage_tokens"],
    [{ exitCode: 1 }, "result_error"],
    [{ answer: "  " }, "result_text_missing"],
  ]) {
    const { result, reason } = run("github-copilot", "gpt-5-mini", copilotStream(change));
    assert.deepEqual(result, { kind: "outcome_unknown" }, JSON.stringify(change));
    assert.equal(reason, code, JSON.stringify(change));
  }
  const after = [...copilotStream(), { type: "assistant.idle", data: {} }];
  assert.equal(run("github-copilot", "gpt-5-mini", after).reason, "event_after_result");
  assert.equal(run("github-copilot", "gpt-5-mini",
    [...copilotStream().slice(0, -1), { type: "session.error", data: {} },
      copilotStream().at(-1)]).reason, "cli_error");
});

test("every channel needs a complete open trace that covers each read", () => {
  for (const [openTrace, code] of [[{ kind: "unverified" }, "trace_unverified"],
    [{ kind: "complete", files: ["other.txt"] }, "trace_unverified"],
    [{ kind: "complete", files: [] }, "read_not_traced"]]) {
    const { result, reason } = run("github-copilot", "gpt-5-mini", copilotStream(),
      { openTrace });
    assert.deepEqual(result, { kind: "outcome_unknown" });
    assert.equal(reason, code);
  }
  assert.equal(run("github-copilot", "gpt-5-mini", copilotStream(), { exitCode: 1 })
    .reason, "exit_or_stdout");
});

const cursorStream = (change = {}) => [
  { type: "system", subtype: "init", apiKeySource: "login", cwd: directory,
    model: "Auto", permissionMode: "default" },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
  { type: "thinking", subtype: "delta", text: "..." },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text",
    text: "I'll read the file." }] } },
  { type: "tool_call", subtype: "started", call_id: "c1", tool_call: {
    [change.tool ?? "readToolCall"]: { args: { path: change.path ?? `${directory}/src/a.txt` } } } },
  { type: "tool_call", subtype: "completed", call_id: "c1", tool_call: {
    [change.tool ?? "readToolCall"]: { args: { path: change.path ?? `${directory}/src/a.txt` },
      result: { success: { content: "file text" } } } } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text",
    text: "{\"units\":" }, { type: "text", text: "[]}" }] } },
  ...(change.extra ? [change.extra] : []),
  { type: "result", subtype: "success", is_error: change.isError ?? false,
    result: "I'll read the file.{\"units\":[]}", usage: { inputTokens: 17553,
      outputTokens: 88, cacheReadTokens: 7680, cacheWriteTokens: 0 } },
];

test("a Cursor answer is only the text after its last tool call", () => {
  const { result } = run("cursor", "auto", cursorStream(), { chunkSize: 5 });
  assert.deepEqual(result, { kind: "verified_success",
    rawModelOutput: "{\"units\":[]}", readFiles: ["src/a.txt"],
    inputTokens: 17553 + 7680, outputTokens: 88, modelAttestation: "requested" });
});

test("a Cursor run is refused on a write or shell tool, an outside path or an odd stream", () => {
  for (const [change, code] of [
    [{ tool: "editToolCall" }, "tool_refused"],
    [{ tool: "shellToolCall" }, "tool_refused"],
    [{ tool: "deleteToolCall" }, "tool_refused"],
    [{ path: "/home/tommy/.config/cursor/auth.json" }, "tool_path_outside"],
    [{ isError: true }, "result_error"],
    [{ extra: { type: "interaction_query", data: {} } }, "unexpected_event"],
  ]) {
    const { result, reason } = run("cursor", "auto", cursorStream(change));
    assert.deepEqual(result, { kind: "outcome_unknown" }, JSON.stringify(change));
    assert.equal(reason, code, JSON.stringify(change));
  }
  const [init, ...rest] = cursorStream();
  assert.equal(run("cursor", "auto", [...rest.slice(0, 1), init, ...rest.slice(1)])
    .reason, "init_order");
  assert.equal(run("cursor", "auto", cursorStream().slice(0, -1)).reason,
    "result_missing");
  assert.equal(run("cursor", "auto", ["not json", ...cursorStream()]).reason,
    "invalid_json");
});

const codexStream = (item = { type: "command_execution",
  command: "/usr/bin/bash -lc 'head -n 1 src/a.txt'", exit_code: 0, status: "completed" }) => [
  { type: "thread.started", thread_id: "t" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "item_0", ...item, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_0", ...item } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message",
    text: "{\"units\":[]}" } },
  { type: "turn.completed", usage: { input_tokens: 27139, cached_input_tokens: 24960,
    cache_write_input_tokens: 0, output_tokens: 59, reasoning_output_tokens: 0 } },
];

test("a Codex run records the requested model and its own usage counts", () => {
  const { result } = run("openai", "gpt-6-luna", codexStream());
  assert.deepEqual(result, { kind: "verified_success",
    rawModelOutput: "{\"units\":[]}", readFiles: ["src/a.txt"],
    inputTokens: 27139, outputTokens: 59, modelAttestation: "requested" });
  for (const item of [{ type: "file_change", changes: [] },
    { type: "web_search", query: "x" }, { type: "mcp_tool_call", tool: "x" }]) {
    assert.equal(run("openai", "gpt-6-luna", codexStream(item)).reason,
      "tool_refused", item.type);
  }
  assert.equal(run("openai", "gpt-6-luna",
    [...codexStream().slice(0, 2), { type: "turn.failed", error: {} }]).reason,
  "cli_error");
});

test("the observer refuses a malformed setup", () => {
  for (const input of [{ provider: "anthropic", modelId: "claude-opus-5-5" },
    { provider: "cursor", modelId: "auto", directory: "/tmp/x" },
    { provider: "cursor", modelId: "auto", files: ["../x"] }]) {
    assert.throws(() => createAmuxV19ChannelStreamObserver({ directory, files,
      ...input }), TypeError);
  }
});
