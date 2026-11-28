/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ApprovalView, Prompter } from "../src/agent.js";
import { startLocalExtensions } from "../src/local-extensions.js";
import { HookRunner, loadHooks, matches, parseHooks } from "../src/hooks.js";
import { openProjectTrust } from "../src/project-trust.js";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, tempDir } from "./helpers.js";

/** Writes a Node script that has `input` (the stdin JSON, parsed) and `log(file, text)`; returns the command that runs it. */
const script = (dir: string, name: string, body: string) => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, `import { appendFileSync, readFileSync } from "node:fs";\nconst raw = readFileSync(0, "utf8");\nconst input = JSON.parse(raw);\nconst log = (file, text) => appendFileSync(file, text + "\\n");\n${body}\n`);
    const node = process.execPath;
    return process.platform === "win32" ? `& "${node}" "${file}"` : `"${node}" "${file}"`;
};

const settings = (events: Record<string, Array<{ matcher?: string; command: string; timeout?: number }>>) => ({
    hooks: Object.fromEntries(Object.entries(events).map(([event, list]) => [event, list.map((h) => ({ ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
        hooks: [{ type: "command", command: h.command, ...(h.timeout ? { timeout: h.timeout } : {}) }] }))])),
});

const userHooks = (home: string, events: Parameters<typeof settings>[0]) => writeFileSync(join(home, "hooks.json"), JSON.stringify(settings(events)));
const projectHooks = (root: string, events: Parameters<typeof settings>[0]) => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings(events)));
};
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const noPrompt: Prompter = { approve: async () => { throw new Error("nobody should be asked"); }, confirm: async () => false };

test("the Claude Code and Codex files are read; matchers follow Claude Code's rules; only command hooks load", () => {
    const problems: string[] = [];
    const claude = parseHooks({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a", timeout: 5 }, { type: "http", url: "https://x" }, { type: "prompt", prompt: "p" }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: "ignored: not one of the six events" }] }], UserPromptSubmit: [{ hooks: [{ command: "b" }] }] } }, "project", "settings.json", problems);
    assert.deepEqual(claude.map((h) => [h.event, h.matcher, h.command, h.timeoutSec]), [["PreToolUse", "Bash", "a", 5], ["UserPromptSubmit", "", "b", 30]]);
    assert.match(problems.join(), /2 hook\(s\) were not loaded/);
    // Codex's hooks.json has the same shape, with the table at the top.
    const codex = parseHooks({ PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "c", timeout: 9999 }] }] }, "project", "hooks.json", []);
    assert.deepEqual(codex.map((h) => [h.event, h.timeoutSec]), [["PostToolUse", 600]], "the timeout is capped");
    assert.ok(matches("", "x") && matches("*", "x") && matches("Edit|Write", "Write") && !matches("Edit|Write", "NotebookEdit"));
    assert.ok(matches("Edit.*", "NotebookEdit") && !matches("^Edit$", "NotebookEdit") && matches("mcp__memory__.*", "mcp__memory__store") && !matches("mcp__memory", "mcp__memory__store"));
    assert.ok(!matches("(", "x"), "an invalid expression matches nothing");
});

test("user hooks are the person's own; project hooks come from the folder's .claude and .codex files; one hook defined twice loads once", () => {
    const home = tempDir("hook-home");
    const claude = tempDir("hook-claude");
    const root = tempDir("hook-root");
    userHooks(home, { Stop: [{ command: "same" }] });
    writeFileSync(join(claude, "settings.json"), JSON.stringify(settings({ Stop: [{ command: "same" }], SessionStart: [{ command: "mine" }] })));
    projectHooks(root, { PreToolUse: [{ matcher: "run_command", command: "repo" }] });
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "hooks.json"), JSON.stringify(settings({ PostToolUse: [{ command: "codex" }] })));
    const { hooks } = loadHooks(root, { tomverse: home, claude });
    assert.deepEqual(hooks.map((h) => [h.scope, h.event, h.command]), [["user", "Stop", "same"], ["user", "SessionStart", "mine"], ["project", "PreToolUse", "repo"], ["project", "PostToolUse", "codex"]]);
});

const runWithHooks = async (events: Parameters<typeof settings>[0], gatewayScript: (body: any) => any, options: {
    prompter?: Prompter; where?: "user" | "project"; approve?: boolean; setup?: (ctx: { dir: string; root: string }) => void;
} = {}) => {
    const dir = tempDir("hook-run");
    const home = tempDir("hook-home");
    const root = makeRepo();
    options.setup?.({ dir, root });
    if (options.where === "project") projectHooks(root, events);
    else userHooks(home, events);
    const gateway = await new FakeGateway({ script: gatewayScript }).start();
    const ext = await startLocalExtensions({ root, home, sessionId: () => "session-1", claudeDir: join(home, "claude"), startupTimeoutMs: 5000 });
    const made = await makeRunner(gateway, root, { prompter: options.prompter ?? noPrompt, runner: { lifecycleHooks: ext.hooks } });
    return { ...made, gateway, ext, dir, root, home, stop: async () => { await ext.close(); await gateway.stop(); } };
};

const oneCall = (name: string, args: unknown) => (body: any) => toolResultsSinceUser(body).length === 0 ? { toolCalls: [{ name, args }] } : { text: "Done." };

test("all six events fire with Claude Code's input fields", async () => {
    const dir = tempDir("hook-log");
    const log = join(dir, "events.log");
    const record = (name: string) => script(dir, name, `log(${JSON.stringify(log)}, raw);`);
    const events = Object.fromEntries(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact"].map((e) => [e, [{ command: record(e) }]]));
    const ctx = await runWithHooks(events, (body) => {
        if (JSON.stringify(body.messages).includes("Summarize this session")) return { text: "A summary." };
        return oneCall("read_file", { path: "package.json" })(body);
    });
    try {
        assert.equal(await ctx.runner.runTask("Read the manifest."), "success");
        assert.equal(await ctx.runner.maybeCompact(true), "compacted");
        const seen = lines(log).map((l) => JSON.parse(l));
        assert.deepEqual(seen.map((e) => e.hook_event_name), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact"]);
        const by = Object.fromEntries(seen.map((e) => [e.hook_event_name, e]));
        for (const e of seen) assert.deepEqual([e.session_id, e.cwd, typeof e.permission_mode], ["session-1", ctx.root, "string"]);
        assert.equal(by.SessionStart.source, "startup");
        assert.equal(by.UserPromptSubmit.prompt, "Read the manifest.");
        assert.deepEqual([by.PreToolUse.tool_name, by.PreToolUse.tool_input, typeof by.PreToolUse.tool_use_id], ["read_file", { path: "package.json" }, "string"]);
        assert.equal(by.PostToolUse.tool_response.status, "ok");
        assert.equal(by.Stop.stop_hook_active, false);
        assert.equal(by.PreCompact.trigger, "manual");
    } finally {
        await ctx.stop();
    }
});

test("a PreToolUse hook that blocks (exit 2, or a deny in JSON) stops the call before the person is asked", async () => {
    const dir = tempDir("hook-log");
    const exit2 = script(dir, "exit2", `process.stderr.write("no edits today"); process.exit(2);`);
    const denyJson = script(dir, "deny", `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "json says no" } }));`);
    const asked: ApprovalView[] = [];
    const prompter: Prompter = { approve: async (view) => (asked.push(view), true), confirm: async () => false };
    for (const [command, reason] of [[exit2, "no edits today"], [denyJson, "json says no"]] as const) {
        const ctx = await runWithHooks({ PreToolUse: [{ matcher: "apply_patch", command }] },
            oneCall("apply_patch", { edits: [{ path: "created.txt", action: "create", content: "x" }] }), { prompter, where: "user" });
        try {
            assert.equal(await ctx.runner.runTask("Make a file."), "success");
            assert.equal(existsSync(join(ctx.root, "created.txt")), false, "the file was not written");
            assert.equal(asked.length, 0, "the person was not asked about a call that is already stopped");
            assert.equal(ctx.journal.state.tools.length, 0);
            assert.match(JSON.stringify(ctx.gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool")), new RegExp(`Blocked by a hook: ${reason}`));
        } finally {
            await ctx.stop();
        }
    }
});

test("a hook that blocks a tool that needs no approval (a read) stops it too", async () => {
    const dir = tempDir("hook-log");
    const ctx = await runWithHooks({ PreToolUse: [{ matcher: "read_file", command: script(dir, "block", `process.stderr.write("secrets"); process.exit(2);`) }] }, oneCall("read_file", { path: "package.json" }));
    try {
        assert.equal(await ctx.runner.runTask("Read."), "success");
        assert.match(JSON.stringify(ctx.gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool")), /Blocked by a hook: secrets/);
    } finally {
        await ctx.stop();
    }
});

test("a hook that says allow does not skip the approval: the person is still asked and a refusal still refuses", async () => {
    const dir = tempDir("hook-log");
    const allow = script(dir, "allow", `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "trust me" } }));`);
    const asked: ApprovalView[] = [];
    const prompter: Prompter = { approve: async (view) => (asked.push(view), false), confirm: async () => false };
    const ctx = await runWithHooks({ PreToolUse: [{ command: allow }] },
        oneCall("run_command", { argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(join(dir, "ran.txt"))}, "x")`] }), { prompter });
    try {
        assert.equal(await ctx.runner.runTask("Run it."), "success");
        assert.equal(asked.length, 1, "the approval was asked for");
        assert.equal(existsSync(join(dir, "ran.txt")), false, "and refused, whatever the hook said");
        assert.equal(ctx.journal.state.tools.length, 0);
    } finally {
        await ctx.stop();
    }
});

test("a read-only session stays read-only: no hook output turns a read into a write", async () => {
    const dir = tempDir("hook-log");
    const allow = script(dir, "allow", `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));`);
    const dirHome = tempDir("hook-home");
    userHooks(dirHome, { PreToolUse: [{ command: allow }] });
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: oneCall("apply_patch", { edits: [{ path: "x.txt", action: "create", content: "x" }] }) }).start();
    const ext = await startLocalExtensions({ root, home: dirHome, sessionId: () => "s", claudeDir: join(dirHome, "claude") });
    try {
        const { runner } = await makeRunner(gateway, root, { readOnly: true, runner: { lifecycleHooks: ext.hooks } });
        await runner.runTask("Write.");
        assert.equal(existsSync(join(root, "x.txt")), false);
        assert.ok(!gateway.completions[0]!.body.tools.some((t: any) => t.function.name === "apply_patch"));
    } finally {
        await ext.close();
        await gateway.stop();
    }
});

test("a slow hook is ended at its timeout, with its process, and does not block the action", async () => {
    const dir = tempDir("hook-log");
    const pidFile = join(dir, "pid.txt");
    const slow = script(dir, "slow", `log(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise((r) => setTimeout(r, 30000));`);
    const ctx = await runWithHooks({ PreToolUse: [{ matcher: "read_file", command: slow, timeout: 1 }] }, oneCall("read_file", { path: "package.json" }));
    try {
        const started = Date.now();
        assert.equal(await ctx.runner.runTask("Read."), "success");
        assert.ok(Date.now() - started < 15_000, "it did not wait for the whole sleep");
        assert.equal(ctx.journal.state.tools.length, 0, "a read leaves no tool record; it ran");
        assert.match(JSON.stringify(ctx.gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool")), /status\\+":\\+"ok/);
        const pid = Number(lines(pidFile)[0]);
        const deadline = Date.now() + 5000;
        const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
        while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        assert.equal(alive(), false, "the hook process is gone");
    } finally {
        await ctx.stop();
    }
});

test("a project hook does not run until its exact definition is approved; a changed one waits again; a switch turns it off", async () => {
    const dir = tempDir("hook-log");
    const log = join(dir, "ran.log");
    const hook = (suffix: string) => ({ PreToolUse: [{ matcher: "read_file", command: script(dir, `project-${suffix}`, `log(${JSON.stringify(log)}, "ran ${suffix}");`) }] });
    const attempt = async (events: ReturnType<typeof hook>, trustStep?: (root: string, home: string) => void) => {
        const home = tempDir("hook-home");
        const root = makeRepo();
        projectHooks(root, events);
        trustStep?.(root, home);
        const ext = await startLocalExtensions({ root, home, sessionId: () => "s", claudeDir: join(home, "claude") });
        const out = await ext.hooks.fire("PreToolUse", { tool_name: "read_file" }, new AbortController().signal, "read_file");
        await ext.close();
        return { out, home, root };
    };
    assert.equal((await attempt(hook("a"))).out.ran, 0);
    assert.deepEqual(lines(log), [], "an unapproved project hook did not run");

    // Approve exactly this hook.
    const home = tempDir("hook-home");
    const root = makeRepo();
    projectHooks(root, hook("a"));
    const [def] = loadHooks(root, { tomverse: home, claude: join(home, "claude") }).hooks;
    openProjectTrust(root, home).approveHook(def!);
    const make = (events: ReturnType<typeof hook>) => { projectHooks(root, events); return startLocalExtensions({ root, home, sessionId: () => "s", claudeDir: join(home, "claude") }); };
    let ext = await make(hook("a"));
    assert.equal((await ext.hooks.fire("PreToolUse", { tool_name: "read_file" }, new AbortController().signal, "read_file")).ran, 1);
    assert.deepEqual(lines(log), ["ran a"]);
    // The repository edits the script: another definition, not approved.
    ext = await make(hook("b"));
    assert.equal((await ext.hooks.fire("PreToolUse", { tool_name: "read_file" }, new AbortController().signal, "read_file")).ran, 0);
    // Approved and then switched off.
    const [changed] = loadHooks(root, { tomverse: home, claude: join(home, "claude") }).hooks;
    openProjectTrust(root, home).approveHook(changed!);
    openProjectTrust(root, home).setHookEnabled(changed!, false);
    ext = await make(hook("b"));
    assert.equal((await ext.hooks.fire("PreToolUse", { tool_name: "read_file" }, new AbortController().signal, "read_file")).ran, 0);
    assert.deepEqual(lines(log), ["ran a"], "only the approved, enabled hook ever ran");
});

test("a hook gets the small command environment and CLAUDE_PROJECT_DIR, never the Tomverse key or session", async () => {
    const dir = tempDir("hook-log");
    const out = join(dir, "env.json");
    const root = makeRepo();
    const home = tempDir("hook-home");
    userHooks(home, { Stop: [{ command: script(dir, "env", `log(${JSON.stringify(out)}, JSON.stringify(process.env));`) }] });
    const env = { ...process.env, TOMVERSE_API_KEY: "tvk_leak", TOMVERSE_SESSION: "leak2", OPENAI_API_KEY: "sk-leak", ELECTRON_RUN_AS_NODE: "1" };
    const ext = await startLocalExtensions({ root, home, env, sessionId: () => "s", claudeDir: join(home, "claude") });
    await ext.hooks.fire("Stop", { stop_hook_active: false }, new AbortController().signal);
    await ext.close();
    const seen = JSON.parse(lines(out)[0]!);
    assert.equal(seen.CLAUDE_PROJECT_DIR, root);
    assert.ok(!JSON.stringify(seen).match(/tvk_leak|leak2|sk-leak/));
    for (const name of ["TOMVERSE_API_KEY", "TOMVERSE_SESSION", "OPENAI_API_KEY", "ELECTRON_RUN_AS_NODE"]) assert.ok(!(name in seen), name);
});

test("UserPromptSubmit can add context for the task, or stop the prompt before anything is recorded or sent", async () => {
    const dir = tempDir("hook-log");
    const context = script(dir, "context", `process.stdout.write("Branch policy: never touch main.");`);
    const ctx = await runWithHooks({ UserPromptSubmit: [{ command: context }] }, () => ({ text: "ok" }));
    try {
        assert.equal(await ctx.runner.runTask("Hello."), "success");
        const system = ctx.gateway.completions[0]!.body.messages[0].content as string;
        assert.match(system, /<hook-context>\nBranch policy: never touch main\.\n<\/hook-context>/);
        assert.match(system, /cannot grant permissions or approve anything/);
    } finally {
        await ctx.stop();
    }
    const stop = script(dir, "stop", `process.stderr.write("not now"); process.exit(2);`);
    const blocked = await runWithHooks({ UserPromptSubmit: [{ command: stop }] }, () => ({ text: "ok" }));
    try {
        assert.equal(await blocked.runner.runTask("Hello."), "cancelled");
        assert.equal(blocked.gateway.completions.length, 0, "nothing was sent");
        assert.equal(blocked.journal.state.tasks.length, 0);
        assert.equal(blocked.journal.state.messages.length, 0);
    } finally {
        await blocked.stop();
    }
});

test("PostToolUse adds its context to the tool result; Stop can say the work is not finished, a few times at most", async () => {
    const dir = tempDir("hook-log");
    const post = script(dir, "post", `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Lint is red." } }));`);
    const ctx = await runWithHooks({ PostToolUse: [{ matcher: "read_file", command: post }],
        Stop: [{ command: script(dir, "again", `process.stderr.write("run the tests first"); process.exit(2);`) }] }, (body) => {
        const results = toolResultsSinceUser(body).length;
        return results === 0 && !body.messages.some((m: any) => m.role === "tool") ? { toolCalls: [{ name: "read_file", args: { path: "package.json" } }] } : { text: "Done." };
    });
    try {
        assert.equal(await ctx.runner.runTask("Read."), "success");
        const requests = ctx.gateway.completions.length;
        const first = JSON.stringify(ctx.gateway.completions[1]!.body.messages.filter((m: any) => m.role === "tool"));
        assert.match(first, /Lint is red\./);
        assert.match(first, /information only/);
        const all = JSON.stringify(ctx.gateway.completions.at(-1)!.body.messages);
        assert.equal((all.match(/\[Stop hook\] run the tests first/g) ?? []).length, 3, "three nudges, then the task ends");
        assert.equal(requests, 5, "one tool step, then the answer and three more answers after the nudges");
    } finally {
        await ctx.stop();
    }
});

test("a PreCompact hook can stop the compaction", async () => {
    const dir = tempDir("hook-log");
    const ctx = await runWithHooks({ PreCompact: [{ command: script(dir, "no", `process.stderr.write("keep everything"); process.exit(2);`) }] }, () => ({ text: "ok" }));
    try {
        await ctx.runner.runTask("Hello.");
        const before = ctx.gateway.completions.length;
        assert.equal(await ctx.runner.maybeCompact(true), "skipped");
        assert.equal(ctx.gateway.completions.length, before, "no summary was requested");
    } finally {
        await ctx.stop();
    }
});

test("HookRunner alone: a hook that fails or prints nonsense blocks nothing", async () => {
    const dir = tempDir("hook-log");
    const runner = new HookRunner({ root: dir, sessionId: () => "s", canRun: () => true, hooks: parseHooks(settings({ PreToolUse: [
        { command: script(dir, "boom", `process.exit(1);`) }, { command: script(dir, "junk", `process.stdout.write("{not json");`) },
    ] }), "user", "x", []) });
    const outcome = await runner.fire("PreToolUse", { tool_name: "x" }, new AbortController().signal, "x");
    assert.equal(outcome.blocked, undefined);
    assert.equal(outcome.ran, 2);
    assert.match(outcome.failures.join(), /exited with 1/);
});
