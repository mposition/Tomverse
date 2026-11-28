// Owner decision 2026-11-28: the GLM Coding Plan runs as Claude Code against
// Z.ai's Anthropic-compatible endpoint, a worker class of its own (`zai`).
// The run is Claude's (arguments, jailed shell, result), with Z.ai's
// endpoint, the operator's root-owned Coding Plan key and a GLM model.
// Nothing here calls a model.

import assert from "node:assert/strict";
import { constants } from "node:fs";
import test from "node:test";

import { amuxCliPricedModelId, amuxCliUsageReceiptSchema, makeAmuxCliUsageReceipt } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { inspectClaudeCliResultUsage } from "../lib/amux/cliUsageObservationCore.ts";
import { amuxV22ChannelPreflight } from "../lib/amux/v22ChannelRun.mjs";
import { AMUX_V22_ZAI_BASE_URL, amuxV22CliEnv, amuxV22ZaiEnv, parseAmuxV22OneShotRequest,
  readAmuxV22ZaiCodingPlanKey } from "../lib/amux/v22OneShotSidecar.mjs";
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
  const env = amuxV22CliEnv("zai", config, null, { shellJail: jail, worktreeTmp: "/w/tmp",
    zaiKey: KEY, modelId: MODEL });
  assert.deepEqual(env, { HOME: config.homePath, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
    CLAUDE_CONFIG_DIR: config.claudeConfigDir, CLAUDE_CODE_SHELL_PREFIX: jail.prefixPath,
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
      read: async (buffer) => { const bytes = Buffer.from(text); bytes.copy(buffer); return { bytesRead: bytes.length }; },
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
