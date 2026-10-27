import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { amuxV22ClaudeArgs, amuxV22SidecarEnabled,
  checkAmuxV22SidecarSocketDir, createAmuxV22SidecarHandler,
  createAmuxV22SidecarServer,
  parseAmuxV22OneShotRequest,
  runAmuxV22OneShot, normalizeAmuxV22ClaudeQuota, probeAmuxV22ClaudeQuota } from
  "../lib/amux/v22OneShotSidecar.mjs";
import { amuxV22ReadOnlyActualLauncherConfigDigest, amuxV22ReadOnlyLaunchScope,
  amuxV22ReadOnlyLaunchScopeDigest } from
  "../lib/amux/v22ReadOnlyRetryProtocol.mjs";

const attemptId = "00000000-0000-4000-8000-000000000001";
const request = { version: 1, attemptId, worker: "worker-a",
  role: "implement", modelId: "claude-opus-5-5",
  budgetMicrousd: 1_250_000, prompt: "Change a small file." };
const config = { worker: "worker-a", binaryPath: "/usr/bin/claude",
  worktreePath: "/srv/tomverse/worktrees/worker-a", homePath: "/home/tommy",
  claudeConfigDir: "/home/tommy/.amux-cli-profiles/claude" };
const retryActualLauncherConfigDigest = amuxV22ReadOnlyActualLauncherConfigDigest({
  ...config, profileConfigDigest: "1".repeat(64), nodeArtifactDigest: "a".repeat(64),
  sidecarArtifactDigest: "b".repeat(64), cliArtifactDigest: "c".repeat(64),
  localCustomizationDigest: "9".repeat(64),
  worktreeIdentityDigest: "d".repeat(64), homeIdentityDigest: "e".repeat(64),
  claudeConfigIdentityDigest: "f".repeat(64),
});
const retryScope = amuxV22ReadOnlyLaunchScope({ profileConfigDigest: "1".repeat(64),
  launcherConfigDigest: retryActualLauncherConfigDigest });
const retryBinding = { version: 1,
  launchBindingId: "00000000-0000-4000-8000-000000000011",
  riskAcceptanceDigest: "2".repeat(64), safeStopEvidenceDigest: "3".repeat(64),
  launchProofDigest: "4".repeat(64),
  launchScopeDigest: amuxV22ReadOnlyLaunchScopeDigest(retryScope),
  launcherPolicyVersion: retryScope.launcherPolicyVersion,
  launcherConfigDigest: retryScope.launcherConfigDigest,
  fixedArgvDigest: retryScope.fixedArgvDigest, toolPolicyDigest: retryScope.toolPolicyDigest,
  profileConfigDigest: retryScope.profileConfigDigest, briefDigest: "5".repeat(64),
  provider: "anthropic", modelId: "claude-opus-5-5", routeId: "route:one",
  routePolicyDigest: "6".repeat(64), catalogApprovalId: "catalog:one",
  catalogVersion: "catalog-v1", pricingVersion: "pricing-v1",
  costReceiptDigest: "7".repeat(64), additionalCapMicroUsd: "3400000",
  worstExposureMicroUsd: "6800000", role: "investigate" };
const recoveryBinding = { version: 1,
  taskId: "c48886b9-86f8-4631-8db8-c0b288a707af", taskRevision: 5,
  attemptId, workerName: "worker-a",
  workerInstanceId: "00000000-0000-4000-8000-000000000012",
  workerGeneration: 8, targetHost: "amux-ubuntu",
  recoveryApprovalId: "00000000-0000-4000-8000-000000000013",
  briefDigest: retryBinding.briefDigest };
const readOnlyRequest = { ...request, role: "investigate", modelId: retryBinding.modelId,
  budgetMicrousd: 3_400_000, prompt: "Inspect the approved files only.",
  recoveryBinding, readOnlyRetry: retryBinding };
const inspectReadOnlyLauncherConfig = async value => ({ current: true,
  launcherConfigDigest: amuxV22ReadOnlyActualLauncherConfigDigest({
    ...value, profileConfigDigest: retryBinding.profileConfigDigest,
    nodeArtifactDigest: "a".repeat(64), sidecarArtifactDigest: "b".repeat(64),
    cliArtifactDigest: "c".repeat(64),
    localCustomizationDigest: "9".repeat(64),
    worktreeIdentityDigest: "d".repeat(64), homeIdentityDigest: "e".repeat(64),
    claudeConfigIdentityDigest: "f".repeat(64),
  }) });
const usage = { type: "result", subtype: "success", is_error: false,
  result: "Synthetic review result",
  num_turns: 1, modelUsage: { "claude-opus-5-5": {
    inputTokens: 10, outputTokens: 5,
    cacheReadInputTokens: 2, cacheCreationInputTokens: 1,
  } } };

test("profile quota uses the tightest reported window and never invents availability", () => {
  const at = "2026-10-12T00:00:00.000Z";
  const reset = "2026-10-12T07:00:00.000Z";
  const body = { five_hour: { utilization: 26, resets_at: reset },
    seven_day: { utilization: 16, resets_at: reset }, seven_day_opus: null,
    limits: [{ kind: "session", percent: 99, resets_at: reset }] };
  assert.equal(normalizeAmuxV22ClaudeQuota(body, at).remaining_basis_points, 7400);
  assert.equal(normalizeAmuxV22ClaudeQuota({ ...body,
    seven_day_opus: { utilization: 0, resets_at: null } }, at).remaining_basis_points, 7400);
  for (const utilization of [undefined, "0", 1]) assert.equal(normalizeAmuxV22ClaudeQuota({ ...body,
    seven_day_opus: { utilization, resets_at: null } }, at), null);
  assert.equal(normalizeAmuxV22ClaudeQuota({ ...body,
    seven_day_opus: { utilization: 100, resets_at: reset } }, at).exhausted, true);
  for (const bad of [{}, { five_hour: body.five_hour },
    { ...body, seven_day: { utilization: "16", resets_at: reset } },
    { ...body, seven_day: { utilization: -1, resets_at: reset } },
    { ...body, five_hour: { utilization: 0, resets_at: at } }]) {
    assert.equal(normalizeAmuxV22ClaudeQuota(bad, at), null);
  }
  const limits = [{ kind: "session", percent: 12.345, resets_at: reset },
    { kind: "weekly_all", percent: 15, resets_at: reset }];
  assert.equal(normalizeAmuxV22ClaudeQuota({ limits }, at).remaining_basis_points, 8500);
  assert.equal(normalizeAmuxV22ClaudeQuota({ limits: [...limits,
    { kind: "weekly_scoped", percent: 0, resets_at: null }] }, at).remaining_basis_points, 8500);
  assert.equal(normalizeAmuxV22ClaudeQuota({ limits: [...limits, { kind: "unknown", percent: 0 }] }, at), null);
});

test("quota reads only the assigned CLI profile, bounds and erases credentials, and never launches CLI", async () => {
  let network = 0, closed = 0, suppliedBuffer;
  const credential = { claudeAiOauth: { accessToken: "synthetic-oauth-token-not-real", expiresAt: Date.now() + 60000 } };
  const options = { uid: 1000,
    readSettings: async () => null,
    open: async path => { assert.equal(path, join(config.claudeConfigDir, ".credentials.json")); return {
      stat: async () => ({ isFile: () => true, mode: 0o100600, uid: 1000, size: 100 }),
      read: async buffer => { suppliedBuffer = buffer; const data = Buffer.from(JSON.stringify(credential));
        data.copy(buffer); return { bytesRead: data.length }; }, close: async () => { closed += 1; },
    }; },
    request: async token => { network += 1; assert.equal(token, credential.claudeAiOauth.accessToken);
      const reset = new Date(Date.now() + 3600000).toISOString();
      return { five_hour: { utilization: 10, resets_at: reset }, seven_day: { utilization: 20, resets_at: reset } }; },
  };
  const result = await probeAmuxV22ClaudeQuota(config, options);
  assert.equal(result.remaining_basis_points, 8000);
  assert.equal(network, 1); assert.equal(closed, 1);
  assert.equal(suppliedBuffer.every(byte => byte === 0), true);
  assert.equal(JSON.stringify(result).includes(credential.claudeAiOauth.accessToken), false);
  credential.claudeAiOauth.expiresAt = Date.now() - 1;
  assert.equal(await probeAmuxV22ClaudeQuota(config, options), null);
  assert.equal(network, 1, "expired authentication must not refresh or call provider");
  credential.claudeAiOauth.expiresAt = Date.now() + 60000;
  assert.equal(await probeAmuxV22ClaudeQuota(config, { ...options,
    readSettings: async () => ({ apiKeyHelper: "must-not-execute" }) }), null);
  assert.equal(await probeAmuxV22ClaudeQuota(config, { ...options,
    readSettings: async () => ({ env: { ANTHROPIC_API_KEY: "not-real" } }) }), null);
  const visited = [];
  assert.equal(await probeAmuxV22ClaudeQuota(config, { ...options,
    readSettings: async path => { visited.push(path);
      return path === join(config.claudeConfigDir, ".claude.json")
        ? { primaryApiKey: "synthetic-not-real" } : null; } }), null);
  assert.ok(visited.includes(join(config.claudeConfigDir, ".claude.json")));
  assert.equal(await probeAmuxV22ClaudeQuota(config, { ...options,
    readSettings: async path => path === join(config.homePath, ".claude.json")
      ? { apiKeyHelper: "must-not-execute" } : null }), null);
  assert.equal(network, 1, "API-key/alternate backend settings cannot borrow subscription quota");
});

test("quota transport forces certificate verification and bounded large global config remains usable", async () => {
  const data = Buffer.from(JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-token-not-real", expiresAt: Date.now() + 60000,
  } }));
  const settings = Buffer.from(JSON.stringify({ metadata: "x".repeat(100_000) }));
  let settingsBuffer, requests = 0;
  const reset = new Date(Date.now() + 3600000).toISOString();
  const file = bytes => ({ stat: async () => ({ isFile: () => true, mode: 0o600, uid: 123, size: bytes.length }),
    read: async buffer => { bytes.copy(buffer); return { bytesRead: bytes.length }; }, close: async () => {} });
  const result = await probeAmuxV22ClaudeQuota(config, { uid: 123,
    open: async () => file(data),
    openSettings: async path => {
      if (path !== join(config.claudeConfigDir, ".claude.json")) throw Object.assign(new Error(), { code: "ENOENT" });
      return { ...file(settings), read: async buffer => { settingsBuffer = buffer;
        settings.copy(buffer); return { bytesRead: settings.length }; } };
    },
    httpsGet: (options, callback) => {
      requests += 1;
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.hostname, "api.anthropic.com"); assert.equal(options.port, 443);
      assert.equal(options.path, "/api/oauth/usage"); assert.equal(options.signal.aborted, false);
      const req = new EventEmitter(); const response = new EventEmitter(); response.statusCode = 200;
      req.destroy = error => req.emit("error", error);
      queueMicrotask(() => { callback(response);
        response.emit("data", Buffer.from(JSON.stringify({ five_hour: { utilization: 10, resets_at: reset },
          seven_day: { utilization: 20, resets_at: reset } })));
        response.emit("end"); });
      return req;
    },
  });
  assert.equal(result.remaining_basis_points, 8000); assert.equal(requests, 1);
  assert.equal(settingsBuffer.every(byte => byte === 0), true);
});

test("quota RPC is bound to the fixed worker and creates no execution journal", async () => {
  let runs = 0, reads = 0;
  const handler = createAmuxV22SidecarHandler({ worker: request.worker, stateDir: config.worktreePath,
    run: async () => { runs += 1; }, quota: async () => { reads += 1; return null; } });
  const message = { op: "quota", requestId: attemptId, worker: request.worker };
  assert.deepEqual(await handler(message), { kind: "quota_unavailable", requestId: attemptId, worker: request.worker });
  await assert.rejects(handler({ ...message, worker: "another-worker" }));
  await assert.rejects(handler({ ...message, claudeConfigDir: "/another-profile" }));
  await assert.rejects(handler({ ...message, requestId: "not-an-id" }));
  assert.equal(reads, 1); assert.equal(runs, 0);
});

test("protocol handshake is exact, worker-bound, and never invokes the CLI", async () => {
  let runs = 0;
  const handler = createAmuxV22SidecarHandler({ worker: request.worker,
    stateDir: config.worktreePath, run: async () => { runs += 1; } });
  assert.deepEqual(await handler({ op: "protocol", requestId: attemptId,
    worker: request.worker }), { kind: "protocol", requestId: attemptId,
    worker: request.worker, capabilities: ["read_only_retry_v1"] });
  await assert.rejects(handler({ op: "protocol", requestId: attemptId,
    worker: "worker-b" }));
  await assert.rejects(handler({ op: "protocol", requestId: attemptId,
    worker: request.worker, capability: true }));
  assert.equal(runs, 0);
});

// Poll by deadline, not by count: the terminal write fsyncs the result and its
// directory, which can take hundreds of milliseconds on a loaded runner.
async function readFinished(handler) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await handler({ op: "readback", attemptId });
    if (result.kind !== "in_progress") return result;
    if (Date.now() > deadline) throw new Error("sidecar result was not recorded");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fakeSpawn(result, options = {}) {
  const calls = [];
  const spawnChild = (binary, args, spawnOptions) => {
    calls.push({ binary, args, spawnOptions });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = "SIGKILL";
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    };
    queueMicrotask(() => {
      child.emit("spawn");
      if (options.hang) return;
      child.stdout.end(result);
      child.exitCode = options.exitCode ?? 0;
      child.emit("close", child.exitCode, null);
    });
    return child;
  };
  return { spawnChild, calls };
}

test("sidecar requires its own exact Ubuntu environment switch", () => {
  assert.equal(amuxV22SidecarEnabled("1"), true);
  for (const flag of [undefined, "", "0", "enabled", "true", " 1", "1 "]) {
    assert.equal(amuxV22SidecarEnabled(flag), false);
  }
});

test("the one-shot request and CLI command have bounded capabilities", () => {
  assert.deepEqual(parseAmuxV22OneShotRequest(request, "worker-a"), request);
  assert.throws(() => parseAmuxV22OneShotRequest({ ...request,
    worker: "worker-b" }, "worker-a"));
  // No fixed per-attempt cap (owner decision 2026-10-25): the reservation is
  // the budget. Only a non-positive or unsafe amount is refused.
  assert.equal(parseAmuxV22OneShotRequest({ ...request,
    budgetMicrousd: 5_000_001 }, "worker-a").budgetMicrousd, 5_000_001);
  for (const budgetMicrousd of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseAmuxV22OneShotRequest({ ...request, budgetMicrousd }, "worker-a"));
  }
  assert.throws(() => parseAmuxV22OneShotRequest({ ...request,
    worktreePath: "/etc" }, "worker-a"));
  const args = amuxV22ClaudeArgs(request);
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--permission-prompts"));
  assert.equal(args.includes("--max-budget-usd"), false,
    "an ordinary run has no dollar stop (owner decision 2026-10-25)");
  assert.equal(args[args.indexOf("--tools") + 1],
    "Read,Grep,Glob,Edit,Write");
  assert.equal(args.some((arg) => arg.includes("Bash")), false);
});

test("read-only retry is validated and closed before the CLI child starts", async () => {
  assert.deepEqual(parseAmuxV22OneShotRequest(readOnlyRequest, "worker-a"), readOnlyRequest);
  const args = amuxV22ClaudeArgs(readOnlyRequest);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--max-turns") + 1], "8");
  assert.equal(args[args.indexOf("--tools") + 1], "Glob,Grep,Read");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Glob,Grep,Read");
  assert.equal(args.some(value => /Bash|Edit|Write|MCP|WebFetch|WebSearch/.test(value)), false);
  let spawned = 0;
  const mutations = [
    { recoveryBinding: { ...recoveryBinding, taskId: "another-task" } },
    { recoveryBinding: { ...recoveryBinding,
      attemptId: "00000000-0000-4000-8000-000000000099" } },
    { modelId: "claude-other" },
    { recoveryBinding: { ...recoveryBinding, briefDigest: "8".repeat(64) } },
    { readOnlyRetry: { ...retryBinding, launcherPolicyVersion: "another-version" } },
    { readOnlyRetry: { ...retryBinding, launcherConfigDigest: "8".repeat(64) } },
    { readOnlyRetry: { ...retryBinding, provider: "openai" } },
    { readOnlyRetry: { ...retryBinding, allowedTools: ["Bash"] } },
  ];
  for (const mutation of mutations) await assert.rejects(() =>
    runAmuxV22OneShot({ ...readOnlyRequest, ...mutation }, config, {
      syntheticPlatform: true,
      inspectReadOnlyLauncherConfig,
      spawnChild: () => { spawned += 1; throw new Error("must not spawn"); },
    }), /invalid read-only (?:retry|recovery) binding/);
  for (const [key, value] of Object.entries({ binaryPath: "/usr/local/bin/claude",
    worktreePath: "/srv/tomverse/worktrees/other", homePath: "/home/other",
    claudeConfigDir: "/home/tommy/.amux-cli-profiles/other" }))
    await assert.rejects(() => runAmuxV22OneShot(readOnlyRequest,
      { ...config, [key]: value }, { syntheticPlatform: true,
        inspectReadOnlyLauncherConfig,
        spawnChild: () => { spawned += 1; throw new Error("must not spawn"); } }),
    /invalid read-only retry launcher configuration/, key);
  for (const current of [false, true]) await assert.rejects(() =>
    runAmuxV22OneShot(readOnlyRequest, config, { syntheticPlatform: true,
      inspectReadOnlyLauncherConfig: async () => current
        ? { current: true, launcherConfigDigest: "f".repeat(64) } : { current: false },
      spawnChild: () => { spawned += 1; throw new Error("must not spawn"); } }),
  /invalid read-only retry launcher configuration/);
  assert.equal(spawned, 0);
  const fake = fakeSpawn(JSON.stringify(usage));
  for (const [launchConfig, launchOptions] of [
    [config, {}],
    [{ ...config, remoteManagedSettingsVerified: true },
      { remoteManagedSettingsVerified: true }],
  ]) await assert.rejects(() => runAmuxV22OneShot(readOnlyRequest, launchConfig, {
    syntheticPlatform: true, spawnChild: fake.spawnChild, ...launchOptions,
  }), /invalid read-only retry launcher configuration/);
  assert.equal(fake.calls.length, 0);
});

test("read-only result echo is durable and a missing echo can never settle as success", async () => {
  for (const includeEcho of [true, false]) {
    const stateDir = await mkdtemp(join(tmpdir(), `amux-v22-read-only-${includeEcho}-`));
    try {
      let calls = 0;
      const echo = { version: 1, launchBindingId: retryBinding.launchBindingId,
        launchProofDigest: retryBinding.launchProofDigest,
        launchScopeDigest: retryBinding.launchScopeDigest };
      const run = async input => { calls += 1; return { kind: "succeeded",
        attemptId: input.attemptId, ...(includeEcho ? { readOnlyRetry: echo } : {}) }; };
      const handler = createAmuxV22SidecarHandler({ worker: "worker-a", stateDir, run });
      const execute = { op: "execute", ...readOnlyRequest };
      assert.equal((await handler(execute)).kind, "in_progress");
      const stored = await readFinished(handler);
      assert.equal(stored.kind, includeEcho ? "succeeded" : "outcome_unknown");
      if (includeEcho) assert.deepEqual(stored.readOnlyRetry, echo);
      else assert.equal(stored.readOnlyRetry, undefined);
      const restarted = createAmuxV22SidecarHandler({ worker: "worker-a", stateDir, run });
      assert.equal((await restarted(execute)).kind,
        includeEcho ? "succeeded" : "outcome_unknown");
      assert.equal(calls, 1, "durable claim must not repeat the provider invocation");
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  }
});

test("one child returns a reviewable result and a content-free receipt", async () => {
  const fake = fakeSpawn(JSON.stringify(usage));
  const result = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: fake.spawnChild,
  });
  assert.equal(result.kind, "succeeded");
  assert.equal(result.attemptId, attemptId);
  assert.equal(Object.hasOwn(result, "usageObservation"), false);
  assert.equal(result.usageReceipt.binding.attemptId, attemptId);
  assert.equal(result.usageReceipt.actualModelId, "claude-opus-5-5");
  assert.equal(result.usageReceipt.completeness, "reported_complete");
  assert.equal(result.usageReceipt.observed.inputTokens, 10);
  assert.match(result.usageReceiptDigest, /^[0-9a-f]{64}$/);
  assert.match(result.outputDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.resultText, usage.result);
  assert.match(result.resultSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.usageReceipt).includes(usage.result), false);
  assert.equal(JSON.stringify(result).includes(request.prompt), false);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].spawnOptions.shell, false);
  assert.equal(fake.calls[0].spawnOptions.env.TOMVERSE_AMUX_SYNC_SECRET,
    undefined);
});

test("v52 guard inventories non-implement attempts and withholds a contract patch", async () => {
  const baseline = async (_path, options) => {
    assert.equal(options.guardIgnoredContract, true);
    return { ok: true, baseSha: "a".repeat(40) };
  };
  const fake = fakeSpawn(JSON.stringify(usage));
  const inspected = await runAmuxV22OneShot({ ...request,
    role: "investigate", gradeGuard: true, executionGrade: "advanced" }, config, {
    syntheticPlatform: true, spawnChild: fake.spawnChild,
    captureBaseline: baseline,
    captureChangedPaths: async () => ({ ok: true, files: [], contractPaths: [] }),
  });
  assert.deepEqual(inspected.changedPaths, []);
  assert.equal(inspected.gradeGuard, true);
  let patchCalls = 0;
  let discarded = 0;
  const contract = await runAmuxV22OneShot({ ...request, gradeGuard: true,
    executionGrade: "routine" },
    config, { syntheticPlatform: true, spawnChild: fake.spawnChild,
      captureBaseline: baseline,
      captureChangedPaths: async () => ({ ok: true,
        files: ["lib/amux/execution.ts"],
        contractPaths: ["lib/amux/execution.ts"] }),
      discardAttemptChanges: async () => { discarded++; return true; },
      capturePatch: async () => { patchCalls++; throw new Error("not reachable"); },
    });
  assert.deepEqual(contract.changedPaths, ["lib/amux/execution.ts"]);
  assert.equal(contract.patchDigest, undefined);
  assert.equal(contract.reviewCommitSha, undefined);
  assert.equal(contract.reviewTouchesContract, undefined);
  assert.equal(patchCalls, 0);
  assert.equal(discarded, 1);
  const readOnlyEdit = await runAmuxV22OneShot({ ...request,
    role: "investigate", gradeGuard: true, executionGrade: "advanced" },
    config, { syntheticPlatform: true, spawnChild: fake.spawnChild,
      captureBaseline: baseline,
      captureChangedPaths: async () => ({ ok: true,
        files: ["lib/ordinary.ts"], contractPaths: [] }),
      discardAttemptChanges: async () => { discarded++; return true; },
    });
  assert.deepEqual(readOnlyEdit.changedPaths, ["lib/ordinary.ts"]);
  assert.equal(discarded, 2);
  const missing = await runAmuxV22OneShot({ ...request, gradeGuard: true,
    executionGrade: "routine" },
    config, { syntheticPlatform: true, spawnChild: fake.spawnChild,
      captureBaseline: baseline,
      captureChangedPaths: async () => ({ ok: false,
        reason: "changed_paths_unavailable" }),
      capturePatch: async () => { patchCalls++; throw new Error("not reachable"); },
    });
  assert.equal(missing.changedPathsReason, "changed_paths_unavailable");
  assert.equal(patchCalls, 0);
});

test("v52 frontier implement binds a review commit to the captured patch", async () => {
  const fake = fakeSpawn(JSON.stringify(usage));
  const result = await runAmuxV22OneShot({ ...request,
    gradeGuard: true, executionGrade: "frontier" }, config, {
    syntheticPlatform: true, spawnChild: fake.spawnChild,
    captureBaseline: async () => ({ ok: true, baseSha: "a".repeat(40) }),
    captureChangedPaths: async () => ({ ok: true,
      files: ["lib/amux/execution.ts"],
      contractPaths: ["lib/amux/execution.ts"] }),
    capturePatch: async (_worktree, _base, options) => {
      assert.equal(options.allowUntracked, true);
      return { ok: true, baseSha: "a".repeat(40),
      patchDigest: "c".repeat(64),
      patchBody: "diff --git a/lib/amux/execution.ts b/lib/amux/execution.ts\n",
      publishFiles: [{ path: "lib/amux/execution.ts", mode: "100644",
        bytesBase64: "YQ==" }] };
    },
    captureReviewCommit: async (_worktree, base, attempt, files, patch) => {
      assert.equal(base, "a".repeat(40));
      assert.equal(attempt, attemptId);
      assert.deepEqual(files, ["lib/amux/execution.ts"]);
      assert.match(patch, /^diff --git /);
      return { ok: true, baseSha: base, commitSha: "b".repeat(40),
        reviewRef: `refs/amux-v52-review/${attemptId}` };
    },
  });
  assert.equal(result.kind, "succeeded");
  assert.equal(result.reviewBaseSha, "a".repeat(40));
  assert.equal(result.reviewCommitSha, "b".repeat(40));
  assert.equal(result.reviewTouchesContract, true);
  assert.equal(result.reviewRef, `refs/amux-v52-review/${attemptId}`);
});

test("implement refuses a dirty baseline before CLI and holds a patch only in memory", async () => {
  const refused = fakeSpawn(JSON.stringify(usage));
  const blocked = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: refused.spawnChild,
    captureBaseline: async () => ({ ok: false, reason: "dirty_worktree" }),
  });
  assert.deepEqual({ kind: blocked.kind, failure: blocked.failure,
    cliStarted: blocked.cliStarted },
  { kind: "failed", failure: "patch_baseline_dirty_worktree",
    cliStarted: false });
  assert.equal(refused.calls.length, 0);

  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-patch-"));
  const patchBody = "diff --git a/example b/example\n";
  const patchDigest = (await import("node:crypto")).createHash("sha256")
    .update(patchBody).digest("hex");
  const publishFiles = [{ path: "tests/example.test.mjs", mode: "100644",
    bytesBase64: "YQ==" }];
  const filesDigest = (await import("node:crypto")).createHash("sha256")
    .update(JSON.stringify(publishFiles)).digest("hex");
  try {
    const fake = fakeSpawn(JSON.stringify(usage));
    const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run: (input) => runAmuxV22OneShot(input, config, {
        syntheticPlatform: true, spawnChild: fake.spawnChild,
        captureBaseline: async () => ({ ok: true, baseSha: "a".repeat(40) }),
        capturePatch: async () => ({ ok: true, baseSha: "a".repeat(40),
          patchBody, patchDigest, publishFiles }),
      }) });
    assert.equal((await handler({ op: "execute", ...request })).kind,
      "in_progress");
    const result = await readFinished(handler);
    assert.equal(result.patchBody, patchBody);
    assert.equal(result.patchDigest, patchDigest);
    assert.deepEqual(result.publishFiles, publishFiles);
    assert.equal(result.publishFilesDigest, filesDigest);
    assert.equal((await readFile(join(stateDir, `${attemptId}.result`),
      "utf8")).includes(patchBody), false);
    assert.equal((await readFile(join(stateDir, `${attemptId}.result`),
      "utf8")).includes(filesDigest), true);
    assert.equal((await handler({ op: "confirm_patch", attemptId,
      patchDigest })).kind, "confirmed");
    assert.equal((await handler({ op: "readback", attemptId })).patchBody,
      undefined);
    assert.equal((await handler({ op: "readback", attemptId }))
      .publishFilesDigest, filesDigest);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("unknown output and deadline never become success or retry", async () => {
  const malformed = fakeSpawn("not-json");
  const malformedResult = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: malformed.spawnChild,
  });
  assert.deepEqual({ kind: malformedResult.kind,
    failure: malformedResult.failure },
    { kind: "outcome_unknown", failure: "invalid_result" });

  const wrongShape = fakeSpawn("{}");
  const wrongShapeResult = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: wrongShape.spawnChild,
  });
  assert.deepEqual({ kind: wrongShapeResult.kind,
    failure: wrongShapeResult.failure },
    { kind: "outcome_unknown", failure: "invalid_result" });

  const hanging = fakeSpawn("", { hang: true });
  const timeoutResult = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: hanging.spawnChild,
    deadlineMs: 5,
  });
  assert.deepEqual({ kind: timeoutResult.kind,
    failure: timeoutResult.failure },
    { kind: "outcome_unknown", failure: "deadline" });
  assert.equal(hanging.calls.length, 1);
});

test("durable claim prevents duplicate CLI invocation across handler restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-once-"));
  try {
    let calls = 0;
    const run = async (input) => {
      calls += 1;
      return { kind: "succeeded", attemptId: input.attemptId,
        cliStarted: true };
    };
    const first = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    const execute = { op: "execute", ...request };
    assert.equal((await first(execute)).kind, "in_progress");
    assert.equal((await readFinished(first)).kind, "succeeded");
    assert.equal((await first(execute)).kind, "succeeded");
    const restarted = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    assert.equal((await restarted(execute)).kind, "succeeded");
    assert.equal((await restarted({ op: "readback", attemptId })).kind,
      "succeeded");
    assert.equal(calls, 1);
    await assert.rejects(restarted({ ...execute,
      prompt: "Different brief" }), /conflict/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("result text is available for exact transfer but never persisted in the sidecar journal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-result-"));
  try {
    const text = "Private review result";
    const sha256 = (await import("node:crypto")).createHash("sha256")
      .update(text).digest("hex");
    const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run: async (input) => ({ kind: "succeeded",
        attemptId: input.attemptId, resultText: text,
        resultSha256: sha256 }) });
    assert.equal((await handler({ op: "execute", ...request })).kind,
      "in_progress");
    const result = await readFinished(handler);
    assert.equal(result.resultText, text);
    assert.equal(result.resultSha256, sha256);
    assert.equal((await readFile(join(stateDir, `${attemptId}.result`),
      "utf8")).includes(text), false);
    assert.equal((await handler({ op: "confirm_result", attemptId,
      sourceSha256: sha256 })).kind, "confirmed");
    assert.equal((await handler({ op: "readback", attemptId })).resultText,
      undefined);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("a crash after the claim is unknown, never a second invocation", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-crash-"));
  let release;
  let first;
  try {
    const pending = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const run = async (input) => { calls += 1; await pending;
      return { kind: "failed", attemptId: input.attemptId }; };
    first = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    const execute = { op: "execute", ...request };
    assert.equal((await first(execute)).kind, "in_progress");
    // The claim is created asynchronously, so wait until it has been written.
    for (let i = 0; i < 50 && calls === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(calls, 1);
    assert.equal((await first(execute)).kind, "in_progress");
    const restarted = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    assert.equal((await restarted(execute)).kind, "outcome_unknown");
    assert.equal(calls, 1);
    release();
    assert.equal((await readFinished(first)).kind, "failed");
    assert.equal((await restarted({ op: "readback", attemptId })).kind,
      "failed");
  } finally {
    // The first handler writes its terminal in the background after release.
    // Let that write finish before removing stateDir, so cleanup never races a
    // file being created there and never replaces an earlier failure.
    release?.();
    if (first) await readFinished(first).catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Ubuntu runs one synthetic CLI process and replays its durable result",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-process-"));
    const stateDir = join(root, "state");
    const binaryPath = join(root, "synthetic-claude");
    const callsPath = join(root, "calls");
    try {
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(binaryPath, `#!/bin/sh\nprintf x >> '${callsPath}'\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false}'\n`);
      await chmod(binaryPath, 0o700);
      const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
        stateDir, run: (input) => runAmuxV22OneShot(input, {
          ...config, binaryPath, worktreePath: root, homePath: root,
          claudeConfigDir: root,
        }) });
      const execute = { op: "execute", ...request, role: "review" };
      assert.equal((await handler(execute)).kind, "in_progress");
      const finished = await readFinished(handler);
      assert.equal(finished.kind, "succeeded");
      assert.match(finished.outputDigest, /^[0-9a-f]{64}$/);
      const restarted = createAmuxV22SidecarHandler({ worker: "worker-a",
        stateDir, run: () => { throw new Error("duplicate CLI invocation"); } });
      assert.deepEqual(await restarted(execute), finished);
      assert.equal(await readFile(callsPath, "utf8"), "x");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test("Ubuntu socket carries only one bounded request and supports readback",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-socket-"));
    const socketPath = join(root, "worker.sock");
    const stateDir = join(root, "state");
    const { mkdir, stat } = await import("node:fs/promises");
    await mkdir(stateDir, { mode: 0o700 });
    let calls = 0;
    const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run: async (input) => { calls += 1;
        return { kind: "succeeded", attemptId: input.attemptId }; } });
    const server = createAmuxV22SidecarServer(socketPath, handler);
    const send = (body) => new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let answer = "";
      socket.once("error", reject);
      socket.on("data", (part) => { answer += part.toString("utf8"); });
      socket.once("end", () => resolve(JSON.parse(answer)));
      socket.once("connect", () => socket.end(`${JSON.stringify(body)}\n`));
    });
    try {
      await checkAmuxV22SidecarSocketDir(socketPath);
      await server.listen();
      assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
      assert.equal((await send({ op: "execute", ...request })).kind,
        "in_progress");
      let answer;
      for (let i = 0; i < 100; i += 1) {
        answer = await send({ op: "readback", attemptId });
        if (answer.kind !== "in_progress") break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(answer.kind, "succeeded");
      assert.equal((await send({ op: "execute", ...request })).kind,
        "succeeded");
      assert.equal(calls, 1);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("Ubuntu socket parent must be private",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-permission-"));
    const { chmod } = await import("node:fs/promises");
    try {
      await chmod(root, 0o755);
      await assert.rejects(checkAmuxV22SidecarSocketDir(
        join(root, "worker.sock")), /unsafe/);
      await chmod(root, 0o750);
      await checkAmuxV22SidecarSocketDir(join(root, "worker.sock"));
      await chmod(root, 0o770);
      await assert.rejects(checkAmuxV22SidecarSocketDir(
        join(root, "worker.sock")), /unsafe/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test("a Codex sidecar runs its own CLI under the role's sandbox and returns a Codex receipt", async () => {
  const codex = { ...config, provider: "openai", binaryPath: "/opt/tomverse-amux-v22/codex",
    claudeConfigDir: "/var/lib/tomverse-amux-v22-codex-impl/cli" };
  const investigate = { ...request, role: "investigate", modelId: "gpt-6-luna" };
  const output = [
    { type: "thread.started", thread_id: "opaque" }, { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "Findings." } },
    { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 400,
      output_tokens: 120, reasoning_output_tokens: 20 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const fake = fakeSpawn(output);
  let cleaned = 0;
  const result = await runAmuxV22OneShot(investigate, codex,
    { syntheticPlatform: true, spawnChild: fake.spawnChild, channelPreflight: () => null,
      createRunHome: async (_provider, value) => ({
        config: { ...value, homePath: "/run-home", claudeConfigDir: "/run-home/codex" },
        cleanup: async () => { cleaned += 1; } }) });
  assert.equal(cleaned, 1);
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call.binary, "/opt/tomverse-amux-v22/codex");
  assert.deepEqual(call.args.slice(0, 4), ["-a", "never", "--no-daemon", "exec"]);
  assert.ok(call.args.includes("read-only") && call.args.includes("gpt-6-luna"));
  // The CLI sees the fresh run home, never the sidecar's own config dir.
  assert.equal(call.spawnOptions.env.CODEX_HOME, "/run-home/codex");
  assert.equal(call.spawnOptions.env.HOME, "/run-home");
  assert.equal(call.spawnOptions.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(result.kind, "succeeded");
  assert.equal(result.resultText, "Findings.");
  assert.equal(result.usageReceipt.cli, "codex");
  assert.equal(result.usageReceipt.provider, "openai");
  assert.equal(result.usageReceipt.source, "codex_jsonl");
  // A Claude model or the Claude-only read-only retry is refused before any spawn.
  await assert.rejects(() => runAmuxV22OneShot({ ...investigate, modelId: "gpt 6" }, codex,
    { syntheticPlatform: true, spawnChild: fake.spawnChild }), /invalid v22 one-shot request/);
  // Cursor takes read roles only: implement is refused before any spawn.
  await assert.rejects(() => runAmuxV22OneShot(request, { ...config, provider: "cursor" },
    { syntheticPlatform: true, spawnChild: fake.spawnChild }), /invalid v22 one-shot request/);
  assert.equal(fake.calls.length, 1);
  // An MCP configuration beside Cursor stops the run before its CLI starts.
  const guarded = fakeSpawn(output);
  const blocked = await runAmuxV22OneShot({ ...request, role: "investigate" },
    { ...config, provider: "cursor" }, { syntheticPlatform: true,
      spawnChild: guarded.spawnChild, channelPreflight: () => "project_cli_config_present" });
  assert.equal(guarded.calls.length, 0);
  assert.deepEqual([blocked.kind, blocked.cliStarted, blocked.failure],
    ["failed", false, "project_cli_config_present"]);
  const claudeOnly = fakeSpawn(output);
  await assert.rejects(() => runAmuxV22OneShot({ ...request, role: "investigate" },
    { ...config, provider: "cursor" },
    { syntheticPlatform: true, spawnChild: claudeOnly.spawnChild, channelPreflight: () => null,
      createRunHome: async (_provider, value) => ({ config: value, cleanup: async () => {} }) }).then((value) => {
    // The request is valid for Cursor (any model name); a Claude JSON result
    // has no Cursor terminal event, so the run is unknown, not failed.
    assert.equal(value.kind, "outcome_unknown");
    throw new Error("checked");
  }), /checked/);
});
