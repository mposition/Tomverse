// Owner request 2026-11-28: Moonshot's Kimi Code CLI is a worker class that
// takes v22 read roles only. Its tools are a custom agent file in the run
// home (ReadFile, Glob, Grep), its configuration comes from --config, its
// sign-in copy keeps only the access token, and its tokens are read from the
// session's wire.jsonl because its stream reports none. Shapes follow the
// kimi_cli sources and documentation; nothing here calls a model.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { amuxCliPricedModelId, amuxCliUsageReceiptSchema, makeAmuxCliUsageReceipt } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { readKimiConfigModels } from "../lib/amux/cliModelListReader.mjs";
import { AmuxV22ChannelAuthRefused, amuxV22ChannelArgs, amuxV22ChannelEnv,
  amuxV22ChannelPreflight, amuxV22ChannelStdin, amuxV22KimiAgent, amuxV22KimiConfig,
  amuxV22KimiHookCommand, amuxV22KimiToolCallRefusal, amuxV22OutputShape,
  createAmuxV22ChannelRunHome, parseAmuxV22ChannelOutput, readAmuxV22KimiGuardDecisions,
  readAmuxV22KimiSessionUsage } from "../lib/amux/v22ChannelRun.mjs";
import { amuxV22KimiToolCallGuard, runAmuxV22KimiToolGuardHook } from
  "../lib/amux/v22KimiToolGuard.mjs";
import { parseAmuxV22OneShotRequest, runAmuxV22OneShot } from "../lib/amux/v22OneShotSidecar.mjs";
import { v22ExecutionReceiptVerified, v22ExecutionSourceForProvider } from
  "../lib/amux/v22TaskExecutionCore.ts";
import { AMUX_V22_PROVIDERS, amuxV22ProviderForClass, amuxV22ProviderRoleSupported,
  amuxV22ReviewAuthorVendor } from "../lib/amux/v22WorkerClaimCore.ts";
import { amuxWorkerCapabilityRefusal } from "../lib/amux/workerCapabilityCore.ts";
import { amuxWorkerProfilePresetCapability } from "../lib/amux/workerProfilePresetCore.ts";
import { AMUX_WORKER_PROVIDER_CLASS_TABLE, AMUX_WORKER_PROVIDER_CLASSES } from
  "../lib/amux/workerRegistryCore.ts";
import { inspectAmuxV22WorkerAuth, stageAmuxV22WorkerAuth } from
  "../lib/amux/v22WorkerAuthStage.mjs";

const ATTEMPT = "00000000-0000-4000-8000-000000000002";
const WORKTREE = "/srv/tomverse/worktrees/kimi-review";
const RUN_HOME = "/var/lib/tomverse-amux-v22-kimi-review/home/run-abc";
const MODEL = "kimi-for-coding";
const NOW = Date.parse("2026-11-28T04:00:00.000Z");
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
// A synthetic login shaped as kimi_cli OAuthToken.to_dict writes it; no value
// is a real token.
const login = (extra = {}) => JSON.stringify({
  access_token: `synthetic-kimi-access-${"a".repeat(40)}`,
  refresh_token: `synthetic-kimi-refresh-${"b".repeat(40)}`,
  expires_at: NOW / 1000 + 900, scope: "kimi-code", token_type: "Bearer", expires_in: 900,
  ...extra });
const call = (name, args, id = "tc_1") => ({ type: "function", id,
  function: { name, arguments: JSON.stringify(args) } });
const assistant = (text, calls) => ({ role: "assistant",
  content: [{ type: "think", think: "planning" }, { type: "text", text }],
  ...(calls ? { tool_calls: calls } : {}) });
const toolResult = (id = "tc_1") => ({ role: "tool", tool_call_id: id, content: "file text" });
const USAGE = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0,
  steps: 2 };
const GUARD = { nodePath: "/usr/bin/node", guardPath: "/opt/tomverse/lib/amux/v22KimiToolGuard.mjs" };
const HOOK = `'/usr/bin/node' '/opt/tomverse/lib/amux/v22KimiToolGuard.mjs' '${WORKTREE}' '${RUN_HOME}/.amux-v22/kimi-guard.log'`;

test("Kimi is a sixth worker class that takes read roles only", () => {
  assert.ok(AMUX_WORKER_PROVIDER_CLASSES.includes("kimi"));
  assert.deepEqual(AMUX_WORKER_PROVIDER_CLASS_TABLE.kimi,
    { cli: "Kimi Code CLI", verified: false, maxRole: "implementation" });
  assert.equal(amuxV22ProviderForClass("kimi"), "kimi");
  assert.equal(AMUX_V22_PROVIDERS.kimi.implement, false);
  assert.equal(amuxV22ProviderRoleSupported("kimi", "implement"), false);
  for (const role of ["investigate", "design", "review"])
    assert.equal(amuxV22ProviderRoleSupported("kimi", role), true, role);
  // The model's vendor is Kimi's own, so a reviewer of another vendor pairs.
  assert.equal(amuxV22ReviewAuthorVendor("kimi", MODEL), "kimi");
  const worker = { workerName: "kimi-impl", providerClass: "kimi",
    roleCeiling: "implementation", desiredState: "active", revision: 1 };
  const capability = amuxWorkerProfilePresetCapability(worker, "impl", MODEL, true);
  assert.deepEqual(capability.v22, { model: MODEL, roles: ["investigate"], tools: ["repo_read"] });
  assert.equal(amuxWorkerCapabilityRefusal(worker, capability), null);
  // An implement request never parses for a Kimi sidecar.
  const request = { version: 1, attemptId: ATTEMPT, worker: "kimi-impl", role: "implement",
    modelId: MODEL, budgetMicrousd: 1_000_000, prompt: "Change a file." };
  assert.throws(() => parseAmuxV22OneShotRequest(request, "kimi-impl", "kimi"), /invalid v22 one-shot request/);
  assert.deepEqual(parseAmuxV22OneShotRequest({ ...request, role: "investigate" },
    "kimi-impl", "kimi"), { ...request, role: "investigate" });
});

test("a read role runs --print with its agent file, an empty skills directory and its own config", () => {
  for (const role of ["investigate", "design", "review"]) {
    const args = amuxV22ChannelArgs("kimi", { role, modelId: MODEL }, WORKTREE,
      { runHomePath: RUN_HOME, kimiGuard: GUARD });
    assert.deepEqual(args.slice(0, 11), ["--print", "--input-format", "text",
      "--output-format", "stream-json", "--work-dir", WORKTREE,
      "--agent-file", `${RUN_HOME}/.amux-v22/kimi-read.yaml`,
      "--skills-dir", `${RUN_HOME}/.amux-v22/skills`]);
    assert.equal(args[11], "--config");
    assert.deepEqual(JSON.parse(args[12]), amuxV22KimiConfig(MODEL, { hookCommand: HOOK }));
    assert.equal(args.length, 13);
  }
  // The prompt travels on stdin as it is, never on the command line.
  assert.equal(amuxV22ChannelStdin("kimi", "Look at the parser."), "Look at the parser.");
  assert.throws(() => amuxV22ChannelArgs("kimi", { role: "implement", modelId: MODEL }, WORKTREE,
    { runHomePath: RUN_HOME, kimiGuard: GUARD }), /read roles only/);
  for (const runHomePath of [null, "relative/home", "/var/lib/../etc", "/home/a b"])
    assert.throws(() => amuxV22ChannelArgs("kimi", { role: "review", modelId: MODEL }, WORKTREE,
      { runHomePath, kimiGuard: GUARD }), /unsafe path/);
  // A hook part that a shell would read as more than one word is refused.
  for (const guardPath of ["/opt/a b.mjs", "/opt/x';rm -rf /;'.mjs", "relative.mjs"])
    assert.throws(() => amuxV22ChannelArgs("kimi", { role: "review", modelId: MODEL }, WORKTREE,
      { runHomePath: RUN_HOME, kimiGuard: { ...GUARD, guardPath } }), /unsafe path/);
  assert.equal(amuxV22KimiHookCommand({ ...GUARD, worktreePath: WORKTREE,
    logPath: `${RUN_HOME}/.amux-v22/kimi-guard.log` }), HOOK);
  assert.throws(() => amuxV22KimiConfig("kimi:for-coding", { hookCommand: HOOK }), /unsafe model/);
  // No configuration without the guard.
  assert.throws(() => amuxV22KimiConfig(MODEL), /tool guard/);
  assert.deepEqual(amuxV22KimiConfig(MODEL, { hookCommand: HOOK }), {
    default_model: "kimi-code/kimi-for-coding",
    providers: { "managed:kimi-code": { type: "kimi", base_url: "https://api.kimi.com/coding/v1",
      api_key: "", oauth: { storage: "file", key: "oauth/kimi-code" } } },
    models: { "kimi-code/kimi-for-coding": { provider: "managed:kimi-code",
      model: "kimi-for-coding", max_context_size: 262_144 } },
    hooks: [{ event: "PreToolUse", command: HOOK, timeout: 15 }] });
  // `tools` replaces the default agent's list: no Shell, no writer, no web, no subagent.
  assert.equal(amuxV22KimiAgent().text, [
    "version: 1", "agent:", "  extend: default", "  tools:",
    '    - "kimi_cli.tools.file:ReadFile"', '    - "kimi_cli.tools.file:Glob"',
    '    - "kimi_cli.tools.file:Grep"', ""].join("\n"));
});

test("no run starts beside the checkout's own .kimi configuration", () => {
  const config = { worktreePath: WORKTREE };
  assert.equal(amuxV22ChannelPreflight("kimi", config, { exists: () => false }), null);
  assert.equal(amuxV22ChannelPreflight("kimi", config,
    { exists: (path) => path.replaceAll("\\", "/").endsWith("/.kimi") }), "project_cli_config_present");
});

test("the run home holds the access token without its refresh token, the agent file and an empty skills directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-kimi-"));
  const home = join(root, "home");
  const cli = join(root, "cli");
  await mkdir(join(cli, "kimi"), { recursive: true });
  await mkdir(home);
  await writeFile(join(cli, "kimi", "kimi-code.json"), login());
  const config = { worktreePath: join(root, "w"), homePath: home, claudeConfigDir: cli };
  const run = await createAmuxV22ChannelRunHome("kimi", config, { now: NOW, role: "review" });
  const entries = [];
  const walk = async (dir, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      entries.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
  };
  await walk(run.config.homePath);
  assert.deepEqual(entries.sort(), [".amux-v22/", ".amux-v22/kimi-guard.log",
    ".amux-v22/kimi-read.yaml", ".amux-v22/skills/",
    ".kimi/", ".kimi/credentials/", ".kimi/credentials/kimi-code.json"].sort());
  // The guard log starts empty, so zero decisions is a reading, not a missing file.
  assert.equal(await readAmuxV22KimiGuardDecisions(run.config.homePath), 0);
  const copy = JSON.parse(await readFile(join(run.config.homePath, ".kimi", "credentials",
    "kimi-code.json"), "utf8"));
  const source = JSON.parse(login());
  assert.deepEqual(copy, { access_token: source.access_token, refresh_token: "",
    expires_at: source.expires_at, scope: "kimi-code", token_type: "Bearer", expires_in: 900 });
  assert.equal(await readFile(join(run.config.homePath, ".amux-v22", "kimi-read.yaml"), "utf8"),
    amuxV22KimiAgent().text);
  const env = amuxV22ChannelEnv("kimi", run.config);
  assert.equal(env.HOME, run.config.homePath);
  assert.equal(env.KIMI_SHARE_DIR, join(run.config.homePath, ".kimi"));
  assert.equal(env.KIMI_CLI_NO_AUTO_UPDATE, "1");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.ok(!JSON.stringify(env).includes("synthetic-kimi"));
  await run.cleanup();
  await assert.rejects(stat(run.config.homePath));
  // An expired access token, or any other shape, makes no run home.
  for (const body of ["not json", login({ expires_at: NOW / 1000 - 1 }),
    login({ access_token: "short" }), login({ expires_at: "soon" }),
    login({ token_type: "Bearer\nX" }), login({ expires_at: NOW / 1000 + 400 * 86_400 }),
    JSON.stringify({ token: JSON.parse(login()) })]) {
    await writeFile(join(cli, "kimi", "kimi-code.json"), body);
    await assert.rejects(createAmuxV22ChannelRunHome("kimi", config, { now: NOW, role: "review" }),
      (error) => error instanceof AmuxV22ChannelAuthRefused);
  }
  assert.deepEqual((await readdir(home)).filter((name) => name.startsWith("run-")), []);
});

test("the stager copies the operator's Kimi login with the refresh token emptied", async () => {
  const inspected = inspectAmuxV22WorkerAuth("kimi", Buffer.from(login()), NOW);
  assert.equal(inspected.expiresAt, NOW + 900_000);
  assert.equal(JSON.parse(inspected.copy.toString("utf8")).refresh_token, "");
  assert.ok(!inspected.copy.toString("utf8").includes("synthetic-kimi-refresh"));
  assert.throws(() => inspectAmuxV22WorkerAuth("kimi", Buffer.from(login()), NOW + 900_000));
  const root = await mkdtemp(join(tmpdir(), "amux-v22-kimi-stage-"));
  const homeDir = join(root, "operator");
  await mkdir(join(homeDir, ".kimi", "credentials"), { recursive: true });
  await writeFile(join(homeDir, ".kimi", "credentials", "kimi-code.json"), login());
  await mkdir(join(root, "tomverse-amux-v22-kimi-review", "cli"), { recursive: true });
  const staged = await stageAmuxV22WorkerAuth({ provider: "kimi", worker: "kimi-review",
    home: homeDir, stateRoot: root, now: NOW });
  assert.deepEqual(staged, { provider: "kimi", worker: "kimi-review", expiresAt: NOW + 900_000 });
  const written = JSON.parse(await readFile(join(root, "tomverse-amux-v22-kimi-review", "cli",
    "kimi", "kimi-code.json"), "utf8"));
  assert.equal(written.refresh_token, "");
  assert.equal(written.access_token, JSON.parse(login()).access_token);
});

test("the stream settles on its last assistant message, with the wire's tokens", () => {
  const output = jsonl(
    assistant("Reading the parser.", [call("ReadFile", { path: "lib/parser.ts", n_lines: 200 })]),
    toolResult(),
    assistant("Searching.", [call("Grep", { pattern: "parse\\(", path: `${WORKTREE}/lib`,
      glob: "*.ts", output_mode: "content", "-n": true }, "tc_2"),
    call("Glob", { pattern: "lib/**/*.ts", directory: "." }, "tc_3")]),
    toolResult("tc_2"), toolResult("tc_3"),
    assistant("The parser drops the last line."));
  const parsed = parseAmuxV22ChannelOutput("kimi", output, { exitCode: 0, role: "review",
    worktreePath: WORKTREE, sessionUsage: USAGE, guardDecisions: 3 });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.success, true);
  assert.equal(parsed.resultText, "The parser drops the last line.");
  assert.deepEqual(parsed.observation.observed, { inputTokens: 1200, outputTokens: 300,
    cacheReadInputTokens: 800, cacheCreationInputTokens: 0, reasoningOutputTokens: null });
  assert.equal(parsed.observation.completeness, "reported_complete");
  assert.equal(parsed.observation.completedTurns, 3);
  const receipt = makeAmuxCliUsageReceipt({ invocationId: ATTEMPT,
    binding: { kind: "task_attempt", attemptId: ATTEMPT }, worker: "kimi-review",
    selectedModelId: MODEL, cliVersion: null, authentication: "unknown",
    startedAt: "2026-11-28T04:00:00.000Z", endedAt: "2026-11-28T04:01:00.000Z",
    status: "succeeded", observation: parsed.observation });
  assert.deepEqual([receipt.cli, receipt.provider, receipt.source, receipt.actualModelId,
    receipt.inputTokensIncludeCacheRead, receipt.reasoningOutputIncludedInOutput],
  ["kimi", "kimi", "kimi_wire", null, false, null]);
  // Kimi names no served model: the receipt is priced and settled as selected.
  assert.equal(amuxCliPricedModelId(receipt), MODEL);
  assert.equal(v22ExecutionSourceForProvider("kimi"), "kimi_wire");
  assert.equal(v22ExecutionReceiptVerified({ attemptId: ATTEMPT, invocationIds: [ATTEMPT],
    events: [{ invocationId: ATTEMPT, status: "succeeded", completeness: "reported_complete",
      projectedApiCostMicrousd: 10n, cli: "kimi", source: "kimi_wire", actualModelId: null,
      selectedModelId: MODEL }], outcome: "succeeded", reservedCostMicrousd: 1_000_000n,
    resultStored: true, expectedExecutionSource: "kimi_wire", budgetBound: false }), true);
  // Without the wire's tokens the run is a result, but its usage is unknown.
  const unread = parseAmuxV22ChannelOutput("kimi", output, { exitCode: 0, role: "review",
    worktreePath: WORKTREE, guardDecisions: 3 });
  assert.equal(unread.success, true);
  assert.equal(unread.observation.observed, null);
  assert.equal(unread.observation.completeness, "unknown");
  // A nonzero exit is a failed result, not a success.
  assert.equal(parseAmuxV22ChannelOutput("kimi", output, { exitCode: 1, role: "review",
    worktreePath: WORKTREE, sessionUsage: USAGE, guardDecisions: 3 }).success, false);
  // Kimi's hooks fail open: a call the guard did not decide makes no result.
  for (const guardDecisions of [null, 0, 2, 4])
    assert.deepEqual(parseAmuxV22ChannelOutput("kimi", output, { exitCode: 0, role: "review",
      worktreePath: WORKTREE, sessionUsage: USAGE, guardDecisions }),
    { valid: false, reason: "tool_guard_unconfirmed" }, String(guardDecisions));
  // A string content (--final-message-only's shape) is read as the answer.
  assert.equal(parseAmuxV22ChannelOutput("kimi", jsonl({ role: "assistant", content: "Done." }),
    { exitCode: 0, role: "investigate", worktreePath: WORKTREE }).resultText, "Done.");
  assert.equal(amuxV22OutputShape(output),
    "assistant:ReadFile tool assistant:Grep tool*2 assistant");
});

test("a tool outside the read list, or a path that leaves the checkout, is never trusted", () => {
  const run = (...calls) => parseAmuxV22ChannelOutput("kimi",
    jsonl(assistant("Working.", calls), toolResult(), assistant("Done.")),
    { exitCode: 0, role: "review", worktreePath: WORKTREE, sessionUsage: USAGE,
      guardDecisions: calls.length });
  const reason = (...calls) => { const parsed = run(...calls); return parsed.valid ? null : parsed.reason; };
  for (const name of ["Shell", "WriteFile", "StrReplaceFile", "FetchURL", "SearchWeb", "Agent",
    "ReadMediaFile", "EnterPlanMode", "AskUserQuestion", "SetTodoList"])
    assert.match(reason(call(name, { path: "a" })), /^tool:/, name);
  for (const args of [{ path: "/etc/passwd" }, { path: "../other/file" },
    { path: "lib/../../etc" }, { path: "~/.kimi/credentials/kimi-code.json" },
    { path: `${RUN_HOME}/.kimi/credentials/kimi-code.json` },
    { path: `${WORKTREE}-other/file` }, { path: "lib\\..\\x" }, { path: "" }, { path: 7 }])
    assert.equal(reason(call("ReadFile", args)), "tool_path", JSON.stringify(args));
  assert.equal(reason(call("Glob", { pattern: "/etc/*" })), "tool_path");
  assert.equal(reason(call("Glob", { pattern: `${WORKTREE}/*` })), "tool_path");
  assert.equal(reason(call("Glob", { pattern: "*", directory: "/" })), "tool_path");
  assert.equal(reason(call("Grep", { pattern: "x", glob: "../*" })), "tool_path");
  assert.equal(reason(call("Grep", { pattern: "x", path: "/home" })), "tool_path");
  // An argument the tool does not document is refused as well.
  assert.equal(reason(call("ReadFile", { path: "a", follow: true })), "tool_arguments");
  assert.equal(reason({ type: "function", id: "x",
    function: { name: "ReadFile", arguments: "{not json" } }), "tool_arguments");
  // Inside the checkout, absolute or relative, the call is fine.
  assert.equal(reason(call("ReadFile", { path: `${WORKTREE}/lib/a.ts` })), null);
  assert.equal(reason(call("ReadFile", { path: WORKTREE })), null);
  assert.equal(amuxV22KimiToolCallRefusal(call("Glob", { pattern: "**/*.md" }), WORKTREE), null);
  // Without a known checkout, an absolute path is never inside it.
  assert.equal(amuxV22KimiToolCallRefusal(call("ReadFile", { path: `${WORKTREE}/a` }), null),
    "tool_path");
});

test("a stream without its answer, a non-JSON line, a write role or an unseen role is not a result", () => {
  const options = { exitCode: 0, role: "review", worktreePath: WORKTREE, sessionUsage: USAGE,
    guardDecisions: 1 };
  const reason = (output, extra = {}) => {
    const parsed = parseAmuxV22ChannelOutput("kimi", output, { ...options, ...extra });
    return parsed.valid ? null : parsed.reason;
  };
  // The run stopped after a tool call: no final answer.
  assert.equal(reason(jsonl(assistant("Reading.", [call("ReadFile", { path: "a" })]))), "no_result");
  assert.equal(reason(jsonl(assistant("Reading.", [call("ReadFile", { path: "a" })]), toolResult())),
    "no_result");
  // Max steps or a provider error is printed as plain text on stdout.
  assert.equal(reason(`${jsonl(assistant("Reading."))}Max number of steps reached: 100\n`),
    "non_object_line");
  assert.equal(reason(""), "empty");
  assert.equal(reason(jsonl(assistant("Done.")), { role: "implement" }), "role");
  assert.equal(reason(jsonl({ role: "user", content: "x" }, assistant("Done."))), "role:user");
  assert.equal(reason(jsonl({ role: "assistant", content: 7 })), "message_shape");
  assert.equal(reason(jsonl({ role: "assistant", content: [], tool_calls: {} })), "message_shape");
  // A notification that names no action passes and is counted; one that does is refused.
  const noted = parseAmuxV22ChannelOutput("kimi", jsonl({ type: "notice", title: "Compacted" },
    assistant("Done.")), options);
  assert.equal(noted.valid, true);
  assert.deepEqual(noted.unrecognized, { "event:notice": 1 });
  assert.equal(reason(jsonl({ type: "notice", tool_call: {} }, assistant("Done."))), "event:notice");
});

test("the guard blocks before a tool runs: any other tool, an undocumented argument, a path that resolves outside", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amux-v22-kimi-guard-")));
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  await mkdir(join(checkout, "lib"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(checkout, "lib", "a.ts"), "x");
  await writeFile(join(outside, "secret.json"), "{}");
  let linked = true;
  try {
    await symlink(outside, join(checkout, "escape"), "junction");
    await symlink(join(outside, "secret.json"), join(checkout, "secret-link"), "file");
  } catch { linked = false; }
  const guard = (name, args) => amuxV22KimiToolCallGuard(name, args, checkout);
  assert.equal(guard("ReadFile", { path: "lib/a.ts" }), null);
  // An absolute path is POSIX on the box; a Windows temp path is not one.
  if (checkout.startsWith("/"))
    assert.equal(guard("ReadFile", { path: join(checkout, "lib", "a.ts") }), null);
  assert.equal(guard("Glob", { pattern: "**/*.ts" }), null);
  assert.equal(guard("Grep", { pattern: "x", path: "lib", glob: "*.ts" }), null);
  // A file that does not exist yet resolves through its existing parent.
  assert.equal(guard("ReadFile", { path: "lib/new/missing.ts" }), null);
  assert.equal(guard("Shell", { command: "cat /etc/passwd" }), "tool");
  assert.equal(guard("ReadFile", { path: "lib/a.ts", follow: true }), "tool_arguments");
  assert.equal(guard("ReadFile", undefined), "tool_arguments");
  assert.equal(guard("Glob", { pattern: "../*" }), "tool_path");
  if (linked) {
    // Inside by its text, outside on disk: blocked before it runs.
    assert.equal(guard("ReadFile", { path: "escape/secret.json" }), "tool_path");
    assert.equal(guard("ReadFile", { path: "secret-link" }), "tool_path");
    assert.equal(guard("Grep", { pattern: "x", path: "escape" }), "tool_path");
    assert.equal(guard("Glob", { pattern: "*", directory: "escape" }), "tool_path");
  }
  // The hook: one decision line per call, exit 2 to block, and anything it
  // cannot read is blocked too.
  const log = join(root, "kimi-guard.log");
  await writeFile(log, "");
  const hook = (input) => runAmuxV22KimiToolGuardHook({ argv: [checkout, log],
    stdin: () => typeof input === "string" ? input : JSON.stringify(input) });
  assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "ReadFile",
    tool_input: { path: "lib/a.ts" }, cwd: checkout }), 0);
  assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "Shell",
    tool_input: { command: "ls" } }), 2);
  assert.equal(hook("{not json"), 2);
  assert.equal(hook({ hook_event_name: "PostToolUse", tool_name: "ReadFile",
    tool_input: { path: "lib/a.ts" } }), 2);
  assert.equal(await readFile(log, "utf8"), "allow\nblock tool\nblock unreadable\nblock event\n");
  assert.equal(await readAmuxV22KimiGuardDecisions(root), null);
  // A log the hook cannot write blocks the call as well.
  assert.equal(runAmuxV22KimiToolGuardHook({ argv: [checkout, join(root, "missing", "log")],
    stdin: () => JSON.stringify({ tool_name: "ReadFile", tool_input: { path: "lib/a.ts" } }) }), 2);
  assert.equal(realpathSync(checkout), checkout);
});

test("the guard log counts only the lines the guard writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-kimi-log-"));
  await mkdir(join(root, ".amux-v22"));
  const write = (text) => writeFile(join(root, ".amux-v22", "kimi-guard.log"), text);
  await write("allow\nblock tool_path\nallow\n");
  assert.equal(await readAmuxV22KimiGuardDecisions(root), 3);
  await write("allow\nsomething else\n");
  assert.equal(await readAmuxV22KimiGuardDecisions(root), null);
  assert.equal(await readAmuxV22KimiGuardDecisions(join(root, "missing")), null);
});

test("the wire's StatusUpdate token usage sums by step, and anything unclear is unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-kimi-wire-"));
  const session = join(root, ".kimi", "sessions", "0123abcd", "session-1");
  await mkdir(session, { recursive: true });
  const record = (type, payload) => ({ timestamp: 1764302400.5, message: { type, payload } });
  const usage = (input, output, cache, id) => record("StatusUpdate", { context_usage: 0.1,
    token_usage: { input_other: input, output, input_cache_read: cache, input_cache_creation: 0 },
    ...(id ? { message_id: id } : {}) });
  const write = (...lines) => writeFile(join(session, "wire.jsonl"), jsonl(...lines));
  const head = [{ type: "metadata", protocol_version: "1.10" }, record("TurnBegin", { user_input: "x" })];
  await write(...head,
    record("StepBegin", { n: 1 }), usage(500, 100, 300, "m1"), record("StatusUpdate", { context_usage: 0.2 }),
    record("ContentPart", { type: "text", text: "a" }),
    record("StepBegin", { n: 2 }), usage(1, 1, 1, "m2"), usage(700, 200, 500, "m2"),
    record("TurnEnd", {}));
  // A step's last report counts once.
  assert.deepEqual(await readAmuxV22KimiSessionUsage(root), { inputTokens: 1200, outputTokens: 300,
    cacheReadTokens: 800, cacheWriteTokens: 0, steps: 2 });
  // A step without its usage, a turn that did not end, a retried, interrupted
  // or compacting step, a second turn, usage before any step: unknown.
  for (const lines of [
    [...head, record("StepBegin", { n: 1 }), usage(5, 5, 0), record("StepBegin", { n: 2 }), record("TurnEnd", {})],
    [...head, record("StepBegin", { n: 1 }), usage(5, 5, 0)],
    [...head, record("StepBegin", { n: 1 }), record("StepRetry", {}), usage(5, 5, 0), record("TurnEnd", {})],
    [...head, record("StepBegin", { n: 1 }), usage(5, 5, 0), record("StepInterrupted", {}), record("TurnEnd", {})],
    [...head, record("CompactionBegin", {}), record("StepBegin", { n: 1 }), usage(5, 5, 0), record("TurnEnd", {})],
    [...head, record("StepBegin", { n: 1 }), usage(5, 5, 0), record("TurnEnd", {}),
      record("TurnBegin", { user_input: "y" }), record("StepBegin", { n: 1 }), usage(5, 5, 0), record("TurnEnd", {})],
    [...head, usage(5, 5, 0), record("StepBegin", { n: 1 }), usage(5, 5, 0), record("TurnEnd", {})],
    [...head, record("TurnEnd", {})],
    [...head, record("StepBegin", { n: 1 }), record("StatusUpdate", { token_usage: { input_other: -1, output: 1,
      input_cache_read: 0, input_cache_creation: 0 } }), record("TurnEnd", {})],
    [...head, { timestamp: 1, message: "StepBegin" }, record("TurnEnd", {})],
  ]) {
    await write(...lines);
    assert.equal(await readAmuxV22KimiSessionUsage(root), null, JSON.stringify(lines.slice(2)));
  }
  await writeFile(join(session, "wire.jsonl"), "{not json\n");
  assert.equal(await readAmuxV22KimiSessionUsage(root), null);
  // Two sessions in one run home cannot be told apart: unknown.
  await write(...head, record("StepBegin", { n: 1 }), usage(5, 5, 0), record("TurnEnd", {}));
  await mkdir(join(root, ".kimi", "sessions", "0123abcd", "session-2"));
  await writeFile(join(root, ".kimi", "sessions", "0123abcd", "session-2", "wire.jsonl"), jsonl(usage(5, 5, 0)));
  assert.equal(await readAmuxV22KimiSessionUsage(root), null);
  assert.equal(await readAmuxV22KimiSessionUsage(join(root, "missing")), null);
});

test("the ledger admits Kimi only from its wire, with its documented token semantics", () => {
  const base = { version: 1, invocationId: ATTEMPT,
    binding: { kind: "task_attempt", attemptId: ATTEMPT }, worker: "kimi-review", cli: "kimi",
    provider: "kimi", selectedModelId: MODEL, actualModelId: null, cliVersion: null,
    authentication: "unknown", startedAt: "2026-11-28T04:00:00.000Z",
    endedAt: "2026-11-28T04:01:00.000Z", status: "succeeded", completeness: "reported_complete",
    source: "kimi_wire", observed: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, reasoningOutputTokens: null },
    inputTokensIncludeCacheRead: false, inputTokensIncludeCacheWrite: false,
    reasoningOutputIncludedInOutput: null, completedTurns: 1 };
  assert.equal(amuxCliUsageReceiptSchema.safeParse(base).success, true);
  for (const change of [{ provider: "cursor" }, { cli: "cursor" }, { source: "cursor_stream" },
    { inputTokensIncludeCacheRead: true }, { reasoningOutputIncludedInOutput: true }])
    assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...base, ...change }).success, false,
      JSON.stringify(change));
  assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...base, completeness: "unknown",
    source: "unreported", observed: null, completedTurns: 0 }).success, true);
});

test("kimi's config.toml models become the CLI's model list, the Kimi Code platform's only", () => {
  const toml = [
    'default_model = "kimi-code/kimi-for-coding"',
    "",
    '[models."kimi-code/kimi-for-coding"]',
    'provider = "managed:kimi-code"',
    'model = "kimi-for-coding"',
    "max_context_size = 262144",
    'display_name = "Kimi for Coding"',
    "",
    '[models."kimi-code/kimi-k3-preview"]',
    'provider = "managed:kimi-code"',
    'model = "kimi-k3-preview" # newest',
    "",
    "[models.other]",
    'provider = "moonshot-open"',
    'model = "kimi-k2-0905"',
    "",
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'model = "not-a-model-table"',
  ].join("\n");
  assert.deepEqual(readKimiConfigModels(toml), [
    { cliModel: "kimi-for-coding", displayName: "Kimi for Coding" },
    { cliModel: "kimi-k3-preview", displayName: null },
  ]);
  assert.deepEqual(readKimiConfigModels(""), []);
});

function fakeSpawn(output) {
  const calls = [];
  const spawnChild = (binary, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    const stdin = [];
    child.stdin.on("data", (part) => stdin.push(part));
    calls.push({ binary, args, spawnOptions, stdin });
    child.kill = () => {};
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout.end(output);
      child.emit("close", 0, null);
    });
    return child;
  };
  return { spawnChild, calls };
}

test("a Kimi review run reads its prompt from stdin and its tokens from the run home's wire", async () => {
  const config = { worker: "kimi-review", provider: "kimi",
    binaryPath: "/opt/tomverse-amux-v22/kimi/bin/kimi", worktreePath: WORKTREE,
    homePath: "/var/lib/tomverse-amux-v22-kimi-review/home",
    claudeConfigDir: "/var/lib/tomverse-amux-v22-kimi-review/cli" };
  const request = { version: 1, attemptId: ATTEMPT, worker: "kimi-review", role: "review",
    modelId: MODEL, budgetMicrousd: 1_000_000, prompt: "Review the change." };
  const fake = fakeSpawn(jsonl(assistant("Reading.", [call("ReadFile", { path: "a.ts" })]),
    toolResult(), assistant("Looks right.")));
  const read = [];
  const outcome = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: fake.spawnChild, channelPreflight: () => null,
    ensureDependencies: async () => ({ ok: true, installed: false }),
    kimiGuard: GUARD,
    readKimiSessionUsage: async (home) => { read.push(home); return USAGE; },
    readKimiGuardDecisions: async (home) => { read.push(home); return 1; },
    createRunHome: async (_provider, value) => ({
      config: { ...value, homePath: RUN_HOME, claudeConfigDir: `${RUN_HOME}/.config` },
      copilotToken: null, cleanup: async () => {} }) });
  assert.deepEqual(read, [RUN_HOME, RUN_HOME]);
  const { args, spawnOptions } = fake.calls[0];
  assert.equal(JSON.parse(args[args.indexOf("--config") + 1]).hooks[0].command, HOOK);
  assert.equal(Buffer.concat(fake.calls[0].stdin).toString("utf8"), "Review the change.");
  assert.ok(!args.includes("Review the change."));
  assert.deepEqual(args.slice(0, 2), ["--print", "--input-format"]);
  assert.ok(args.includes(`${RUN_HOME}/.amux-v22/kimi-read.yaml`));
  assert.equal(spawnOptions.env.KIMI_SHARE_DIR, join(RUN_HOME, ".kimi"));
  assert.equal(spawnOptions.env.KIMI_CLI_NO_AUTO_UPDATE, "1");
  assert.equal(outcome.kind, "succeeded");
  assert.equal(outcome.usageReceipt.source, "kimi_wire");
  assert.equal(outcome.usageReceipt.completeness, "reported_complete");
});
