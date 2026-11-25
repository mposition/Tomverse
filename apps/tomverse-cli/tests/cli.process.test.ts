/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FakeGateway, TEST_KEY, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, tempDir } from "./helpers.js";

/**
 * The built CLI as a user runs it: a separate process, its stdout/stderr and
 * exit code. Run after `npm run build` (npm run cli:test does both).
 * TOMVERSE_CLI_BIN may name an installed cli.js or a standalone executable
 * (`npm run build:binary`); an executable is started directly, without node.
 */
const CLI = process.env.TOMVERSE_CLI_BIN ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const [PROGRAM, PROGRAM_ARGS] = CLI.endsWith(".js") ? [process.execPath, [CLI]] : [CLI, []];
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

type Run = { code: number | null; stdout: string; stderr: string };
const run = (args: string[], options: { cwd: string; env?: Record<string, string | undefined>; home: string }) =>
    new Promise<Run>((resolve) => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(TOMVERSE_|OPENAI_|AI_GATEWAY)/.test(k)) env[k] = v;
        Object.assign(env, { TOMVERSE_HOME: options.home }, options.env ?? {});
        for (const [k, v] of Object.entries(options.env ?? {})) if (v === undefined) delete env[k];
        const child = spawn(PROGRAM, [...PROGRAM_ARGS, ...args], { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

const jsonl = (text: string) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const setup = (gateway: FakeGateway, trust = true) => {
    const home = tempDir("home");
    const root = makeRepo();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ endpoint: gateway.base, allowInsecureLocalhost: true, model: "fake-coder", trustedRoots: trust ? [root] : [] }));
    return { home, root, env: { TOMVERSE_API_KEY: TEST_KEY } };
};

test("--version and --help work from the built package", { skip: !existsSync(CLI) && "build first" }, async () => {
    const home = tempDir("home");
    const version = await run(["--version"], { cwd: home, home });
    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), pkg.version);
    const help = await run(["--help"], { cwd: home, home });
    assert.equal(help.code, 0);
    for (const word of ["exec", "resume", "models", "usage", "sessions", "diff", "undo", "doctor", "--read-only", "--max-requests", "--no-persist", "Exit codes"]) assert.ok(help.stdout.includes(word), word);
    const bad = await run(["--no-such-flag"], { cwd: home, home });
    assert.equal(bad.code, 2);
});

test("exec --json: read-only task, JSON lines only on stdout, exit 0, receipts summed", async () => {
    const gateway = await new FakeGateway({ script: (body) => (toolResultsSinceUser(body).length ? { text: "sum subtracts" } : { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] }) }).start();
    try {
        const { home, root, env } = setup(gateway);
        const result = await run(["exec", "--json", "--read-only", "--effort", "high", "What does sum do?"], { cwd: root, home, env });
        assert.equal(result.code, 0, result.stderr);
        const events = jsonl(result.stdout);
        assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), ["assistant", "effort", "final", "request", "response", "session", "tool_result"].sort());
        const final = events.at(-1);
        assert.equal(final.type, "final");
        assert.equal(final.status, "success");
        assert.equal(final.exit_code, 0);
        assert.equal(final.cost.requests, 2);
        assert.equal(final.cost.charged, 6, "two requests at 3 credits each, from the server's receipts");
        assert.ok(!result.stdout.includes(TEST_KEY) && !result.stderr.includes(TEST_KEY.slice(13)));
        // The three read tools and delegate (explore subagents only: a read-only session has nothing a worker could change).
        assert.deepEqual(gateway.completions.map((c) => c.body.tools.map((t: any) => t.function.name).sort()), [["delegate", "list_files", "read_file", "search_text"], ["delegate", "list_files", "read_file", "search_text"]]);
        assert.deepEqual(gateway.completions.map((c) => c.body.tomverse_effort), ["high", "high"]);
    } finally {
        await gateway.stop();
    }
});

test("exec stops with exit 3 at the first approval and leaves files as they were", async () => {
    const gateway = await new FakeGateway({
        script: () => ({ toolCalls: [{ name: "run_command", args: { command: "echo pwned > pwned.txt" } }] }),
    }).start();
    try {
        const { home, root, env } = setup(gateway);
        const result = await run(["exec", "--json", "Run something"], { cwd: root, home, env });
        assert.equal(result.code, 3, result.stderr);
        const events = jsonl(result.stdout);
        const approval = events.find((e) => e.type === "approval_required");
        assert.equal(approval.tool, "run_command");
        assert.equal(approval.command.mode, "shell");
        assert.equal(approval.command.display, "echo pwned > pwned.txt");
        assert.equal(events.at(-1).status, "needs_approval");
        assert.equal(existsSync(join(root, "pwned.txt")), false);
        // The session is resumable and listed.
        const list = await run(["sessions", "list", "--json"], { cwd: root, home, env });
        assert.equal(jsonl(list.stdout)[0].status, "needs_approval");
        // Resuming without a terminal still cannot approve.
        const resumed = await run(["resume", events[0].session_id, "--json"], { cwd: root, home, env });
        assert.equal(resumed.code, 3);
        assert.equal(existsSync(join(root, "pwned.txt")), false);
    } finally {
        await gateway.stop();
    }
});

test("an untrusted folder, a missing key and a plain-http endpoint stop before any model request", async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "x" }) }).start();
    try {
        const untrusted = setup(gateway, false);
        assert.equal((await run(["exec", "hi"], { cwd: untrusted.root, home: untrusted.home, env: untrusted.env })).code, 3);
        const trusted = setup(gateway);
        const noKey = await run(["exec", "hi"], { cwd: trusted.root, home: trusted.home, env: { TOMVERSE_API_KEY: undefined } });
        assert.equal(noKey.code, 1);
        assert.match(noKey.stderr, /TOMVERSE_API_KEY/);
        writeFileSync(join(trusted.home, "config.json"), JSON.stringify({ endpoint: gateway.base, model: "fake-coder", trustedRoots: [trusted.root] }));
        const http = await run(["exec", "hi"], { cwd: trusted.root, home: trusted.home, env: trusted.env });
        assert.equal(http.code, 1);
        assert.match(http.stderr, /allow-insecure-localhost/);
        writeFileSync(join(trusted.home, "config.json"), JSON.stringify({ endpoint: "http://example.com/api/v1", allowInsecureLocalhost: true, model: "fake-coder", trustedRoots: [trusted.root] }));
        assert.match((await run(["exec", "hi"], { cwd: trusted.root, home: trusted.home, env: trusted.env })).stderr, /must use https/);
        assert.equal(gateway.completions.length, 0);
    } finally {
        await gateway.stop();
    }
});

test("a redirect is never followed, so the key never reaches another host", async () => {
    const elsewhere: string[] = [];
    const other = createServer((req, res) => {
        elsewhere.push(String(req.headers.authorization ?? ""));
        res.end("{}");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherPort = (other.address() as { port: number }).port;
    const redirector = createServer((req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${otherPort}${req.url}` });
        res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    try {
        const home = tempDir("home");
        const root = makeRepo();
        writeFileSync(join(home, "config.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${(redirector.address() as { port: number }).port}/api/v1`, allowInsecureLocalhost: true, model: "fake-coder", trustedRoots: [root] }));
        const result = await run(["models"], { cwd: root, home, env: { TOMVERSE_API_KEY: TEST_KEY } });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /redirect/);
        assert.deepEqual(elsewhere, []);
    } finally {
        other.close();
        redirector.close();
    }
});

test("doctor and models make no model request; usage --session sums only this session's receipts", async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "hello" }) }).start();
    try {
        const { home, root, env } = setup(gateway);
        const doctor = await run(["doctor", "--json"], { cwd: root, home, env });
        assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
        const checks = jsonl(doctor.stdout);
        for (const name of ["node", "endpoint", "key", "models", "credits", "recovery", "folder"]) assert.ok(checks.some((c) => c.name === name), name);
        assert.ok(!checks.some((c) => c.status === "fail"), JSON.stringify(checks));
        assert.ok(checks.find((c) => c.name === "key").detail.includes("tvk_abcdefgh_…"));
        assert.match(checks.find((c) => c.name === "key").detail, /from TOMVERSE_API_KEY/);
        const models = jsonl((await run(["models", "--json"], { cwd: root, home, env })).stdout);
        assert.deepEqual(models.map((m) => m.id), ["fake-coder", "fake-small", "smart-adaptive"]);
        assert.equal(gateway.completions.length, 0, "no generation, no charge");

        const exec = jsonl((await run(["exec", "--json", "--read-only", "hi"], { cwd: root, home, env })).stdout);
        const sessionId = exec[0].session_id;
        // Another client spends on the same key meanwhile: not this session's cost.
        gateway.receipts.set("req_other", { requestId: "req_other", idempotencyKey: null, status: "settled", chargedCredits: 50, heldCredits: 0, modelId: "fake-coder" });
        const usage = jsonl((await run(["usage", "--session", sessionId, "--json"], { cwd: root, home, env })).stdout);
        const cost = usage.find((e) => e.type === "session_cost");
        assert.equal(cost.requests, 1);
        assert.equal(cost.charged, 3);
    } finally {
        await gateway.stop();
    }
});

test("a session is resumed only with the key that started it", async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "x" }) }).start();
    try {
        const { home, root, env } = setup(gateway);
        const first = jsonl((await run(["exec", "--json", "--read-only", "hi"], { cwd: root, home, env })).stdout);
        const before = gateway.completions.length;
        const otherKey = `tvk_zzzzzzzz_${"Q".repeat(43)}`;
        const resumed = await run(["resume", first[0].session_id, "--json", "again"], { cwd: root, home, env: { TOMVERSE_API_KEY: otherKey } });
        assert.equal(resumed.code, 2);
        assert.match(resumed.stderr, /belongs to key tvk_abcdefgh/);
        assert.equal(gateway.completions.length, before);
    } finally {
        await gateway.stop();
    }
});
test("project memory: the agent keeps a note, `memory show` and `memory clear` manage it, and `config set memory off` stops reading and writing", { skip: !existsSync(CLI) && "build first" }, async () => {
    const gateway = await new FakeGateway({
        script: (body) => (body.messages.some((m: any) => m.role === "tool")
            ? { text: "Noted." }
            : { toolCalls: [{ name: "remember_fact", args: { fact: "Use the staging database for integration tests." } }] }),
    }).start();
    try {
        const { home, root, env } = setup(gateway);
        const exec = (task: string) => run(["exec", task], { cwd: root, home, env });
        assert.equal((await exec("Remember how to test.")).code, 0);
        const shown = await run(["memory", "show"], { cwd: root, home });
        assert.match(shown.stdout, /m-[0-9a-f]{8}  Use the staging database for integration tests\./);
        // Another folder has its own, empty memory.
        assert.match((await run(["memory", "show"], { cwd: tempDir("elsewhere"), home })).stdout, /Nothing is remembered/);
        // The next task's first request carries the note.
        gateway.completions.length = 0;
        await exec("Another task.");
        assert.match(gateway.completions[0]!.body.messages[0].content, /<project-memory>\n- Use the staging database/);
        // Off: not read, not offered, not written.
        assert.equal((await run(["config", "set", "memory", "off"], { cwd: root, home })).code, 0);
        gateway.completions.length = 0;
        await exec("A third task.");
        assert.ok(!/project-memory/.test(gateway.completions[0]!.body.messages[0].content));
        assert.ok(!gateway.completions[0]!.body.tools.some((t: any) => t.function.name === "remember_fact"));
        assert.match((await run(["memory", "show"], { cwd: root, home })).stdout, /Memory is off/);
        assert.equal((await run(["config", "set", "memory", "maybe"], { cwd: root, home })).code, 2);
        // Delete.
        assert.equal((await run(["config", "unset", "memory"], { cwd: root, home })).code, 0);
        assert.equal((await run(["memory", "clear", "--yes"], { cwd: root, home })).code, 0);
        assert.match((await run(["memory", "show"], { cwd: root, home })).stdout, /Nothing is remembered/);
    } finally {
        await gateway.stop();
    }
});

test("sessions fork copies a saved session into a new one, and says which turns it holds", { skip: !existsSync(CLI) && "build first" }, async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "sum subtracts" }) }).start();
    try {
        const { home, root, env } = setup(gateway);
        const first = await run(["exec", "--json", "--read-only", "What does sum do?"], { cwd: root, home, env });
        assert.equal(first.code, 0, first.stderr);
        const id = jsonl(first.stdout).at(-1).session_id as string;
        const forked = await run(["sessions", "fork", id, "--json"], { cwd: root, home, env });
        assert.equal(forked.code, 0, forked.stderr);
        const event = jsonl(forked.stdout).find((e) => e.type === "session_forked");
        assert.equal(event.from, id);
        assert.equal(event.turns, 1);
        assert.notEqual(event.session_id, id);
        const listed = jsonl((await run(["sessions", "list", "--json"], { cwd: root, home, env })).stdout);
        assert.deepEqual(listed.map((s) => s.id).sort(), [id, event.session_id].sort());
        // A turn that does not exist is refused, and the original is untouched.
        const bad = await run(["sessions", "fork", id, "--turn", "2"], { cwd: root, home, env });
        assert.equal(bad.code, 1);
        assert.match(bad.stderr, /from 1 to 1/);
        assert.equal((await run(["sessions", "fork"], { cwd: root, home, env })).code, 2);
    } finally {
        await gateway.stop();
    }
});
