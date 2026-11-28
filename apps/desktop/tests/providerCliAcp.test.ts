import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { permissionModes } from "../src/permission-contract";
import { acpArguments, acpSafety, acpSecretPath, classifyAcpPermission, commandNamesCredential, insideProject, namesCredential, realPathOf, trackToolCall, type TrackedCall } from "../src/host/provider-cli-acp";
import { cliExecEnvironment, runProviderCli, type CliApproval, type ExecEvent, type ExecRun } from "../src/host/provider-cli-exec";
import { desktopNativeCopy } from "../../../locales/desktopNative";
import { acpOwnRules, CLI_READ_ONLY_REFUSAL, cliReadOnlyRefused, cliRunsOwnRules, cliPermissionPlan, liveAcpProviders, liveCliFile, liveCliNames, liveCliProviderForModel, liveCliProviders, liveCliRunnable, providerConfigFolders,
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

test("Each CLI starts as an ACP agent with its permission mode forced on the command line where it has an option", () => {
  assert.deepEqual(acpArguments("qwen", "ask"), ["--acp", "--permission-mode", "default"]);
  assert.deepEqual(acpArguments("qwen", "read_only"), ["--acp", "--permission-mode", "dontAsk"]);
  assert.deepEqual(acpArguments("xai", "allow_all"), ["--permission-mode", "default", "--no-auto-update", "agent", "--no-leader", "stdio"]);
  assert.deepEqual(acpArguments("xai", "read_only"), ["--permission-mode", "dontAsk", "--no-auto-update", "agent", "--no-leader", "stdio"]);
  assert.deepEqual(acpArguments("moonshot", "ask"), ["acp"]);
  assert.deepEqual(acpArguments("mistral", "ask"), []);
  assert.deepEqual(acpArguments("minimax", "ask"), ["acp"]);
  assert.deepEqual(acpArguments("google", "ask"), ["acp", "--disable-telemetry"]);
  for (const provider of liveAcpProviders) for (const mode of permissionModes) {
    const args = acpArguments(provider, mode);
    assert.ok(!args.some((arg) => /yolo|auto-approve|bypass|skip-permissions|always-approve|dangerous|trust|--api-key|--gemini-dir|--agent-profile|approval-mode/i.test(arg)), `${provider} ${mode}`);
    // The list handed out is a copy, and Qwen Code's rejected option is never used.
    args.push("x");
    assert.ok(!acpArguments(provider, mode).includes("x"));
  }
});

test("The table of known permission modes names, for each CLI, the modes that ask and the ones that do not", () => {
  assert.deepEqual(acpSafety.mistral.known, ["ask", "accept-edits", "smart-approve", "auto-approve"]);
  assert.deepEqual(acpSafety.mistral.interactive, ["ask"]);
  assert.deepEqual(acpSafety.xai.known, []);
  assert.deepEqual(acpSafety.minimax.config, [{ id: "permissionMode", known: ["default", "auto", "bypassPermissions"], accepted: ["default"] }]);
  for (const provider of liveAcpProviders) {
    const rule = acpSafety[provider];
    for (const mode of [...rule.readOnly, ...rule.interactive]) assert.ok(rule.known.includes(mode), `${provider} ${mode}`);
    for (const mode of rule.interactive) assert.ok(!/yolo|auto|accept|bypass/i.test(mode) || mode === "default", `${provider} ${mode}`);
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
  for (const folder of [".qwen", ".vibe", ".grok", ".kimi-code", ".minimax", ".minimax-code", ".gemini", ".codex", ".claude"]) assert.ok(providerConfigFolders.includes(folder as never), folder);
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
    assert.equal(verdict({ kind: "search", title: "Search", rawInput: { pattern: "x", path: cwd } }), "allow");
    // A read or search that names no place is not allowed on its own.
    assert.equal(verdict({ kind: "search", title: "Search", rawInput: { pattern: "x" } }), "deny");
    assert.equal(verdict({ kind: "read", title: "Read" }), "deny");
    assert.equal(verdict({ kind: "think", title: "Think" }), "deny");
    assert.equal(verdict({ kind: "execute", title: "ls", rawInput: {} }), "deny");
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

test("A command request without command text is refused unseen: the title is never taken for the command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-perm-"));
  try {
    for (const mode of ["ask", "auto_review", "allow_all"] as const) {
      const plan = cliPermissionPlan("qwen", mode);
      for (const toolCall of [{ kind: "execute", title: "rm -rf build" }, { kind: "execute", title: "rm -rf build", rawInput: {} }, { kind: "execute", title: "ls", rawInput: { command: "  " } },
        { kind: "execute", title: "ls", rawInput: { command: 7 } }, { kind: "execute", title: "ls", rawInput: "not json" }]) {
        const decision = classifyAcpPermission(request(toolCall), { cwd, plan });
        assert.equal(decision.verdict, "refuse", `${mode} ${JSON.stringify(toolCall)}`);
        assert.equal(decision.approval.refused, true);
      }
      const words = classifyAcpPermission(request({ kind: "execute", title: "List", rawInput: { command: ["ls", "-la"] } }), { cwd, plan });
      assert.equal(words.verdict, "ask");
      assert.equal(words.approval.input.command, "ls -la");
    }
    // The credential check reads the command itself, not its description.
    const plan = cliPermissionPlan("qwen", "ask");
    assert.equal(classifyAcpPermission(request({ kind: "execute", title: "Show the build log", rawInput: { command: "type %USERPROFILE%\\.qwen\\settings.json" } }), { cwd, plan }).verdict, "refuse");
    assert.equal(classifyAcpPermission(request({ kind: "execute", title: "cat ~/.vibe/.env", rawInput: { command: "ls" } }), { cwd, plan }).verdict, "ask");
    assert.equal(classifyAcpPermission(request({ kind: "execute", title: "x" }), { cwd, plan: cliPermissionPlan("qwen", "read_only") }).verdict, "deny");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("A read or search that names no place is denied in Read only and goes to the card, whole, in Ask", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-perm-"));
  try {
    const bare = { kind: "search", title: "Search the project", rawInput: { pattern: "TODO", glob: "**/*.ts" } };
    assert.equal(classifyAcpPermission(request(bare), { cwd, plan: cliPermissionPlan("moonshot", "read_only") }).verdict, "deny");
    for (const mode of ["ask", "auto_review", "allow_all"] as const) {
      const decision = classifyAcpPermission(request(bare), { cwd, plan: cliPermissionPlan("moonshot", mode) });
      assert.equal(decision.verdict, "ask", mode);
      assert.deepEqual(decision.approval.input, { kind: "search", title: "Search the project", rawInput: { pattern: "TODO", glob: "**/*.ts" } });
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("A link in the project that leads to a credential file is refused whatever it is called, and one that leads outside is not inside", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-acp-link-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(cwd, "docs"), { recursive: true });
    await mkdir(join(home, ".qwen"), { recursive: true });
    await writeFile(join(home, ".qwen", "subscription_credentials.json"), "{}");
    await writeFile(join(cwd, "notes.txt"), "n");
    const { symlink } = await import("node:fs/promises");
    const made: string[] = [];
    // A folder link (a junction on Windows) needs no privilege; a file link may not be allowed here.
    try { await symlink(join(home, ".qwen"), join(cwd, "docs", "settings"), process.platform === "win32" ? "junction" : "dir"); made.push("folder"); } catch { /* not supported here */ }
    try { await symlink(join(home, ".qwen", "subscription_credentials.json"), join(cwd, "readme-copy.txt"), "file"); made.push("file"); } catch { /* not supported here */ }
    if (made.length === 0) { t.skip("This system does not allow links."); return; }
    const plans = { ask: cliPermissionPlan("moonshot", "ask"), read_only: cliPermissionPlan("moonshot", "read_only"), allow_all: cliPermissionPlan("moonshot", "allow_all") };
    const targets = [...(made.includes("folder") ? ["docs/settings/anything.json", "docs/settings"] : []), ...(made.includes("file") ? ["readme-copy.txt"] : [])];
    for (const target of targets) {
      assert.ok(namesCredential(target, cwd), target);
      assert.ok(!insideProject(target, cwd), target);
      for (const toolCall of [{ kind: "read", locations: [{ path: target }] }, { kind: "edit", title: "Edit", locations: [{ path: join(cwd, target) }] }, { kind: "search", rawInput: { path: target } }]) {
        assert.equal(classifyAcpPermission(request(toolCall), { cwd, plan: plans.ask }).verdict, "refuse", `${target} ask`);
        assert.equal(classifyAcpPermission(request(toolCall), { cwd, plan: plans.allow_all }).verdict, "refuse", `${target} allow_all`);
        assert.equal(classifyAcpPermission(request(toolCall), { cwd, plan: plans.read_only }).verdict, "deny", `${target} read_only`);
      }
    }
    // An ordinary path next to them is not.
    assert.ok(!namesCredential("notes.txt", cwd));
    assert.ok(!namesCredential("docs/new.md", cwd));
    assert.ok(insideProject("docs/new.md", cwd));
    assert.equal(classifyAcpPermission(request({ kind: "edit", locations: [{ path: "docs/new.md" }] }), { cwd, plan: plans.allow_all }).verdict, "allow");
    // The real path keeps the part that does not exist yet.
    const real = realPathOf("docs/not/yet.md", cwd);
    assert.ok(real?.endsWith(join("docs", "not", "yet.md")));
    assert.equal(realPathOf(`a${String.fromCharCode(1)}b`, cwd), null);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A project that lives under a provider settings folder name is not refused as a whole", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-acp-home-"));
  try {
    const cwd = join(root, ".claude", "worktrees", "app");
    await mkdir(join(cwd, "src"), { recursive: true });
    assert.ok(!namesCredential("src/a.ts", cwd));
    assert.ok(!namesCredential(join(cwd, "src", "a.ts"), cwd));
    assert.ok(namesCredential(join(cwd, ".claude", "settings.json"), cwd));
    assert.equal(classifyAcpPermission(request({ kind: "edit", locations: [{ path: join(cwd, "src", "a.ts") }] }), { cwd, plan: cliPermissionPlan("qwen", "allow_all") }).verdict, "allow");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------- the requests of the real CLIs

const vibeOptions = [{ optionId: "a", name: "Allow once", kind: "allow_once" }, { optionId: "b", name: "Always", kind: "allow_always" },
  { optionId: "c", name: "Always, permanently", kind: "allow_always_permanent" }, { optionId: "d", name: "Reject", kind: "reject_once" }];
const tracking = (updates: Array<[string, object]>) => {
  const calls = new Map<string, TrackedCall>();
  for (const [id, update] of updates) trackToolCall(calls, id, update as Record<string, unknown>);
  return calls;
};
const chunk = (text: string) => ({ content: [{ type: "content", content: { type: "text", text } }] });

test("Vibe asks with only the call's id: what its earlier tool_call said is what the card and the checks use", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-vibe-"));
  try {
    const calls = tracking([
      ["effect-1", { title: "Writing hello.txt", kind: "edit", content: [{ path: "hello.txt", newText: "hi", type: "diff" }], locations: [{ path: join(cwd, "hello.txt") }], rawInput: { filePath: "hello.txt", content: "hi" } }],
      ["effect-2", { title: "bash: printf 'hi' > hello.txt && cat hello.txt", kind: "execute", rawInput: { command: "printf 'hi' > hello.txt && cat hello.txt" } }],
      ["effect-3", { title: "Writing the login", kind: "edit", locations: [{ path: "/home/p/.vibe/.env" }], rawInput: { filePath: "/home/p/.vibe/.env", content: "x" } }],
    ]);
    const ask = (id: string, mode: "read_only" | "ask" | "allow_all") => classifyAcpPermission({ sessionId: "s", toolCall: { toolCallId: id }, options: vibeOptions },
      { cwd, plan: cliPermissionPlan("mistral", mode), tracked: calls.get(id) });
    const edit = ask("effect-1", "ask");
    assert.equal(edit.verdict, "ask");
    assert.deepEqual([edit.approval.tool, edit.approval.input], ["Write", { file_path: "hello.txt", content: "hi" }]);
    // Only "allow once" is ever chosen: not "always", not "always, permanently".
    assert.deepEqual([edit.allowOption, edit.rejectOption], ["a", "d"]);
    assert.equal(ask("effect-1", "allow_all").verdict, "allow");
    assert.equal(ask("effect-1", "read_only").verdict, "deny");
    const bash = ask("effect-2", "ask");
    assert.deepEqual([bash.verdict, bash.approval.tool, bash.approval.input.command], ["ask", "Bash", "printf 'hi' > hello.txt && cat hello.txt"]);
    assert.equal(ask("effect-2", "allow_all").verdict, "ask", "a command still asks in Allow all");
    assert.equal(ask("effect-3", "allow_all").verdict, "refuse");
    assert.equal(ask("effect-3", "ask").approval.refused, true);
    // A request that says nothing, with nothing tracked, is refused without a card (denied in Read only).
    for (const mode of ["ask", "auto_review", "allow_all"] as const) {
      const empty = classifyAcpPermission({ sessionId: "s", toolCall: { toolCallId: "effect-ghost" }, options: vibeOptions }, { cwd, plan: cliPermissionPlan("mistral", mode) });
      assert.deepEqual([empty.verdict, empty.approval.refused], ["refuse", true], mode);
    }
    assert.equal(classifyAcpPermission({ sessionId: "s", toolCall: { toolCallId: "x" }, options: vibeOptions }, { cwd, plan: cliPermissionPlan("mistral", "read_only") }).verdict, "deny");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Kimi streams a call's arguments as JSON text before it asks: a whole object is the call's input, anything else is not", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-kimi-"));
  try {
    const calls = tracking([
      ["0:tool_1", { title: "Write", kind: "edit", status: "pending" }], ["0:tool_1", chunk('{"path":"hello.txt",')], ["0:tool_1", chunk('"content":"hi"}')],
      ["0:tool_2", { title: "Bash", kind: "execute", status: "pending" }], ["0:tool_2", chunk('{"command":')], ["0:tool_2", chunk('"ls -la"}')],
      ["0:tool_3", { title: "Bash", kind: "execute", status: "pending" }], ["0:tool_3", chunk('{"command":"ls')],
      ["0:tool_4", { title: "Write", kind: "edit", status: "pending" }], ["0:tool_4", chunk('{"path":"/home/p/.kimi-code/credentials/x","content":"x"}')],
      // A CLI that repeats the whole text in each update.
      ["0:tool_5", { title: "Write", kind: "edit" }], ["0:tool_5", chunk('{"path":"a.md"')], ["0:tool_5", chunk('{"path":"a.md","content":"A"}')],
      ["0:tool_6", { title: "Bash", kind: "execute" }], ["0:tool_6", chunk("[1, 2]")],
    ]);
    const ask = (id: string, title: string, mode: "read_only" | "ask" | "allow_all") => classifyAcpPermission({ sessionId: "s", options: vibeOptions,
      toolCall: { toolCallId: id, title, content: [{ type: "content", content: { type: "text", text: `Requesting approval to ${title}` } }] } },
    { cwd, plan: cliPermissionPlan("moonshot", mode), tracked: calls.get(id) });
    const write = ask("0:tool_1", "Write", "ask");
    assert.deepEqual([write.verdict, write.approval.tool, write.approval.input], ["ask", "Write", { file_path: "hello.txt", content: "hi" }]);
    assert.equal(ask("0:tool_1", "Write", "allow_all").verdict, "allow");
    assert.equal(ask("0:tool_1", "Write", "read_only").verdict, "deny");
    const bash = ask("0:tool_2", "Bash", "ask");
    assert.deepEqual([bash.verdict, bash.approval.tool, bash.approval.input.command], ["ask", "Bash", "ls -la"]);
    // Text that is not yet, or not at all, one JSON object is not used: a command with no command text is refused.
    assert.equal(ask("0:tool_3", "Bash", "ask").verdict, "refuse");
    assert.equal(ask("0:tool_6", "Bash", "ask").verdict, "refuse");
    assert.equal(ask("0:tool_4", "Write", "allow_all").verdict, "refuse");
    const again = ask("0:tool_5", "Write", "ask");
    assert.deepEqual(again.approval.input, { file_path: "a.md", content: "A" });
    // The request's own text ("Requesting approval...") is never taken for the call's input.
    assert.equal(classifyAcpPermission({ sessionId: "s", options: vibeOptions, toolCall: { toolCallId: "0:new", title: "Write", content: [{ type: "content", content: { type: "text", text: '{"path":"x"}' } }] } },
      { cwd, plan: cliPermissionPlan("moonshot", "allow_all") }).approval.input.rawInput, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Antigravity names its arguments in its own way and sends options with no kind", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-agy-"));
  try {
    const bare = [{ optionId: "allow", name: "Allow" }, { optionId: "deny", name: "Deny" }];
    const bash = classifyAcpPermission({ sessionId: "s", options: bare, toolCall: { name: "run_command", kind: "execute", title: "echo hi", args: { CommandLine: "echo hi" },
      rawInput: { CommandLine: "echo hi", WaitMsBeforeAsync: 5000, toolSummary: "Print hi" } } }, { cwd, plan: cliPermissionPlan("google", "ask") });
    assert.deepEqual([bash.verdict, bash.approval.tool, bash.allowOption, bash.rejectOption], ["ask", "Bash", "allow", "deny"]);
    // Every field of the request is on the card.
    assert.deepEqual(bash.approval.input, { command: "echo hi", WaitMsBeforeAsync: 5000, toolSummary: "Print hi" });
    const write = classifyAcpPermission({ sessionId: "s", options: bare, toolCall: { name: "write_file", kind: "edit", rawInput: { Content: "hi", Overwrite: true, Path: join(cwd, "hello.txt") } } },
      { cwd, plan: cliPermissionPlan("google", "allow_all") });
    assert.equal(write.verdict, "allow");
    const card = classifyAcpPermission({ sessionId: "s", options: bare, toolCall: { name: "write_file", kind: "edit", rawInput: { Content: "hi", Overwrite: true, Path: join(cwd, "hello.txt") } } },
      { cwd, plan: cliPermissionPlan("google", "ask") });
    assert.deepEqual([card.approval.tool, card.approval.input], ["Write", { file_path: join(cwd, "hello.txt"), content: "hi", Overwrite: true }]);
    for (const toolCall of [{ kind: "edit", rawInput: { Content: "x", Path: "/home/p/.gemini/antigravity-cli/state" } }, { kind: "execute", rawInput: { CommandLine: "type ~/.gemini/config" } }]) {
      assert.equal(classifyAcpPermission({ sessionId: "s", options: bare, toolCall }, { cwd, plan: cliPermissionPlan("google", "ask") }).verdict, "refuse");
    }
    // Options that carry a kind of their own are not guessed from their ids.
    const named = classifyAcpPermission({ sessionId: "s", toolCall: { kind: "read", rawInput: { Path: join(cwd, "a") } }, options: [{ optionId: "allow", kind: "allow_always" }, { optionId: "deny", kind: "reject_always" }] },
      { cwd, plan: cliPermissionPlan("google", "ask") });
    assert.deepEqual([named.allowOption, named.rejectOption], [undefined, undefined]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("MiniMax Code reports a call's arguments in an update after the call, and the request's own fields win over what was tracked", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-minimax-"));
  try {
    const calls = tracking([
      ["m1", { title: "write", name: "write", kind: "edit" }], ["m1", { rawInput: { path: "hello.txt", content: "hi" } }],
      ["m2", { title: "bash", kind: "execute" }], ["m2", { rawInput: { command: "od -c notes.md | head -5" } }],
      ["m3", { title: "bash", kind: "execute", rawInput: { command: "cat ~/.minimax/auth.json" } }],
      ["m4", { title: "bash", kind: "execute", rawInput: { command: "ls" } }],
    ]);
    const ask = (toolCall: object, mode: "ask" | "allow_all", id: string) => classifyAcpPermission({ sessionId: "s", options: vibeOptions, toolCall: { toolCallId: id, ...toolCall } },
      { cwd, plan: cliPermissionPlan("minimax", mode), tracked: calls.get(id) });
    const write = ask({ title: "write", kind: "edit" }, "ask", "m1");
    assert.deepEqual([write.verdict, write.approval.tool, write.approval.input], ["ask", "Write", { file_path: "hello.txt", content: "hi" }]);
    assert.equal(ask({ title: "write", kind: "edit" }, "allow_all", "m1").verdict, "allow");
    const bash = ask({ title: "bash", kind: "execute" }, "ask", "m2");
    assert.deepEqual([bash.verdict, bash.approval.input.command], ["ask", "od -c notes.md | head -5"]);
    // The request's command wins on the card, and the tracked one is checked too.
    assert.equal(ask({ kind: "execute", rawInput: { command: "pwd" } }, "ask", "m4").approval.input.command, "pwd");
    assert.equal(ask({ kind: "execute", rawInput: { command: "pwd" } }, "ask", "m3").verdict, "refuse");
    assert.equal(ask({ kind: "execute", rawInput: { command: "cat ~/.minimax-code/x" } }, "ask", "m4").verdict, "refuse");
    // A request that names a different place than the call did is judged by both: outside the project asks even in Allow all.
    const moved = classifyAcpPermission({ sessionId: "s", options: vibeOptions, toolCall: { toolCallId: "m1", kind: "edit", locations: [{ path: join(cwd, "..", "elsewhere.txt") }] } },
      { cwd, plan: cliPermissionPlan("minimax", "allow_all"), tracked: calls.get("m1") });
    assert.equal(moved.verdict, "ask");
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

type Session = { modes?: { current: string; available: string[] } | null; config?: Record<string, string>; modeOption?: boolean; setMode?: string; setConfig?: string; flipTo?: string };
const modesOf = (provider: LiveAcpProvider, current: string) => ({ current, available: [...acpSafety[provider].known] });
/** What each CLI reports when it starts in a mode that asks, and in the mode it really starts in (Vibe: accept-edits; MiniMax Code: permissionMode auto). */
const safeSession: Record<LiveAcpProvider, Session> = {
  qwen: { modes: modesOf("qwen", "default"), modeOption: false }, xai: { modes: null }, moonshot: { modes: modesOf("moonshot", "default") },
  mistral: { modes: modesOf("mistral", "ask") }, minimax: { modes: modesOf("minimax", "default"), config: { permissionMode: "default" } }, google: { modes: modesOf("google", "default") },
};
const unsafeSession: Record<LiveAcpProvider, Session> = {
  qwen: { modes: modesOf("qwen", "yolo"), modeOption: false }, xai: { modes: null }, moonshot: { modes: modesOf("moonshot", "yolo") },
  mistral: { modes: modesOf("mistral", "accept-edits") }, minimax: { modes: modesOf("minimax", "default"), config: { permissionMode: "auto" } }, google: { modes: modesOf("google", "accept-edits") },
};

function acpRun(directory: string, scenario: object, overrides: Partial<ExecRun> = {}): ExecRun & { events: ExecEvent[] } {
  const events: ExecEvent[] = [];
  const provider = (overrides.provider ?? "mistral") as LiveAcpProvider;
  return { provider: "mistral", file: process.execPath, argsPrefix: [fakeAgent, JSON.stringify({ session: safeSession[provider], ...scenario })], cwd: directory, prompt: "Fix the bug", mode: "read_only",
    env: { ...process.env, TOMVERSE_CODE_KEY: "tvk_must_not_pass", OPENAI_API_KEY: "sk-must-not-pass", MISTRAL_API_KEY: "mk-must-not-pass", KIMI_CODE_HOME: "/must/not/pass", NODE_OPTIONS: "" },
    signal: new AbortController().signal, onEvent: (event) => events.push(event), events, ...overrides };
}
type Seen = { args: string[]; env: string[]; cwd: string; prompt?: string; modeSets: string[]; configSets: Array<{ configId: string; value: string }>; fsError?: number; terminalError?: number;
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
    assert.deepEqual(seen.args, ["--acp", "--permission-mode", "dontAsk"]);
    assert.deepEqual(seen.initialize.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    assert.equal(seen.initialize.protocolVersion, 1);
    assert.deepEqual(seen.sessionNew.mcpServers, []);
    assert.equal(seen.prompt, "Fix the bug");
    assert.deepEqual(seen.modeSets, [], "Qwen Code is already in a mode that refuses");
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
    assert.deepEqual(seen.modeSets, [], "a mode that asks is kept");
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
    assert.deepEqual(seen.args, ["--permission-mode", "default", "--no-auto-update", "agent", "--no-leader", "stdio"]);
    assert.deepEqual(approvals.map(({ id }) => id), ["t-echo", "t-out", "t-cred", "t-cmd", "t-read", "t-auth"]);
    assert.ok(allowed(outcomeOf(seen, "edit-project")));
    assert.ok(allowed(outcomeOf(seen, "run-echo")));
    for (const name of ["edit-credential", "command-credential", "read-grok-auth"]) assert.ok(rejected(outcomeOf(seen, name)), name);
  });
});

test("Every CLI that starts in a mode that approves on its own is put in one that asks, and the task is sent only after that is confirmed", async () => {
  await withProject(async (directory) => {
    type Expected = { modes: string[]; configs: Array<{ configId: string; value: string }> };
    const none: Expected = { modes: [], configs: [] };
    const permission: Expected = { modes: [], configs: [{ configId: "permissionMode", value: "default" }] };
    const expected: Record<LiveAcpProvider, Record<"read_only" | "ask", Expected>> = {
      qwen: { read_only: { modes: ["dontAsk"], configs: [] }, ask: { modes: ["default"], configs: [] } },
      xai: { read_only: none, ask: none },
      moonshot: { read_only: { modes: ["plan"], configs: [] }, ask: { modes: ["default"], configs: [] } },
      mistral: { read_only: { modes: ["ask"], configs: [] }, ask: { modes: ["ask"], configs: [] } },
      minimax: { read_only: { modes: ["plan"], configs: permission.configs }, ask: permission },
      google: { read_only: { modes: ["default"], configs: [] }, ask: { modes: ["default"], configs: [] } },
    };
    for (const provider of liveAcpProviders) for (const mode of ["read_only", "ask"] as const) {
      // Antigravity edits without asking and has no read-only mode: a Read only task on it is refused before the process starts.
      if (cliReadOnlyRefused(provider, mode)) continue;
      const record = join(directory, "..", `acp-record-${provider}-${mode}-${Date.now()}.json`);
      const result = await runProviderCli(acpRun(directory, { scenario: "simple", record, session: unsafeSession[provider] }, { provider, mode, approve: async () => false }));
      const seen = await seenIn(record);
      await rm(record, { force: true });
      assert.equal(result.status, "completed", `${provider} ${mode}: ${result.error}`);
      assert.deepEqual(seen.modeSets, expected[provider][mode].modes, `${provider} ${mode}`);
      assert.deepEqual(seen.configSets, expected[provider][mode].configs, `${provider} ${mode}`);
      assert.equal(seen.prompt, "Fix the bug");
    }
  });
});

test("A mode that cannot be confirmed as one that asks ends the run before any task is sent", async () => {
  await withProject(async (directory) => {
    const attempt = async (session: Session, provider: LiveAcpProvider, mode: "read_only" | "ask" = "ask") => {
      const record = join(directory, "..", `acp-record-mode-${Date.now()}-${Math.random()}.json`);
      const result = await runProviderCli(acpRun(directory, { scenario: "simple", record, session }, { provider, mode, approve: async () => false, limits: { confirm: 400 } }));
      const seen = await seenIn(record);
      await rm(record, { force: true });
      return { result, seen };
    };
    const fails = async (session: Session, provider: LiveAcpProvider, pattern: RegExp, mode?: "read_only" | "ask") => {
      const { result, seen } = await attempt(session, provider, mode);
      assert.equal(result.status, "failed", JSON.stringify(session));
      assert.match(result.error ?? "", pattern);
      assert.equal(seen.prompt, undefined, "the task was not sent");
    };
    // A mode outside the table of the CLI's known ones, wherever it is reported.
    await fails({ modes: modesOf("mistral", "turbo") }, "mistral", /not one Desktop knows/);
    await fails({ modes: { current: "default", available: ["default"] } }, "mistral", /not one Desktop knows/);
    await fails({ modes: { current: "turbo", available: ["turbo", "default"] }, modeOption: false }, "google", /not one Desktop knows/);
    // A CLI that shows no modes where it has them, or modes where it has none.
    await fails({ modes: null }, "mistral", /did not report its permission mode/);
    await fails({ modes: { current: "default", available: ["default"] } }, "xai", /not one Desktop knows/);
    // Cannot switch: the safe mode is not on offer, the switch is refused, or nothing confirms it.
    await fails({ modes: { current: "accept-edits", available: ["accept-edits", "auto-approve"] } }, "mistral", /cannot switch to "ask"/);
    await fails({ ...unsafeSession.mistral, setMode: "error" }, "mistral", /refused to switch/);
    // A set_mode success with an empty answer is the switch, as ACP defines it (the real Vibe, Kimi and Antigravity answer {}).
    for (const [session, provider, mode, target] of [[unsafeSession.mistral, "mistral", "ask", "ask"], [unsafeSession.google, "google", "ask", "default"]] as const) {
      const quiet = await attempt({ ...session, setMode: "silent" }, provider, mode);
      assert.equal(quiet.result.status, "completed", provider);
      assert.deepEqual(quiet.seen.modeSets, [target], provider);
    }
    // MiniMax Code's own option: missing, unknown, refused, or unconfirmed.
    await fails({ modes: modesOf("minimax", "default") }, "minimax", /did not report its "permissionMode" option/);
    await fails({ modes: modesOf("minimax", "default"), config: { permissionMode: "turbo" } }, "minimax", /not one Desktop knows/);
    await fails({ ...unsafeSession.minimax, setConfig: "error" }, "minimax", /refused to set its "permissionMode"/);
    await fails({ ...unsafeSession.minimax, setConfig: "silent" }, "minimax", /did not confirm its "permissionMode"/);
    // A switch the CLI answers in its result, or by a notification, is confirmed.
    for (const how of ["result", "notify"]) {
      const mode = await attempt({ ...unsafeSession.mistral, setMode: how }, "mistral");
      assert.equal(mode.result.status, "completed", how);
      assert.deepEqual(mode.seen.modeSets, ["ask"]);
      const config = await attempt({ ...unsafeSession.minimax, setConfig: how }, "minimax");
      assert.equal(config.result.status, "completed", how);
    }
  });
});

test("A CLI that moves itself to a mode that does not ask during the task is ended", async () => {
  await withProject(async (directory) => {
    for (const [provider, flipTo] of [["mistral", "auto-approve"], ["qwen", "yolo"]] as const) {
      const result = await runProviderCli(acpRun(directory, { scenario: "flip", session: { ...safeSession[provider], flipTo } }, { provider, mode: "ask", approve: async () => true }));
      assert.equal(result.status, "failed", provider);
      assert.match(result.error ?? "", /changed its permission mode/);
    }
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
      const mode = cliReadOnlyRefused(provider, "read_only") ? "ask" : "read_only";
      const result = await runProviderCli(acpRun(directory, { scenario: "script", record }, { provider, mode, approve: async () => false }));
      const seen = await seenIn(record);
      await rm(record, { force: true });
      assert.equal(result.status, "completed", provider);
      assert.deepEqual(seen.args, acpArguments(provider, mode), provider);
    }
  });
});

test("The permission table covers every mode for every ACP provider", () => {
  for (const provider of liveAcpProviders) for (const mode of permissionModes) assert.ok(cliPermissionPlan(provider, mode), `${provider} ${mode}`);
});

test("The requests of the real CLIs, replayed by a stand-in agent, reach the card and the answers as the plan says", async () => {
  await withProject(async (directory) => {
    const names = ["vibe-edit", "vibe-bash", "vibe-credential", "vibe-unknown", "kimi-write", "kimi-bash", "kimi-credential", "kimi-partial", "agy-bash", "agy-write", "agy-credential",
      "minimax-write", "minimax-bash"];
    const run = async (mode: "read_only" | "ask" | "allow_all") => {
      const record = join(directory, "..", `acp-record-formats-${mode}-${Date.now()}.json`);
      const approvals: CliApproval[] = [];
      const result = await runProviderCli(acpRun(directory, { scenario: "formats", record }, { mode, approve: async (approval) => { approvals.push(approval); return true; } }));
      const seen = await seenIn(record);
      await rm(record, { force: true });
      assert.equal(result.status, "completed", `${mode}: ${result.error}`);
      assert.deepEqual(seen.outcomes.map(({ name }) => name), names);
      return { approvals, seen };
    };
    // Ask: every readable request reaches the card whole; credential, empty and argument-less ones are refused and answered no.
    const ask = await run("ask");
    const shown = ask.approvals.filter(({ refused }) => !refused);
    assert.deepEqual(ask.approvals.filter(({ refused }) => refused).map(({ id }) => id).sort(), ["0:tool_3", "0:tool_4", "effect-3", "effect-ghost", "unknown"]);
    const byId = Object.fromEntries(ask.approvals.map((approval) => [approval.id, approval]));
    assert.deepEqual([byId["effect-1"]!.tool, byId["effect-1"]!.input], ["Write", { file_path: "hello.txt", content: "hi" }]);
    assert.equal(byId["effect-2"]!.input.command, "printf 'hi' > hello.txt && cat hello.txt");
    assert.deepEqual([byId["0:tool_1"]!.tool, byId["0:tool_1"]!.input], ["Write", { file_path: "hello.txt", content: "hi" }]);
    assert.equal(byId["0:tool_2"]!.input.command, "ls -la");
    assert.equal(byId["m1"]!.tool, "Write");
    assert.equal(byId["m2"]!.input.command, "od -c notes.md | head -5");
    assert.ok(shown.length >= 8);
    for (const name of ["vibe-credential", "vibe-unknown", "kimi-credential", "kimi-partial"]) assert.ok(rejected(outcomeOf(ask.seen, name)), name);
    for (const name of ["vibe-edit", "vibe-bash", "kimi-write", "kimi-bash", "minimax-write", "minimax-bash"]) assert.ok(allowed(outcomeOf(ask.seen, name)), name);
    // Antigravity's options have no kind: "allow" and "deny" are picked by their ids, and a credential is answered "deny".
    assert.equal(outcomeOf(ask.seen, "agy-bash")?.optionId, "allow");
    assert.equal(outcomeOf(ask.seen, "agy-credential")?.optionId, "deny");
    assert.ok(ask.seen.outcomes.every(({ outcome }) => outcome.optionId !== "always" && outcome.optionId !== "permanent"));

    // Allow all: an edit inside the project is answered without a card, in each CLI's own format; commands still ask.
    const all = await run("allow_all");
    const asked = all.approvals.map(({ id }) => id);
    for (const id of ["effect-1", "0:tool_1", "m1"]) assert.ok(!asked.includes(id), `${id} needs no card`);
    for (const id of ["effect-2", "0:tool_2", "m2"]) assert.ok(asked.includes(id), `${id} asks`);
    for (const name of ["vibe-edit", "kimi-write", "agy-write", "minimax-write"]) assert.ok(allowed(outcomeOf(all.seen, name)), name);
    assert.equal(outcomeOf(all.seen, "agy-write")?.optionId, "allow");

    // Read only: nothing is shown, nothing is allowed.
    const readOnly = await run("read_only");
    assert.deepEqual(readOnly.approvals, []);
    for (const name of names) assert.ok(!allowed(outcomeOf(readOnly.seen, name)), name);
  });
});

test("The note about a CLI's own rules is for the CLIs seen to read, edit or run commands without asking, and for no other", async () => {
  assert.deepEqual(acpOwnRules.qwen, { readsWithoutAsking: true, editsWithoutAsking: false, safeCommandsWithoutAsking: true });
  assert.deepEqual(acpOwnRules.google, { readsWithoutAsking: true, editsWithoutAsking: true, safeCommandsWithoutAsking: false });
  assert.deepEqual(acpOwnRules.minimax, { readsWithoutAsking: false, editsWithoutAsking: true, safeCommandsWithoutAsking: false });
  assert.deepEqual(acpOwnRules.mistral, { readsWithoutAsking: false, editsWithoutAsking: false, safeCommandsWithoutAsking: true });
  for (const provider of ["qwen", "google", "minimax", "mistral"] as const) assert.equal(cliRunsOwnRules(provider), true, provider);
  for (const provider of ["moonshot", "xai", "openai", "anthropic", "zai"] as const) assert.equal(cliRunsOwnRules(provider), false, provider);
  // Every language has the note, and it is not the English one copied.
  const languages = Object.keys(desktopNativeCopy) as Array<keyof typeof desktopNativeCopy>;
  assert.deepEqual([...languages].sort(), ["de", "en", "es", "fr", "ko", "pt", "zh", "zh-Hant"]);
  for (const language of languages) {
    assert.ok(desktopNativeCopy[language].cliOwnRules.length > 40, language);
    if (language !== "en") assert.notEqual(desktopNativeCopy[language].cliOwnRules, desktopNativeCopy.en.cliOwnRules, language);
  }
  // The runner shows it only through that check, once, with the task's other notes.
  const runner = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "host", "runner-process.ts"), "utf8");
  const start = runner.indexOf("async function executeProviderCli");
  const body = runner.slice(start, runner.indexOf("async function approveNativePatch"));
  assert.equal(body.match(/cliOwnRules/g)?.length, 1);
  assert.match(body, /if \(cliRunsOwnRules\(command\.provider\)\) leading\.push\(desktopCodeNotice\("cliOwnRules"\)\);/);
});

test("A Read only task on Antigravity is refused before it starts, with the reason in every language; the other CLIs are not", async () => {
  assert.equal(cliReadOnlyRefused("google", "read_only"), true);
  for (const mode of ["ask", "auto_review", "allow_all"] as const) assert.equal(cliReadOnlyRefused("google", mode), false, mode);
  // MiniMax Code edits without asking too, but has a plan mode to run in; the others hold Read only in a mode of their own.
  for (const provider of ["qwen", "xai", "moonshot", "mistral", "minimax", "openai", "anthropic", "zai"] as const) assert.equal(cliReadOnlyRefused(provider, "read_only"), false, provider);
  assert.equal(CLI_READ_ONLY_REFUSAL, "Antigravity cannot run a Read only task: it edits and reads without asking. Use Ask, or another CLI.");
  assert.equal(desktopNativeCopy.en.cliNoReadOnly, CLI_READ_ONLY_REFUSAL);
  for (const language of Object.keys(desktopNativeCopy) as Array<keyof typeof desktopNativeCopy>) {
    assert.ok(desktopNativeCopy[language].cliNoReadOnly.includes("Antigravity"), language);
    if (language !== "en") assert.notEqual(desktopNativeCopy[language].cliNoReadOnly, CLI_READ_ONLY_REFUSAL, language);
  }
  await withProject(async (directory) => {
    const record = join(directory, "..", `acp-record-refused-${Date.now()}.json`);
    const refused = await runProviderCli(acpRun(directory, { scenario: "script", record, session: safeSession.google }, { provider: "google", mode: "read_only" }));
    assert.equal(refused.status, "failed");
    assert.equal(refused.error, CLI_READ_ONLY_REFUSAL);
    assert.equal(refused.exitCode, null);
    await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" }, "the process was never started");
    // MiniMax Code in Read only is held to its plan mode.
    const plan = await runProviderCli(acpRun(directory, { scenario: "simple", record, session: { ...safeSession.minimax, modes: modesOf("minimax", "default") } }, { provider: "minimax", mode: "read_only" }));
    assert.equal(plan.status, "completed", plan.error);
    assert.deepEqual((await seenIn(record)).modeSets, ["plan"]);
    await rm(record, { force: true });
  });
  // The task shows the reason as a note of its own, and no second "could not start" line.
  const runner = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "host", "runner-process.ts"), "utf8");
  const body = runner.slice(runner.indexOf("async function executeProviderCli"), runner.indexOf("async function approveNativePatch"));
  assert.match(body, /if \(cliReadOnlyRefused\(command\.provider, command\.permission\)\) \{/);
  assert.match(body, /desktopCodeNotice\("cliNoReadOnly"\)/);
  assert.match(body, /!refusedReadOnly &&/);
});

test("A command that names a link or a folder leading to a credential store is refused, in every mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-acp-cmd-"));
  try {
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(cwd, "docs"), { recursive: true });
    await mkdir(join(home, ".qwen"), { recursive: true });
    await writeFile(join(home, ".env"), "SECRET=1");
    await writeFile(join(home, ".qwen", "settings.json"), "{}");
    await writeFile(join(cwd, "notes.txt"), "n");
    const { symlink } = await import("node:fs/promises");
    const made: string[] = [];
    try { await symlink(join(home, ".env"), join(cwd, "link"), "file"); made.push("file"); } catch { /* not allowed here */ }
    try { await symlink(join(home, ".qwen"), join(cwd, "cfg"), process.platform === "win32" ? "junction" : "dir"); made.push("folder"); } catch { /* not allowed here */ }
    if (made.length === 0) { t.skip("This system does not allow links."); return; }
    const commands = [...(made.includes("file") ? ["cat link", "head -n 1 ./link", "cp link /tmp/x"] : []), ...(made.includes("folder") ? ["cat cfg/settings.json", "ls -la cfg", "grep -r key cfg/"] : [])];
    for (const command of commands) {
      for (const mode of ["ask", "auto_review", "allow_all"] as const) {
        const decision = classifyAcpPermission(request({ kind: "execute", title: "Run", rawInput: { command } }), { cwd, plan: cliPermissionPlan("qwen", mode) });
        assert.deepEqual([decision.verdict, decision.approval.refused], ["refuse", true], `${mode}: ${command}`);
      }
      assert.equal(classifyAcpPermission(request({ kind: "execute", title: "Run", rawInput: { command } }), { cwd, plan: cliPermissionPlan("qwen", "read_only") }).verdict, "deny", command);
      assert.ok(commandNamesCredential(command, cwd), command);
    }
    // Words that lead nowhere, or to ordinary files, are judged by their names alone.
    for (const command of ["cat notes.txt", "ls docs", "echo hello world", "cat docs/not/yet.md", "git status --short"]) {
      assert.equal(commandNamesCredential(command, cwd), false, command);
      assert.equal(classifyAcpPermission(request({ kind: "execute", title: "Run", rawInput: { command } }), { cwd, plan: cliPermissionPlan("qwen", "ask") }).verdict, "ask", command);
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("A request that holds more than is looked at in part is refused, not judged on its first part", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tomverse-acp-limits-"));
  try {
    const places = (count: number) => Array.from({ length: count }, (_, index) => ({ path: join(cwd, `file-${index}.ts`) }));
    const diffs = (count: number) => Array.from({ length: count }, (_, index) => ({ type: "diff", path: join(cwd, `file-${index}.ts`), oldText: "a", newText: "b" }));
    const decide = (toolCall: object, mode: "read_only" | "ask" | "allow_all", tracked?: TrackedCall) => classifyAcpPermission(request({ kind: "edit", title: "Edit", ...toolCall }), { cwd, plan: cliPermissionPlan("moonshot", mode), tracked });
    const tooMany: Array<[string, object]> = [
      ["65 locations", { locations: places(65) }],
      ["65 diffs", { content: diffs(65) }],
      ["65 paths in a list", { rawInput: { paths: places(65).map(({ path }) => path) } }],
      ["65 entries of any kind", { rawInput: { items: Array.from({ length: 65 }, () => 1), path: join(cwd, "a.ts") } }],
      ["a path nested too deep", { rawInput: { a: { b: { c: { d: { path: "/home/p/.qwen/x" } } } } } }],
      ["a path longer than 4096", { locations: [{ path: join(cwd, "x".repeat(4_200)) }] }],
      ["an oversized rawInput text", { rawInput: JSON.stringify({ path: join(cwd, "a.ts"), content: "x".repeat(70_000) }) + " ".repeat(10) }],
      ["an oversized rawInput", { rawInput: { path: join(cwd, "a.ts"), content: "x".repeat(70_000) } }],
    ];
    for (const [name, toolCall] of tooMany) {
      for (const mode of ["ask", "allow_all"] as const) {
        const decision = decide(toolCall, mode);
        assert.deepEqual([decision.verdict, decision.approval.refused], ["refuse", true], `${name} ${mode}`);
      }
      assert.equal(decide(toolCall, "read_only").verdict, "deny", name);
    }
    // At the limit, the request is looked at whole.
    assert.equal(decide({ locations: places(64) }, "ask").verdict, "ask");
    assert.equal(decide({ locations: places(64) }, "allow_all").verdict, "allow");
    // A command with too many words is refused too, and so is one the CLI streamed too much of.
    const words = Array.from({ length: 300 }, (_, index) => `w${index}`).join(" ");
    assert.equal(decide({ kind: "execute", rawInput: { command: `echo ${words}` } }, "ask").verdict, "refuse");
    assert.equal(decide({ kind: "execute", rawInput: { command: "echo hi" } }, "ask").verdict, "ask");
    const calls = new Map<string, TrackedCall>();
    trackToolCall(calls, "big", { title: "Write", kind: "edit", content: diffs(65) });
    assert.equal(calls.get("big")?.limited, true);
    assert.equal(classifyAcpPermission({ sessionId: "s", options, toolCall: { toolCallId: "big" } }, { cwd, plan: cliPermissionPlan("moonshot", "allow_all"), tracked: calls.get("big") }).verdict, "refuse");
    trackToolCall(calls, "text", { title: "Write", kind: "edit" });
    trackToolCall(calls, "text", chunk("x".repeat(40_000)));
    trackToolCall(calls, "text", chunk("y".repeat(40_000)));
    assert.equal(calls.get("text")?.limited, true);
    assert.equal(classifyAcpPermission({ sessionId: "s", options, toolCall: { toolCallId: "text" } }, { cwd, plan: cliPermissionPlan("moonshot", "ask"), tracked: calls.get("text") }).verdict, "refuse");
    trackToolCall(calls, "manyLocations", { title: "Edit", kind: "edit", locations: places(65) });
    assert.equal(calls.get("manyLocations")?.limited, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
