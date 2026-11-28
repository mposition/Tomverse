// Owner request 2026-11-28: Alibaba's Qwen Code CLI is a worker class that
// takes v22 read roles only, signed in with the owner's Alibaba Cloud Coding
// Plan key. A read role runs headless in plan mode with only the read tools;
// shapes follow the qwen-code sources and documentation, and nothing here
// calls a model.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { amuxCliPricedModelId, amuxCliUsageReceiptSchema, makeAmuxCliUsageReceipt } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { AmuxV22ChannelAuthRefused, amuxV22ChannelArgs, amuxV22ChannelEnv, amuxV22CliSandboxArgs,
  amuxV22ChannelPreflight, amuxV22ChannelStdin, createAmuxV22ChannelRunHome,
  parseAmuxV22ChannelOutput } from "../lib/amux/v22ChannelRun.mjs";
import { parseAmuxV22OneShotRequest, runAmuxV22OneShot } from "../lib/amux/v22OneShotSidecar.mjs";
import { v22ExecutionReceiptVerified, v22ExecutionSourceForProvider } from
  "../lib/amux/v22TaskExecutionCore.ts";
import { AMUX_V22_PROVIDERS, amuxV22ProviderForClass, amuxV22ProviderRoleSupported } from
  "../lib/amux/v22WorkerClaimCore.ts";
import { amuxWorkerProfilePresetCapability } from "../lib/amux/workerProfilePresetCore.ts";
import { AMUX_WORKER_PROVIDER_CLASS_TABLE } from "../lib/amux/workerRegistryCore.ts";
import { inspectAmuxV22WorkerAuth, stageAmuxV22WorkerAuth } from
  "../lib/amux/v22WorkerAuthStage.mjs";

const ATTEMPT = "00000000-0000-4000-8000-000000000003";
const WORKTREE = "/srv/tomverse/worktrees/qwen-review";
const MODEL = "qwen3-coder-plus";
const KEY = `sk-sp-synthetic${"c".repeat(32)}`;
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const init = (fields = {}) => ({ type: "system", subtype: "init", uuid: "u", session_id: "s",
  cwd: WORKTREE, tools: ["read_file", "glob", "grep_search"], mcp_servers: [], model: MODEL,
  permission_mode: "plan", qwen_code_version: "0.28.7", ...fields });
const assistant = (content) => ({ type: "assistant", uuid: "a", session_id: "s",
  parent_tool_use_id: null, message: { id: "m", type: "message", role: "assistant", model: MODEL,
    content } });
const toolUse = (name, input, id = "t1") => ({ type: "tool_use", id, name, input });
const toolResult = (id = "t1") => ({ type: "user", uuid: "r", session_id: "s",
  parent_tool_use_id: null, message: { role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "file text" }] } });
const result = (fields = {}) => ({ type: "result", subtype: "success", uuid: "z", session_id: "s",
  is_error: false, result: "The parser drops the last line.", duration_ms: 1, duration_api_ms: 1,
  num_turns: 2, usage: { input_tokens: 4000, output_tokens: 250, cache_read_input_tokens: 1500,
    total_tokens: 4250 }, permission_denials: [], ...fields });
const read = (role = "review") => ({ exitCode: 0, role, worktreePath: WORKTREE });

test("Qwen is a seventh worker class that implements by editing files, with no shell in any role", () => {
  assert.deepEqual(AMUX_WORKER_PROVIDER_CLASS_TABLE.qwen,
    { cli: "Qwen Code CLI", verified: false, maxRole: "implementation" });
  assert.equal(amuxV22ProviderForClass("qwen"), "qwen");
  // Owner request 2026-11-28: implement too.
  assert.equal(AMUX_V22_PROVIDERS.qwen.implement, true);
  for (const role of ["implement", "investigate", "design", "review"])
    assert.equal(amuxV22ProviderRoleSupported("qwen", role), true, role);
  const worker = { providerClass: "qwen", roleCeiling: "implementation" };
  assert.deepEqual(amuxWorkerProfilePresetCapability(worker, "impl", MODEL, true).v22,
    { model: MODEL, roles: ["implement", "investigate"], tools: ["repo_read", "repo_write"] });
  const request = { version: 1, attemptId: ATTEMPT, worker: "qwen-review", role: "implement",
    modelId: MODEL, budgetMicrousd: 1_000_000, prompt: "Change a file." };
  assert.deepEqual(parseAmuxV22OneShotRequest(request, "qwen-review", "qwen"), request);
});

test("a read role runs headless in plan mode with the read tools only, the prompt on stdin", () => {
  const args = amuxV22ChannelArgs("qwen", { role: "investigate", modelId: MODEL }, WORKTREE);
  assert.deepEqual(args, ["--output-format", "stream-json", "--input-format", "text",
    "--approval-mode", "plan", "--auth-type", "openai", "--safe-mode", "--model", MODEL,
    "--extensions", "none", "--core-tools", "read_file", "glob", "grep_search",
    "--exclude-tools", "run_shell_command", "web_fetch", "web_search",
    "agent", "skill", "save_memory", "todo_write", "notebook_edit", "monitor", "lsp",
    "list_directory", "edit", "write_file"]);
  assert.ok(!args.includes("-p") && !args.includes("--yolo"));
  assert.equal(amuxV22ChannelStdin("qwen", "Look at the parser."), "Look at the parser.");
  // Implement: auto-edit approves the two file writers, and still no shell.
  const implement = amuxV22ChannelArgs("qwen", { role: "implement", modelId: MODEL }, WORKTREE);
  assert.deepEqual(implement, ["--output-format", "stream-json", "--input-format", "text",
    "--approval-mode", "auto-edit", "--auth-type", "openai", "--safe-mode", "--model", MODEL,
    "--extensions", "none", "--core-tools", "read_file", "glob", "grep_search", "edit", "write_file",
    "--exclude-tools", "run_shell_command", "web_fetch", "web_search",
    "agent", "skill", "save_memory", "todo_write", "notebook_edit", "monitor", "lsp",
    "list_directory"]);
  assert.throws(() => amuxV22ChannelArgs("qwen", { role: "operate", modelId: MODEL }, WORKTREE),
    /unknown v22 role/);
  assert.equal(amuxV22ChannelPreflight("qwen", { worktreePath: WORKTREE },
    { exists: (path) => path.replaceAll("\\", "/").endsWith("/.qwen"), symlinkOutside: () => null }),
  "project_cli_config_present");
  assert.equal(amuxV22ChannelPreflight("qwen", { worktreePath: WORKTREE },
    { exists: () => false, symlinkOutside: () => null }), null);
  // Qwen's view shows the checkout as it is, so a link out of it is refused too.
  assert.equal(amuxV22ChannelPreflight("qwen", { worktreePath: WORKTREE },
    { exists: () => false, symlinkOutside: () => "escape" }), "checkout_symlink_outside");
});

test("the stager copies only the Coding Plan key; the run gets it in its environment", async () => {
  const settings = (env) => JSON.stringify({ modelProviders: { openai: [] }, env,
    security: { auth: { selectedType: "openai" } } });
  const inspected = inspectAmuxV22WorkerAuth("qwen", Buffer.from(settings(
    { BAILIAN_CODING_PLAN_API_KEY: KEY, OTHER_SECRET: "sk-other-secret-value-1234" })), Date.now());
  assert.equal(inspected.copy.toString("utf8"), KEY);
  assert.equal(inspected.expiresAt, null);
  for (const body of ["not json", settings({}), settings({ BAILIAN_CODING_PLAN_API_KEY: "short" }),
    settings({ BAILIAN_CODING_PLAN_API_KEY: `${KEY}\nX` }), JSON.stringify({ env: null })])
    assert.throws(() => inspectAmuxV22WorkerAuth("qwen", Buffer.from(body), Date.now()));

  const root = await mkdtemp(join(tmpdir(), "amux-v22-qwen-"));
  const operator = join(root, "operator");
  await mkdir(join(operator, ".qwen"), { recursive: true });
  await writeFile(join(operator, ".qwen", "settings.json"),
    settings({ BAILIAN_CODING_PLAN_API_KEY: KEY }));
  await mkdir(join(root, "tomverse-amux-v22-qwen-review", "cli"), { recursive: true });
  assert.deepEqual(await stageAmuxV22WorkerAuth({ provider: "qwen", worker: "qwen-review",
    home: operator, stateRoot: root }), { provider: "qwen", worker: "qwen-review", expiresAt: null });
  const cli = join(root, "tomverse-amux-v22-qwen-review", "cli");
  assert.equal(await readFile(join(cli, "qwen", "coding-plan-key"), "utf8"), KEY);

  const home = join(root, "home");
  await mkdir(home);
  const config = { worktreePath: join(root, "w"), homePath: home, claudeConfigDir: cli };
  const run = await createAmuxV22ChannelRunHome("qwen", config, { role: "review" });
  assert.equal(run.qwenApiKey, KEY);
  assert.deepEqual(await readdir(join(run.config.homePath, ".qwen")), ["settings.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(run.config.homePath, ".qwen", "settings.json"),
    "utf8")), { general: { enableAutoUpdate: false } });
  const env = amuxV22ChannelEnv("qwen", run.config, { qwenApiKey: run.qwenApiKey });
  assert.equal(env.QWEN_HOME, join(run.config.homePath, ".qwen"));
  assert.equal(env.OPENAI_BASE_URL, "https://coding-intl.dashscope.aliyuncs.com/v1");
  assert.equal(env.OPENAI_API_KEY, KEY);
  assert.equal(env.PATH, "/usr/bin:/bin");
  await run.cleanup();
  await assert.rejects(stat(run.config.homePath));
  await writeFile(join(cli, "qwen", "coding-plan-key"), "not a key");
  await assert.rejects(createAmuxV22ChannelRunHome("qwen", config, { role: "review" }),
    (error) => error instanceof AmuxV22ChannelAuthRefused);
});

test("the stream settles from its result, with Copilot's cache-read semantics", () => {
  const output = jsonl(init(), assistant([{ type: "thinking", thinking: "plan" },
    { type: "text", text: "Reading." }, toolUse("read_file", { absolute_path: `${WORKTREE}/lib/a.ts` })]),
  toolResult(), assistant([toolUse("grep_search", { pattern: "parse\\(", path: "lib", glob: "*.ts" }, "t2"),
    toolUse("glob", { pattern: "src/**/*.ts" }, "t3")]), toolResult("t2"), toolResult("t3"),
  assistant([{ type: "text", text: "The parser drops the last line." }]), result());
  const parsed = parseAmuxV22ChannelOutput("qwen", output, read());
  assert.equal(parsed.valid, true);
  assert.equal(parsed.success, true);
  assert.equal(parsed.resultText, "The parser drops the last line.");
  // Input includes cache reads, so all of it is priced as input.
  assert.deepEqual(parsed.observation.observed, { inputTokens: 4000, outputTokens: 250,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: null });
  assert.equal(parsed.observation.completedTurns, 2);
  const receipt = makeAmuxCliUsageReceipt({ invocationId: ATTEMPT,
    binding: { kind: "task_attempt", attemptId: ATTEMPT }, worker: "qwen-review",
    selectedModelId: MODEL, cliVersion: null, authentication: "unknown",
    startedAt: "2026-11-28T04:00:00.000Z", endedAt: "2026-11-28T04:01:00.000Z",
    status: "succeeded", observation: parsed.observation });
  assert.deepEqual([receipt.cli, receipt.provider, receipt.source, receipt.actualModelId,
    receipt.inputTokensIncludeCacheRead, receipt.reasoningOutputIncludedInOutput],
  ["qwen", "qwen", "qwen_stream", null, true, null]);
  assert.equal(amuxCliPricedModelId(receipt), MODEL);
  assert.equal(v22ExecutionSourceForProvider("qwen"), "qwen_stream");
  assert.equal(v22ExecutionReceiptVerified({ attemptId: ATTEMPT, invocationIds: [ATTEMPT],
    events: [{ invocationId: ATTEMPT, status: "succeeded", completeness: "reported_complete",
      projectedApiCostMicrousd: 10n, cli: "qwen", source: "qwen_stream", actualModelId: null,
      selectedModelId: MODEL }], outcome: "succeeded", reservedCostMicrousd: 1_000_000n,
    resultStored: true, expectedExecutionSource: "qwen_stream", budgetBound: false }), true);
  for (const change of [{ inputTokensIncludeCacheRead: false }, { source: "kimi_wire" },
    { provider: "kimi" }])
    assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...receipt, ...change }).success, false,
      JSON.stringify(change));
  // A failed run is a failed result; a run without a result is none.
  const failed = parseAmuxV22ChannelOutput("qwen", jsonl(init(), result({ subtype: "error_max_turns",
    is_error: true, result: undefined, error: { message: "max turns" } })), read());
  assert.deepEqual([failed.valid, failed.success, failed.resultText], [true, false, null]);
  assert.deepEqual(parseAmuxV22ChannelOutput("qwen", jsonl(init(), assistant([{ type: "text",
    text: "x" }])), read()), { valid: false, reason: "no_result" });
});

test("another permission mode, tool, subagent, block or path makes the run untrusted", () => {
  const reason = (output, options = read()) => {
    const parsed = parseAmuxV22ChannelOutput("qwen", output, options);
    return parsed.valid ? null : parsed.reason;
  };
  const withCall = (...blocks) => jsonl(init(), assistant(blocks), toolResult(), result());
  for (const mode of ["default", "yolo", "auto-edit", "auto", undefined])
    assert.equal(reason(jsonl(init({ permission_mode: mode }), result())), "permission_mode", String(mode));
  assert.equal(reason(jsonl(result())), "permission_mode");
  assert.equal(reason(jsonl(init({ subtype: "session_start" }), result())), null);
  for (const name of ["run_shell_command", "write_file", "edit", "web_fetch", "agent",
    "list_directory", "skill"])
    assert.equal(reason(withCall(toolUse(name, { command: "ls" }))), `tool:${name}`, name);
  for (const input of [{ absolute_path: "/etc/passwd" }, { absolute_path: `${WORKTREE}/../x` },
    { absolute_path: "~/.qwen/settings.json" }, { path: "/home" }, { dir_path: "../x" },
    { absolute_path: `${WORKTREE}-other/a` }, { absolute_path: "lib\\..\\x" }])
    assert.equal(reason(withCall(toolUse("read_file", input))), "tool_path", JSON.stringify(input));
  assert.equal(reason(withCall(toolUse("glob", { pattern: "/etc/*" }))), "tool_path");
  assert.equal(reason(withCall(toolUse("glob", { pattern: "../**" }))), "tool_path");
  assert.equal(reason(withCall(toolUse("grep_search", { pattern: "x", glob: "/etc/*" }))), "tool_path");
  // A regex is not a path.
  assert.equal(reason(withCall(toolUse("grep_search", { pattern: "/etc/(passwd|shadow)", path: "lib" }))), null);
  assert.equal(reason(jsonl(init(), { ...assistant([{ type: "text", text: "x" }]),
    parent_tool_use_id: "t9" }, result())), "subagent");
  assert.equal(reason(jsonl(init(), assistant([{ type: "image", source: {} }]), result())), "block:image");
  assert.equal(reason(jsonl(init(), { type: "assistant", message: {} }, result())), "message_shape");
  assert.equal(reason(jsonl(init(), { type: "control_request", request: { subtype: "can_use_tool",
    tool_name: "run_shell_command" } }, result())), "event:control_request");
  assert.equal(reason(`${jsonl(init())}Error: not JSON\n`), "non_object_line");
  assert.equal(reason(jsonl(init(), result()), read("operate")), "role");
  // Implement must report auto-edit; a read role that reports it is refused.
  assert.equal(reason(jsonl(init(), result()), read("implement")), "permission_mode");
  assert.equal(reason(jsonl(init({ permission_mode: "auto-edit" }), result()), read("implement")), null);
  assert.equal(reason(jsonl(init({ permission_mode: "auto-edit" }), result())), "permission_mode");
  // Implement's writers: inside the checkout only, never .git; a read role has none.
  const implementCall = (...blocks) => jsonl(init({ permission_mode: "auto-edit" }), assistant(blocks),
    toolResult(), result());
  assert.equal(reason(implementCall(toolUse("write_file", { file_path: `${WORKTREE}/lib/new.ts`,
    content: "x" })), read("implement")), null);
  assert.equal(reason(implementCall(toolUse("edit", { file_path: `${WORKTREE}/lib/a.ts`,
    old_string: "a", new_string: "b" })), read("implement")), null);
  for (const input of [{ file_path: "/etc/hosts", content: "x" }, { file_path: `${WORKTREE}/.git/config`,
    content: "x" }, { file_path: ".git/hooks/pre-commit", content: "x" }])
    assert.equal(reason(implementCall(toolUse("write_file", input)), read("implement")), "tool_path",
      JSON.stringify(input));
  assert.equal(reason(implementCall(toolUse("run_shell_command", { command: "ls" })), read("implement")),
    "tool:run_shell_command");
  assert.equal(reason(withCall(toolUse("write_file", { file_path: `${WORKTREE}/a`, content: "x" }))),
    "tool:write_file");
  // A kind that names no action passes and is counted.
  const noted = parseAmuxV22ChannelOutput("qwen", jsonl(init(), { type: "stream_event",
    event: { kind: "ping" } }, result()), read());
  assert.equal(noted.valid, true);
  assert.deepEqual(noted.unrecognized, { "event:stream_event": 1 });
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

test("a Qwen review run reads its prompt from stdin and its key from its environment only", async () => {
  const config = { worker: "qwen-review", provider: "qwen",
    binaryPath: "/opt/tomverse-amux-v22/qwen/bin/qwen", worktreePath: WORKTREE,
    homePath: "/var/lib/tomverse-amux-v22-qwen-review/home",
    claudeConfigDir: "/var/lib/tomverse-amux-v22-qwen-review/cli" };
  const request = { version: 1, attemptId: ATTEMPT, worker: "qwen-review", role: "review",
    modelId: MODEL, budgetMicrousd: 1_000_000, prompt: "Review the change." };
  const fake = fakeSpawn(jsonl(init(), assistant([{ type: "text", text: "Looks right." }]),
    result({ result: "Looks right." })));
  const outcome = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: fake.spawnChild, channelPreflight: () => null,
    ensureDependencies: async () => ({ ok: true, installed: false }),
    createRunHome: async (_provider, value) => ({
      config: { ...value, homePath: "/run-home", claudeConfigDir: "/run-home/.config" },
      copilotToken: null, qwenApiKey: KEY, cleanup: async () => {} }) });
  const { args, spawnOptions } = fake.calls[0];
  assert.equal(Buffer.concat(fake.calls[0].stdin).toString("utf8"), "Review the change.");
  assert.ok(!args.includes("Review the change.") && !args.includes(KEY));
  assert.equal(spawnOptions.env.OPENAI_API_KEY, KEY);
  assert.equal(spawnOptions.env.QWEN_HOME, join("/run-home", ".qwen"));
  assert.equal(outcome.kind, "succeeded");
  assert.equal(outcome.usageReceipt.source, "qwen_stream");
});

test("Qwen runs only inside a bubblewrap view, the checkout writable for implement only", async () => {
  const config = { worker: "qwen-impl", provider: "qwen",
    binaryPath: "/opt/tomverse-amux-v22/qwen/bin/qwen", worktreePath: WORKTREE,
    homePath: "/var/lib/tomverse-amux-v22-qwen-impl/home",
    claudeConfigDir: "/var/lib/tomverse-amux-v22-qwen-impl/cli" };
  for (const role of ["implement", "review"]) {
    const output = jsonl(init({ permission_mode: role === "implement" ? "auto-edit" : "plan" }),
      assistant([{ type: "text", text: "Done." }]), result({ result: "Done." }));
    const fake = fakeSpawn(output);
    const outcome = await runAmuxV22OneShot({ version: 1, attemptId: ATTEMPT, worker: "qwen-impl", role,
      modelId: MODEL, budgetMicrousd: 1_000_000, prompt: "Work." }, config, {
      syntheticPlatform: true, spawnChild: fake.spawnChild, channelPreflight: () => null,
      ensureDependencies: async () => ({ ok: true, installed: false }),
      createRunHome: async (_provider, value) => ({ config: { ...value, homePath: "/run-home",
        claudeConfigDir: "/run-home/.config" }, copilotToken: null, qwenApiKey: KEY, cleanup: async () => {} }) });
    const { binary, args } = fake.calls[0];
    assert.equal(binary, "/usr/bin/bwrap", role);
    const cut = args.indexOf("--");
    assert.deepEqual(args.slice(0, cut + 1), amuxV22CliSandboxArgs({ worktreePath: WORKTREE,
      runHomePath: "/run-home", binaryPath: config.binaryPath, writable: role === "implement" }));
    assert.equal(args[cut + 1], config.binaryPath);
    const at = args.indexOf(WORKTREE);
    assert.equal(args[at - 1], role === "implement" ? "--bind" : "--ro-bind", role);
    assert.ok(!args.includes(KEY) && !args.includes("--unshare-net"));
    assert.equal(outcome.kind, "succeeded", role);
  }
  // Qwen's own install only, never another CLI's or the whole install root.
  assert.throws(() => amuxV22CliSandboxArgs({ worktreePath: WORKTREE, runHomePath: "/run-home",
    binaryPath: "/usr/local/bin/qwen" }), /root-owned install/);
});
