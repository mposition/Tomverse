// Runs the codex and claude adapters against stand-in programs that only copy a
// task's solution. This checks the plumbing (how the programs are started,
// what they receive on stdin and argv, what environment they see, timeouts and
// result parsing). It cannot check that the real CLIs behave the same way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runJob } from "../run.mjs";
import { loadTask } from "../lib/tasks.mjs";
import { quoteForCmd } from "../lib/proc.mjs";
import { route as claude, buildClaudeArgs } from "../routes/claude.mjs";
import { route as codex, buildCodexArgs } from "../routes/codex.mjs";
import { tempDir } from "./helpers.mjs";

const sandbox = tempDir("code-eval-adapters-");
const agentScript = join(sandbox.dir, "fake-agent.mjs");

const AGENT = `
import { appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const kind = process.argv[2];
const args = process.argv.slice(3);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ kind, args, prompt, cwd: process.cwd(), hasKey: "TOMVERSE_API_KEY" in process.env, hasClaudeCode: "CLAUDECODE" in process.env }) + "\\n");
const mode = process.env.FAKE_MODE ?? "solve";
if (mode === "hang") setTimeout(() => {}, 60000);
else {
    if (mode === "solve") cpSync(join(process.env.FAKE_SOLUTION, "."), process.cwd(), { recursive: true, force: true });
    if (kind === "codex") {
        if (mode === "fail") console.log(JSON.stringify({ type: "turn.failed", error: { message: "model refused" } }));
        else console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } }));
        process.exit(mode === "fail" ? 1 : 0);
    }
    console.log(JSON.stringify({ type: "result", is_error: mode === "fail", result: "done", num_turns: 3, total_cost_usd: 0.42, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 90, output_tokens: 5 } }));
}
`;

// A launcher that works the way the real CLIs are installed: a .cmd shim on
// Windows (started through cmd.exe) and a plain script elsewhere.
const launcher = (kind) => {
    const target = join(sandbox.dir, process.platform === "win32" ? `fake-${kind}.cmd` : `fake-${kind}`);
    const node = process.execPath;
    if (process.platform === "win32") writeFileSync(target, `@echo off\r\n"${node}" "${agentScript}" ${kind} %*\r\n`);
    else {
        writeFileSync(target, `#!/bin/sh\nexec "${node}" "${agentScript}" ${kind} "$@"\n`);
        chmodSync(target, 0o755);
    }
    return target;
};

let codexBin;
let claudeBin;
before(() => {
    writeFileSync(agentScript, AGENT);
    codexBin = launcher("codex");
    claudeBin = launcher("claude");
});
after(() => sandbox.dispose());

const environment = (mode = "solve") => {
    const log = join(sandbox.dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
    const task = loadTask("bf-pagination");
    return {
        task,
        log,
        env: {
            ...process.env,
            TOMVERSE_API_KEY: "tvk_aaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            CLAUDECODE: "1",
            CODE_EVAL_CODEX_BIN: codexBin,
            CODE_EVAL_CLAUDE_BIN: claudeBin,
            FAKE_LOG: log,
            FAKE_MODE: mode,
            FAKE_SOLUTION: join(task.dir, "solution"),
        },
    };
};
const calls = (log) => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("codex adapter: argv, stdin prompt, working folder, environment and result", async () => {
    const { task, env, log } = environment();
    const record = await runJob({ route: codex, task, options: { model: "some-model" }, env });
    assert.equal(record.adapterStatus, "ok", record.adapterError);
    assert.equal(record.passed, true, record.checkOutputTail);
    assert.deepEqual(record.metrics, { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, turns: 1 });
    const [call] = calls(log);
    assert.deepEqual(call.args, buildCodexArgs({ model: "some-model" }));
    assert.equal(call.prompt, task.prompt);
    assert.match(call.cwd.replaceAll("\\", "/"), /code-eval-[^/]+\/work$/);
    assert.equal(call.hasKey, false, "the Tomverse key must not reach another tool");
});

test("claude adapter: arguments with spaces and parentheses arrive intact", async () => {
    const { task, env, log } = environment();
    const record = await runJob({ route: claude, task, options: {}, env });
    assert.equal(record.adapterStatus, "ok", record.adapterError);
    assert.equal(record.passed, true, record.checkOutputTail);
    assert.deepEqual(record.metrics, { inputTokens: 10, cachedInputTokens: 90, outputTokens: 5, costUsd: 0.42, turns: 3 });
    const [call] = calls(log);
    assert.deepEqual(call.args, buildClaudeArgs());
    assert.equal(call.prompt, task.prompt);
    assert.equal(call.hasKey, false);
    assert.equal(call.hasClaudeCode, false, "a measurement must not look like a nested Claude Code session");
});

test("a failing tool is recorded as an adapter error and the folder is still checked", async () => {
    for (const route of [codex, claude]) {
        const { task, env } = environment("fail");
        const record = await runJob({ route, task, options: {}, env });
        assert.equal(record.adapterStatus, "error", route.name);
        assert.equal(record.passed, false, route.name);
        assert.ok(record.adapterError, route.name);
    }
});

test("a tool that does nothing fails the task but is not an adapter error", async () => {
    const { task, env } = environment("idle");
    const record = await runJob({ route: codex, task, options: {}, env });
    assert.equal(record.adapterStatus, "ok");
    assert.equal(record.passed, false);
    assert.equal(record.changedFiles, 0);
});

test("a hung tool is stopped at the task time limit", async () => {
    const { task, env } = environment("hang");
    const started = Date.now();
    const record = await runJob({ route: codex, task: { ...task, timeoutSeconds: 2 }, options: {}, env });
    assert.equal(record.adapterStatus, "timeout");
    assert.equal(record.passed, false);
    assert.ok(Date.now() - started < 30_000);
});

test("preflight finds the override and reports a missing tool", () => {
    assert.equal(codex.preflight({ CODE_EVAL_CODEX_BIN: codexBin }), null);
    assert.equal(claude.preflight({ CODE_EVAL_CLAUDE_BIN: claudeBin }), null);
    assert.match(codex.preflight({ PATH: "", Path: "" }) ?? "", /codex CLI was not found/);
});

test("quoteForCmd leaves plain words alone and quotes the rest", () => {
    assert.equal(quoteForCmd("--sandbox"), "--sandbox");
    assert.equal(quoteForCmd("C:\\tools\\codex.cmd"), "C:\\tools\\codex.cmd");
    assert.equal(quoteForCmd("Bash(node *)"), '"Bash(node *)"');
    assert.equal(quoteForCmd("a,b"), "a,b");
    assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});
