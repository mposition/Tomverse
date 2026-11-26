/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FakeGateway, TEST_KEY, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, tempDir } from "./helpers.js";

/** The built CLI as a user runs it (see cli.process.test.ts): orchestration is off until the person turns it on in the config. */
const CLI = process.env.TOMVERSE_CLI_BIN ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const [PROGRAM, PROGRAM_ARGS] = CLI.endsWith(".js") ? [process.execPath, [CLI]] : [CLI, []];
const skip = !existsSync(CLI) && "build first";

const run = (args: string[], options: { cwd: string; home: string; env?: Record<string, string> }) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(TOMVERSE_|OPENAI_|AI_GATEWAY)/.test(k)) env[k] = v;
        delete env.CLAUDE_CONFIG_DIR;
        Object.assign(env, { TOMVERSE_HOME: options.home, HOME: options.home, USERPROFILE: options.home }, options.env ?? {});
        const child = spawn(PROGRAM, [...PROGRAM_ARGS, ...args], { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

const jsonl = (text: string) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("config: orchestration is off until turned on, says what it may use, and keeps its numbers in range", { skip }, async () => {
    const home = tempDir("home");
    const cwd = tempDir("cwd");
    const config = async (...args: string[]) => run(["config", ...args], { cwd, home });
    const on = await config("set", "orchestrate", "on");
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /up to 3 subagents at once, 90 requests in all/);
    assert.equal((await config("set", "orchestrate-max-subagents", "2")).code, 0);
    assert.equal((await config("set", "orchestrate-max-requests", "40")).code, 0);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.deepEqual([saved.orchestrate, saved.orchestrateMaxSubagents, saved.orchestrateMaxRequests], [true, 2, 40]);
    for (const [key, value] of [["orchestrate-max-subagents", "50"], ["orchestrate-max-requests", "1"], ["orchestrate-max-requests", "many"], ["orchestrate", "maybe"]]) {
        const bad = await config("set", key!, value!);
        assert.equal(bad.code, 2, `${key} ${value}`);
    }
    assert.equal((await config("unset", "orchestrate")).code, 0);
    assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).orchestrate, undefined);
});

test("exec with orchestration on: the limits are in the run's events, subtasks run, and the result carries one summary per subtask", { skip }, async () => {
    const gateway = await new FakeGateway({
        script: (body) => {
            const system = String(body.messages?.[0]?.content);
            if (/subagent of Tomverse CLI/.test(system)) return { text: `Report: ${String(body.messages.find((m: any) => m.role === "user")?.content)}` };
            return toolResultsSinceUser(body).length
                ? { text: "Both subtasks are in." }
                : { toolCalls: [{ name: "delegate", args: { subtasks: [{ title: "Part one", goal: "ONE" }, { title: "Part two", goal: "TWO" }] } }] };
        },
    }).start();
    try {
        const home = tempDir("home");
        const root = makeRepo();
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, "config.json"), JSON.stringify({ endpoint: gateway.base, allowInsecureLocalhost: true, model: "fake-coder", trustedRoots: [root], orchestrate: true, orchestrateMaxSubagents: 2, orchestrateMaxRequests: 40 }));
        const result = await run(["exec", "--json", "--read-only", "--max-requests", "30", "Look at both parts"], { cwd: root, home, env: { TOMVERSE_API_KEY: TEST_KEY } });
        assert.equal(result.code, 0, result.stderr);
        const events = jsonl(result.stdout);
        assert.ok(events.some((event) => event.type === "orchestration" && event.max_subagents === 2 && event.max_requests === 40));
        assert.deepEqual(events.filter((event) => event.type === "subtask_updated" && event.state === "success").map((event) => event.id).length, 2);
        assert.equal(events.at(-1).status, "success");
        const main = gateway.completions.filter((c) => !/subagent of Tomverse CLI/.test(String(c.body.messages[0].content))).at(-1)!.body;
        const delegateResult = JSON.parse(main.messages.filter((m: any) => m.role === "tool").at(-1).content);
        assert.deepEqual(delegateResult.results.map((row: any) => [row.title, row.status]), [["Part one", "success"], ["Part two", "success"]]);
        assert.match(String(gateway.completions[0]!.body.messages[0].content), /Orchestration is on \(up to 2 subagents at once, 40 requests in all/);
    } finally {
        await gateway.stop();
    }
});

test("without the setting, delegate has no subtasks and nothing is announced", { skip }, async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
    try {
        const home = tempDir("home");
        const root = makeRepo();
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, "config.json"), JSON.stringify({ endpoint: gateway.base, allowInsecureLocalhost: true, model: "fake-coder", trustedRoots: [root] }));
        const result = await run(["exec", "--json", "--read-only", "hi"], { cwd: root, home, env: { TOMVERSE_API_KEY: TEST_KEY } });
        assert.equal(result.code, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /Orchestration/);
        const schema = gateway.completions[0]!.body.tools.find((t: any) => t.function.name === "delegate").function.parameters;
        assert.deepEqual(Object.keys(schema.properties).sort(), ["kind", "tasks"]);
    } finally {
        await gateway.stop();
    }
});
