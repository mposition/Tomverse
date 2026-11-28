// A stand-in for Codex `exec` and Claude Code's stream protocol, run through the Node binary by the provider CLI tests.
// argv[2] is a JSON object { scenario, record?, pidFile? }; the rest of argv is what the adapter would pass the real CLI.
// The scenario "auto" picks one from the prompt: "[hang]" waits (and starts a child), "[fail]" ends the turn badly, anything else succeeds.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const options = JSON.parse(process.argv[2] ?? "{}");
const args = process.argv.slice(3);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = (extra = {}) => {
  if (options.record) fs.writeFileSync(options.record, JSON.stringify({ args, env: Object.keys(process.env).sort(), cwd: process.cwd(), ...extra }));
};
const readAll = () => new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => resolve(text));
});
const hold = () => setInterval(() => undefined, 1000);

async function codex() {
  const prompt = await readAll();
  const scenario = options.scenario !== "auto" ? options.scenario : prompt.includes("[hang]") ? "codex-hang" : prompt.includes("[fail]") ? "codex-fail" : "codex-ok";
  record({ prompt });
  if (scenario === "codex-hang") {
    out({ type: "thread.started", thread_id: "thread-hang" });
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(options.pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
    hold();
    return;
  }
  if (scenario === "codex-middle") {
    // The CLI starts a middle process that starts a background command and exits at once, so the command's parent is gone.
    const grandchildFile = options.pidFile + ".grandchild";
    const script = `const { spawn } = require("node:child_process"); const fs = require("node:fs");
      const g = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" }); g.unref();
      fs.writeFileSync(${JSON.stringify(grandchildFile)}, String(g.pid)); setTimeout(() => process.exit(0), 100);`;
    const middle = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    fs.writeFileSync(options.pidFile, JSON.stringify({ cli: process.pid, middle: middle.pid }));
    out({ type: "thread.started", thread_id: "thread-middle" });
    hold();
    return;
  }
  if (scenario === "codex-orphan") {
    // The CLI finishes and exits, and leaves a background command running.
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    child.unref();
    fs.writeFileSync(options.pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
    out({ type: "thread.started", thread_id: "thread-orphan" });
    out({ type: "turn.completed", usage: {} });
    return;
  }
  if (scenario === "codex-flood") {
    out({ type: "thread.started", thread_id: "thread-flood" });
    process.stdout.write(`${"x".repeat(3 * 1024 * 1024)}\n`);
    process.stdout.write("not json\n");
    for (let index = 0; index < 5000; index += 1) {
      out({ type: "item.completed", item: { id: `item_${index}`, type: "command_execution", command: `echo ${index}`, aggregated_output: "y".repeat(2000), exit_code: 0, status: "completed" } });
    }
    out({ type: "item.completed", item: { id: "final", type: "agent_message", text: "flooded" } });
    out({ type: "turn.completed", usage: {} });
    return;
  }
  if (scenario === "codex-silent") return;
  if (scenario === "codex-fail") {
    out({ type: "thread.started", thread_id: "thread-fail" });
    out({ type: "turn.failed", error: { message: "The model is unavailable." } });
    process.exitCode = 1;
    return;
  }
  out({ type: "thread.started", thread_id: "thread-ok" });
  out({ type: "turn.started" });
  out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "git status", aggregated_output: "", exit_code: null, status: "in_progress" } });
  out({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "git status", aggregated_output: "clean\n", exit_code: 0, status: "completed" } });
  out({ type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/new.ts", kind: "add" }], status: "completed" } });
  out({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: `done: ${prompt}` } });
  out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
}

function claude() {
  const lines = readline.createInterface({ input: process.stdin });
  const queue = [];
  let waiting;
  lines.on("line", (line) => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); } else queue.push(line);
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { waiting = resolve; }));
  lines.on("close", () => process.exit(0));
  (async () => {
    const first = JSON.parse(await next());
    const prompt = first.message.content[0].text;
    const scenario = options.scenario !== "auto" ? options.scenario : prompt.includes("[hang]") ? "claude-hang" : "claude-approve";
    out({ type: "system", subtype: "init", session_id: first.session_id, model: "claude-test", permissionMode: "default" });
    if (scenario === "claude-gone") {
      // The CLI asks, then ends without waiting for the answer.
      out({ type: "control_request", request_id: "r-gone", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t-gone" } });
      setTimeout(() => process.exit(3), 200);
      return;
    }
    if (scenario === "claude-hang") {
      record({ prompt });
      const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(options.pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
      out({ type: "control_request", request_id: "r-hang", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "sleep 100" }, tool_use_id: "t-hang" } });
      hold();
      return;
    }
    out({ type: "assistant", uuid: "a1", message: { model: "claude-test", content: [{ type: "text", text: "I will run a command." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] } });
    out({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" }, tool_use_id: "t1" } });
    const response = JSON.parse(await next());
    const decision = response.response.response;
    record({ prompt, response });
    if (decision.behavior === "allow") {
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi\n" }] } });
      out({ type: "assistant", uuid: "a2", message: { model: "claude-test", content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "docs/new.md", content: "x" } }] } });
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] }, tool_use_result: { type: "create" } });
      out({ type: "assistant", uuid: "a3", message: { model: "claude-test", content: [{ type: "text", text: "ran it" }] } });
    } else {
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: decision.message, is_error: true }] } });
      out({ type: "assistant", uuid: "a4", message: { model: "claude-test", content: [{ type: "text", text: `denied: ${decision.message}` }] } });
    }
    out({ type: "result", subtype: "success", is_error: false, result: "finished" });
  })();
}

// The copy of the Node binary saved as an ACP CLI (Mistral Vibe's `vibe-acp`) is a stand-in ACP agent.
if (path.basename(process.execPath).toLowerCase().replace(/\.exe$/, "") === "vibe-acp") await import("./fake-acp-agent.mjs");
else if (options.scenario.startsWith("claude") || (options.scenario === "auto" && args.includes("--print"))) claude();
else void codex();
