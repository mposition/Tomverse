import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createAmuxV22ReadOnlyApiHost,
  inspectAmuxV22ReadOnlyApiLauncher } from "../lib/amux/v22ReadOnlyApiHost.mjs";
import { createAmuxV22SidecarHandler,
  runAmuxV22ReadOnlyApiOneShot } from "../lib/amux/v22OneShotSidecar.mjs";
import {
  AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiLaunchScopeDigest,
  amuxV22ReadOnlyApiRepositoryScopeDigest,
} from "../lib/amux/v22ReadOnlyApiProtocol.mjs";

const now = Date.parse("2026-10-13T01:00:00.000Z");
const worker = "claude-investigate";
const attemptId = "00000000-0000-4000-8000-000000000061";
const sourceRevision = "a".repeat(40);
const metadataDigest = "3".repeat(64);
const artifactDigest = "4".repeat(64);
const execFileAsync = promisify(execFile);
const gitBinary = process.platform === "win32" ?
  "C:\\Program Files\\Git\\mingw64\\bin\\git.exe" : "/usr/bin/git";
const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
const commitRepository = async root => {
  const run = args => execFileAsync(gitBinary,
    ["--no-pager", "-c", `core.hooksPath=${gitNullDevice}`,
      "-c", "commit.gpgSign=false", ...args], {
      cwd: root, windowsHide: true,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitNullDevice,
        GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" },
    });
  await run(["init", "--quiet"]);
  await run(["add", "--", "safe/finding.txt"]);
  await run(["-c", "user.name=AMUX Test", "-c", "user.email=amux@example.invalid",
    "commit", "--quiet", "-m", "snapshot"]);
  return (await run(["rev-parse", "HEAD"])).stdout.trim();
};

const makeFrame = repositoryScopeDigest => ({ version: 1,
  executorKind: "read_only_api_retry_v1", provider: "anthropic",
  modelId: "claude-opus-5-5", routeId: "recovery:anthropic",
  routePolicyDigest: "1".repeat(64), catalogApprovalId: "catalog:approved",
  catalogVersion: "catalog-v1", catalogDigest: "2".repeat(64),
  pricingVersion: "pricing-v1", pricingSource: "verified-record",
  pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
  pricingExpiresAt: "2026-10-20T00:00:00.000Z",
  uncachedInputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 100_000,
  cacheWriteMicroUsdPerMillion: 1_250_000,
  outputMicroUsdPerMillion: 5_000_000,
  tokenLimits: { uncachedInputTokens: 1_000, cacheReadTokens: 500,
    cacheWriteTokens: 500, outputTokens: 1_000 },
  maxProviderTurns: 8, maxOutputTokensPerTurn: 1_000, maxRetries: 0,
  maximumCostMicroUsd: 3_400_000,
  credentialProfileId: "first-task-recovery-anthropic",
  credentialMetadataDigest: metadataDigest, executorArtifactDigest: artifactDigest,
  settingsDigest: AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  repositoryScopeDigest,
  brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST });

test("dedicated API host advertises only a current frame and never enters the CLI path", async () => {
  const base = await mkdtemp(join(tmpdir(), "amux-api-host-"));
  try {
    const root = join(base, "repository");
    const keyFile = join(base, "dedicated.key");
    await mkdir(join(root, "safe"), { recursive: true });
    await writeFile(join(root, "safe", "finding.txt"), "approved source\n");
    const sourceRevision = await commitRepository(root);
    await writeFile(keyFile, "sk-ant-mock-only-never-sent");
    await chmod(keyFile, 0o600);
    const uid = (await lstat(keyFile)).uid;
    const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest({
      sourceRevision, allowedPrefixes: ["safe"],
    });
    const frame = makeFrame(repositoryScopeDigest);
    let fetches = 0;
    const environment = {
      TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED: "true",
      TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES: "true",
      TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED: "true",
      TOMVERSE_AMUX_V22_WORKER: worker,
      TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT: root,
      TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION: sourceRevision,
      TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON: JSON.stringify(["safe"]),
      TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON: JSON.stringify(frame),
      TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE: keyFile,
    };
    const syntheticLstat = async path => {
      const info = await lstat(path);
      info.mode = (info.mode & ~0o777) | 0o600;
      return info;
    };
    const host = await createAmuxV22ReadOnlyApiHost(environment, { uid, now,
      testOnly: true, hostDeadlineAtMs: now + 600_000,
      lstat: syntheticLstat,
      clock: () => now, fetcher: async url => {
        fetches += 1;
        if (url === AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL)
          return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 });
        return new Response(JSON.stringify({ type: "message", role: "assistant",
          model: frame.modelId, content: [{ type: "text", text: "mock finding" }],
          stop_reason: "end_turn", usage: { input_tokens: 10,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            output_tokens: 10 } }), { status: 200 });
      } });
    assert.deepEqual(host.capabilities(), ["read_only_api_retry_v1"]);
    const launchScope = { version: 1, executorKind: "read_only_api_retry_v1",
      launcherConfigDigest: host.launcherConfigDigest,
      apiExecutionFrameDigest: host.apiExecutionFrameDigest };
    const binding = { version: 1, executorKind: "read_only_api_retry_v1",
      launchBindingId: "00000000-0000-4000-8000-000000000062",
      riskAcceptanceDigest: "5".repeat(64), safeStopEvidenceDigest: "6".repeat(64),
      launchProofDigest: "7".repeat(64),
      launchScopeDigest: amuxV22ReadOnlyApiLaunchScopeDigest(launchScope),
      launcherConfigDigest: host.launcherConfigDigest,
      apiExecutionFrame: frame, apiExecutionFrameDigest: host.apiExecutionFrameDigest,
      briefDigest: "8".repeat(64), provider: frame.provider, modelId: frame.modelId,
      routeId: frame.routeId, routePolicyDigest: frame.routePolicyDigest,
      catalogApprovalId: frame.catalogApprovalId, catalogVersion: frame.catalogVersion,
      pricingVersion: frame.pricingVersion, costReceiptDigest: "9".repeat(64),
      additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
      role: "investigate" };
    const request = { version: 1, attemptId, worker, modelId: frame.modelId,
      role: "investigate", budgetMicrousd: 3_400_000,
      prompt: "Inspect only the approved source.", readOnlyRetry: binding,
      recoveryBinding: { version: 1,
        taskId: "c48886b9-86f8-4631-8db8-c0b288a707af", taskRevision: 4,
        attemptId, workerName: worker,
        workerInstanceId: "00000000-0000-4000-8000-000000000063",
        workerGeneration: 1, targetHost: "amux-ubuntu",
        recoveryApprovalId: "00000000-0000-4000-8000-000000000064",
        briefDigest: binding.briefDigest } };
    const result = await runAmuxV22ReadOnlyApiOneShot(request, host);
    assert.equal(result.kind, "succeeded");
    assert.equal(result.cliStarted, false);
    assert.equal(result.resultText, "mock finding");
    assert.equal(result.apiExecutionReceipt.digest.length, 64);
    assert.equal(result.apiExecutionReceipt.apiExecutionFrameDigest,
      amuxV22ReadOnlyApiExecutionFrameDigest(frame));
    assert.equal(fetches, 2);

    const handler = createAmuxV22SidecarHandler({ worker,
      stateDir: join(base, "state"), run: async () => result,
      protocolCapabilities: host.capabilities });
    assert.deepEqual(await handler({ op: "protocol", worker,
      requestId: "00000000-0000-4000-8000-000000000065" }), {
      kind: "protocol", worker,
      requestId: "00000000-0000-4000-8000-000000000065",
      capabilities: ["read_only_api_retry_v1"],
    });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("API host stays closed for default-off, shared env credentials and in-root key files", async () => {
  const base = await mkdtemp(join(tmpdir(), "amux-api-host-closed-"));
  try {
    const root = join(base, "repository");
    await mkdir(join(root, "safe"), { recursive: true });
    await writeFile(join(root, "safe", "finding.txt"), "approved source\n");
    const sourceRevision = await commitRepository(root);
    const keyFile = join(root, "key");
    await writeFile(keyFile, "sk-ant-mock-only-never-sent");
    await chmod(keyFile, 0o600);
    const uid = (await lstat(keyFile)).uid;
    const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest({
      sourceRevision, allowedPrefixes: ["safe"],
    });
    const baseEnvironment = {
      TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED: "true",
      TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES: "true",
      TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED: "true",
      TOMVERSE_AMUX_V22_WORKER: worker,
      TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT: root,
      TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION: sourceRevision,
      TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON: JSON.stringify(["safe"]),
      TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON:
        JSON.stringify(makeFrame(repositoryScopeDigest)),
      TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE: keyFile,
    };
    let fetches = 0;
    for (const change of [
      { TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED: "false" },
      { ANTHROPIC_API_KEY: "shared-forbidden" },
      { ENGINEERING_AGENT_ANTHROPIC_API_KEY: "shared-forbidden" },
      { DATABASE_URL: "shared-forbidden" },
      { NODE_OPTIONS: "--import=unapproved" },
      {},
    ]) await assert.rejects(createAmuxV22ReadOnlyApiHost({ ...baseEnvironment, ...change },
      { uid, now, testOnly: true, hostDeadlineAtMs: now + 600_000,
        clock: () => now, fetcher: async () => { fetches += 1; } }));
    assert.equal(fetches, 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("root API preflight binds only verified non-secret metadata and frame digest", async () => {
  const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest({
    sourceRevision, allowedPrefixes: ["safe"],
  });
  const frame = makeFrame(repositoryScopeDigest);
  const frameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(frame);
  const state = { worker, enabled: true, operationalGatesSatisfied: true,
    credentialDedicated: true, apiExecutionFrameDigest: frameDigest,
    credentialProfileId: frame.credentialProfileId,
    credentialMetadataDigest: frame.credentialMetadataDigest,
    executorArtifactDigest: frame.executorArtifactDigest,
    settingsDigest: frame.settingsDigest,
    repositoryScopeDigest: frame.repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest,
    gitProofDigest: "b".repeat(64),
    snapshotDigest: "a".repeat(64) };
  const current = await inspectAmuxV22ReadOnlyApiLauncher(worker, frame,
    { now, readApiLauncherState: async () => state });
  assert.equal(current.current, true);
  assert.match(current.launcherConfigDigest, /^[a-f0-9]{64}$/);
  const changedGitProof = await inspectAmuxV22ReadOnlyApiLauncher(worker, frame,
    { now, readApiLauncherState: async () => ({ ...state,
      gitProofDigest: "c".repeat(64) }) });
  assert.equal(changedGitProof.current, true);
  assert.notEqual(changedGitProof.launcherConfigDigest, current.launcherConfigDigest,
    "the protected Git binary, root, and command proof must change the host digest");
  assert.deepEqual(await inspectAmuxV22ReadOnlyApiLauncher(worker, frame,
    { now, readApiLauncherState: async () => ({ ...state,
      apiExecutionFrameDigest: "0".repeat(64) }) }), { current: false });
});
