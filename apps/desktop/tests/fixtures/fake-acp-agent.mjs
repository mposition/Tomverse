// A stand-in for an ACP agent (Qwen Code, Grok Build, Kimi Code, Mistral Vibe, MiniMax Code, Antigravity): JSON-RPC over stdio.
// argv[2] is a JSON object { scenario, record?, pidFile? }; the rest of argv is what the adapter would pass the real CLI.
// The scenario "auto" picks one from the prompt: "[hang]" waits (and starts a child), "[fail]" fails the prompt, "[quiet]" exits
// without answering it, "[flood]" prints far too much, "[linger]" ignores the end of its input, "[simple]" asks once to run `echo hi`,
// anything else runs the permission script.
// The agent never contacts a provider: it is the whole of the "CLI" in a test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const options = JSON.parse(process.argv[2] ?? "{}");
const args = process.argv.slice(3);
const out = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const notify = (sessionId, update) => out({ method: "session/update", params: { sessionId, update } });
const state = { args, env: Object.keys(process.env).sort(), cwd: process.cwd(), outcomes: [] };
const save = () => { if (options.record) fs.writeFileSync(options.record, JSON.stringify(state)); };

const pending = new Map();
let counter = 100;
const ask = (method, params) => new Promise((resolve) => { const id = counter++; pending.set(id, resolve); out({ id, method, params }); });

const scenario = options.scenario ?? "auto";
// The session's modes and options: `session.modes` is { current, available } or null for an agent that shows none; `session.config` maps option ids to values;
// `session.setMode` and `session.setConfig` say how a change is answered: "notify" (default), "result", "silent" (nothing changes) or "error".
const session = options.session ?? {};
const modes = session.modes === undefined ? { current: "ask", available: ["ask", "accept-edits", "smart-approve", "auto-approve"] } : session.modes;
state.mode = modes?.current;
state.config = { ...(session.config ?? {}) };
state.modeSets = [];
state.configSets = [];
const configOptions = () => [...(modes && session.modeOption !== false ? [{ id: "mode", name: "Mode", currentValue: state.mode, options: [] }] : []),
  ...Object.entries(state.config).map(([id, value]) => ({ id, name: id, currentValue: value, options: [] }))];
const permission = (sessionId, toolCall) => ask("session/request_permission", { sessionId, toolCall: { status: "pending", ...toolCall }, options: [
  { optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" }] });

async function script(sessionId, prompt) {
  const home = os.homedir();
  const requests = [
    ["run-echo", { toolCallId: "t-echo", kind: "execute", title: "echo hi", rawInput: { command: "echo hi" } }],
    ["edit-project", { toolCallId: "t-edit", kind: "edit", title: "Write docs/new.md", locations: [{ path: path.join(process.cwd(), "docs", "new.md") }],
      content: [{ type: "diff", path: path.join(process.cwd(), "docs", "new.md"), oldText: null, newText: "x" }] }],
    ["edit-outside", { toolCallId: "t-out", kind: "edit", title: "Write ../outside.md", locations: [{ path: path.join(process.cwd(), "..", "outside.md") }],
      content: [{ type: "diff", path: path.join(process.cwd(), "..", "outside.md"), oldText: null, newText: "x" }] }],
    ["edit-credential", { toolCallId: "t-cred", kind: "edit", title: "Write the login file", locations: [{ path: path.join(home, ".qwen", "subscription_credentials.json") }],
      content: [{ type: "diff", path: path.join(home, ".qwen", "subscription_credentials.json"), oldText: "a", newText: "b" }] }],
    ["command-credential", { toolCallId: "t-cmd", kind: "execute", title: "cat the login", rawInput: { command: "cat ~/.vibe/.env" } }],
    ["read-project", { toolCallId: "t-read", kind: "read", title: "Read notes.txt", locations: [{ path: path.join(process.cwd(), "notes.txt") }] }],
    ["read-grok-auth", { toolCallId: "t-auth", kind: "read", title: "Read auth", locations: [{ path: path.join(home, ".grok", "auth.json") }] }],
  ];
  for (const [name, call] of requests) {
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId: call.toolCallId, title: call.title, kind: call.kind, status: "pending", rawInput: call.rawInput,
      locations: call.locations, content: call.content });
    const reply = await permission(sessionId, call);
    state.outcomes.push({ name, outcome: reply.result?.outcome ?? reply.error });
    const selected = reply.result?.outcome?.optionId === "allow";
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: selected ? "completed" : "failed",
      content: selected && call.kind === "execute" ? [{ type: "content", content: { type: "text", text: "hi\n" } }] : call.content });
  }
  // The client offers no file system or terminal: both are refused.
  state.fsError = (await ask("fs/read_text_file", { sessionId, path: path.join(process.cwd(), "notes.txt") })).error?.code;
  state.terminalError = (await ask("terminal/create", { sessionId, command: "echo" })).error?.code;
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done: ${prompt}` } });
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((part) => part.text).join("");
  state.prompt = text;
  const tag = scenario !== "auto" ? scenario : ["hang", "fail", "quiet", "flood", "linger", "simple", "flip"].find((name) => text.includes(`[${name}]`)) ?? "script";
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I will " } });
  notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "work. " } });
  if (tag === "flip") notify(sessionId, { sessionUpdate: "current_mode_update", currentModeId: session.flipTo ?? "auto-approve" });
  if (tag === "quiet") { save(); process.exit(0); }
  if (tag === "fail") { out({ id, error: { code: -32603, message: "The model is unavailable." } }); return; }
  if (tag === "refusal") { out({ id, result: { stopReason: "refusal" } }); return; }
  if (tag === "flood") {
    process.stdout.write(`${"x".repeat(3 * 1024 * 1024)}\n`);
    process.stdout.write("not json\n");
    for (let index = 0; index < 5000; index += 1) notify(sessionId, { sessionUpdate: "tool_call", toolCallId: `f${index}`, title: `echo ${index}`, kind: "execute", status: "completed", rawInput: { command: `echo ${index}` },
      content: [{ type: "content", content: { type: "text", text: "y".repeat(2000) } }] });
    out({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (tag === "simple") {
    const reply = await permission(sessionId, { toolCallId: "t-echo", kind: "execute", title: "echo hi", rawInput: { command: "echo hi" } });
    state.outcomes.push({ name: "run-echo", outcome: reply.result?.outcome ?? reply.error });
    const yes = reply.result?.outcome?.optionId === "allow";
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: yes ? "ran it" : "denied it" } });
    save();
    out({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (tag === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(options.pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
    save();
    await permission(sessionId, { toolCallId: "t-hang", kind: "execute", title: "sleep 100", rawInput: { command: "sleep 100" } });
    return;
  }
  await script(sessionId, text);
  save();
  out({ id, result: { stopReason: "end_turn" } });
  if (tag === "linger") setInterval(() => undefined, 1000);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("close", () => { if (scenario !== "linger" && !String(state.prompt).includes("[linger]")) process.exit(0); });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  queueMicrotask(save);
  if (message.method === undefined) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
  if (message.method === "initialize") {
    state.initialize = message.params;
    if (scenario === "silent") return;
    out({ id: message.id, result: { protocolVersion: scenario === "badversion" ? 2 : 1, agentInfo: { name: "fake-acp", version: "0" }, agentCapabilities: {}, authMethods: [] } });
  } else if (message.method === "session/new") {
    state.sessionNew = message.params;
    if (scenario === "auth") { out({ id: message.id, error: { code: -32000, message: "Authentication required" } }); save(); return; }
    out({ id: message.id, result: { sessionId: "session-1", ...(modes ? { modes: { currentModeId: state.mode, availableModes: modes.available.map((id) => ({ id, name: id })) } } : {}),
      configOptions: configOptions() } });
  } else if (message.method === "session/set_mode") {
    const id = message.params.modeId;
    state.modeSets.push(id);
    const how = session.setMode ?? "notify";
    if (how === "error") out({ id: message.id, error: { code: -32602, message: "No such mode." } });
    else {
      out({ id: message.id, result: how === "result" ? { modes: { currentModeId: id } } : {} });
      if (how !== "silent") state.mode = id;
      if (how === "notify") notify("session-1", { sessionUpdate: "current_mode_update", currentModeId: id });
    }
  } else if (message.method === "session/set_config_option") {
    const { configId, value } = message.params;
    state.configSets.push({ configId, value });
    const how = session.setConfig ?? "notify";
    if (how === "error") out({ id: message.id, error: { code: -32602, message: "No such option." } });
    else {
      if (how !== "silent") state.config[configId] = value;
      out({ id: message.id, result: how === "result" ? { configOptions: configOptions() } : {} });
      if (how === "notify") notify("session-1", { sessionUpdate: "config_option_update", configOptions: configOptions() });
    }
  } else if (message.method === "session/prompt") {
    void prompt(message.id, message.params);
  }
});
