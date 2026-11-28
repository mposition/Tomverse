// Owner decision 2026-11-28: the GLM Coding Plan runs as Claude Code against
// Z.ai's Anthropic-compatible endpoint, a worker class of its own (`zai`).
// The run is Claude's (arguments, jailed shell, result), with Z.ai's
// endpoint, the operator's root-owned Coding Plan key and a GLM model.
// Nothing here calls a model.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

import { amuxCliPricedModelId, amuxCliUsageReceiptSchema, makeAmuxCliUsageReceipt } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { inspectClaudeCliResultUsage } from "../lib/amux/cliUsageObservationCore.ts";
import { amuxV22ChannelPreflight } from "../lib/amux/v22ChannelRun.mjs";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AMUX_V22_ZAI_BASE_URL, amuxV22ClaudeArgs, amuxV22CliEnv, amuxV22ZaiDisallowedTools,
  createAmuxV22ZaiRunHome,
  amuxV22ZaiEnv, parseAmuxV22OneShotRequest, readAmuxV22ZaiCodingPlanKey, runAmuxV22OneShot } from
  "../lib/amux/v22OneShotSidecar.mjs";
import { v22ExecutionReceiptVerified, v22ExecutionSourceForProvider } from
  "../lib/amux/v22TaskExecutionCore.ts";
import { AMUX_V22_PROVIDERS, amuxV22OneShotRouteSupported, amuxV22ProviderForClass,
  amuxV22ProviderRoleSupported, amuxV22ReviewAuthorVendor } from "../lib/amux/v22WorkerClaimCore.ts";
import { amuxWorkerProfilePresetCapability } from "../lib/amux/workerProfilePresetCore.ts";
import { AMUX_WORKER_PROVIDER_CLASS_TABLE } from "../lib/amux/workerRegistryCore.ts";

const ATTEMPT = "00000000-0000-4000-8000-000000000004";
const MODEL = "glm-5.4";
const KEY = `synthetic0123456789abcdef.${"d".repeat(16)}`;
const config = { worker: "zai-impl", provider: "zai", worktreePath: "/srv/tomverse/worktrees/zai-impl",
  homePath: "/var/lib/tomverse-amux-v22-zai-impl/home",
  claudeConfigDir: "/var/lib/tomverse-amux-v22-zai-impl/cli" };

test("Z.ai is an eighth worker class that implements as a Claude worker does, under Z.ai's name", () => {
  assert.deepEqual(AMUX_WORKER_PROVIDER_CLASS_TABLE.zai,
    { cli: "Claude Code (Z.ai GLM)", verified: false, maxRole: "implementation" });
  assert.equal(amuxV22ProviderForClass("zai"), "zai");
  assert.equal(AMUX_V22_PROVIDERS.zai.implement, true);
  for (const role of ["implement", "investigate", "design", "review"])
    assert.equal(amuxV22ProviderRoleSupported("zai", role), true, role);
  // A GLM route only: a Claude model never runs on the Coding Plan key.
  assert.equal(amuxV22OneShotRouteSupported("zai", MODEL), true);
  for (const modelId of ["claude-opus-5-5", "glm-5.4[1m]", "gpt-6"])
    assert.equal(amuxV22OneShotRouteSupported("zai", modelId), false, modelId);
  // The review server keeps the model's vendor away: Z.ai, not Anthropic.
  assert.equal(amuxV22ReviewAuthorVendor("zai", MODEL), "zai");
  const capability = amuxWorkerProfilePresetCapability({ providerClass: "zai",
    roleCeiling: "implementation" }, "impl", MODEL, true);
  assert.ok(capability.v22.roles.includes("implement"));
  const request = { version: 1, attemptId: ATTEMPT, worker: "zai-impl", role: "implement",
    modelId: MODEL, budgetMicrousd: 1_000_000, prompt: "Change a file." };
  assert.deepEqual(parseAmuxV22OneShotRequest(request, "zai-impl", "zai"), request);
});

test("the run is Claude Code's environment with Z.ai's endpoint, key and model, and nothing else changes", () => {
  const jail = { prefixPath: "/run/jail/prefix", binPath: "/run/jail/bin" };
  // HOME and the Claude profile are the run's own fresh ones, never the worker's.
  const runHome = { config: { ...config, homePath: `${config.homePath}/run-1`,
    claudeConfigDir: `${config.homePath}/run-1/.claude` } };
  const env = amuxV22CliEnv("zai", config, runHome, { shellJail: jail, worktreeTmp: "/w/tmp",
    zaiKey: KEY, modelId: MODEL });
  assert.deepEqual(env, { HOME: runHome.config.homePath, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
    CLAUDE_CONFIG_DIR: runHome.config.claudeConfigDir, CLAUDE_CODE_SHELL_PREFIX: jail.prefixPath,
    CLAUDE_CODE_TMPDIR: "/w/tmp", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: KEY, API_TIMEOUT_MS: "3000000", ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" });
  // The global endpoint, never mainland China's.
  assert.equal(AMUX_V22_ZAI_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.ok(!JSON.stringify(env).includes("bigmodel.cn"));
  // A Claude worker's environment is as it was.
  const claude = amuxV22CliEnv("anthropic", config, null, {});
  assert.deepEqual(Object.keys(claude).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH"]);
  for (const [key, modelId] of [[null, MODEL], ["short", MODEL], [`${KEY}\n`, MODEL], [KEY, "claude-opus-5-5"]])
    assert.throws(() => amuxV22ZaiEnv(key, modelId), /invalid z.ai run/);
  // A project settings file could redirect the endpoint, so none may be there.
  for (const name of ["settings.json", "settings.local.json"])
    assert.equal(amuxV22ChannelPreflight("zai", config,
      { exists: (path) => path.replaceAll("\\", "/").endsWith(`/.claude/${name}`) }),
    "project_cli_config_present", name);
  assert.equal(amuxV22ChannelPreflight("zai", config, { exists: () => false }), null);
});

test("the key is read only from a root-owned regular file nobody else may read", async () => {
  const opened = [];
  const fakeOpen = (stat, text) => async (path, flags) => {
    opened.push([path.replaceAll("\\", "/"), flags]);
    return { stat: async () => stat,
      // One byte per read, as a short read may return: the reader reads to the end.
      read: async (buffer, offset, length, position) => {
        const bytes = Buffer.from(text).subarray(position, position + Math.min(1, length));
        bytes.copy(buffer, offset); return { bytesRead: bytes.length }; },
      close: async () => {} };
  };
  const file = (fields = {}) => ({ isFile: () => true, uid: 0, mode: 0o100640, size: 80, ...fields });
  assert.equal(await readAmuxV22ZaiCodingPlanKey(config, { openFile: fakeOpen(file(), `${KEY}\n`) }), KEY);
  assert.deepEqual(opened[0], [`${config.claudeConfigDir}/zai/coding-plan-key`,
    constants.O_RDONLY | constants.O_NOFOLLOW]);
  for (const stat of [file({ uid: 1001 }), file({ mode: 0o100644 }), file({ mode: 0o100660 }),
    file({ isFile: () => false }), file({ size: 9000 })])
    assert.equal(await readAmuxV22ZaiCodingPlanKey(config, { openFile: fakeOpen(stat, KEY) }), null);
  assert.equal(await readAmuxV22ZaiCodingPlanKey(config, { openFile: fakeOpen(file(), "not a key") }), null);
  // A link (O_NOFOLLOW refuses it) or a missing file is no key.
  assert.equal(await readAmuxV22ZaiCodingPlanKey(config, { openFile: async () => {
    throw Object.assign(new Error("ELOOP"), { code: "ELOOP" }); } }), null);
});

test("a Z.ai receipt is Claude Code's counts under Z.ai's name, settled as the selected model", () => {
  const result = { type: "result", subtype: "success", is_error: false, result: "Done.",
    num_turns: 2, usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 300,
      cache_creation_input_tokens: 0 },
    modelUsage: { "glm-5.4[1m]": { inputTokens: 900, outputTokens: 120,
      cacheReadInputTokens: 300, cacheCreationInputTokens: 0 } } };
  const claude = inspectClaudeCliResultUsage(result, { exitCode: 0, stdoutComplete: true,
    freshPrintInvocation: true });
  // The sidecar's conversion: Z.ai's name, no model attestation.
  const observation = { ...claude, cli: "zai", models: [] };
  const receipt = makeAmuxCliUsageReceipt({ invocationId: ATTEMPT,
    binding: { kind: "task_attempt", attemptId: ATTEMPT }, worker: "zai-impl",
    selectedModelId: MODEL, cliVersion: null, authentication: "unknown",
    startedAt: "2026-11-28T04:00:00.000Z", endedAt: "2026-11-28T04:01:00.000Z",
    status: "succeeded", observation });
  assert.deepEqual([receipt.cli, receipt.provider, receipt.source, receipt.actualModelId,
    receipt.inputTokensIncludeCacheRead, receipt.inputTokensIncludeCacheWrite],
  ["zai", "zai", "zai_claude_result", null, false, false]);
  assert.equal(amuxCliPricedModelId(receipt), MODEL);
  assert.equal(v22ExecutionSourceForProvider("zai"), "zai_claude_result");
  assert.equal(v22ExecutionReceiptVerified({ attemptId: ATTEMPT, invocationIds: [ATTEMPT],
    events: [{ invocationId: ATTEMPT, status: "succeeded", completeness: receipt.completeness,
      projectedApiCostMicrousd: 10n, cli: "zai", source: "zai_claude_result", actualModelId: null,
      selectedModelId: MODEL }], outcome: "succeeded", reservedCostMicrousd: 1_000_000n,
    resultStored: true, expectedExecutionSource: "zai_claude_result", budgetBound: false }),
  receipt.completeness === "reported_complete");
  for (const change of [{ provider: "anthropic" }, { source: "claude_result" },
    { inputTokensIncludeCacheRead: true }, { cliFailure: "turn_limit", status: "failed" }])
    assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...receipt, ...change }).success, false,
      JSON.stringify(change));
});

test("a Z.ai run's file tools may not read the key, the profile, the run home or /proc", () => {
  assert.deepEqual(amuxV22ZaiDisallowedTools(config), ["--disallowedTools", [
    `Read(/${config.claudeConfigDir}/**)`, `Edit(/${config.claudeConfigDir}/**)`,
    "Read(//proc/**)", "Edit(//proc/**)",
    `Read(/${config.homePath}/**)`, `Edit(/${config.homePath}/**)`].join(",")]);
  // A checkout inside the run home keeps its own reads; the home is then not denied.
  const inside = { ...config, worktreePath: `${config.homePath}/checkout` };
  assert.ok(!amuxV22ZaiDisallowedTools(inside)[1].includes(`Read(/${config.homePath}/**)`));
  // A checkout inside the profile, or an unsafe path, cannot be run at all.
  for (const bad of [{ worktreePath: `${config.claudeConfigDir}/w` }, { homePath: "/a b" },
    { claudeConfigDir: "relative" }, { worktreePath: "/proc/1" }])
    assert.throws(() => amuxV22ZaiDisallowedTools({ ...config, ...bad }));
});

function fakeSpawn(output) {
  const calls = [];
  const spawnChild = (binary, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    calls.push({ binary, args, spawnOptions });
    child.kill = () => {};
    queueMicrotask(() => { child.emit("spawn"); child.stdout.end(output); child.emit("close", 0, null); });
    return child;
  };
  return { spawnChild, calls };
}

test("a Z.ai run is Claude Code with its deny rules, its jail and Z.ai's environment", async () => {
  const request = { version: 1, attemptId: ATTEMPT, worker: "zai-impl", role: "investigate",
    modelId: MODEL, budgetMicrousd: 1_000_000, prompt: "Look at the parser." };
  const result = { type: "result", subtype: "success", is_error: false, result: "It drops a line.",
    num_turns: 1, usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0 },
    modelUsage: { [MODEL]: { inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0 } } };
  const fake = fakeSpawn(`${JSON.stringify(result)}
`);
  const keys = [];
  const options = { syntheticPlatform: true, spawnChild: fake.spawnChild, channelPreflight: () => null,
    ensureDependencies: async () => ({ ok: true, installed: false }),
    createShellJail: async () => ({ binPath: "/jail/bin", prefixPath: "/jail/prefix",
      cleanup: async () => {} }),
    zaiManagedSettingsPresent: () => false,
    createZaiRunHome: async (value) => ({ config: { ...value, homePath: "/run-home",
      claudeConfigDir: "/run-home/.claude" }, copilotToken: null, cleanup: async () => { cleaned += 1; } }),
    readZaiKey: async (value) => { keys.push(value.claudeConfigDir); return KEY; } };
  let cleaned = 0;
  const outcome = await runAmuxV22OneShot(request, { ...config, binaryPath: "/opt/claude/bin/claude" },
    options);
  assert.deepEqual(keys, [config.claudeConfigDir]);
  const { binary, args, spawnOptions } = fake.calls[0];
  assert.equal(binary, "/opt/claude/bin/claude");
  assert.deepEqual(args, [...amuxV22ClaudeArgs(request, { flow: true }),
    ...amuxV22ZaiDisallowedTools(config)]);
  assert.ok(!args.includes(KEY));
  assert.equal(spawnOptions.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(spawnOptions.env.ANTHROPIC_BASE_URL, AMUX_V22_ZAI_BASE_URL);
  assert.equal(spawnOptions.env.CLAUDE_CODE_SHELL_PREFIX, "/jail/prefix");
  assert.equal(spawnOptions.env.HOME, "/run-home");
  assert.equal(spawnOptions.env.CLAUDE_CONFIG_DIR, "/run-home/.claude");
  assert.equal(cleaned, 1);
  assert.equal(outcome.kind, "succeeded");
  assert.equal(outcome.usageReceipt.cli, "zai");
  assert.equal(outcome.usageReceipt.actualModelId, null);
  // No key, no run.
  const none = fakeSpawn("");
  const refused = await runAmuxV22OneShot(request, { ...config, binaryPath: "/opt/claude/bin/claude" },
    { ...options, spawnChild: none.spawnChild, readZaiKey: async () => null });
  assert.deepEqual([refused.kind, refused.cliStarted, refused.failure],
    ["failed", false, "channel_auth_refused"]);
  assert.equal(none.calls.length, 0);
  // Claude Code's managed settings on the host: no run either.
  const managed = await runAmuxV22OneShot(request, { ...config, binaryPath: "/opt/claude/bin/claude" },
    { ...options, spawnChild: none.spawnChild, zaiManagedSettingsPresent: () => true });
  assert.deepEqual([managed.kind, managed.cliStarted, managed.failure],
    ["failed", false, "project_cli_config_present"]);
  assert.equal(none.calls.length, 0);
  // A Claude worker's arguments carry no Z.ai rule.
  assert.ok(!amuxV22ClaudeArgs({ ...request, modelId: "claude-opus-5-5" }, { flow: true })
    .includes("--disallowedTools"));
});

test("a Z.ai run home is fresh and empty, and goes away after the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "amux-v22-zai-"));
  const run = await createAmuxV22ZaiRunHome({ ...config, homePath: root });
  assert.ok(run.config.homePath.startsWith(join(root, "run-")));
  assert.equal(run.config.claudeConfigDir, join(run.config.homePath, ".claude"));
  assert.deepEqual(await readdir(run.config.homePath), [".claude"]);
  assert.deepEqual(await readdir(run.config.claudeConfigDir), []);
  await run.cleanup();
  await assert.rejects(stat(run.config.homePath));
});
