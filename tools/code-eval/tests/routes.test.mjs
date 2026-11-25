import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, runNode } from "./helpers.mjs";
import { ROUTE_NAMES, getRoute } from "../routes/index.mjs";
import { buildCodexArgs, parseCodexEvents } from "../routes/codex.mjs";
import { ALLOWED_TOOLS, DEFAULT_MAX_BUDGET_USD, DISALLOWED_TOOLS, buildClaudeArgs, parseClaudeResult } from "../routes/claude.mjs";
import { ENGINE_FEATURES, buildWorkerRequest, parseEngineFeatures } from "../routes/tomverse.mjs";
import { decideApproval, isInside } from "../routes/tomverse-approval.mjs";
import { envWithout, runProcess } from "../lib/proc.mjs";

test("route registry", () => {
    assert.deepEqual(ROUTE_NAMES, ["fake", "noop", "tomverse", "codex", "claude"]);
    for (const name of ["fake", "noop"]) assert.equal(getRoute(name).paid, false);
    for (const name of ["tomverse", "codex", "claude"]) {
        const route = getRoute(name);
        assert.equal(route.paid, true);
        assert.match(route.paidNotice, new RegExp(`^route ${name} `));
        assert.equal(typeof route.preflight, "function");
    }
    assert.throws(() => getRoute("nope"), /Unknown route "nope"/);
});

test("codex arguments: workspace-write sandbox, prompt on stdin, no bypass flags", () => {
    const args = buildCodexArgs({ model: "some-model" });
    assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(args.at(-1), "-");
    assert.equal(args[args.indexOf("--model") + 1], "some-model");
    assert.ok(!args.some((a) => /dangerously|danger-full-access|bypass/.test(a)));
    assert.ok(!buildCodexArgs().includes("--model"));
});

test("codex events are summed and failures surface", () => {
    const text = [
        "not json",
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 3 } }),
    ].join("\n");
    assert.deepEqual(parseCodexEvents(text), { metrics: { inputTokens: 150, cachedInputTokens: 40, outputTokens: 10, turns: 2 }, error: null });
    assert.deepEqual(parseCodexEvents(""), { metrics: {}, error: null });
    assert.equal(parseCodexEvents(JSON.stringify({ type: "turn.failed", error: { message: "quota" } })).error, "quota");
    assert.equal(parseCodexEvents(JSON.stringify({ type: "error", message: "bad" })).error, "bad");
});

test("claude arguments: edits and tests only, no prompts, a spending cap", () => {
    const args = buildClaudeArgs({ model: "m" });
    assert.ok(args.includes("-p"));
    assert.equal(args[args.indexOf("--output-format") + 1], "json");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
    assert.equal(args[args.indexOf("--max-budget-usd") + 1], String(DEFAULT_MAX_BUDGET_USD));
    assert.equal(args[args.indexOf("--model") + 1], "m");
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(!args.some((a) => /dangerously|bypassPermissions/.test(a)));
    const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
    assert.deepEqual(allowed, ALLOWED_TOOLS);
    assert.ok(allowed.includes("Edit") && allowed.includes("Bash(node *)"));
    assert.ok(!allowed.some((tool) => /^(Bash\((curl|rm|git push|npm install)|WebFetch|WebSearch)/.test(tool)));
    assert.deepEqual(args[args.indexOf("--disallowedTools") + 1].split(","), DISALLOWED_TOOLS);
    assert.equal(buildClaudeArgs({ maxBudgetUsd: 3 })[buildClaudeArgs({ maxBudgetUsd: 3 }).indexOf("--max-budget-usd") + 1], "3");
});

test("claude result parsing", () => {
    const result = { type: "result", subtype: "success", is_error: false, num_turns: 4, total_cost_usd: 0.12, result: "done", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 90, output_tokens: 20 } };
    const expected = { metrics: { inputTokens: 15, cachedInputTokens: 90, outputTokens: 20, costUsd: 0.12, turns: 4 }, error: null };
    assert.deepEqual(parseClaudeResult(JSON.stringify(result)), expected);
    assert.deepEqual(parseClaudeResult(JSON.stringify([{ type: "system" }, result])), expected);
    assert.equal(parseClaudeResult(JSON.stringify({ ...result, is_error: true, result: "limit" })).error, "limit");
    assert.equal(parseClaudeResult("garbage").error, "output was not JSON");
});

test("no real route puts the prompt or a key into argv", () => {
    for (const args of [buildCodexArgs(), buildClaudeArgs()]) assert.ok(args.every((a) => a.length < 200));
    const request = buildWorkerRequest({ prompt: "p", workDir: "w", resultFile: "r", timeoutMs: 5, model: null, maxRequests: undefined });
    assert.deepEqual(Object.keys(request).sort(), ["commandTimeoutMs", "engine", "limits", "maxRequests", "model", "prompt", "resultFile", "timeoutMs", "workDir"]);
    assert.ok(!JSON.stringify(request).includes("tvk_"));
});

test("the worker request carries the engine conditions: extended limits and every engine feature by default", () => {
    const base = { prompt: "p", workDir: "w", resultFile: "r", timeoutMs: 5 };
    const request = buildWorkerRequest(base);
    assert.equal(request.limits, "extended");
    assert.deepEqual(request.engine, ["backgroundCommands", "images", "nestedInstructions", "subagents"]);
    assert.equal(request.maxRequests, null, "without --max-requests the profile decides the request count");
    assert.equal(buildWorkerRequest({ ...base, maxRequests: 7, limits: "standard", engine: [] }).maxRequests, 7);
    assert.throws(() => buildWorkerRequest({ ...base, limits: "huge" }), /--limits must be one of/);
});

test("--engine takes none or a list of the features a measurement may turn on, never web or memory", () => {
    assert.deepEqual(parseEngineFeatures(undefined), ENGINE_FEATURES);
    assert.deepEqual(parseEngineFeatures("none"), []);
    assert.deepEqual(parseEngineFeatures("subagents, images"), ["images", "subagents"]);
    for (const bad of ["web", "memory", "subagents,web_fetch", "", ","]) assert.throws(() => parseEngineFeatures(bad), /--engine takes/, bad);
    assert.ok(!ENGINE_FEATURES.some((name) => /web|memory/i.test(name)));
});

test("approval policy: only inside the working folder", () => {
    const root = join(ROOT, "work");
    assert.equal(isInside(root, "src/a.js"), true);
    assert.equal(isInside(root, join(root, "src", "a.js")), true);
    assert.equal(isInside(root, "../other/a.js"), false);
    assert.equal(isInside(root, ROOT), false);
    const patch = (...paths) => ({ patch: paths.map((path) => ({ path, action: "update" })) });
    assert.equal(decideApproval(patch("src/a.js", "test/b.test.mjs"), root).approved, true);
    assert.equal(decideApproval(patch("src/a.js", "../outside.js"), root).approved, false);
    assert.equal(decideApproval({ error: "bad input", patch: [] }, root).approved, false);
    assert.equal(decideApproval({}, root).approved, false);
});

test("approval policy for commands", () => {
    const root = join(ROOT, "work");
    const command = (display, cwd = root, args = []) => ({ command: { display, cwd, args, file: "node", mode: "argv" } });
    for (const ok of ["node --test", "node -e \"console.log(1)\"", "git diff", "git status --short", "ls src"]) {
        assert.equal(decideApproval(command(ok), root).approved, true, ok);
    }
    for (const bad of ["curl https://example.com", "wget x", "git push origin main", "npm install left-pad", "npx something", "pip install x", "rm -rf /", "rm -rf ../x", "ssh host", "sudo ls", "Invoke-WebRequest http://x"]) {
        assert.equal(decideApproval(command(bad), root).approved, false, bad);
    }
    assert.equal(decideApproval(command("node --test", join(root, "..")), root).approved, false);
    assert.equal(decideApproval(command("node", root, ["-e", "fetch(1)", "git push"]), root).approved, false);
});

test("the tomverse worker loads the runtime offline (no model request)", () => {
    const run = runNode([join(ROOT, "routes", "tomverse-worker.mjs"), "--selftest"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /selftest ok/);
});

test("the key is never written by any harness file", () => {
    const files = [...readdirSync(join(ROOT, "routes")).map((f) => join(ROOT, "routes", f)), join(ROOT, "run.mjs"), join(ROOT, "lib", "proc.mjs")];
    for (const file of files) {
        if (!file.endsWith(".mjs")) continue;
        const text = readFileSync(file, "utf8");
        assert.ok(!/writeFileSync\([^)]*(KEY|key)/.test(text), file);
        assert.ok(!/console\.(log|error)\([^)]*process\.env\.TOMVERSE_API_KEY/.test(text), file);
    }
    const worker = readFileSync(join(ROOT, "routes", "tomverse-worker.mjs"), "utf8");
    assert.match(worker, /delete process\.env\.TOMVERSE_API_KEY/);
});

test("runProcess: output, stdin, exit code and timeout with a process tree kill", async () => {
    const ok = await runProcess({ file: process.execPath, args: ["-e", "process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase()))"], input: "abc" });
    assert.deepEqual([ok.code, ok.stdout, ok.timedOut], [0, "ABC", false]);
    const failed = await runProcess({ file: process.execPath, args: ["-e", "console.error('x');process.exit(3)"] });
    assert.deepEqual([failed.code, failed.stderr.trim()], [3, "x"]);
    const started = Date.now();
    const slow = await runProcess({ file: process.execPath, args: ["-e", "setTimeout(()=>{},30000)"], timeoutMs: 400 });
    assert.equal(slow.timedOut, true);
    assert.ok(Date.now() - started < 10_000);
    const missing = await runProcess({ file: "definitely-not-a-program-xyz" });
    assert.ok(missing.spawnError);
});

test("envWithout removes names case-insensitively on Windows", () => {
    const env = envWithout(["TOMVERSE_API_KEY"], { A: "1", TOMVERSE_API_KEY: "secret" });
    assert.deepEqual(env, { A: "1" });
});
