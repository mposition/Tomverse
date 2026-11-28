import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { permissionModes } from "../src/permission-contract";
import { acpArguments, acpCommandLine, acpSecretPath, classifyAcpPermission, insideProject } from "../src/host/provider-cli-acp";
import { cliExecEnvironment, runProviderCli, type CliApproval, type ExecEvent, type ExecRun } from "../src/host/provider-cli-exec";
import { cliPermissionPlan, liveAcpProviders, liveCliFile, liveCliNames, liveCliProviderForModel, liveCliProviders, liveCliRunnable, providerConfigFolders,
  type LiveAcpProvider } from "../src/provider-cli-exec-contract";

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-agent.mjs");

// ------------------------------------------------------------------ contract

test("The six ACP CLIs are live routes of their own saved file, with the Claude Code permission plan", () => {
  assert.deepEqual([...liveAcpProviders], ["qwen", "xai", "moonshot", "mistral", "minimax", "google"]);
  for (const provider of liveAcpProviders) {
    assert.ok(liveCliProviders.includes(provider));
    assert.equal(liveCliFile[provider], provider);
    assert.equal(liveCliProviderForModel(`provider-cli:${provider}`), provider);
    assert.deepEqual(cliPermissionPlan(provider, "read_only"), { grants: "read_only", approvals: "none" });
    assert.deepEqual(cliPermissionPlan(provider, "ask"), { grants: "ask", approvals: "card" });
    assert.equal(cliPermissionPlan(provider, "auto_review").approvals, "card");
    assert.deepEqual(cliPermissionPlan(provider, "allow_all"), { grants: "allow_all", approvals: "card", notice: "cliAllowAllCommandsAsk" });
  }
  assert.deepEqual(liveAcpProviders.map((provider) => liveCliNames[provider]),
    ["Qwen Code", "Grok Build", "Kimi Code", "Mistral Vibe", "MiniMax Code", "Antigravity"]);
});

test("A saved file is runnable when it is the executable itself, never a release archive or an installation folder", () => {
  for (const provider of liveAcpProviders) assert.equal(liveCliRunnable(provider, { status: "userTrusted" }), true, provider);
  for (const provider of ["qwen", "mistral", "minimax"] as const) assert.equal(liveCliRunnable(provider, { status: "pathVerified" }), false, provider);
  for (const provider of ["xai", "moonshot", "google", "openai", "anthropic"] as const) assert.equal(liveCliRunnable(provider, { status: "pathVerified" }), true, provider);
  assert.equal(liveCliRunnable("qwen", { status: "versionUnverified" }), false);
  assert.equal(liveCliRunnable("qwen", { status: "checkRequired" }), false);
  assert.equal(liveCliRunnable("qwen", undefined), false);
});

test("Each CLI starts as an ACP agent with its own arguments and no approval-skipping flag", () => {
  assert.deepEqual(acpArguments("qwen"), ["--acp", "--approval-mode", "default"]);
  assert.deepEqual(acpArguments("moonshot"), ["acp"]);
  assert.deepEqual(acpArguments("mistral"), []);
  assert.deepEqual(acpArguments("xai"), ["--no-auto-update", "agent", "--no-leader", "stdio"]);
  assert.deepEqual(acpArguments("minimax"), ["acp"]);
  assert.deepEqual(acpArguments("google"), ["acp", "--disable-telemetry"]);
  for (const provider of liveAcpProviders) {
    assert.ok(!acpCommandLine[provider].some((arg) => /yolo|auto-approve|dangerous|bypass|skip-permissions|trust|--api-key|--gemini-dir|--agent-profile/i.test(arg)), provider);
    // The list handed out is a copy.
    acpArguments(provider).push("x");
    assert.ok(!acpCommandLine[provider].includes("x"));
  }
});

test("The CLI gets its own home and sign-in and no Tomverse or provider key", () => {
  const env = { HOME: "/home/p", USERPROFILE: "C:\\Users\\p", PATH: "/usr/bin", TOMVERSE_CODE_KEY: "tvk", OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "ak", GEMINI_API_KEY: "gk",
    MISTRAL_API_KEY: "mk", KIMI_CODE_HOME: "/elsewhere", QWEN_HOME: "/q", ELECTRON_RUN_AS_NODE: "1", CLAUDE_CONFIG_DIR: "/c", XAI_API_KEY: "xk" };
  for (const provider of liveAcpProviders) {
    const result = cliExecEnvironment(env, provider, "linux");
    assert.equal(result.HOME, "/home/p", provider);
    assert.equal(result.NO_COLOR, "1");
    for (const name of ["TOMVERSE_CODE_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "KIMI_CODE_HOME", "QWEN_HOME", "ELECTRON_RUN_AS_NODE"]) {
      assert.ok(!(name in result), `${provider} ${name}`);
    }
    // Claude Code's settings are not part of another CLI's run.
    assert.ok(!("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" in result) && !("DISABLE_AUTOUPDATER" in result), provider);
  }
  assert.equal(cliExecEnvironment(env, "google", "linux").AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.ok(!("AGY_CLI_DISABLE_AUTO_UPDATE" in cliExecEnvironment(env, "qwen", "linux")));
});

// ------------------------------------------------------------ credential paths

test("A provider CLI's settings and sign-in files are always refused, wherever they are written", () => {
  for (const folder of [".qwen", ".vibe", ".grok", ".kimi-code", ".gemini", ".codex", ".claude"]) assert.ok(providerConfigFolders.includes(folder as never), folder);
  const refused = [
    "C:\\Users\\p\\.qwen\\subscription_credentials.json", "C:\\Users\\p\\.qwen\\settings.json", "/home/p/.vibe/.env", "~/.vibe/config.toml", "/home/p/.grok/auth.json",
    "C:\\Users\\p\\.kimi-code\\credentials\\token.json", "/home/p/.gemini/antigravity-cli/state", "/home/p/.gemini/config", "/home/p/.codex/auth.json",
    "project/.claude/settings.json", "subscription_credentials.json", "oauth_creds.json", ".env", "keys/id_rsa", ".ssh/config", "x/.git/config", "my-api-key.txt",
    "%USERPROFILE%\\.QWEN\\x", ".q\u200bwen/x".replace(".q\u200bwen", ".qwen"),
  ];
  for (const path of refused) assert.ok(acpSecretPath(path), path);
  for (const path of ["src/app.ts", "docs/new.md", "notes.txt", "C:\\work\\project\\README.md", "lib/qwen-client.ts", "docs/vibe.md", "grok/index.ts"]) {
    assert.ok(!acpSecretPath(path), path);
  }
});

test("A path is inside the project only when it stays there after the folder's links are followed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tomverse-acp-path-"));
  try {
    assert.ok(insideProject(join(directory, "docs", "new.md"), directory));
    assert.ok(insideProject("docs/new.md", directory));
    assert.ok(insideProject(directory, directory));
    assert.ok(!insideProject(join(directory, "..", "outside.md"), directory));
    assert.ok(!insideProject("../outside.md", directory));
    assert.ok(!insideProject(join(directory, "..", `${directory.split(/[\\/]/).pop()}-sibling`, "x"), directory));
    assert.ok(!insideProject("C:\\Windows\\system32\\x".replace("C:\\Windows\\system32\\x", process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd"), directory));
    assert.ok(!insideProject("a\u0000b", directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- permissions

const options = [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
const request = (toolCall: object, extra: object = {}) => ({ sessionId: "s", toolCall: { toolCallId: "t1", status: "pending", ...toolCall }, options, ...extra });

test("Read only denies every write and command request without a card, and allows a read inside the project", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-perm-"));
  try {
    const plan = cliPermissionPlan("qwen", "read_only");
    const verdict = (toolCall: object) => classifyAcpPermission(request(toolCall), { cwd, plan }).verdict;
    assert.equal(verdict({ kind: "execute", title: "ls", rawInput: { command: "ls" } }), "deny");
    assert.equal(verdict({ kind: "edit", title: "Edit", locations: [{ path: join(cwd, "a.ts") }], content: [{ type: "diff", path: join(cwd, "a.ts"), oldText: "a", newText: "b" }] }), "deny");
    assert.equal(verdict({ kind: "delete", title: "Delete", locations: [{ path: join(cwd, "a.ts") }] }), "deny");
    assert.equal(verdict({ kind: "fetch", title: "Fetch https://example.com" }), "deny");
    assert.equal(verdict({ kind: "other", title: "mcp tool" }), "deny");
    assert.equal(verdict({ kind: "read", title: "Read a.ts", locations: [{ path: join(cwd, "a.ts") }] }), "allow");
    assert.equal(verdict({ kind: "search", title: "Search", rawInput: { pattern: "x" } }), "allow");
    assert.equal(verdict({ kind: "read", title: "Read outside", locations: [{ path: join(cwd, "..", "x.txt") }] }), "deny");
    assert.equal(verdict({ kind: "read", title: "Read login", locations: [{ path: "/home/p/.qwen/subscription_credentials.json" }] }), "deny");
    // Only "allow once" is ever chosen.
    const read = classifyAcpPermission(request({ kind: "read", locations: [{ path: join(cwd, "a.ts") }] }), { cwd, plan });
    assert.equal(read.allowOption, "allow");
    assert.equal(read.rejectOption, "reject");
    const onlyAlways = classifyAcpPermission({ ...request({ kind: "read", locations: [{ path: join(cwd, "a.ts") }] }), options: [options[1]] }, { cwd, plan });
    assert.equal(onlyAlways.verdict, "deny");
    assert.equal(onlyAlways.allowOption, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Ask and Auto review send every request to the card as what it is, and never show a credential request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-perm-"));
  try {
    for (const mode of ["ask", "auto_review"] as const) {
      const plan = cliPermissionPlan("moonshot", mode);
      const decide = (toolCall: object) => classifyAcpPermission(request(toolCall), { cwd, plan });
      const shell = decide({ kind: "execute", title: "Run tests", rawInput: { command: "npm test" } });
      assert.equal(shell.verdict, "ask");
      assert.equal(shell.approval.tool, "Bash");
      assert.deepEqual(shell.approval.input, { command: "npm test", description: "Run tests" });
      // The agent sometimes sends its arguments as a JSON string.
      assert.equal(decide({ kind: "execute", title: "t", rawInput: JSON.stringify({ command: "ls -la" }) }).approval.input.command, "ls -la");
      const created = decide({ kind: "edit", title: "Write", content: [{ type: "diff", path: join(cwd, "n.md"), oldText: null, newText: "hello" }] });
      assert.deepEqual([created.verdict, created.approval.tool, created.approval.input], ["ask", "Write", { file_path: join(cwd, "n.md"), content: "hello" }]);
      const changed = decide({ kind: "edit", title: "Edit", content: [{ type: "diff", path: join(cwd, "n.md"), oldText: "a", newText: "b" }] });
      assert.deepEqual([changed.approval.tool, changed.approval.input.old_string, changed.approval.input.new_string], ["Edit", "a", "b"]);
      const several = decide({ kind: "edit", title: "Edit two", content: [{ type: "diff", path: "a", oldText: "1", newText: "2" }, { type: "diff", path: "b", oldText: null, newText: "3" }] });
      assert.equal(several.approval.tool, "MultiEdit");
      const other = decide({ kind: "fetch", title: "Fetch docs", rawInput: { url: "https://example.com" } });
      assert.equal(other.verdict, "ask");
      assert.equal(other.approval.tool, "Fetch docs");
      assert.deepEqual(other.approval.input, { kind: "fetch", title: "Fetch docs", rawInput: { url: "https://example.com" } });
      for (const credential of [
        { kind: "edit", title: "Write", locations: [{ path: "/home/p/.qwen/subscription_credentials.json" }] },
        { kind: "read", title: "Read", rawInput: { path: "/home/p/.grok/auth.json" } },
        { kind: "execute", title: "cat", rawInput: { command: "cat ~/.vibe/.env" } },
        { kind: "execute", title: "cat ~/.kimi-code/credentials/x" },
        { kind: "other", title: "x", rawInput: { files: ["a.ts", ".gemini/antigravity-cli/token"] } },
        { kind: "edit", title: "Write", content: [{ type: "diff", path: ".env", oldText: null, newText: "A=1" }] },
      ]) {
        const refused = decide(credential);
        assert.equal(refused.verdict, "refuse", JSON.stringify(credential));
        assert.equal(refused.approval.refused, true);
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Allow all approves only a file edit inside the project; commands, network and anything outside still ask", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-perm-"));
  try {
    const plan = cliPermissionPlan("mistral", "allow_all");
    const decide = (toolCall: object) => classifyAcpPermission(request(toolCall), { cwd, plan }).verdict;
    const diff = (path: string) => [{ type: "diff", path, oldText: "a", newText: "b" }];
    assert.equal(decide({ kind: "edit", title: "Edit", locations: [{ path: join(cwd, "src", "a.ts") }], content: diff(join(cwd, "src", "a.ts")) }), "allow");
    assert.equal(decide({ kind: "edit", title: "Edit", locations: [{ path: "src/a.ts" }] }), "allow");
    assert.equal(decide({ kind: "edit", title: "Edit", locations: [{ path: join(cwd, "..", "a.ts") }], content: diff(join(cwd, "..", "a.ts")) }), "ask");
    assert.equal(decide({ kind: "edit", title: "Edit", locations: [{ path: join(cwd, "a.ts") }, { path: join(cwd, "..", "b.ts") }] }), "ask");
    assert.equal(decide({ kind: "edit", title: "Edit" }), "ask");
    assert.equal(decide({ kind: "edit", title: "Edit", rawInput: { path: join(cwd, "a.ts"), command: "rm -rf x" } }), "ask");
    assert.equal(decide({ kind: "execute", title: "ls", rawInput: { command: "ls" } }), "ask");
    assert.equal(decide({ kind: "delete", title: "Delete", locations: [{ path: join(cwd, "a.ts") }] }), "ask");
    assert.equal(decide({ kind: "move", title: "Move", locations: [{ path: join(cwd, "a.ts") }] }), "ask");
    assert.equal(decide({ kind: "fetch", title: "Fetch" }), "ask");
    assert.equal(decide({ kind: "read", title: "Read", locations: [{ path: join(cwd, "a.ts") }] }), "ask");
    // A credential file is refused in every mode.
    assert.equal(decide({ kind: "edit", title: "Edit", locations: [{ path: join(cwd, ".env") }], content: diff(join(cwd, ".env")) }), "refuse");
    assert.equal(decide({ kind: "edit", title: "Edit", locations: [{ path: "/home/p/.vibe/.env" }] }), "refuse");
    // No "allow once" option, no automatic yes.
    assert.equal(classifyAcpPermission({ ...request({ kind: "edit", locations: [{ path: "a.ts" }] }), options: [options[2]] }, { cwd, plan }).verdict, "ask");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------- the process

async function withProject<T>(body: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "tomverse-provider-acp-"));
  try {
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "notes.txt"), "Project notes\n");
    return await body(directory);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

function acpRun(directory: string, scenario: object, overrides: Partial<ExecRun> = {}): ExecRun & { events: ExecEvent[] } {
  const events: ExecEvent[] = [];
  return { provider: "mistral", file: process.execPath, argsPrefix: [fakeAgent, JSON.stringify(scenario)], cwd: directory, prompt: "Fix the bug", mode: "read_only",
    env: { ...process.env, TOMVERSE_CODE_KEY: "tvk_must_not_pass", OPENAI_API_KEY: "sk-must-not-pass", MISTRAL_API_KEY: "mk-must-not-pass", KIMI_CODE_HOME: "/must/not/pass", NODE_OPTIONS: "" },
    signal: new AbortController().signal, onEvent: (event) => events.push(event), events, ...overrides };
}
type Seen = { args: string[]; env: string[]; cwd: string; prompt: string; modeSet?: string; fsError?: number; terminalError?: number;
  initialize: { protocolVersion: number; clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean } };
  sessionNew: { cwd: string; mcpServers: unknown[] };
  outcomes: Array<{ name: string; outcome: { outcome: string; optionId?: string } }> };
const seenIn = async (record: string) => JSON.parse(await readFile(record, "utf8")) as Seen;
const outcomeOf = (seen: Seen, name: string) => seen.outcomes.find((entry) => entry.name === name)?.outcome;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function dead(pid: number) {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  return !alive(pid);
}
const allowed = (outcome: { outcome: string; optionId?: string } | undefined) => outcome?.outcome === "selected" && outcome.optionId === "allow";
const rejected = (outcome: { outcome: string; optionId?: string } | undefined) => outcome?.outcome === "selected" && outcome.optionId === "reject";

test("A Read only run advertises no file system or terminal, runs in the project, denies commands and edits, and never sees a Tomverse variable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("A provider CLI run must not call a server."); });
  await withProject(async (directory) => {
    const record = join(directory, "..", `acp-record-${Date.now()}.json`);
    const approvals: CliApproval[] = [];
    const run = acpRun(directory, { scenario: "script", record }, { provider: "qwen", approve: async (approval) => { approvals.push(approval); return true; } });
    const result = await runProviderCli(run);
    const seen = await seenIn(record);
    await rm(record, { force: true });
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(approvals, [], "Read only never asks the person");
    assert.deepEqual(seen.args, ["--acp", "--approval-mode", "default"]);
    assert.deepEqual(seen.initialize.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    assert.equal(seen.initialize.protocolVersion, 1);
    assert.deepEqual(seen.sessionNew.mcpServers, []);
    assert.equal(seen.prompt, "Fix the bug");
    assert.equal(seen.modeSet, "plan");
    for (const name of ["TOMVERSE_CODE_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY", "KIMI_CODE_HOME", "NODE_OPTIONS"]) assert.ok(!seen.env.includes(name), name);
    assert.deepEqual(seen.env.filter((name) => /tomverse/i.test(name)), []);
    for (const name of ["run-echo", "edit-project", "edit-outside", "edit-credential", "command-credential", "read-grok-auth"]) assert.ok(rejected(outcomeOf(seen, name)), name);
    assert.ok(allowed(outcomeOf(seen, "read-project")));
    assert.equal(seen.fsError, -32601);
    assert.equal(seen.terminalError, -32601);
    const types = run.events.map((event) => event.type);
    assert.equal(types[0], "session");
    assert.equal(types.at(-1), "turn");
    assert.deepEqual(run.events.filter((event) => event.type === "message").map((event) => (event as { text: string }).text), ["I will work. ", "done: Fix the bug"]);
    assert.ok(run.events.some((event) => event.type === "command" && event.command === "echo hi"));
    assert.ok(run.events.some((event) => event.type === "files" && event.files.some((file) => file.path.endsWith("new.md") && file.kind === "create")));
  });
});

test("Ask puts the requests on the card one at a time, refuses credential requests unseen, and only ever answers allow once", async () => {
  await withProject(async (directory) => {
    const record = join(directory, "..", `acp-record-${Date.now()}-ask.json`);
    const approvals: CliApproval[] = [];
    let open = 0;
    let overlapped = false;
    const run = acpRun(directory, { scenario: "script", record }, { mode: "ask", approve: async (approval) => {
      open += 1;
      overlapped ||= open > 1;
      approvals.push(approval);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open -= 1;
      // The person says yes to everything: a request the adapter refuses must still be answered no.
      return true;
    } });
    const result = await runProviderCli(run);
    const seen = await seenIn(record);
    await rm(record, { force: true });
    assert.equal(result.status, "completed");
    assert.equal(overlapped, false);
    assert.deepEqual(approvals.map(({ id }) => id), ["t-echo", "t-edit", "t-out", "t-cred", "t-cmd", "t-read", "t-auth"]);
    assert.deepEqual(approvals.filter(({ refused }) => refused).map(({ id }) => id), ["t-cred", "t-cmd", "t-auth"]);
    assert.equal(approvals[0]!.tool, "Bash");
    assert.equal(approvals[1]!.tool, "Write");
    for (const name of ["run-echo", "edit-project", "edit-outside", "read-project"]) assert.ok(allowed(outcomeOf(seen, name)), name);
    for (const name of ["edit-credential", "command-credential", "read-grok-auth"]) assert.ok(rejected(outcomeOf(seen, name)), name);
    assert.ok(seen.outcomes.every(({ outcome }) => outcome.optionId !== "always"));
    assert.equal(seen.modeSet, undefined, "Ask keeps the CLI's own mode");
    assert.ok(run.events.some((event) => event.type === "command" && event.state === "done" && event.output === "hi\n"));
    assert.ok(run.events.some((event) => event.type === "command" && event.state === "failed"));
  });
});

test("A declined request, a failing approver and a missing approver all answer no", async () => {
  await withProject(async (directory) => {
    for (const approve of [async () => false, async () => { throw new Error("The card closed."); }, undefined]) {
      const record = join(directory, "..", `acp-record-${Date.now()}-deny.json`);
      const result = await runProviderCli(acpRun(directory, { scenario: "script", record }, { mode: "ask", approve }));
      const seen = await seenIn(record);
      await rm(record, { force: true });
      assert.equal(result.status, "completed");
      assert.ok(seen.outcomes.every(({ name, outcome }) => rejected(outcome) || (name === "read-project" && rejected(outcome))), JSON.stringify(seen.outcomes));
    }
  });
});

test("Allow all approves an edit inside the project without a card; commands and edits outside still ask", async () => {
  await withProject(async (directory) => {
    const record = join(directory, "..", `acp-record-${Date.now()}-all.json`);
    const approvals: CliApproval[] = [];
    const run = acpRun(directory, { scenario: "script", record }, { mode: "allow_all", provider: "xai", approve: async (approval) => { approvals.push(approval); return !approval.refused; } });
    const result = await runProviderCli(run);
    const seen = await seenIn(record);
    await rm(record, { force: true });
    assert.equal(result.status, "completed");
    assert.deepEqual(seen.args, ["--no-auto-update", "agent", "--no-leader", "stdio"]);
    assert.deepEqual(approvals.map(({ id }) => id), ["t-echo", "t-out", "t-cred", "t-cmd", "t-read", "t-auth"]);
    assert.ok(allowed(outcomeOf(seen, "edit-project")));
    assert.ok(allowed(outcomeOf(seen, "run-echo")));
    for (const name of ["edit-credential", "command-credential", "read-grok-auth"]) assert.ok(rejected(outcomeOf(seen, name)), name);
  });
});

test("An agent that starts in a mode that approves on its own is switched back, or the run does not go on", async () => {
  await withProject(async (directory) => {
    const record = join(directory, "..", `acp-record-${Date.now()}-mode.json`);
    const switched = await runProviderCli(acpRun(directory, { scenario: "unsafe", record }, { mode: "ask", approve: async () => false }));
    assert.equal(switched.status, "completed");
    assert.equal((await seenIn(record)).modeSet, "default");
    await rm(record, { force: true });
    const stuck = await runProviderCli(acpRun(directory, { scenario: "unsafe-stuck", record }, { mode: "ask", approve: async () => false }));
    assert.equal(stuck.status, "failed");
    assert.match(stuck.error ?? "", /approves actions on its own/);
  });
});

test("A CLI that is not signed in, speaks another protocol or never answers fails with a plain reason, before any prompt is sent", async () => {
  await withProject(async (directory) => {
    const auth = await runProviderCli(acpRun(directory, { scenario: "auth" }));
    assert.equal(auth.status, "failed");
    assert.match(auth.error ?? "", /not signed in/);
    const version = await runProviderCli(acpRun(directory, { scenario: "badversion" }));
    assert.equal(version.status, "failed");
    assert.match(version.error ?? "", /protocol version 1/);
    const silent = await runProviderCli(acpRun(directory, { scenario: "silent" }, { limits: { handshake: 400 } }));
    assert.equal(silent.status, "failed");
    assert.match(silent.error ?? "", /handshake/);
    const early = await runProviderCli({ ...acpRun(directory, { scenario: "auto" }), argsPrefix: ["-e", "process.exit(2)"] });
    assert.equal(early.status, "failed");
    assert.equal(early.exitCode, 2);
    assert.match(early.error ?? "", /before it accepted the task/);
    const missing = await runProviderCli({ ...acpRun(directory, { scenario: "auto" }), file: join(directory, "no-such-cli"), argsPrefix: [] });
    assert.equal(missing.status, "failed");
  });
});

test("A task that fails, is refused or ends without an answer is not reported as completed", async () => {
  await withProject(async (directory) => {
    const failed = await runProviderCli(acpRun(directory, { scenario: "auto" }, { prompt: "Fix it [fail]" }));
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /The model is unavailable/);
    const refused = await runProviderCli(acpRun(directory, { scenario: "refusal" }));
    assert.equal(refused.status, "failed");
    assert.match(refused.error ?? "", /refused/);
    // The agent left after taking the task, without saying how it went: it may have changed files.
    const quiet = await runProviderCli(acpRun(directory, { scenario: "auto" }, { prompt: "Fix it [quiet]" }));
    assert.equal(quiet.status, "unknown");
  });
});

test("An agent that does not leave when its input ends is ended after the turn, and the task is still completed", { timeout: 60_000 }, async () => {
  await withProject(async (directory) => {
    const started = Date.now();
    const result = await runProviderCli(acpRun(directory, { scenario: "auto" }, { prompt: "Fix it [linger]", approve: async () => false }));
    assert.equal(result.status, "completed");
    assert.ok(Date.now() - started < 30_000);
  });
});

test("Output beyond the limit ends the run, and one oversized or non-JSON line is skipped", async () => {
  await withProject(async (directory) => {
    const result = await runProviderCli(acpRun(directory, { scenario: "auto" }, { prompt: "Fix it [flood]", limits: { stream: 1024 * 1024, line: 4096 } }));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /more than Tomverse Desktop reads/);
    assert.ok(result.skipped >= 1);
  });
});

test("Stop answers a waiting card with a no and ends the agent and its child", { timeout: 60_000 }, async () => {
  await withProject(async (directory) => {
    const pidFile = join(directory, "pids.json");
    const controller = new AbortController();
    let asking!: () => void;
    const questioned = new Promise<void>((resolve) => { asking = resolve; });
    const run = acpRun(directory, { scenario: "hang", pidFile, record: join(directory, "r.json") }, {
      mode: "ask", signal: controller.signal,
      approve: (_request, signal) => new Promise<boolean>((resolve) => { asking(); signal.addEventListener("abort", () => resolve(false), { once: true }); }),
    });
    const running = runProviderCli(run);
    await questioned;
    let pids: { parent: number; child: number } | undefined;
    for (let attempt = 0; attempt < 100 && !pids; attempt += 1) {
      try { pids = JSON.parse(await readFile(pidFile, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(pids);
    controller.abort();
    assert.equal((await running).status, "stopped");
    assert.ok(await dead(pids.parent));
    assert.ok(await dead(pids.child));
  });
});

test("Stop before the process starts runs nothing", async () => {
  await withProject(async (directory) => {
    const controller = new AbortController();
    controller.abort();
    assert.equal((await runProviderCli(acpRun(directory, { scenario: "script" }, { signal: controller.signal }))).status, "stopped");
  });
});

test("Each ACP provider runs through the same adapter", async () => {
  await withProject(async (directory) => {
    for (const provider of liveAcpProviders as readonly LiveAcpProvider[]) {
      const record = join(directory, "..", `acp-record-${provider}-${Date.now()}.json`);
      const result = await runProviderCli(acpRun(directory, { scenario: "script", record }, { provider }));
      const seen = await seenIn(record);
      await rm(record, { force: true });
      assert.equal(result.status, "completed", provider);
      assert.deepEqual(seen.args, [...acpArguments(provider)], provider);
    }
  });
});

test("The permission table covers every mode for every ACP provider", () => {
  for (const provider of liveAcpProviders) for (const mode of permissionModes) assert.ok(cliPermissionPlan(provider, mode), `${provider} ${mode}`);
});
