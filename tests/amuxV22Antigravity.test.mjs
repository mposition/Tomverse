// Owner decision 2026-11-10: Google's Antigravity CLI (agy) is a worker
// class that may implement. Its tools are a custom agent in the run home, its
// prompt is one NDJSON line on stdin, its sign-in copy keeps the refresh
// token, and its implement shell is the sidecar's jail found first on PATH
// (all measured on agy 1.5.4 on the AMUX box).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { amuxCliPricedModelId, amuxCliUsageReceiptSchema, makeAmuxCliUsageReceipt } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { readAntigravityModelList } from "../lib/amux/cliModelListReader.mjs";
import { AmuxV22ChannelAuthRefused, amuxV22AntigravityAgent, amuxV22AntigravitySettings,
  amuxV22ChannelArgs, amuxV22ChannelEnv, amuxV22ChannelPreflight, amuxV22ChannelStdin,
  amuxV22OutputShape, createAmuxV22ChannelRunHome, parseAmuxV22ChannelOutput } from
  "../lib/amux/v22ChannelRun.mjs";
import { amuxV22CliEnv, parseAmuxV22OneShotRequest, runAmuxV22OneShot } from
  "../lib/amux/v22OneShotSidecar.mjs";
import { v22ExecutionReceiptVerified, v22ExecutionSourceForProvider } from
  "../lib/amux/v22TaskExecutionCore.ts";
import { AMUX_V22_PROVIDERS, amuxV22ProviderForClass, amuxV22ProviderRoleSupported } from
  "../lib/amux/v22WorkerClaimCore.ts";
import { amuxWorkerCapabilityRefusal } from "../lib/amux/workerCapabilityCore.ts";
import { amuxWorkerProfilePresetCapability } from "../lib/amux/workerProfilePresetCore.ts";
import { AMUX_WORKER_PROVIDER_CLASS_TABLE, AMUX_WORKER_PROVIDER_CLASSES } from
  "../lib/amux/workerRegistryCore.ts";
import { inspectAmuxV22WorkerAuth, stageAmuxV22WorkerAuth } from
  "../lib/amux/v22WorkerAuthStage.mjs";

const ATTEMPT = "00000000-0000-4000-8000-000000000001";
const WORKTREE = "/srv/tomverse/worktrees/antigravity-impl";
const MODEL = "gemini-4-argon-medium";
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
// A synthetic login shaped as agy 1.5.4 stores it; no value is a real token.
const login = (extra = {}) => JSON.stringify({ token: {
  access_token: `ya29.synthetic-access-${"a".repeat(40)}`, token_type: "Bearer",
  refresh_token: `1//synthetic-refresh-${"b".repeat(40)}`,
  expiry: "2026-11-10T10:40:30.969839658Z", expires_in: 3599 },
auth_method: "consumer", id_token_email: "owner@example.com", ...extra });
const step = (fields) => ({ event: "step_update", step_update: { conversation_id: "c",
  step_index: 1, state: "DONE", ...fields } });
const result = (fields = {}) => ({ event: "result", result: { conversation_id: "c",
  status: "SUCCESS", response: "Done.", num_turns: 1,
  usage: { input_tokens: 12758, output_tokens: 704, thinking_tokens: 283,
    cache_read_tokens: 7469, total_tokens: 13462 }, ...fields } });
const init = { event: "init", conversation_id: "c", init: { model: MODEL,
  cwd: WORKTREE, tools: ["run_command", "search_web", "write_to_file"],
  permission_mode: "request-review" } };

test("Antigravity is a fifth worker class that may implement; Cursor still may not", () => {
  assert.ok(AMUX_WORKER_PROVIDER_CLASSES.includes("antigravity"));
  assert.deepEqual(AMUX_WORKER_PROVIDER_CLASS_TABLE.antigravity,
    { cli: "Antigravity CLI", verified: false, maxRole: "implementation" });
  assert.equal(amuxV22ProviderForClass("antigravity"), "antigravity");
  assert.equal(AMUX_V22_PROVIDERS.antigravity.implement, true);
  for (const role of ["implement", "investigate", "design", "review"])
    assert.equal(amuxV22ProviderRoleSupported("antigravity", role), true, role);
  assert.equal(amuxV22ProviderRoleSupported("cursor", "implement"), false);
  const worker = { workerName: "antigravity-impl", providerClass: "antigravity",
    roleCeiling: "implementation", desiredState: "active", revision: 1 };
  const capability = amuxWorkerProfilePresetCapability(worker, "impl", MODEL, true);
  assert.deepEqual(capability.v22, { model: MODEL, roles: ["implement", "investigate"],
    tools: ["repo_read", "repo_write"] });
  assert.equal(amuxWorkerCapabilityRefusal(worker, capability), null);
  // An unverified class never reaches the contract ceiling's review roles.
  assert.notEqual(amuxWorkerCapabilityRefusal({ ...worker, roleCeiling: "contract" },
    { ...capability, v22: { ...capability.v22, roles: ["review"], tools: ["repo_read"] } }), null);
});

test("the role's tools are a custom agent; the prompt is never on the command line", () => {
  const read = amuxV22ChannelArgs("antigravity", { role: "investigate", modelId: MODEL }, WORKTREE);
  const write = amuxV22ChannelArgs("antigravity", { role: "implement", modelId: MODEL }, WORKTREE);
  for (const args of [read, write]) {
    assert.deepEqual(args.slice(0, 6), ["-p", "", "--input-format", "stream-json",
      "--output-format", "stream-json"]);
    assert.ok(args.includes("--disable-slash-commands"));
    assert.equal(args[args.indexOf("--model") + 1], MODEL);
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  }
  assert.equal(read[read.indexOf("--agent") + 1], "amux-v22-read");
  assert.equal(write[write.indexOf("--agent") + 1], "amux-v22-implement");
  assert.deepEqual(JSON.parse(read[read.indexOf("--settings") + 1]), { permissions: {
    deny: ["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"] } });
  assert.deepEqual(JSON.parse(write[write.indexOf("--settings") + 1]), { permissions: {
    allow: ["command(*)", `write_file(${WORKTREE})`],
    deny: ["read_url(*)", "execute_url(*)", "mcp(*)"] } });
  for (const role of ["design", "review"])
    assert.equal(amuxV22AntigravityAgent(role).text, amuxV22AntigravityAgent("investigate").text);
  assert.match(amuxV22AntigravityAgent("investigate").text, /tools:\n {2}- view_file\n---/);
  const implement = amuxV22AntigravityAgent("implement");
  assert.deepEqual(implement.path, [".gemini", "config", "agents", "amux-v22-implement", "agent.md"]);
  assert.match(implement.text, /^---\nname: amux-v22-implement\n/);
  assert.match(implement.text, /mainAgent: true\ntools:\n {2}- view_file\n {2}- write_to_file\n {2}- replace_file_content\n {2}- multi_replace_file_content\n {2}- run_command\n---/);
  // An unknown role never falls through to the implement agent.
  assert.throws(() => amuxV22AntigravityAgent("operate"), /unknown v22 role/);
  assert.throws(() => amuxV22AntigravityAgent(null), /unknown v22 role/);
  for (const path of ["relative", "/a/../b", "/a b", "/a'b"])
    assert.throws(() => amuxV22AntigravitySettings(true, path), /unsafe/, path);
  const prompt = "Fix it.\n\"quoted\"";
  assert.deepEqual(JSON.parse(amuxV22ChannelStdin("antigravity", prompt)),
    { event: "user", message: { content: prompt } });
  assert.ok(amuxV22ChannelStdin("antigravity", prompt).endsWith("}\n"));
  assert.equal(amuxV22ChannelStdin("github-copilot", prompt), prompt);
});

test("no run starts beside the checkout's own agents or Gemini configuration", () => {
  const config = { worktreePath: WORKTREE };
  assert.equal(amuxV22ChannelPreflight("antigravity", config, { exists: () => false }), null);
  for (const dir of [".agents", ".gemini"])
    assert.equal(amuxV22ChannelPreflight("antigravity", config,
      { exists: (path) => path.endsWith(dir) }), "project_cli_config_present", dir);
});

test("the run home holds the sign-in with its refresh token, no e-mail, and the role's agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-agy-"));
  const home = join(root, "home");
  const cli = join(root, "cli");
  await mkdir(join(cli, "antigravity"), { recursive: true });
  await mkdir(home);
  await writeFile(join(cli, "antigravity", "antigravity-oauth-token"), login());
  const config = { worktreePath: join(root, "w"), homePath: home, claudeConfigDir: cli };
  for (const role of ["implement", "investigate"]) {
    const run = await createAmuxV22ChannelRunHome("antigravity", config, { role });
    const files = [];
    const walk = async (dir, prefix = "") => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        else files.push(`${prefix}${entry.name}`);
      }
    };
    await walk(run.config.homePath);
    const agent = role === "implement" ? "amux-v22-implement" : "amux-v22-read";
    assert.deepEqual(files.sort(), [`.gemini/antigravity-cli/antigravity-oauth-token`,
      `.gemini/config/agents/${agent}/agent.md`].sort());
    const copy = JSON.parse(await readFile(join(run.config.homePath, ".gemini",
      "antigravity-cli", "antigravity-oauth-token"), "utf8"));
    const source = JSON.parse(login());
    assert.deepEqual(copy, { token: { access_token: source.token.access_token,
      token_type: "Bearer", refresh_token: source.token.refresh_token,
      expiry: source.token.expiry }, auth_method: "consumer" });
    const env = amuxV22ChannelEnv("antigravity", run.config);
    assert.equal(env.HOME, run.config.homePath);
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.ok(!JSON.stringify(env).includes("synthetic-refresh"));
    await run.cleanup();
    await assert.rejects(stat(run.config.homePath));
  }
  // Without a known role there is no agent to write, so no run home.
  await assert.rejects(createAmuxV22ChannelRunHome("antigravity", config));
  for (const body of ["not json", login({ token: { access_token: "x" } }),
    JSON.stringify({ ...JSON.parse(login()), auth_method: "Consumer Plan" }),
    JSON.stringify({ token: { ...JSON.parse(login()).token, token_type: "MAC" },
      auth_method: "consumer" }),
    JSON.stringify({ token: { ...JSON.parse(login()).token, refresh_token: "" },
      auth_method: "consumer" })]) {
    await writeFile(join(cli, "antigravity", "antigravity-oauth-token"), body);
    await assert.rejects(createAmuxV22ChannelRunHome("antigravity", config, { role: "implement" }),
      (error) => error instanceof AmuxV22ChannelAuthRefused);
  }
  assert.deepEqual((await readdir(home)).filter((name) => name.startsWith("run-")), []);
});

test("the stager copies the operator's Antigravity login with its refresh token, never its e-mail", async () => {
  const inspected = inspectAmuxV22WorkerAuth("antigravity", Buffer.from(login()), Date.now());
  const copy = JSON.parse(inspected.copy.toString("utf8"));
  assert.ok(copy.token.refresh_token.startsWith("1//synthetic-refresh-"));
  assert.equal(copy.id_token_email, undefined);
  assert.equal(inspected.expiresAt, Date.parse("2026-11-10T10:40:30.969839658Z"));
  // Google's access token lasts an hour: an expired one is still staged.
  assert.ok(inspectAmuxV22WorkerAuth("antigravity", Buffer.from(login()),
    Date.parse("2026-12-01T00:00:00Z")).copy.length > 0);
  assert.throws(() => inspectAmuxV22WorkerAuth("antigravity", Buffer.from("{}"), Date.now()),
    /unsafe AMUX v22 worker sign-in/);
  const root = await mkdtemp(join(tmpdir(), "amux-v22-agy-stage-"));
  await mkdir(join(root, "tomverse-amux-v22-antigravity-impl", "cli"), { recursive: true });
  const staged = await stageAmuxV22WorkerAuth({ provider: "antigravity",
    worker: "antigravity-impl", home: "/home/tommy", stateRoot: root,
    readFile: async (path) => {
      assert.equal(path, join("/home/tommy", ".gemini", "antigravity-cli", "antigravity-oauth-token"));
      return Buffer.from(login());
    } });
  assert.equal(staged.provider, "antigravity");
  const written = JSON.parse(await readFile(join(root, "tomverse-amux-v22-antigravity-impl",
    "cli", "antigravity", "antigravity-oauth-token"), "utf8"));
  assert.equal(written.auth_method, "consumer");
  assert.equal(written.id_token_email, undefined);
});

test("the stream settles from its result; a tool outside the role's list is never trusted", () => {
  const done = parseAmuxV22ChannelOutput("antigravity", jsonl(init,
    step({ step_index: 0, step_type: "user_input" }),
    step({ step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file" } }),
    step({ step_type: "tool", tool_name: "edit_file" }),
    step({ step_type: "tool", tool_name: "write_file" }),
    step({ step_type: "tool", tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } } }),
    step({ step_type: "agent_response", text_delta: "Done." }), result()),
  { exitCode: 0, role: "implement" });
  assert.equal(done.valid, true);
  assert.equal(done.success, true);
  assert.equal(done.resultText, "Done.");
  assert.deepEqual(done.observation.observed, { inputTokens: 12758, outputTokens: 704,
    cacheReadInputTokens: 7469, cacheCreationInputTokens: 0, reasoningOutputTokens: null });
  assert.equal(done.observation.completeness, "reported_complete");
  assert.equal(done.observation.inputTokensIncludeCacheRead, false);

  const receipt = makeAmuxCliUsageReceipt({ invocationId: ATTEMPT,
    binding: { kind: "task_attempt", attemptId: ATTEMPT }, worker: "antigravity-impl",
    selectedModelId: MODEL, cliVersion: null, authentication: "unknown",
    startedAt: "2026-11-10T00:00:00.000Z", endedAt: "2026-11-10T00:01:00.000Z",
    status: "succeeded", observation: done.observation });
  assert.equal(amuxCliUsageReceiptSchema.safeParse(receipt).success, true);
  assert.deepEqual([receipt.cli, receipt.provider, receipt.source, receipt.actualModelId],
    ["antigravity", "antigravity", "antigravity_stream", null]);
  assert.equal(amuxCliPricedModelId(receipt), MODEL);
  assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...receipt, provider: "cursor" }).success, false);
  assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...receipt,
    inputTokensIncludeCacheRead: true }).success, false);
  assert.equal(v22ExecutionSourceForProvider("antigravity"), "antigravity_stream");
  assert.equal(v22ExecutionReceiptVerified({ attemptId: ATTEMPT, invocationIds: [ATTEMPT],
    outcome: "succeeded", reservedCostMicrousd: BigInt(1), resultStored: true,
    budgetBound: false, expectedExecutionSource: "antigravity_stream",
    events: [{ invocationId: ATTEMPT, status: "succeeded", completeness: "reported_complete",
      projectedApiCostMicrousd: null, cli: "antigravity", source: "antigravity_stream",
      actualModelId: null, selectedModelId: MODEL }] }), true);

  const refused = (role, ...events) =>
    parseAmuxV22ChannelOutput("antigravity", jsonl(init, ...events, result()), { exitCode: 0, role });
  // A read role never writes or runs a command; no role searches the web.
  for (const tool of ["run_command", "write_file", "edit_file"])
    assert.deepEqual(refused("investigate", step({ step_type: "tool", tool_name: tool })),
      { valid: false, reason: `tool:${tool}` }, tool);
  for (const tool of ["search_web", "read_url_content", "call_mcp_tool", "browser_subagent",
    "notebook_execution", "schedule", undefined])
    assert.equal(refused("implement", step({ step_type: "tool", tool_name: tool })).valid, false);
  assert.deepEqual(refused("implement", step({ step_type: "tool", tool_name: "read_file",
    subagent_info: { name: "x" } })), { valid: false, reason: "subagent" });
  assert.deepEqual(refused("implement", step({ step_type: "browser" })),
    { valid: false, reason: "step:browser" });
  assert.deepEqual(refused("implement", { event: "tool_use", name: "run_command" }),
    { valid: false, reason: "event:tool_use" });
  assert.deepEqual(parseAmuxV22ChannelOutput("antigravity", jsonl(init),
    { exitCode: 0, role: "implement" }), { valid: false, reason: "no_result" });
  // A finished run that failed is a known failure, not an unknown outcome.
  const failed = parseAmuxV22ChannelOutput("antigravity", jsonl(init,
    result({ status: "ERROR", response: "" })), { exitCode: 1, role: "implement" });
  assert.deepEqual([failed.valid, failed.success, failed.resultText], [true, false, null]);
  assert.equal(failed.observation.completeness, "reported_partial");
  assert.equal(amuxV22OutputShape(jsonl(init, step({ step_type: "tool", tool_name: "search_web" }),
    result())), "init step_update:search_web result");
});

test("agy models lines become the CLI's model list", () => {
  assert.deepEqual(readAntigravityModelList(["Fetching available models...",
    "gemini-4-argon-medium\tGemini 4 Argon (Medium)", "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
    "not a model line", ""].join("\n")), [
    { cliModel: "gemini-4-argon-medium", displayName: "Gemini 4 Argon (Medium)" },
    { cliModel: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 (High)" }]);
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

test("an Antigravity implement run gets the jail first on PATH and the prompt on stdin", async () => {
  const config = { worker: "antigravity-impl", provider: "antigravity",
    binaryPath: "/opt/tomverse-amux-v22/antigravity-1.5.4/agy", worktreePath: WORKTREE,
    homePath: "/var/lib/tomverse-amux-v22-antigravity-impl/home",
    claudeConfigDir: "/var/lib/tomverse-amux-v22-antigravity-impl/cli" };
  const request = { version: 1, attemptId: ATTEMPT, worker: "antigravity-impl",
    role: "implement", modelId: MODEL, budgetMicrousd: 1_250_000, prompt: "Change a small file." };
  assert.deepEqual(parseAmuxV22OneShotRequest(request, "antigravity-impl", "antigravity"), request);
  const tmp = join(WORKTREE, "node_modules", ".cache", "amux-tmp");
  const output = jsonl(init, step({ step_type: "tool", tool_name: "run_command" }), result());
  for (const role of ["implement", "investigate"]) {
    const made = [];
    const roles = [];
    const fake = fakeSpawn(output);
    const outcome = await runAmuxV22OneShot({ ...request, role }, config, {
      syntheticPlatform: true, spawnChild: fake.spawnChild, channelPreflight: () => null,
      ensureDependencies: async () => ({ ok: true, installed: false }),
      createShellJail: async (paths) => { made.push(paths);
        return { binPath: "/run-home/shell-1/bin", prefixPath: "/run-home/shell-1/prefix",
          cleanup: async () => { made.push("cleaned"); } }; },
      createRunHome: async (_provider, value, options) => { roles.push(options.role);
        return { config: { ...value, homePath: "/run-home", claudeConfigDir: "/run-home/.config" },
          copilotToken: null, cleanup: async () => {} }; } });
    assert.deepEqual(roles, [role]);
    const { env } = fake.calls[0].spawnOptions;
    assert.equal(env.HOME, "/run-home");
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
    assert.deepEqual(JSON.parse(Buffer.concat(fake.calls[0].stdin).toString("utf8")),
      { event: "user", message: { content: "Change a small file." } });
    assert.ok(!fake.calls[0].args.includes("Change a small file."));
    if (role === "implement") {
      assert.deepEqual(made, [{ worktreePath: WORKTREE, tmpPath: tmp, homePath: "/run-home" },
        "cleaned"]);
      assert.equal(env.PATH, "/run-home/shell-1/bin:/usr/bin:/bin");
      assert.equal(env.SHELL, "/run-home/shell-1/bin/bash");
      assert.equal(env.TMPDIR, tmp);
    } else {
      assert.deepEqual(made, []);
      assert.equal(env.PATH, "/usr/bin:/bin");
      assert.equal(env.SHELL, undefined);
      // A read role's stream with a command in it is never a result.
      assert.deepEqual([outcome.kind, outcome.failure], ["outcome_unknown", "invalid_result"]);
    }
  }
  // No jail, no implement run: the shell would otherwise run open.
  const fake = fakeSpawn(output);
  const outcome = await runAmuxV22OneShot(request, config, { syntheticPlatform: true,
    spawnChild: fake.spawnChild, channelPreflight: () => null,
    ensureDependencies: async () => ({ ok: true, installed: false }),
    createShellJail: async () => null,
    createRunHome: async (_provider, value) => ({ config: { ...value, homePath: "/run-home" },
      copilotToken: null, cleanup: async () => {} }) });
  assert.deepEqual([outcome.kind, outcome.cliStarted, outcome.failure],
    ["failed", false, "shell_jail_unavailable"]);
  assert.equal(fake.calls.length, 0);
  // The environment helper alone: no jail means the plain PATH.
  assert.equal(amuxV22CliEnv("antigravity", config, { config: { ...config, homePath: "/h" } }).PATH,
    "/usr/bin:/bin");
});
