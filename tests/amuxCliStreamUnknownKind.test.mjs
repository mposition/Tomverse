import assert from "node:assert/strict";
import test from "node:test";

import { amuxCliUnknownKindActs, amuxCliUnknownKindSummary, createAmuxCliUnknownKindLog } from
  "../lib/amux/cliStreamUnknownKind.mjs";
import { createAmuxV19ChannelStreamObserver } from "../lib/amux/ideaV19CliChannelOutput.mjs";
import { parseAmuxV22ChannelOutput } from "../lib/amux/v22ChannelRun.mjs";
import { antigravityUnknownKindActs } from "../tools/review-orchestrator/lib/antigravity.mjs";

// Owner direction 2026-11-21: a CLI stream check stays strict about a tool
// outside the role's list, a subagent, the permission mode and the result; a
// kind it has not seen passes, counted by name, when nothing in it names an
// action. The streams below are synthetic, shaped like the box's worker
// transcripts (key names read on 2026-11-21, no value kept).

const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const parse = (provider, events, { role = "implement", exitCode = 0 } = {}) =>
  parseAmuxV22ChannelOutput(provider, jsonl(...events), { exitCode, role, readRoleShell: true });

test("an unseen kind is refused only when its name or a key names an action", () => {
  for (const [name, body] of [["system_message", { conversation_id: "c", step_index: 3,
    state: "DONE", step_type: "system_message", duration_seconds: 0.1 }],
  ["error", { id: "i", type: "error", message: "model stream retried" }],
  ["thread.compacted", { type: "thread.compacted", usage: { input_tokens: 1 } }],
  ["status", { type: "system", subtype: "status", session_id: "s" }]])
    assert.equal(amuxCliUnknownKindActs(name, body), false, name);
  for (const [name, body] of [["web_search", { query: "x" }], ["mcp_tool_call", {}],
    ["browser", {}], ["collab_agent", {}], ["notice", { detail: { CommandLine: "rm" } }],
    ["notice", { items: [{ file_path: "/etc/passwd" }] }], ["notice", { permissionMode: "auto" }],
    ["interaction_query", {}], ["has space", {}], ["", {}], [7, {}], [undefined, {}],
    ["notice", { nested: { deeper: { tool_info: {} } } }]])
    assert.equal(amuxCliUnknownKindActs(name, body), true, String(name));
  // A value is never read: the model's text cannot make a kind fail or pass.
  assert.equal(amuxCliUnknownKindActs("notice", { text: "run_command web_search tool" }), false);
  // The review server's copy keeps the same rule.
  for (const [name, body] of [["system_message", { state: "DONE" }], ["telemetry", {}],
    ["tool_use", {}], ["notice", { detail: { Path: "x" } }], ["x y", {}]])
    assert.equal(antigravityUnknownKindActs(name, body), amuxCliUnknownKindActs(name, body), String(name));
  const log = createAmuxCliUnknownKindLog();
  log.note("step:system_message"); log.note("step:system_message"); log.note("event:x");
  assert.deepEqual(log.snapshot(), { "step:system_message": 2, "event:x": 1 });
  assert.equal(amuxCliUnknownKindSummary(log.snapshot()), "step:system_message*2,event:x");
  assert.equal(amuxCliUnknownKindSummary(undefined), "");
});

// --- Antigravity ---------------------------------------------------------

const init = (mode = "request-review") => ({ event: "init", conversation_id: "c", init: {
  model: "gemini-4-hydrogen-high", cwd: "/w", agent: "amux-v22-implement",
  tools: ["view_file", "run_command"], permission_mode: mode } });
const step = (fields) => ({ event: "step_update", step_update: { conversation_id: "c",
  step_index: 1, state: "DONE", ...fields } });
const done = { event: "result", result: { conversation_id: "c", status: "SUCCESS",
  response: "Done.", duration_seconds: 9, num_turns: 3, usage: { input_tokens: 10,
    output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 } } };
// The 2026-11-21 AMUX-CRAWL-002 run's step shapes: reads, commands and edits,
// then a system_message step carrying only its ids, state and duration.
const crawl = [init(), step({ step_type: "user_input" }),
  step({ step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file",
    parameters: { Path: "/w/a.ts" } } }),
  step({ step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command",
    parameters: { CommandLine: "npm test" }, output: "ok" } }),
  step({ step_type: "tool", tool_name: "edit_file", tool_info: { name: "edit_file" } }),
  step({ step_type: "system_message", duration_seconds: 0.2 }),
  step({ step_type: "agent_response", text_delta: "Done.", usage: {} }), done];

test("Antigravity: the system_message run is a valid result, counted by name", () => {
  const parsed = parse("antigravity", crawl);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.success, true);
  assert.equal(parsed.resultText, "Done.");
  assert.deepEqual(parsed.unrecognized, { "step:system_message": 1 });
  // An unseen top-level event that names nothing is counted the same way.
  assert.deepEqual(parse("antigravity", [init(), { event: "heartbeat", conversation_id: "c" },
    done]).unrecognized, { "event:heartbeat": 1 });
  // A run with nothing unseen carries no list.
  assert.equal(Object.hasOwn(parse("antigravity", [init(), done]), "unrecognized"), false);
});

test("Antigravity: an unseen kind with a tool field, a disallowed tool, a subagent or another mode stays refused", () => {
  const refused = (events, role = "implement") => {
    const parsed = parse("antigravity", events, { role });
    assert.equal(parsed.valid, false);
    return parsed.reason;
  };
  assert.equal(refused([init(), step({ step_type: "system_message", tool_name: "search_web" }), done]),
    "tool:search_web");
  assert.equal(refused([init(), step({ step_type: "system_message", tool_info: { name: "x" } }), done]),
    "tool:?");
  assert.equal(refused([init(), step({ step_type: "system_message",
    detail: { parameters: { CommandLine: "curl x" } } }), done]), "step:system_message");
  assert.equal(refused([init(), step({ step_type: "browser" }), done]), "step:browser");
  assert.equal(refused([init(), { event: "tool_use", name: "run_command" }, done]), "event:tool_use");
  assert.equal(refused([init(), { event: "notice", file_path: "/x" }, done]), "event:notice");
  assert.equal(refused([init(), step({ step_type: "tool", tool_name: "search_web" }), done]),
    "tool:search_web");
  assert.equal(refused([init(), step({ step_type: "tool", tool_name: "edit_file" }), done],
    "investigate"), "tool:edit_file");
  assert.equal(refused([init(), step({ step_type: "system_message", subagent_info: {} }), done]),
    "subagent");
  // An unseen step that names a tool on the role's list is still an action.
  assert.equal(refused([init(), step({ step_type: "browser", tool_name: "read_file" }), done]),
    "step:browser");
  assert.equal(refused([init(), step({ step_type: "system_message", tool_name: "read_file",
    tool_info: { name: "read_file" } }), done]), "step:system_message");
  assert.equal(refused([init("always-proceed"), done]), "permission_mode");
  assert.equal(refused([init(), step({ step_type: "system_message" })]), "no_result");
  assert.equal(parseAmuxV22ChannelOutput("antigravity", `${jsonl(init())}not json\n${jsonl(done)}`,
    { exitCode: 0, role: "implement" }).reason, "non_object_line");
});

// --- Codex -----------------------------------------------------------------

const codexDone = { type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 0,
  output_tokens: 1, reasoning_output_tokens: 0 } };
const codex = (...middle) => [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" },
  ...middle, { type: "item.completed", item: { id: "i9", type: "agent_message", text: "ok" } },
  codexDone];

test("Codex: an unseen item or event that names nothing passes and is counted", () => {
  const parsed = parse("openai", codex(
    { type: "item.completed", item: { id: "i1", type: "error", message: "retrying" } },
    { type: "thread.compacted", thread_id: "t" }));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.unrecognized, { "item:error": 1, "event:thread.compacted": 1 });
});

test("Codex: an unseen item or event that names an action stays refused", () => {
  const reason = (...middle) => parse("openai", codex(...middle)).reason;
  for (const type of ["web_search", "mcp_tool_call", "collab_tool_call", "image_generation",
    "unknown_tool"])
    assert.equal(reason({ type: "item.started", item: { id: "i", type } }), `item:${type}`);
  assert.equal(reason({ type: "item.started", item: { id: "i", type: "plan_note",
    changes: [{ path: "a" }] } }), "item:plan_note");
  assert.equal(reason({ type: "item.started", item: "web_search" }), "item:?");
  assert.equal(reason({ type: "exec_approval_request", call_id: "c" }), "event:exec_approval_request");
  // The sandboxed shell and file changes stay allowed, as before.
  assert.equal(parse("openai", codex({ type: "item.completed", item: { id: "i",
    type: "command_execution", command: "ls" } })).valid, true);
});

// --- Copilot ---------------------------------------------------------------

const copilot = (...middle) => [{ type: "session.tools_updated", data: { model: "m" } },
  ...middle,
  { type: "assistant.message", data: { model: "m", toolRequests: [], content: "answer" } },
  { type: "model.call_final_result", data: { model: "m", result: "success" } },
  { type: "result", exitCode: 0, usage: { premiumRequests: 0 } }];

test("Copilot: an unseen event passes and is counted; a tool named anywhere is held to the list", () => {
  const parsed = parse("github-copilot", copilot({ type: "session.compaction_start", data: {} }),
    { role: "investigate" });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.unrecognized, { "event:session.compaction_start": 1 });
  const reason = (event, role = "investigate") => parse("github-copilot", copilot(event), { role }).reason;
  assert.equal(reason({ type: "assistant.tool_call_delta", data: { toolName: "web_fetch" } }),
    "tool:web_fetch");
  assert.equal(reason({ type: "session.new_kind", data: { toolName: "edit" } }), "tool:edit");
  assert.equal(reason({ type: "tool.execution_start", data: { toolName: "edit" } }, "design"),
    "tool:edit");
  assert.equal(reason({ type: "subagent.started", data: { agentName: "x" } }, "implement"),
    "subagent");
  // An unseen event that names an action without a toolName stays refused.
  assert.equal(reason({ type: "browser.open", data: {} }), "event:browser.open");
  assert.equal(reason({ type: "session.notice", data: { command: "ls" } }), "event:session.notice");
  assert.equal(parse("github-copilot", copilot({ type: "tool.execution_start",
    data: { toolName: "edit" } }), { role: "implement" }).valid, true);
});

// --- Cursor ----------------------------------------------------------------

const cursorDone = { type: "result", subtype: "success", is_error: false, result: "answer",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
const cursor = (...middle) => [{ type: "system", subtype: "init", permissionMode: "default" },
  ...middle, { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
  cursorDone];

test("Cursor: an unseen event passes and is counted; one with a tool call or a question stays refused", () => {
  const parsed = parse("cursor", cursor({ type: "connection", subtype: "reconnected" }),
    { role: "investigate" });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.unrecognized, { "event:connection": 1 });
  const reason = (...events) => parse("cursor", cursor(...events), { role: "investigate" }).reason;
  assert.equal(reason({ type: "background", call: { shellToolCall: { args: {} } } }), "event:background");
  assert.equal(reason({ type: "interaction_query", data: {} }), "event:interaction_query");
  assert.equal(reason({ type: "tool_call", tool_call: { shellToolCall: { args: {} } } }),
    "tool:shellToolCall");
  assert.equal(parse("cursor", cursor({ type: "tool_call", tool_call: { readToolCall: { args: {} } } }),
    { role: "investigate" }).valid, true);
});

// --- v19 channels --------------------------------------------------------

const directory = "/tmp/amux-v19-checkout-Ab12Cd";
const v19 = (provider, modelId, events) => {
  const observer = createAmuxV19ChannelStreamObserver({ provider, modelId, directory,
    files: ["src/a.txt"] });
  observer.observeChunk(Buffer.from(jsonl(...events), "utf8"));
  const result = observer.finish({ exitCode: 0, stdoutComplete: true,
    openTrace: { kind: "complete", files: [] } });
  return { result, reason: observer.rejectReason().code, unseen: observer.unrecognizedEvents() };
};

test("v19 Codex and Cursor channels pass a harmless unseen kind and still refuse an action", () => {
  const codexStream = (...middle) => [{ type: "thread.started", thread_id: "t" },
    { type: "turn.started" }, ...middle,
    { type: "item.completed", item: { id: "i1", type: "agent_message", text: "{\"units\":[]}" } },
    { type: "turn.completed", usage: { input_tokens: 2, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }];
  const fine = v19("openai", "gpt-6-luna", codexStream(
    { type: "item.completed", item: { id: "i0", type: "error", message: "retrying" } },
    { type: "thread.compacted" }));
  assert.equal(fine.result.kind, "verified_success");
  assert.deepEqual(fine.unseen, { "item:error": 1, "event:thread.compacted": 1 });
  // The verified result carries them, as the Claude channel's result does.
  assert.deepEqual(fine.result.unrecognizedEvents, fine.unseen);
  assert.equal(Object.hasOwn(v19("openai", "gpt-6-luna", codexStream()).result,
    "unrecognizedEvents"), false);
  assert.equal(v19("openai", "gpt-6-luna", codexStream({ type: "item.started",
    item: { id: "i0", type: "web_search", query: "x" } })).reason, "tool_refused");
  assert.equal(v19("openai", "gpt-6-luna", codexStream({ type: "exec_approval_request" })).reason,
    "unexpected_event");
  const cursorStream = (...middle) => [{ type: "system", subtype: "init", cwd: directory,
    model: "Auto", permissionMode: "default" }, ...middle,
  { type: "assistant", message: { content: [{ type: "text", text: "{\"units\":[]}" }] } },
  { type: "result", subtype: "success", is_error: false, result: "{\"units\":[]}",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }];
  const cursorFine = v19("cursor", "auto", cursorStream({ type: "connection" },
    { type: "system", subtype: "status", session_id: "s" }));
  assert.equal(cursorFine.result.kind, "verified_success");
  assert.deepEqual(cursorFine.unseen, { "event:connection": 1, "system:status": 1 });
  assert.equal(v19("cursor", "auto", cursorStream({ type: "system", subtype: "status",
    permissionMode: "auto" })).reason, "init_order");
  assert.equal(v19("cursor", "auto", cursorStream({ type: "background",
    call: { editToolCall: {} } })).reason, "unexpected_event");
  // Anything after the result is still refused, seen or not.
  const late = [...cursorStream(), { type: "connection" }];
  assert.equal(v19("cursor", "auto", late).reason, "event_after_result");
});
