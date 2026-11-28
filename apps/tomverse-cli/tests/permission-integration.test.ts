/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures and partial approval views */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ApprovalView, Prompter } from "../src/agent.js";
import type { BrowserAgentHost, BrowserAgentRequest } from "../src/browser-tools.js";
import type { GitToolAction, GitToolReply } from "../src/git-tools.js";
import { startLocalExtensions } from "../src/local-extensions.js";
import { mcpToolName } from "../src/mcp-client.js";
import { PERMISSION_MODES, PermissionGate, evaluate, type GateContext, type PermissionMode, type PermissionRule, type ScopedRule } from "../src/permissions.js";
import { runCommandDescription } from "../src/tools.js";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, tempDir } from "./helpers.js";

/**
 * Where the permission modes meet every tool that asks for an approval: patches, commands, web pages, clicks and typing in the
 * browser tab, MCP tools, the git tools and a subagent's changes. Each of these was built on its own; here they are checked
 * against the one rule: the mode, the rules and the boundaries decide first, and only what they leave to a person reaches one.
 *
 * Where each cell of the mode x request matrix is pinned:
 *   patch, command, web, browser, mcp  the "decision matrix" test (the pure decision) and the runner tests below it
 *   git                                "git tools: read-only mode refuses ..." (all four modes, through a Runner)
 *   subagent                           the two "subagents:" tests (all four modes for a change; rules and boundaries for a command)
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const PAGE = "http://127.0.0.1:4100/";
const ORIGIN = "http://127.0.0.1:4100";
const ROOT = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";

/** A gate that counts how often it was asked: the git tools must never reach it. */
class SpyGate extends PermissionGate {
    decided = 0;
    override async decide(view: ApprovalView, context: GateContext) {
        this.decided += 1;
        return super.decide(view, context);
    }
}
const gateFor = (mode: PermissionMode, rules: ScopedRule[] = []) => new SpyGate({ mode, rules: () => rules });
const rule = (effect: PermissionRule["effect"], tool: string, pattern?: string): ScopedRule => ({ effect, tool, ...(pattern !== undefined ? { pattern } : {}), scope: "user" });
const isReview = (body: any) => JSON.stringify(body.messages?.[0] ?? "").includes("You review ONE action");
const isSub = (body: any) => /subagent of Tomverse CLI/.test(String(body.messages?.[0]?.content));
const toolMessages = (gateway: FakeGateway) => JSON.stringify(gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool"));
const toolOutputs = (gateway: FakeGateway) => gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content) as { status?: string });
const allowAnswer = JSON.stringify({ verdict: "allow", reason: "scripted" });
const nobody: Prompter = { approve: async () => assert.fail("a person was asked"), confirm: async () => assert.fail("a person was asked") };
const asking = (answer: boolean, seen: ApprovalView[]): Prompter => ({ approve: async (view) => (seen.push(view), answer), confirm: async () => false });

// ── Views for the pure decision ────────────────────────────────────────────

const patchView = (): ApprovalView => ({ approvalId: "a", toolCallId: "t", toolName: "apply_patch", input: {}, root: ROOT,
    patch: [{ path: "src/a.ts", action: "update", absolute: process.platform === "win32" ? `${ROOT}\\src\\a.ts` : `${ROOT}/src/a.ts` } as any] });
const commandView = (): ApprovalView => ({ approvalId: "a", toolCallId: "t", toolName: "run_command", input: { argv: ["npm", "test"] }, root: ROOT,
    command: { mode: "argv", file: "/usr/bin/npm", args: ["test"], display: "npm test", shell: null, cwd: ROOT, timeoutMs: 1000, envNames: [] } });
const webView = (): ApprovalView => ({ approvalId: "a", toolCallId: "t", toolName: "web_fetch", input: { url: "https://docs.example.com/x" }, root: ROOT,
    web: { url: "https://docs.example.com/x", host: "docs.example.com" } });
const browserView = (action: "click" | "type" = "click"): ApprovalView => ({ approvalId: "a", toolCallId: "t", toolName: `browser_${action}`, input: { selector: "#add" }, root: ROOT,
    browser: { action, origin: ORIGIN, url: PAGE, selector: "#add", ...(action === "type" ? { text: "hi" } : {}) } });
const computerView = (action: "click" | "type" | "key" | "scroll" = "click"): ApprovalView => ({ approvalId: "a", toolCallId: "t", toolName: `computer_${action}`, input: { x: 1, y: 2 }, root: ROOT,
    computer: { action, window: { id: "1a2b:4242", title: "Fixture calculator", app: "fixture-calc" }, x: 1, y: 2 } });
const mcpView = (server: string, tool: string, name = `mcp__${server}__${tool}`): ApprovalView => ({ approvalId: "a", toolCallId: "t", toolName: name, input: { q: 1 }, root: ROOT,
    mcp: { server, tool, definition: "def-1", scope: "user" } });
const kindOf = (view: ApprovalView, mode: PermissionMode, rules: ScopedRule[] = []) => evaluate(view, { mode, rules }).kind;

test("decision matrix, requests that ask: each mode against patch, command, web, browser and MCP", () => {
    const expected: Record<PermissionMode, Record<string, string>> = {
        read_only: { patch: "deny", command: "deny", web: "human", browser: "deny", computer: "deny", mcp: "deny" },
        ask: { patch: "human", command: "human", web: "human", browser: "human", computer: "human", mcp: "human" },
        auto_review: { patch: "review", command: "review", web: "human", browser: "human", computer: "human", mcp: "human" },
        allow_all: { patch: "allow", command: "allow", web: "human", browser: "human", computer: "human", mcp: "human" },
    };
    for (const mode of PERMISSION_MODES) {
        assert.equal(kindOf(patchView(), mode), expected[mode]!.patch, `${mode} patch`);
        assert.equal(kindOf(commandView(), mode), expected[mode]!.command, `${mode} command`);
        assert.equal(kindOf(webView(), mode), expected[mode]!.web, `${mode} web`);
        assert.equal(kindOf(browserView("click"), mode), expected[mode]!.browser, `${mode} browser click`);
        assert.equal(kindOf(browserView("type"), mode), expected[mode]!.browser, `${mode} browser type`);
        for (const action of ["click", "type", "key", "scroll"] as const) assert.equal(kindOf(computerView(action), mode), expected[mode]!.computer, `${mode} computer ${action}`);
        assert.equal(kindOf(mcpView("github", "list_issues"), mode), expected[mode]!.mcp, `${mode} mcp`);
    }
});

test("an action in a desktop window is a person's decision in every mode; no rule allows it and it is never put to a reviewer", () => {
    for (const mode of ["ask", "auto_review", "allow_all"] as const) {
        assert.equal(kindOf(computerView(), mode, [rule("allow", "computer_click"), rule("allow", "run_command", "**")]), "human", `${mode} with allow rules`);
    }
    assert.equal(kindOf(computerView(), "allow_all", [rule("deny", "mcp__x")]), "human");
});

test("an MCP tool and a web host run without a person only when a rule names them, in every mode; deny and ask rules still win", () => {
    const allowTool = rule("allow", "mcp__github__list_issues");
    for (const mode of ["ask", "auto_review", "allow_all"] as const) {
        assert.equal(kindOf(mcpView("github", "list_issues"), mode, [allowTool]), "allow", `${mode} named tool`);
        assert.equal(kindOf(mcpView("github", "list_issues"), mode, [rule("allow", "mcp__github__*")]), "allow", `${mode} whole server by wildcard`);
        assert.equal(kindOf(mcpView("github", "list_issues"), mode, [rule("allow", "mcp__github")]), "allow", `${mode} whole server`);
        assert.equal(kindOf(mcpView("github", "create_pr"), mode, [allowTool]), "human", `${mode} another tool of the server`);
        assert.equal(kindOf(mcpView("gitlab", "list_issues"), mode, [allowTool]), "human", `${mode} the same tool name on another server`);
        assert.equal(kindOf(mcpView("github", "list_issues"), mode, [allowTool, rule("ask", "mcp__github__list_issues")]), "human", `${mode} ask beats allow`);
        assert.equal(kindOf(mcpView("github", "list_issues"), mode, [allowTool, rule("deny", "mcp__github")]), "deny", `${mode} deny beats allow`);
    }
    // No rule lifts read-only.
    assert.equal(kindOf(mcpView("github", "list_issues"), "read_only", [allowTool]), "deny");
    // A request that does not say which server it is for is never allowed by a rule.
    const nameOnly: ApprovalView = { approvalId: "a", toolCallId: "t", toolName: "mcp__github__list_issues", input: {}, root: ROOT };
    assert.equal(kindOf(nameOnly, "allow_all", [allowTool, rule("allow", "mcp__github__*")]), "human");
    assert.equal(kindOf(nameOnly, "allow_all", [rule("deny", "mcp__github__*")]), "deny");
});

test("MCP rules compare the server and the tool of the request: a long tool name, a tool with unusual characters, a server id that holds __", () => {
    const taken = new Set<string>();
    const longTool = "a".repeat(100);
    const functionName = mcpToolName("server", longTool, taken);
    assert.ok(functionName.length <= 64 && functionName !== `mcp__server__${longTool}`, "a shortened function name carries a hash");
    const long = mcpView("server", longTool, functionName);
    for (const tool of [functionName, "mcp__server__*", "mcp__server"]) {
        assert.equal(kindOf(long, "ask", [rule("allow", tool)]), "allow", tool);
        assert.equal(kindOf(long, "allow_all", [rule("deny", tool)]), "deny", `deny ${tool}`);
    }
    // The tool's own long name is enough to deny or ask about it, but it never allows (only the name the model sees does).
    assert.equal(kindOf(long, "allow_all", [rule("deny", `mcp__server__${longTool}`)]), "deny");
    assert.equal(kindOf(long, "allow_all", [rule("ask", `mcp__server__${longTool}`)]), "human");
    assert.equal(kindOf(long, "allow_all", [rule("allow", `mcp__server__${longTool}`)]), "human");
    assert.equal(kindOf(long, "ask", [rule("allow", `mcp__server__${"a".repeat(99)}`)]), "human", "a different tool name");
    const odd = mcpView("server", "read file!", mcpToolName("server", "read file!", new Set()));
    assert.equal(kindOf(odd, "ask", [rule("allow", "mcp__server__read_file_")]), "allow", "the name as the model sees it");
    // A server whose id holds a double underscore is not part of another server's rules.
    const nested = mcpView("a__b", "tool");
    assert.equal(kindOf(nested, "ask", [rule("allow", "mcp__a__*")]), "human");
    assert.equal(kindOf(nested, "ask", [rule("allow", "mcp__a")]), "human");
    assert.equal(kindOf(nested, "ask", [rule("allow", "mcp__a__b__*")]), "allow");
    assert.equal(kindOf(nested, "ask", [rule("allow", "mcp__a__b")]), "human", "the bare form of a server id that holds __ is not read as the whole server");
    assert.equal(kindOf(mcpView("a", "b__tool"), "ask", [rule("allow", "mcp__a__b__*")]), "human", "and the reverse");
    // A narrow rule for one tool never opens another server whose id happens to continue its text.
    assert.equal(kindOf(mcpView("github__list_issues", "delete_repo"), "allow_all", [rule("allow", "mcp__github__list_issues")]), "human");
    assert.equal(kindOf(mcpView("github", "list_issues"), "allow_all", [rule("allow", "mcp__github__list_issues")]), "allow");
    assert.equal(kindOf(mcpView("a", "b__x"), "allow_all", [rule("allow", "mcp__a__b__x")]), "allow", "the function name the model sees");
    assert.equal(kindOf(mcpView("a__b", "x"), "allow_all", [rule("allow", "mcp__a__b__x")]), "allow", "the same function name, the same rule");
    assert.equal(kindOf(mcpView("a__b", "y"), "allow_all", [rule("allow", "mcp__a__b__x")]), "human");
    // A deny or ask rule errs on the restrictive side: it still reaches the tools of a server whose id continues its text.
    assert.equal(kindOf(nested, "allow_all", [rule("deny", "mcp__a__*")]), "deny");
    assert.equal(kindOf(nested, "allow_all", [rule("ask", "mcp__a")]), "human");
});

// ── MCP through a Runner ───────────────────────────────────────────────────

const mcpScript = (names: string[]) => (body: any) => {
    if (isReview(body)) return { text: allowAnswer };
    const done = toolResultsSinceUser(body).length;
    return done < names.length ? { toolCalls: [{ name: names[done]!, args: { text: "hello" } }] } : { text: "Done." };
};

const withMcp = async (servers: Record<string, unknown>, calls: string[], then: (ctx: { ext: Awaited<ReturnType<typeof startLocalExtensions>>; gateway: FakeGateway; root: string; home: string }) => Promise<void>, project?: Record<string, unknown>) => {
    const root = makeRepo();
    const home = tempDir("perm-int-home");
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    if (project) writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: project }));
    const gateway = await new FakeGateway({ script: mcpScript(calls) }).start();
    const ext = await startLocalExtensions({ root, home, sessionId: () => "s", claudeDir: join(home, "claude"), startupTimeoutMs: 10_000 });
    try {
        await then({ ext, gateway, root, home });
    } finally {
        await ext.close();
        await gateway.stop();
    }
};
const stdio = (extra: { env?: Record<string, string> } = {}) => ({ command: process.execPath, args: [FIXTURE], ...(extra.env ? { env: extra.env } : {}) });

test("MCP: allow-all and auto review still ask a person for a tool no rule names; a rule that names it runs without one; read-only refuses", async () => {
    await withMcp({ s: stdio() }, ["mcp__s__echo"], async ({ ext, gateway, root }) => {
        for (const mode of ["ask", "auto_review", "allow_all"] as const) {
            const seen: ApprovalView[] = [];
            const gate = gateFor(mode);
            const { runner, journal } = await makeRunner(gateway, root, { prompter: asking(true, seen), runner: { mcp: ext.mcp, permissions: gate } });
            assert.equal(await runner.runTask("Echo."), "success");
            assert.equal(seen.length, 1, `${mode}: a person was asked`);
            assert.equal(seen[0]!.mcp?.server, "s");
            assert.equal(journal.state.approvals[0]!.by, undefined, `${mode}: answered by the person, not by the policy`);
            assert.equal(journal.state.tools[0]?.output?.text, "hello");
            assert.equal(journal.unresolvedGenerations().length, 0);
            assert.equal(journal.state.generations.some((g) => g.purpose === "review"), false, `${mode}: no reviewer was asked about an MCP tool`);
        }
    });
    await withMcp({ s: stdio() }, ["mcp__s__echo"], async ({ ext, gateway, root }) => {
        for (const mode of ["ask", "auto_review", "allow_all"] as const) {
            const { runner, journal } = await makeRunner(gateway, root, { prompter: nobody, runner: { mcp: ext.mcp, permissions: gateFor(mode, [rule("allow", "mcp__s__echo")]) } });
            assert.equal(await runner.runTask("Echo."), "success");
            assert.deepEqual([journal.state.approvals[0]!.decision, journal.state.approvals[0]!.policy?.source], ["approved", "allow_rule"], mode);
            assert.equal(journal.state.tools[0]?.output?.text, "hello", `${mode}: it ran`);
        }
        // A deny rule beats the allow rule, and read-only refuses whatever the rules say.
        for (const [mode, rules, source] of [
            ["allow_all", [rule("allow", "mcp__s__*"), rule("deny", "mcp__s__echo")], "deny_rule"],
            ["read_only", [rule("allow", "mcp__s__*")], "mode"],
        ] as const) {
            const { runner, journal } = await makeRunner(gateway, root, { prompter: nobody, runner: { mcp: ext.mcp, permissions: gateFor(mode, [...rules]) } });
            assert.equal(await runner.runTask("Echo."), "success");
            assert.deepEqual([journal.state.approvals[0]!.decision, journal.state.approvals[0]!.policy?.source], ["denied", source], mode);
            assert.equal(journal.state.tools.length, 0, `${mode}: the server was not called`);
        }
    });
});

test("MCP: an allow rule does not skip the check that the approval is for the server definition connected now", async () => {
    await withMcp({ s: stdio() }, ["mcp__s__echo"], async ({ ext, gateway, root }) => {
        const { runner, journal } = await makeRunner(gateway, root, { prompter: nobody, runner: { mcp: ext.mcp, permissions: gateFor("allow_all", [rule("allow", "mcp__s__*")]) } });
        // The server is replaced after the tools were offered: what the approval is bound to is no longer what is connected.
        const real = ext.mcp.info.bind(ext.mcp);
        ext.mcp.info = (name: string) => { const info = real(name); return info ? { ...info, hash: "a-different-definition" } : info; };
        try {
            assert.equal(await runner.runTask("Echo."), "success");
        } finally {
            ext.mcp.info = real;
        }
        assert.equal(journal.state.approvals[0]!.policy?.source, "allow_rule");
        assert.equal(journal.state.tools.length, 0, "not called");
        assert.match(toolMessages(gateway), /approval was for another server definition/);
    });
});

test("MCP: a project server nobody approved is not connected, so an allow rule for it reaches nothing", async () => {
    const marker = join(tempDir("perm-int-marker"), "started.txt");
    await withMcp({}, ["mcp__repo__echo"], async ({ ext, gateway, root }) => {
        assert.equal(ext.mcp.status().find((server) => server.id === "repo")?.state, "pending_approval");
        const { runner, journal } = await makeRunner(gateway, root, { prompter: nobody, runner: { mcp: ext.mcp, permissions: gateFor("allow_all", [rule("allow", "mcp__repo__*"), rule("allow", "mcp__repo")]) } });
        assert.equal(await runner.runTask("Echo."), "success");
        assert.equal(existsSync(marker), false, "the project's server was never started");
        assert.equal(journal.state.tools.length, 0);
        assert.ok(!gateway.completions[0]!.body.tools.some((tool: any) => /^mcp__repo__/.test(tool.function.name)), "its tools were not offered");
    }, { repo: stdio({ env: { FIXTURE_MARKER: marker } }) });
});

// ── The browser tab ────────────────────────────────────────────────────────

const fakeBrowser = (seen: BrowserAgentRequest[], overrides: Partial<Record<BrowserAgentRequest["tool"], unknown>> = {}): BrowserAgentHost => async (request) => {
    seen.push(request);
    if (request.tool in overrides) return overrides[request.tool];
    if (request.tool === "navigate") return { status: "ok", url: request.url, title: "Fixture" };
    return { status: "ok", url: PAGE, title: "Fixture" };
};
const browserScript = (calls: Array<{ name: string; args: Record<string, unknown> }>) => (body: any) => {
    if (isReview(body)) return { text: allowAnswer };
    const done = toolResultsSinceUser(body).length;
    return done < calls.length ? { toolCalls: [calls[done]!] } : { text: "Done." };
};

test("browser clicks and typing: read-only refuses, and every other mode asks a person, never a reviewer and never the mode", async () => {
    const calls = [{ name: "browser_navigate", args: { url: PAGE } }, { name: "browser_click", args: { selector: "#add" } }];
    const expected: Record<PermissionMode, { clicked: boolean; people: number; reviews: number; source: string | undefined; decision: string }> = {
        read_only: { clicked: false, people: 0, reviews: 0, source: "mode", decision: "denied" },
        ask: { clicked: true, people: 1, reviews: 0, source: undefined, decision: "approved" },
        auto_review: { clicked: true, people: 1, reviews: 0, source: undefined, decision: "approved" },
        allow_all: { clicked: true, people: 1, reviews: 0, source: undefined, decision: "approved" },
    };
    for (const mode of PERMISSION_MODES) {
        const gateway = await new FakeGateway({ script: browserScript(calls) }).start();
        try {
            const hostSeen: BrowserAgentRequest[] = [];
            const seen: ApprovalView[] = [];
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: asking(true, seen), runner: { browserAgent: fakeBrowser(hostSeen), permissions: gateFor(mode) } });
            assert.equal(await runner.runTask("Press the button."), "success");
            const want = expected[mode];
            assert.equal(hostSeen.some((request) => request.tool === "click"), want.clicked, `${mode}: click reached the browser`);
            assert.equal(seen.length, want.people, `${mode}: people asked`);
            assert.equal(journal.state.generations.filter((g) => g.purpose === "review").length, want.reviews, `${mode}: reviews`);
            assert.deepEqual([journal.state.approvals[0]!.decision, journal.state.approvals[0]!.policy?.source], [want.decision, want.source], mode);
        } finally {
            await gateway.stop();
        }
    }
});

test("a password or card field is refused by the browser host in every mode: the CLI relays that answer and never types it itself", async () => {
    const calls = [{ name: "browser_navigate", args: { url: PAGE } }, { name: "browser_type", args: { selector: "#secret", text: "hunter2" } }];
    for (const mode of ["ask", "auto_review", "allow_all"] as const) {
        const gateway = await new FakeGateway({ script: browserScript(calls) }).start();
        try {
            const hostSeen: BrowserAgentRequest[] = [];
            const refusal = { status: "error", message: "Passwords, one-time codes and card fields are never typed by the agent." };
            const { runner } = await makeRunner(gateway, makeRepo(), { prompter: asking(true, []), runner: { browserAgent: fakeBrowser(hostSeen, { type: refusal }), permissions: gateFor(mode) } });
            assert.equal(await runner.runTask("Log in."), "success");
            assert.equal(hostSeen.filter((request) => request.tool === "type").length, 1, `${mode}: the request went to the host, which is the one that knows the field`);
            assert.match(toolMessages(gateway), /never typed by the agent/);
        } finally {
            await gateway.stop();
        }
    }
});

// ── Git ────────────────────────────────────────────────────────────────────

const gitScript = (calls: Array<{ name: string; args: unknown }>) => (body: any) => {
    const done = toolResultsSinceUser(body).length;
    return done < calls.length ? { toolCalls: [calls[done]!] } : { text: "Done." };
};
const gitCalls = [
    { name: "commit_changes", args: { message: "Fix sum", paths: ["sum.js"] } },
    { name: "publish_changes", args: { pullRequest: { title: "T", body: "B", base: "main", draft: true } } },
];

test("git tools: read-only mode refuses a commit and a push before the host is asked; in every other mode only the host's own card decides", async () => {
    for (const mode of PERMISSION_MODES) {
        const gateway = await new FakeGateway({ script: gitScript(gitCalls) }).start();
        try {
            const asked: GitToolAction[] = [];
            // The host answers as Desktop does when the person closes or denies the card: nothing is approved on its own.
            const host = async (action: GitToolAction): Promise<GitToolReply> => { asked.push(action); return { status: "denied" }; };
            const gate = gateFor(mode, [rule("allow", "run_command", "git"), rule("allow", "mcp__s__*")]);
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: nobody, runner: { git: host, permissions: gate } });
            assert.equal(await runner.runTask("Commit and publish."), "success");
            if (mode === "read_only") {
                assert.deepEqual(asked, [], "no request reached the host, so no card could open");
                assert.match(toolMessages(gateway), /Read-only mode: nothing is committed or pushed/);
                assert.deepEqual(toolOutputs(gateway).map((output) => output.status), ["denied", "denied"], "both calls were answered as denied");
            } else {
                assert.deepEqual(asked.map((action) => action.kind), ["commit", "publish"], `${mode}: both calls went to the host's approval card`);
                assert.match(toolMessages(gateway), /denied/);
            }
            assert.equal(gate.decided, 0, `${mode}: no mode, rule or reviewer was asked to approve a git action`);
            assert.equal(journal.state.approvals.length, 0, `${mode}: nothing the gate could have approved was recorded`);
            assert.equal(journal.state.generations.filter((g) => g.purpose === "review").length, 0, `${mode}: no reviewer saw it`);
        } finally {
            await gateway.stop();
        }
    }
});

test("git tools: the mode is read at the time of the call, so switching to read-only stops the next commit", async () => {
    const gateway = await new FakeGateway({ script: gitScript([gitCalls[0]!]) }).start();
    try {
        let mode: PermissionMode = "allow_all";
        const asked: GitToolAction[] = [];
        const gate = new PermissionGate({ mode: () => mode, rules: () => [] });
        const { runner } = await makeRunner(gateway, makeRepo(), { prompter: nobody, runner: { git: async (action) => { asked.push(action); return { status: "denied" }; }, permissions: gate } });
        mode = "read_only";
        await runner.runTask("Commit.");
        assert.deepEqual(asked, []);
    } finally {
        await gateway.stop();
    }
});

// ── Hooks ──────────────────────────────────────────────────────────────────

const hookScript = (dir: string, name: string, body: string) => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, `import { appendFileSync, readFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\nconst log = (file, text) => appendFileSync(file, text + "\\n");\n${body}\n`);
    return process.platform === "win32" ? `& "${process.execPath}" "${file}"` : `"${process.execPath}" "${file}"`;
};
const withHooks = async (events: Record<string, Array<{ matcher?: string; command: string }>>, then: (ctx: { ext: Awaited<ReturnType<typeof startLocalExtensions>>; root: string; home: string }) => Promise<void>, servers: Record<string, unknown> = {}) => {
    const root = makeRepo();
    const home = tempDir("perm-int-hooks");
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(Object.entries(events).map(([event, list]) => [event,
        list.map((h) => ({ ...(h.matcher !== undefined ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: h.command }] }))])) }));
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    const ext = await startLocalExtensions({ root, home, sessionId: () => "s", claudeDir: join(home, "claude"), startupTimeoutMs: 10_000 });
    try {
        await then({ ext, root, home });
    } finally {
        await ext.close();
    }
};
const oneCall = (name: string, args: unknown) => (body: any) => (isReview(body) ? { text: allowAnswer } : toolResultsSinceUser(body).length === 0 ? { toolCalls: [{ name, args }] } : { text: "Done." });
const create = (path: string) => ({ edits: [{ path, action: "create", content: `${path}\n` }] });

test("hooks: a PreToolUse block holds in allow-all and auto review, before the gate is asked, and a hook's allow never lifts a mode, a rule or a boundary", async () => {
    const dir = tempDir("perm-int-log");
    const block = hookScript(dir, "block", `process.stderr.write("no files today"); process.exit(2);`);
    await withHooks({ PreToolUse: [{ matcher: "apply_patch", command: block }] }, async ({ ext, root }) => {
        for (const mode of ["allow_all", "auto_review"] as const) {
            const gateway = await new FakeGateway({ script: oneCall("apply_patch", create(`${mode}.txt`)) }).start();
            try {
                const gate = gateFor(mode, [rule("allow", "apply_patch", "**")]);
                const { runner, journal } = await makeRunner(gateway, root, { prompter: nobody, runner: { lifecycleHooks: ext.hooks, permissions: gate } });
                assert.equal(await runner.runTask("Make a file."), "success");
                assert.equal(existsSync(join(root, `${mode}.txt`)), false, `${mode}: not written`);
                assert.equal(journal.state.approvals[0]!.decision, "denied");
                assert.equal(gate.decided, 0, `${mode}: the block answered before the gate`);
                assert.match(toolMessages(gateway), /Blocked by a hook: no files today/);
            } finally {
                await gateway.stop();
            }
        }
    });
    const allow = hookScript(dir, "allow", `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "trust me" } }));`);
    await withHooks({ PreToolUse: [{ command: allow }] }, async ({ ext, root }) => {
        const cases: Array<{ label: string; mode: PermissionMode; rules: ScopedRule[]; call: [string, unknown]; wantPeople: number; wantDecision: string; wantSource?: string }> = [
            { label: "read-only still refuses a patch", mode: "read_only", rules: [], call: ["apply_patch", create("ro.txt")], wantPeople: 0, wantDecision: "denied", wantSource: "mode" },
            { label: "a deny rule still refuses a command", mode: "allow_all", rules: [rule("deny", "run_command", "node")], call: ["run_command", { argv: ["node", "--version"] }], wantPeople: 0, wantDecision: "denied", wantSource: "deny_rule" },
            { label: "an ask rule still asks a person", mode: "allow_all", rules: [rule("ask", "run_command", "node")], call: ["run_command", { argv: ["node", "--version"] }], wantPeople: 1, wantDecision: "denied" },
            { label: "ask mode still asks a person", mode: "ask", rules: [], call: ["apply_patch", create("ask.txt")], wantPeople: 1, wantDecision: "denied" },
            { label: "a command that leaves the computer is still a person's call in allow-all", mode: "allow_all", rules: [rule("allow", "run_command", "git")], call: ["run_command", { argv: ["git", "push", "origin", "main"] }], wantPeople: 1, wantDecision: "denied" },
        ];
        for (const entry of cases) {
            const gateway = await new FakeGateway({ script: oneCall(...entry.call) }).start();
            try {
                const seen: ApprovalView[] = [];
                const { runner, journal } = await makeRunner(gateway, root, { prompter: asking(false, seen), runner: { lifecycleHooks: ext.hooks, permissions: gateFor(entry.mode, entry.rules) } });
                assert.equal(await runner.runTask("Do it."), "success");
                assert.equal(seen.length, entry.wantPeople, entry.label);
                assert.deepEqual([journal.state.approvals[0]!.decision, journal.state.approvals[0]!.policy?.source], [entry.wantDecision, entry.wantSource], entry.label);
                assert.equal(journal.state.tools.some((t) => t.state === "completed"), false, `${entry.label}: nothing ran`);
            } finally {
                await gateway.stop();
            }
        }
    });
});

test("hooks: a PreToolUse hook runs once for a browser click, and can block it and a git commit", async () => {
    const dir = tempDir("perm-int-log");
    const log = join(dir, "pre.log");
    const count = hookScript(dir, "count", `log(${JSON.stringify(log)}, input.tool_name);`);
    await withHooks({ PreToolUse: [{ matcher: "browser_click", command: count }] }, async ({ ext, root }) => {
        const gateway = await new FakeGateway({ script: browserScript([{ name: "browser_navigate", args: { url: PAGE } }, { name: "browser_click", args: { selector: "#add" } }]) }).start();
        try {
            const hostSeen: BrowserAgentRequest[] = [];
            const { runner } = await makeRunner(gateway, root, { prompter: asking(true, []), runner: { lifecycleHooks: ext.hooks, browserAgent: fakeBrowser(hostSeen), permissions: gateFor("allow_all") } });
            assert.equal(await runner.runTask("Press."), "success");
            assert.equal(hostSeen.some((request) => request.tool === "click"), true);
            assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), ["browser_click"], "one hook run for one click");
        } finally {
            await gateway.stop();
        }
    });
    const block = hookScript(dir, "block-git", `process.stderr.write("no git"); process.exit(2);`);
    await withHooks({ PreToolUse: [{ matcher: "commit_changes|publish_changes|browser_click", command: block }] }, async ({ ext, root }) => {
        const gateway = await new FakeGateway({ script: gitScript(gitCalls) }).start();
        try {
            const asked: GitToolAction[] = [];
            const { runner } = await makeRunner(gateway, root, { prompter: nobody, runner: { lifecycleHooks: ext.hooks, git: async (action) => { asked.push(action); return { status: "denied" }; }, permissions: gateFor("allow_all") } });
            assert.equal(await runner.runTask("Commit."), "success");
            assert.deepEqual(asked, [], "the hook stopped both before the host's card");
            assert.match(toolMessages(gateway), /Blocked by a hook: no git/);
        } finally {
            await gateway.stop();
        }
        const browser = await new FakeGateway({ script: browserScript([{ name: "browser_navigate", args: { url: PAGE } }, { name: "browser_click", args: { selector: "#add" } }]) }).start();
        try {
            const hostSeen: BrowserAgentRequest[] = [];
            const { runner } = await makeRunner(browser, root, { prompter: nobody, runner: { lifecycleHooks: ext.hooks, browserAgent: fakeBrowser(hostSeen), permissions: gateFor("allow_all") } });
            await runner.runTask("Press.");
            assert.equal(hostSeen.some((request) => request.tool === "click"), false, "a blocked click never reaches the browser");
        } finally {
            await browser.stop();
        }
    });
    const blockMcp = hookScript(dir, "block-mcp", `process.stderr.write("no mcp"); process.exit(2);`);
    await withHooks({ PreToolUse: [{ matcher: "mcp__.*", command: blockMcp }] }, async ({ ext, root }) => {
        const gateway = await new FakeGateway({ script: mcpScript(["mcp__s__echo"]) }).start();
        try {
            const { runner, journal } = await makeRunner(gateway, root, { prompter: nobody, runner: { lifecycleHooks: ext.hooks, mcp: ext.mcp, permissions: gateFor("allow_all", [rule("allow", "mcp__s__*")]) } });
            assert.equal(await runner.runTask("Echo."), "success");
            assert.equal(journal.state.tools.length, 0);
            assert.match(toolMessages(gateway), /Blocked by a hook: no mcp/);
        } finally {
            await gateway.stop();
        }
    }, { s: stdio() });
});

// ── Subagents ──────────────────────────────────────────────────────────────

const workerScript = (call: { name: string; args: unknown }) => async (body: any) => {
    if (isReview(body)) return { text: allowAnswer };
    if (isSub(body)) {
        if (!body.messages.some((m: any) => m.role === "tool")) return { toolCalls: [call] };
        const answer = JSON.parse(body.messages.filter((m: any) => m.role === "tool").at(-1).content);
        return { text: answer.status === "denied" ? "I was not allowed." : "Done." };
    }
    if (!toolResultsSinceUser(body).length) return { toolCalls: [{ name: "delegate", args: { kind: "worker", tasks: ["Do the work."] } }] };
    return { text: "The worker is done." };
};

test("subagents: a worker's change is judged by the same mode and rules as the main agent's, and read-only stops it", async () => {
    const expected: Record<PermissionMode, { people: number; reviews: number; written: boolean; source: string | undefined }> = {
        read_only: { people: 0, reviews: 0, written: false, source: "mode" },
        ask: { people: 1, reviews: 0, written: true, source: undefined },
        auto_review: { people: 0, reviews: 1, written: true, source: "auto_review" },
        allow_all: { people: 0, reviews: 0, written: true, source: "mode" },
    };
    for (const mode of PERMISSION_MODES) {
        const root = makeRepo();
        const gateway = await new FakeGateway({ script: workerScript({ name: "apply_patch", args: create("worker.txt") }) }).start();
        try {
            const seen: ApprovalView[] = [];
            const { runner, journal } = await makeRunner(gateway, root, { prompter: asking(true, seen), runner: { subagents: true, permissions: gateFor(mode) } });
            assert.equal(await runner.runTask("Delegate it."), "success");
            const want = expected[mode];
            assert.equal(existsSync(join(root, "worker.txt")), want.written, `${mode}: written`);
            assert.equal(seen.length, want.people, `${mode}: people asked`);
            assert.equal(journal.state.generations.filter((g) => g.purpose === "review").length, want.reviews, `${mode}: reviews`);
            assert.equal(journal.state.approvals[0]!.policy?.source, want.source, mode);
            assert.match(journal.state.approvals[0]!.toolCallId, /^sa-[0-9a-f]{6}:/, "the approval belongs to the worker's call");
        } finally {
            await gateway.stop();
        }
    }
});

test("subagents: a worker's command follows the rules and the boundaries too", async () => {
    const cases: Array<{ label: string; rules: ScopedRule[]; mode: PermissionMode; argv: string[]; people: number; ran: boolean; source: string | undefined }> = [
        { label: "a deny rule", rules: [rule("deny", "run_command", "node")], mode: "allow_all", argv: ["node", "--version"], people: 0, ran: false, source: "deny_rule" },
        { label: "an allow rule", rules: [rule("allow", "run_command", "node")], mode: "ask", argv: ["node", "--version"], people: 0, ran: true, source: "allow_rule" },
        { label: "a push, whatever the mode and rules", rules: [rule("allow", "run_command", "git")], mode: "allow_all", argv: ["git", "push", "origin", "main"], people: 1, ran: false, source: undefined },
    ];
    for (const entry of cases) {
        const gateway = await new FakeGateway({ script: workerScript({ name: "run_command", args: { argv: entry.argv } }) }).start();
        try {
            const seen: ApprovalView[] = [];
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: asking(false, seen), runner: { subagents: true, permissions: gateFor(entry.mode, entry.rules) } });
            assert.equal(await runner.runTask("Delegate it."), "success");
            assert.equal(seen.length, entry.people, entry.label);
            assert.equal(journal.state.tools.some((t) => t.state === "completed" || t.state === "failed"), entry.ran, entry.label);
            assert.equal(journal.state.approvals[0]!.policy?.source, entry.source, entry.label);
        } finally {
            await gateway.stop();
        }
    }
});

// ── A run with no one to ask (tomverse exec) ───────────────────────────────

test("no prompter: a deny rule, read-only mode and a credential path are refused now; an allow rule runs; what needs a person waits", async () => {
    const node = ["node", "--version"];
    const cases: Array<{ label: string; mode: PermissionMode; rules: ScopedRule[]; call: [string, unknown]; outcome: string; decision?: string; source?: string; ran?: boolean }> = [
        { label: "deny rule", mode: "ask", rules: [rule("deny", "run_command", "node")], call: ["run_command", { argv: node }], outcome: "success", decision: "denied", source: "deny_rule" },
        { label: "read-only", mode: "read_only", rules: [], call: ["apply_patch", create("ro.txt")], outcome: "success", decision: "denied", source: "mode" },
        { label: "a deny rule beats an allow rule", mode: "ask", rules: [rule("allow", "run_command", "node"), rule("deny", "run_command", "node")], call: ["run_command", { argv: node }], outcome: "success", decision: "denied", source: "deny_rule" },
        { label: "allow rule", mode: "ask", rules: [rule("allow", "run_command", "node")], call: ["run_command", { argv: node }], outcome: "success", decision: "approved", source: "allow_rule", ran: true },
        { label: "no rule", mode: "ask", rules: [], call: ["run_command", { argv: node }], outcome: "needs_approval" },
        { label: "a push, even with an allow rule", mode: "ask", rules: [rule("allow", "run_command", "git")], call: ["run_command", { argv: ["git", "push", "origin", "main"] }], outcome: "needs_approval" },
        { label: "allow-all without a rule for a web page", mode: "allow_all", rules: [], call: ["web_fetch", { url: "https://example.com/" }], outcome: "needs_approval" },
    ];
    for (const entry of cases) {
        const gateway = await new FakeGateway({ script: oneCall(...entry.call) }).start();
        try {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null, runner: { permissions: gateFor(entry.mode, entry.rules), web: {} } });
            assert.equal(await runner.runTask("Do it."), entry.outcome, entry.label);
            if (entry.outcome === "needs_approval") {
                assert.equal(journal.state.pendingApprovals.length, 1, `${entry.label}: held for a person`);
                assert.equal(journal.state.approvals.length, 0, `${entry.label}: nothing was decided yet`);
            } else {
                assert.equal(journal.state.pendingApprovals.length, 0, entry.label);
                assert.deepEqual([journal.state.approvals[0]!.decision, journal.state.approvals[0]!.policy?.source], [entry.decision, entry.source], entry.label);
                assert.equal(journal.state.tools.some((t) => t.state === "completed"), entry.ran === true, `${entry.label}: ran`);
            }
        } finally {
            await gateway.stop();
        }
    }
    // A credential file is not offered to anyone, so it is not held either.
    const gateway = await new FakeGateway({ script: oneCall("apply_patch", create(".env")) }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null, runner: { permissions: gateFor("ask", [rule("allow", "apply_patch", "**")]) } });
        assert.equal(await runner.runTask("Write secrets."), "success");
        assert.equal(journal.state.pendingApprovals.length, 0);
        assert.equal(journal.state.approvals[0]!.decision, "denied");
    } finally {
        await gateway.stop();
    }
});

test("no prompter: a batch holds if any call needs a person, and decides everything when every call is settled", async () => {
    const batch = (...calls: Array<{ name: string; args: unknown }>) => (body: any) => (toolResultsSinceUser(body).length === 0 ? { toolCalls: calls } : { text: "Done." });
    const node = { name: "run_command", args: { argv: ["node", "--version"] } };
    const gateway = await new FakeGateway({ script: batch(node, { name: "run_command", args: { argv: ["node", "-p", "1"] } }) }).start();
    try {
        // One command is allowed by a rule, the other is not: the whole batch waits for a person and nothing was recorded.
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null, runner: { permissions: gateFor("ask", [rule("allow", "run_command", "node --version")]) } });
        assert.equal(await runner.runTask("Two."), "needs_approval");
        assert.equal(journal.state.pendingApprovals.length, 2);
        assert.equal(journal.state.approvals.length, 0);
    } finally {
        await gateway.stop();
    }
    const settled = await new FakeGateway({ script: batch(node, { name: "run_command", args: { argv: ["node", "-p", "1"] } }) }).start();
    try {
        const { runner, journal } = await makeRunner(settled, makeRepo(), { prompter: null, runner: { permissions: gateFor("ask", [rule("allow", "run_command", "node --version"), rule("deny", "run_command", "node -p")]) } });
        assert.equal(await runner.runTask("Two."), "success");
        assert.deepEqual(journal.state.approvals.map((a) => [a.decision, a.policy?.source]), [["approved", "allow_rule"], ["denied", "deny_rule"]]);
    } finally {
        await settled.stop();
    }
});

// ── The words run_command uses about itself ────────────────────────────────

test("run_command says it is not sandboxed unless the host says it is", async () => {
    assert.match(runCommandDescription(), /not sandboxed/);
    assert.match(runCommandDescription({ sandboxed: false }), /not sandboxed/);
    assert.doesNotMatch(runCommandDescription({ sandboxed: true }), /not sandboxed/);
    assert.match(runCommandDescription({ sandboxed: true }), /sandbox/);
    for (const [sandboxed, pattern] of [[false, /not sandboxed/], [true, /command sandbox/]] as const) {
        const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
        try {
            const { runner } = await makeRunner(gateway, makeRepo(), { runner: sandboxed ? { sandboxed: true } : {} });
            await runner.runTask("hi");
            const description = gateway.completions[0]!.body.tools.find((tool: any) => tool.function.name === "run_command").function.description;
            assert.match(description, pattern);
        } finally {
            await gateway.stop();
        }
    }
});

test("no prompter: an approval the rules settled when the batch was looked at but that needs a person when it is decided is refused, never approved", async () => {
    const gateway = await new FakeGateway({ script: oneCall("run_command", { argv: ["node", "--version"] }) }).start();
    try {
        // The rules file reads fine when the batch is looked at and cannot be read when the approval is decided.
        let reads = 0;
        const gate = new PermissionGate({ mode: "ask", rules: () => { reads += 1; if (reads > 1) throw new Error("unreadable"); return [rule("allow", "run_command", "node --version")]; } });
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null, runner: { permissions: gate } });
        assert.equal(await runner.runTask("Do it."), "success");
        assert.equal(journal.state.approvals[0]!.decision, "denied");
        assert.equal(journal.state.tools.some((t) => t.state === "completed"), false, "nothing ran");
        assert.match(toolMessages(gateway), /No one is available to approve this/);
    } finally {
        await gateway.stop();
    }
});

// ── Opening a public site in the browser tab ───────────────────────────────

const SITE = "https://docs.example.com/guide?x=1";
const navigateView = (): ApprovalView => ({ approvalId: "a", toolCallId: "t", toolName: "browser_navigate", input: { url: SITE }, root: ROOT,
    web: { url: SITE, host: "docs.example.com" } });

test("opening a public site asks a person in every mode and reaches the browser only after the answer; a local page is never asked", async () => {
    const calls = [{ name: "browser_navigate", args: { url: SITE } }, { name: "browser_navigate", args: { url: PAGE } }];
    for (const mode of PERMISSION_MODES) {
        for (const answer of [true, false]) {
            const gateway = await new FakeGateway({ script: browserScript(calls) }).start();
            try {
                const hostSeen: BrowserAgentRequest[] = [];
                const seen: ApprovalView[] = [];
                const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: asking(answer, seen), runner: { browserAgent: fakeBrowser(hostSeen), browserWeb: true, permissions: gateFor(mode) } });
                assert.equal(await runner.runTask("Look at the guide."), "success");
                assert.equal(seen.length, 1, `${mode}: one question, for the public site only`);
                assert.deepEqual([seen[0]!.toolName, seen[0]!.web?.host], ["browser_navigate", "docs.example.com"]);
                assert.deepEqual(hostSeen.map((request) => request.tool === "navigate" ? request.url : ""), answer ? [SITE, PAGE] : [PAGE], `${mode}/${answer}`);
                assert.equal(journal.state.generations.filter((g) => g.purpose === "review").length, 0, `${mode}: a reviewer never answers it`);
                assert.equal(journal.state.approvals[0]!.policy, undefined, `${mode}: no mode or rule answered`);
            } finally {
                await gateway.stop();
            }
        }
    }
});

test("without the second switch the runner asks nothing about a public address: the host refuses it", async () => {
    const gateway = await new FakeGateway({ script: browserScript([{ name: "browser_navigate", args: { url: SITE } }]) }).start();
    try {
        const hostSeen: BrowserAgentRequest[] = [];
        const seen: ApprovalView[] = [];
        const refusal = { status: "error", message: "Only an http address on localhost can be opened." };
        const { runner } = await makeRunner(gateway, makeRepo(), { prompter: asking(true, seen), runner: { browserAgent: fakeBrowser(hostSeen, { navigate: refusal }), permissions: gateFor("ask") } });
        assert.equal(await runner.runTask("Look at the guide."), "success");
        assert.deepEqual(seen, []);
        assert.match(toolMessages(gateway), /Only an http address on localhost/);
    } finally {
        await gateway.stop();
    }
});

test("an address that cannot be opened at all (port, IP, credentials) is refused without asking or reaching the browser", async () => {
    for (const url of ["https://docs.example.com:8443/", "https://192.168.0.1/", "https://user:pw@docs.example.com/", "http://docs.example.com/", "https://intranet/"]) {
        const gateway = await new FakeGateway({ script: browserScript([{ name: "browser_navigate", args: { url } }]) }).start();
        try {
            const hostSeen: BrowserAgentRequest[] = [];
            const seen: ApprovalView[] = [];
            const { runner } = await makeRunner(gateway, makeRepo(), { prompter: asking(true, seen), runner: { browserAgent: fakeBrowser(hostSeen), browserWeb: true, permissions: gateFor("allow_all") } });
            assert.equal(await runner.runTask("Look."), "success");
            assert.deepEqual([seen.length, hostSeen.length], [0, 0], url);
        } finally {
            await gateway.stop();
        }
    }
});

test("rules: a deny or ask rule for a site covers opening it in the browser; an allow rule for web_fetch does not", () => {
    const allow: ScopedRule = { effect: "allow", tool: "web_fetch", pattern: "docs.example.com", scope: "user" };
    const deny: ScopedRule = { effect: "deny", tool: "web_fetch", pattern: "*.example.com", scope: "project" };
    const ask: ScopedRule = { effect: "ask", tool: "web_fetch", pattern: "docs.example.com", scope: "user" };
    for (const mode of ["ask", "auto_review", "allow_all"] as const) {
        assert.equal(kindOf(navigateView(), mode), "human", mode);
        assert.equal(kindOf(navigateView(), mode, [allow]), "human", `${mode}: a web_fetch allow rule does not open the browser`);
        assert.equal(kindOf(navigateView(), mode, [deny]), "deny", mode);
        assert.equal(kindOf(navigateView(), mode, [ask]), "human", mode);
        assert.equal(kindOf(webView(), mode, [allow]), "allow", `${mode}: web_fetch itself is unchanged`);
    }
    assert.equal(kindOf(navigateView(), "read_only"), "human", "reading a page is asked about in read-only mode, as web_fetch is");
});
