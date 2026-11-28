import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { permissionModes, type PermissionModeId } from "../src/permission-contract";
import { cliPermissionPlan, cliPermissionPlans, liveCliFile, liveCliModelId, liveCliProviderForModel, liveCliProviders, permissionRank, ZAI_ANTHROPIC_BASE_URL } from "../src/provider-cli-exec-contract";
import { claudeArguments, claudeParser, claudeSecretRules, claudeTools, cliExecEnvironment, codexArguments, codexParser, codexWriteProfile,
  credentialPathsIn, runProviderCli, type CliApproval, type ExecEvent, type ExecRun } from "../src/host/provider-cli-exec";

// A made-up Z.ai key, put together at run time so no credential-shaped literal sits in the source.
const sampleZai = ["zai", "key", "0123456789"].join("-");

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-provider-cli.mjs");

// ------------------------------------------------------------ permission table

test("The CLI is never started above the permission mode the person chose", () => {
  for (const provider of liveCliProviders) {
    for (const mode of permissionModes) {
      const plan = cliPermissionPlan(provider, mode);
      assert.ok(permissionRank[plan.grants] <= permissionRank[mode], `${provider} ${mode} grants ${plan.grants}`);
    }
    assert.equal(cliPermissionPlan(provider, "read_only").grants, "read_only");
  }
  assert.deepEqual(Object.keys(cliPermissionPlans).sort(), [...liveCliProviders].sort());
});

test("The permission table, as the CLI's own options", () => {
  const codex = (mode: PermissionModeId) => codexArguments({ cwd: "/work", plan: cliPermissionPlan("openai", mode) });
  const claude = (mode: PermissionModeId, platform: NodeJS.Platform = "linux") => claudeArguments({ plan: cliPermissionPlan("anthropic", mode), sessionId: "s", platform });
  const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  // Codex `exec` cannot ask: Ask runs read-only and says so; Auto review is Codex's own reviewer; Allow all stays in the project sandbox.
  assert.equal(pair(codex("read_only"), "--sandbox"), "read-only");
  assert.equal(pair(codex("ask"), "--sandbox"), "read-only");
  assert.equal(cliPermissionPlan("openai", "ask").notice, "cliAskReadOnly");
  // Codex's own reviewer could approve a push or an upload that Tomverse leaves to the person, so it is never used.
  assert.equal(cliPermissionPlan("openai", "auto_review").notice, "cliAutoReviewScoped");
  assert.equal(cliPermissionPlan("openai", "allow_all").notice, "cliAllowAllScoped");
  // The write modes run in a permission profile: the project and the temp folder writable, the credential files found read-only.
  for (const mode of ["auto_review", "allow_all"] as const) {
    const args = codexArguments({ cwd: "/work", plan: cliPermissionPlan("openai", mode), readOnlyPaths: [".env", ".ssh/**"] });
    assert.ok(!args.includes("--sandbox"), mode);
    assert.ok(args.includes('default_permissions="tomverse"'), mode);
    assert.equal(args.find((arg) => arg.startsWith("permissions.tomverse=")),
      'permissions.tomverse={filesystem={":root"="read", ":tmpdir"="write", ":workspace_roots"={"."="write", ".env"="read", ".ssh/**"="read"}}}', mode);
  }
  for (const mode of permissionModes) {
    const args = codex(mode);
    // No mode reaches the unsandboxed or bypass options, the user's config file or rule files; the prompt comes on stdin.
    for (const forbidden of ["danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--yolo", "--approve-for-me", "--not-so-yolo"]) assert.ok(!args.includes(forbidden), `${mode} ${forbidden}`);
    for (const required of ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--ephemeral"]) assert.ok(args.includes(required), `${mode} ${required}`);
    assert.equal(args.at(-1), "-");
    assert.equal(pair(args, "-C"), "/work");
    // Without the user's config Codex has no Windows sandbox and refuses every command, so the unelevated one is named there.
    const windows = codexArguments({ cwd: "C:\\work", plan: cliPermissionPlan("openai", mode), platform: "win32" });
    assert.ok(windows.includes('windows.sandbox="unelevated"'), mode);
    assert.ok(!codexArguments({ cwd: "/work", plan: cliPermissionPlan("openai", mode), platform: "linux" }).some((arg) => arg.startsWith("windows.")), mode);
  }

  // A read-only file is named exactly; Codex takes a glob only to deny reading.
  assert.ok(codexWriteProfile(['a "b"/.env']).at(-1)!.includes('"a \\"b\\"/.env"="read"'));

  // Claude Code: the tool list is the hard limit; approvals come back over the stream except in Read only.
  assert.deepEqual(claudeTools("read_only"), ["Read", "Glob"]);
  assert.equal(pair(claude("read_only"), "--tools"), "Read,Glob");
  assert.equal(pair(claude("read_only"), "--permission-prompts"), "none");
  assert.equal(pair(claude("read_only"), "--permission-mode"), "dontAsk");
  for (const mode of ["ask", "auto_review", "allow_all"] as const) {
    assert.deepEqual(claudeTools(mode, "linux"), ["Read", "Glob", "Edit", "Write", "Bash"]);
    // No tool that returns file contents without the Read deny rules (credential files) applying to it.
    assert.ok(!claudeTools(mode, "linux").includes("Grep"), mode);
    assert.equal(pair(claude(mode), "--permission-prompts"), "host", mode);
    // Without the stdio prompt tool Claude Code denies every approval without sending can_use_tool (seen with 2.1.278).
    assert.equal(pair(claude(mode), "--permission-prompt-tool"), "stdio", mode);
    assert.equal(pair(claude(mode), "--permission-mode"), "default", mode);
  }
  // Claude Code's own auto mode could approve a shell command that publishes; Auto review asks the person instead and says so.
  assert.equal(cliPermissionPlan("anthropic", "auto_review").approvals, "card");
  assert.equal(cliPermissionPlan("anthropic", "auto_review").notice, "cliAutoReviewAsks");
  assert.ok(!claude("auto_review").includes("auto"));
  assert.ok(!claude("ask").includes("--allowedTools"), "Ask never pre-approves a tool");
  // Allow all pre-approves file edits; a command is still the person's to approve.
  assert.equal(pair(claude("allow_all"), "--allowedTools"), "Read,Glob,Edit,Write");
  assert.equal(pair(claude("allow_all", "win32"), "--allowedTools"), "Read,Glob,Edit,Write");
  assert.equal(cliPermissionPlan("anthropic", "allow_all").approvals, "card");
  assert.equal(cliPermissionPlan("anthropic", "allow_all").notice, "cliAllowAllCommandsAsk");
  assert.ok(claudeTools("ask", "win32").includes("PowerShell"));
  for (const mode of permissionModes) {
    const args = claude(mode);
    for (const required of ["--restricted", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence", "--print"]) assert.ok(args.includes(required), `${mode} ${required}`);
    // Credential files are denied for every tool and every mode, whatever an allow rule or a mode says.
    const denied = pair(args, "--disallowedTools").split(",");
    for (const rule of ["Read(**/.env*)", "Edit(**/.env*)", "Write(**/id_rsa*)", "Read(**/.ssh/**)", "Edit(**/.git/**)", "Read(**/*.pem)"]) assert.ok(denied.includes(rule), `${mode} ${rule}`);
    assert.deepEqual(denied, claudeSecretRules);
    for (const forbidden of ["bypassPermissions", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]) assert.ok(!args.includes(forbidden), `${mode} ${forbidden}`);
  }
  assert.equal(liveCliProviderForModel(liveCliModelId("anthropic")), "anthropic");
  assert.equal(liveCliProviderForModel("gpt-5"), null);
});

// -------------------------------------------------------------- environment

test("The names Claude Code is denied are the names Tomverse's own file tools refuse", async () => {
  const { isSecretPath } = await import("../../tomverse-cli/src/workspace.js");
  for (const name of [".env", ".env.local", "config/.npmrc", "id_rsa", "keys/server.pem", "a/secrets.yaml", "credentials.json", ".ssh/config", "x/.git/config", "gcp-key.json"]) {
    assert.ok(isSecretPath(name), name);
    const base = name.split("/").pop()!;
    const covered = claudeSecretRules.some((rule) => {
      const pattern = rule.slice(rule.indexOf("(**/") + 4, -1);
      if (pattern.endsWith("/**")) return name.split("/").includes(pattern.slice(0, -3));
      const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
      return new RegExp(`^${source}$`).test(base);
    });
    assert.ok(covered, `${name} is covered by a deny rule`);
  }
});

test("The CLI gets what it needs to find its own sign-in and nothing of this app's", () => {
  const env = {
    SystemRoot: "C:\\Windows", Path: "C:\\tools;C:\\Windows", USERPROFILE: "C:\\Users\\Ada", APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", CODEX_HOME: "D:\\codex",
    HTTPS_PROXY: "http://proxy:3128", TOMVERSE_DESKTOP_PROJECT_LOCKS: "C:\\locks", TOMVERSE_CODE_KEY: "tvk_secret", TOMVERSE_SESSION_TOKEN: "session",
    ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require evil.js", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-ant-x", GITHUB_TOKEN: "ghp_x",
    AWS_SECRET_ACCESS_KEY: "aws", SSH_AUTH_SOCK: "/tmp/agent",
  };
  const result = cliExecEnvironment(env, "openai", "win32");
  assert.equal(result.PATH, "C:\\tools;C:\\Windows");
  assert.equal(result.USERPROFILE, "C:\\Users\\Ada");
  assert.equal(result.CODEX_HOME, "D:\\codex");
  assert.equal(result.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(result.NO_COLOR, "1");
  for (const name of Object.keys(result)) {
    assert.ok(!/^(TOMVERSE_|ELECTRON|NODE_OPTIONS)/i.test(name) && !/KEY|TOKEN|SECRET|SOCK/i.test(name), name);
  }
  assert.equal(Object.values(result).some((value) => /tvk_|session|sk-|ghp_/.test(value)), false);
  assert.equal(cliExecEnvironment({ HOME: "/h", PATH: "/usr/bin" }, "anthropic", "linux").CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(cliExecEnvironment({ HOME: "/h" }, "openai", "linux").CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
});

// ------------------------------------------------------------------ parsers

test("Codex's JSONL becomes messages, commands, file changes and the end of the turn", () => {
  const parse = codexParser();
  const events = [
    { type: "thread.started", thread_id: "t1" },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls", status: "in_progress" } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "c2", type: "command_execution", command: "rm x", aggregated_output: "", exit_code: null, status: "declined" } },
    { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "add" }, { path: "b.ts", kind: "update" }, { path: "c.ts", kind: "delete" }, { path: "d.ts", kind: "weird" }], status: "completed" } },
    { type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "docs", tool: "search", status: "failed" } },
    { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Done." } },
    { type: "item.completed", item: { id: "r1", type: "reasoning", text: "private thoughts" } },
    { type: "item.started", item: { id: "a2", type: "agent_message", text: "partial" } },
    { type: "turn.completed", usage: {} },
    { type: "turn.failed", error: { message: "boom" } },
    { type: "something.new", value: 1 },
  ].flatMap((line) => parse(line));
  assert.deepEqual(events, [
    { type: "session", id: "t1" },
    { type: "command", id: "c1", command: "ls", state: "running" },
    { type: "command", id: "c1", command: "ls", state: "done", exitCode: 0, output: "a\n" },
    { type: "command", id: "c2", command: "rm x", state: "declined", output: "" },
    { type: "files", id: "f1", files: [{ path: "a.ts", kind: "create" }, { path: "b.ts", kind: "update" }, { path: "c.ts", kind: "delete" }], state: "done" },
    { type: "tool", id: "m1", name: "docs.search", state: "failed" },
    { type: "message", id: "a1", text: "Done." },
    { type: "turn", state: "completed" },
    { type: "turn", state: "failed", error: "boom" },
  ]);
});

test("Claude Code's frames become messages, tool calls with their results, and the end of the turn", () => {
  const parse = claudeParser();
  const events = [
    { type: "system", subtype: "init", session_id: "s1", model: "claude-test" },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
    { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "w1", name: "Write", input: { file_path: "n.md", content: "x" } }, { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "o.md" } },
      { type: "tool_use", id: "r1", name: "Read", input: { file_path: "p.md" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: [{ type: "text", text: "a\nb" }] }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] }, tool_use_result: { type: "create" } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "no", is_error: true }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "text" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "x" }] } },
    { type: "result", subtype: "success", is_error: false, result: "ok" },
    { type: "result", subtype: "error_max_turns", is_error: true },
  ].flatMap((frame) => parse(frame));
  assert.deepEqual(events, [
    { type: "session", id: "s1", model: "claude-test" },
    { type: "delta", id: "stream", text: "Hel" },
    { type: "message", id: "u1:0", text: "Hello" },
    { type: "command", id: "b1", command: "ls", state: "running" },
    { type: "files", id: "w1", files: [{ path: "n.md", kind: "create" }], state: "running" },
    { type: "files", id: "e1", files: [{ path: "o.md", kind: "update" }], state: "running" },
    { type: "tool", id: "r1", name: "Read", detail: "p.md", state: "running" },
    { type: "command", id: "b1", command: "", state: "done", output: "a\nb" },
    { type: "files", id: "w1", files: [{ path: "n.md", kind: "create" }], state: "done" },
    { type: "files", id: "e1", files: [{ path: "o.md", kind: "update" }], state: "failed" },
    { type: "tool", id: "r1", name: "Read", state: "done" },
    { type: "turn", state: "completed" },
    { type: "turn", state: "failed", error: "error_max_turns" },
  ]);
});

// ------------------------------------------------------------- the process

async function withFake<T>(body: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "tomverse-provider-cli-"));
  try { return await body(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

function baseRun(directory: string, scenario: object, overrides: Partial<ExecRun> = {}): ExecRun & { events: ExecEvent[] } {
  const events: ExecEvent[] = [];
  return { provider: "openai", file: process.execPath, argsPrefix: [fake, JSON.stringify(scenario)], cwd: directory, prompt: "Fix the bug", mode: "read_only",
    env: { ...process.env, TOMVERSE_CODE_KEY: "tvk_must_not_pass", OPENAI_API_KEY: "sk-must-not-pass", NODE_OPTIONS: "" }, signal: new AbortController().signal,
    onEvent: (event) => events.push(event), events, ...overrides };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function dead(pid: number) {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  return !alive(pid);
}

test("A Codex run reads the prompt on stdin, runs in the project folder with the mapped options and a small environment, and ends completed", async (t) => {
  // No Tomverse server is reached: any request would fail this test.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("A provider CLI run must not call a server."); });
  await withFake(async (directory) => {
    const record = join(directory, "record.json");
    await writeFile(join(directory, ".env"), "A=1");
    const run = baseRun(directory, { scenario: "codex-ok", record }, { mode: "allow_all" });
    const result = await runProviderCli(run);
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(run.events.map((event) => event.type), ["session", "command", "command", "files", "message", "turn"]);
    assert.equal(run.events.find((event) => event.type === "message")?.type === "message" && (run.events.find((event) => event.type === "message") as { text: string }).text, "done: Fix the bug");
    const seen = JSON.parse(await readFile(record, "utf8")) as { args: string[]; env: string[]; cwd: string; prompt: string };
    assert.equal(seen.prompt, "Fix the bug");
    assert.ok(!seen.args.includes("--sandbox"));
    assert.ok(seen.args.includes('default_permissions="tomverse"'));
    // The project's credential files are found before the start and named read-only.
    const profile = seen.args.find((arg) => arg.startsWith("permissions.tomverse=")) ?? "";
    assert.ok(profile.includes('".env"="read"'), profile);
    assert.equal(await realpathOf(seen.cwd), await realpathOf(directory));
    for (const name of ["TOMVERSE_CODE_KEY", "OPENAI_API_KEY", "NODE_OPTIONS"]) assert.ok(!seen.env.includes(name), name);
    assert.deepEqual(seen.env.filter((name) => /tomverse/i.test(name)), []);
  });
});

async function realpathOf(path: string) {
  const { realpath } = await import("node:fs/promises");
  return (await realpath(path)).toLowerCase();
}

test("A run that ends badly or without saying how it went is not reported as completed", async () => {
  await withFake(async (directory) => {
    const failed = await runProviderCli(baseRun(directory, { scenario: "codex-fail" }));
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "The model is unavailable.");
    // It may have changed files before it went silent: the outcome is unknown, never "completed".
    const silent = await runProviderCli(baseRun(directory, { scenario: "codex-silent" }));
    assert.equal(silent.status, "unknown");
    const missing = await runProviderCli(baseRun(directory, { scenario: "codex-ok" }, { file: join(directory, "no-such-cli"), argsPrefix: [] }));
    assert.equal(missing.status, "failed");
  });
});

test("Stop ends the CLI and everything it started", { timeout: 60_000 }, async () => {
  await withFake(async (directory) => {
    const pidFile = join(directory, "pids.json");
    const controller = new AbortController();
    const run = baseRun(directory, { scenario: "codex-hang", pidFile }, { signal: controller.signal });
    const running = runProviderCli(run);
    let pids: { parent: number; child: number } | undefined;
    for (let attempt = 0; attempt < 100 && !pids; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { pids = JSON.parse(await readFile(pidFile, "utf8")); } catch { /* not written yet */ }
    }
    assert.ok(pids, "the stand-in CLI started a child");
    assert.ok(alive(pids.parent) && alive(pids.child));
    controller.abort();
    const result = await running;
    assert.equal(result.status, "stopped");
    assert.ok(await dead(pids.parent), "the CLI is gone");
    assert.ok(await dead(pids.child), "its child is gone");
  });
});

test("What the CLI left running ends with it, and a question nobody can answer any more is cancelled", { timeout: 60_000 }, async () => {
  await withFake(async (directory) => {
    const pidFile = join(directory, "pids.json");
    const result = await runProviderCli(baseRun(directory, { scenario: "codex-orphan", pidFile }));
    assert.equal(result.status, "completed");
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as { parent: number; child: number };
    assert.ok(await dead(pids.parent));
    assert.ok(await dead(pids.child), "the background command did not outlive the CLI");

    let cancelled = false;
    const gone = await runProviderCli(baseRun(directory, { scenario: "claude-gone" }, {
      provider: "anthropic", mode: "ask",
      approve: (_request, signal) => new Promise<boolean>((resolve) => signal.addEventListener("abort", () => { cancelled = true; resolve(false); }, { once: true })),
    }));
    assert.ok(cancelled, "the waiting approval was cancelled when the CLI ended");
    assert.equal(gone.status, "unknown");
    assert.equal(gone.exitCode, 3);
  });
});

// Windows: Node starts every child inside a kill-on-close job object. Linux: the supervisor kills the group when its parent dies. macOS has neither.
test("When the worker crashes, a background command whose parent is already gone goes with it", { timeout: 60_000, skip: process.platform === "darwin" }, async () => {
  const { spawn } = await import("node:child_process");
  await withFake(async (directory) => {
    const pidFile = join(directory, "pids.json");
    const abandon = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "abandon-provider-cli.ts");
    const worker = spawn(process.execPath, ["--import", "tsx", abandon, fake, pidFile], { stdio: "ignore", cwd: join(dirname(abandon), "..", "..") });
    // The stand-in worker ends itself with SIGKILL, so no exit handler of the run runs.
    await new Promise<number | null>((resolve) => worker.once("close", resolve));
    const cli = JSON.parse(await readFile(pidFile, "utf8")) as { cli: number; middle: number };
    const grandchild = Number(await readFile(pidFile + ".grandchild", "utf8"));
    assert.ok(await dead(cli.cli), "the CLI went with the worker");
    assert.ok(await dead(cli.middle));
    assert.ok(await dead(grandchild), "so did the command whose parent had already exited");
  });
});

test("A run stopped before it starts never starts the CLI", async () => {
  await withFake(async (directory) => {
    const record = join(directory, "record.json");
    const controller = new AbortController();
    controller.abort();
    const result = await runProviderCli(baseRun(directory, { scenario: "codex-ok", record }, { signal: controller.signal }));
    assert.equal(result.status, "stopped");
    await assert.rejects(readFile(record, "utf8"));
  });
});

test("Output of any size is read without keeping it: an oversize line is skipped and the stream has a ceiling", { timeout: 120_000 }, async () => {
  await withFake(async (directory) => {
    let commands = 0;
    const run = baseRun(directory, { scenario: "codex-flood" }, { onEvent: (event) => { if (event.type === "command") commands += 1; } });
    const heapBefore = process.memoryUsage().heapUsed;
    const result = await runProviderCli(run);
    assert.equal(result.status, "completed");
    assert.ok(result.skipped >= 2, "the 3 MB line and the line that is not JSON were skipped");
    assert.equal(commands, 5000);
    assert.ok(process.memoryUsage().heapUsed - heapBefore < 200 * 1024 * 1024, "the output was not accumulated");
    // A ceiling on the whole stream ends the run as failed and stops the process.
    const capped = await runProviderCli(baseRun(directory, { scenario: "codex-flood" }, { limits: { stream: 1024 * 1024, line: 4096 } }));
    assert.equal(capped.status, "failed");
    assert.match(capped.error ?? "", /more than/);
  });
});

test("Claude Code's approval comes back from the person, and the answer is the person's alone", { timeout: 60_000 }, async () => {
  await withFake(async (directory) => {
    for (const allow of [true, false]) {
      const record = join(directory, `record-${allow}.json`);
      const asked: CliApproval[] = [];
      const run = baseRun(directory, { scenario: "claude-approve", record }, {
        provider: "anthropic", mode: "ask", approve: async (request) => { asked.push(request); return allow; },
      });
      const result = await runProviderCli(run);
      assert.equal(result.status, "completed", String(allow));
      assert.deepEqual(asked, [{ id: "r1", tool: "Bash", input: { command: "echo hi" } }]);
      const seen = JSON.parse(await readFile(record, "utf8")) as { response: { type: string; response: { subtype: string; request_id: string; response: Record<string, unknown> } }; prompt: string; args: string[] };
      assert.equal(seen.prompt, "Fix the bug");
      assert.equal(seen.response.type, "control_response");
      assert.equal(seen.response.response.request_id, "r1");
      if (allow) {
        assert.deepEqual(seen.response.response.response, { behavior: "allow", updatedInput: { command: "echo hi" } });
        assert.ok(run.events.some((event) => event.type === "files" && event.state === "done" && event.files[0]?.path === "docs/new.md" && event.files[0].kind === "create"));
        assert.ok(run.events.some((event) => event.type === "command" && event.state === "done" && event.output === "hi\n"));
      } else {
        assert.equal(seen.response.response.response.behavior, "deny");
        assert.ok(run.events.some((event) => event.type === "command" && event.state === "failed"));
      }
    }
  });
});

test("Without an approver, or in a mode that never asks, every request is denied", async () => {
  await withFake(async (directory) => {
    for (const overrides of [{ mode: "ask" as const }, { mode: "read_only" as const, approve: async () => true }]) {
      const record = join(directory, `record-${overrides.mode}.json`);
      const result = await runProviderCli(baseRun(directory, { scenario: "claude-approve", record }, { provider: "anthropic", ...overrides }));
      assert.equal(result.status, "completed");
      const seen = JSON.parse(await readFile(record, "utf8")) as { response: { response: { response: { behavior: string } } } };
      assert.equal(seen.response.response.response.behavior, "deny", overrides.mode);
    }
  });
});

test("Stop answers a waiting approval with a denial and ends the process tree", { timeout: 60_000 }, async () => {
  await withFake(async (directory) => {
    const pidFile = join(directory, "pids.json");
    const controller = new AbortController();
    let asking!: () => void;
    const questioned = new Promise<void>((resolve) => { asking = resolve; });
    const run = baseRun(directory, { scenario: "claude-hang", pidFile, record: join(directory, "r.json") }, {
      provider: "anthropic", mode: "ask", signal: controller.signal,
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

/** The source without its comments, so a sentence that says what the code does not do is not mistaken for code. */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("The provider CLI route has no path to a Tomverse API or to credits", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "host");
  for (const file of ["provider-cli-exec.ts", "provider-cli-transcript.ts"]) {
    const source = withoutComments(await readFile(join(root, file), "utf8"));
    assert.doesNotMatch(source, /\bfetch\s*\(|Gateway|gatewayFor|resolveEndpoint|credit|connection\.key|codeSessionTokens|desktop-session/i, file);
  }
  const runner = await readFile(join(root, "runner-process.ts"), "utf8");
  const start = runner.indexOf("async function executeProviderCli");
  const end = runner.indexOf("async function approveNativePatch");
  assert.ok(start > 0 && end > start);
  const body = withoutComments(runner.slice(start, end));
  assert.doesNotMatch(body, /gatewayFor|new Gateway|\.models\(\)|connection|codeSessionTokens|sessionCost|requestStatus|fetch\s*\(/);
  // The command carries no Tomverse connection or token to the worker.
  const messages = await readFile(join(root, "messages.ts"), "utf8");
  const command = withoutComments(messages.slice(messages.indexOf('type: "start-provider-cli"'), messages.indexOf('type: "resume"')));
  // The one key it may carry is the Z.ai route's own provider key (Claude Code on the Coding Plan), never a Tomverse one.
  const zaiField = /zai\?: \{ key: string; configDir: string \}/;
  assert.match(command, zaiField);
  assert.doesNotMatch(command.replace(zaiField, ""), /connection|connectionKey|token|key:/i);
});

test("Codex's write modes make the project's credential files read-only, a folder as a whole", async () => {
  const root = await mkdtemp(join(tmpdir(), "tv-cred-"));
  try {
    for (const [path, text] of [[".env", "A=1"], ["app/.env.local", "B=2"], ["keys/server.pem", "k"], [".ssh/id_ed25519", "k"], ["secrets/a.txt", "s"],
      ["node_modules/pkg/.env", "x"], ["src/index.ts", "x"], ["README.md", "x"]] as const) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    assert.deepEqual(await credentialPathsIn(root), [".env", ".ssh/**", "app/.env.local", "keys/server.pem", "node_modules/pkg/.env", "secrets/**"]);
    await assert.rejects(credentialPathsIn(join(root, "missing")), "a project that cannot be listed is not run with write access");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A folder the search cannot list is read-only as a whole", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tv-cred-"));
  try {
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "locked", ".env"), "A=1");
    await chmod(join(root, "locked"), 0o300);
    assert.deepEqual(await credentialPathsIn(root), ["locked/**"]);
  } finally {
    await chmod(join(root, "locked"), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code (Z.ai) runs the Claude Code adapter with the Z.ai endpoint, its key and a settings folder of its own", async () => {
  const zai = { key: sampleZai, configDir: "/data/provider-cli/zai-claude" };
  const env = { HOME: "/h", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/h/.claude", ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "other", ANTHROPIC_BASE_URL: "https://elsewhere" };
  const result = cliExecEnvironment(env, "zai", "linux", zai);
  assert.equal(result.ANTHROPIC_BASE_URL, ZAI_ANTHROPIC_BASE_URL);
  assert.equal(result.ANTHROPIC_AUTH_TOKEN, zai.key);
  // The person's own ~/.claude (and its sign-in) is not the folder this route uses.
  assert.equal(result.CLAUDE_CONFIG_DIR, zai.configDir);
  assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  // No other route gets a provider key or endpoint, whatever the environment holds.
  for (const provider of ["openai", "anthropic"] as const) {
    const other = cliExecEnvironment(env, provider, "linux", zai);
    for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) assert.equal(other[name], undefined, `${provider} ${name}`);
    assert.equal(other.CLAUDE_CONFIG_DIR, "/h/.claude", provider);
  }
  assert.equal(liveCliFile.zai, "anthropic");
  assert.deepEqual(cliPermissionPlans.zai, cliPermissionPlans.anthropic);
  assert.equal(liveCliProviderForModel(liveCliModelId("zai")), "zai");
});

test("A Claude Code (Z.ai) run without its key does not start; with it, the key is in the environment and never on the command line", async () => {
  await withFake(async (directory) => {
    const missing = join(directory, "missing.json");
    const refused = await runProviderCli(baseRun(directory, { scenario: "claude-approve", record: missing }, { provider: "zai", mode: "ask" }));
    assert.equal(refused.status, "failed");
    await assert.rejects(readFile(missing, "utf8"), { code: "ENOENT" }, "the CLI was not started");

    const record = join(directory, "record.json");
    const zai = { key: sampleZai, configDir: join(directory, "zai-claude") };
    const result = await runProviderCli(baseRun(directory, { scenario: "claude-approve", record }, { provider: "zai", mode: "ask", zai, approve: async () => false }));
    assert.equal(result.status, "completed");
    const seen = JSON.parse(await readFile(record, "utf8")) as { args: string[]; env: string[] };
    for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"]) assert.ok(seen.env.includes(name), name);
    assert.ok(seen.args.includes("--restricted") && seen.args.includes("--print"), "the Claude Code adapter's options");
    assert.ok(!seen.args.some((arg) => arg.includes(zai.key)), "the key is not on the command line");
  });
});
