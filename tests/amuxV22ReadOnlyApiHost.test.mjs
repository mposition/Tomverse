import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, open as openFile, rm,
  writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createAmuxV22ReadOnlyApiHost,
  amuxV22ReadOnlyApiCredentialMetadataDigest,
  inspectAmuxV22ReadOnlyApiLauncher, inspectAmuxV22ReadOnlyApiStateDirectory,
  readAmuxV22ReadOnlyApiLauncherState } from "../lib/amux/v22ReadOnlyApiHost.mjs";
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
    const syntheticOpen = async (path, flags) => {
      const handle = await openFile(path, flags);
      const stat = handle.stat.bind(handle);
      handle.stat = async () => {
        const info = await stat();
        info.mode = (info.mode & ~0o777) | 0o600;
        return info;
      };
      return handle;
    };
    const host = await createAmuxV22ReadOnlyApiHost(environment, { uid, now,
      testOnly: true, hostDeadlineAtMs: now + 600_000,
      serviceConfigDigest: "d".repeat(64), rootProtectedPath: async () => true,
      lstat: syntheticLstat, open: syntheticOpen,
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
    const mismatchedScope = { ...launchScope, launcherConfigDigest: "0".repeat(64) };
    await assert.rejects(runAmuxV22ReadOnlyApiOneShot({ ...request,
      readOnlyRetry: { ...binding, launcherConfigDigest: "0".repeat(64),
        launchScopeDigest: amuxV22ReadOnlyApiLaunchScopeDigest(mismatchedScope) } }, host),
    /invalid read-only API sidecar configuration/);
    assert.equal(fetches, 0, "a mismatched root proof must not reach the provider");
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
    snapshotDigest: "a".repeat(64), serviceConfigDigest: "d".repeat(64) };
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

test("default root reader measures fixed unit artifacts and returns metadata-only proof", async () => {
  const base = await mkdtemp(join(tmpdir(), "amux-api-root-reader-"));
  try {
    const files = {
      unit: join(process.cwd(), "scripts/systemd/amux-v22-read-only-api-sidecar@.service"),
      node: join(base, "node"), artifact: join(base, "sidecar.mjs"),
      environment: join(base, "profile.env"), profile: join(base, "profile.json"),
      repository: join(base, "repository"), processStatus: join(base, "status"),
      processCommand: join(base, "cmdline"), processEnvironment: join(base, "environ"),
    };
    await mkdir(files.repository);
    await writeFile(files.node, "fixed node artifact\n");
    await writeFile(files.artifact, "fixed sidecar artifact\n");
    const executorArtifactDigest = createHash("sha256")
      .update("fixed sidecar artifact\n").digest("hex");
    const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest({
      sourceRevision, allowedPrefixes: ["safe"],
    });
    const profile = { version: 1,
      credentialProfileId: "first-task-recovery-anthropic",
      provider: "anthropic", allowedProviderHost: "api.anthropic.com",
      keyOwner: "tomverse-amux-v22-api", keyMode: "0600",
      keyPath: "/etc/tomverse-amux-v22/read-only-api/first-task-recovery-anthropic.key",
      retentionClass: "operator-managed-dedicated-recovery", shared: false };
    const frame = { ...makeFrame(repositoryScopeDigest), executorArtifactDigest,
      credentialMetadataDigest: amuxV22ReadOnlyApiCredentialMetadataDigest(profile) };
    const environment = {
      TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED: "true",
      TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES: "true",
      TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED: "true",
      TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION: sourceRevision,
      TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON: JSON.stringify(["safe"]),
      TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON: JSON.stringify(frame),
      TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE:
        "/etc/tomverse-amux-v22/read-only-api/first-task-recovery-anthropic.key",
      TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_FILE:
        "/etc/tomverse-amux-v22/read-only-api/first-task-recovery-anthropic.profile.json",
      TOMVERSE_AMUX_V22_WORKER: worker,
      TOMVERSE_AMUX_V22_SIDECAR_SOCKET:
        `/run/tomverse-amux-v22-read-only-api-${worker}/task.sock`,
      TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR:
        `/var/lib/tomverse-amux-v22-read-only-api/${worker}`,
      TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT:
        "/srv/tomverse-amux-v22-read-only-api/repository",
      TOMVERSE_AMUX_V22_READ_ONLY_API_HOST_ENV_FILE:
        `/etc/tomverse-amux-v22/read-only-api@${worker}.env`,
    };
    await writeFile(files.environment, [
      "TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED=true",
      "TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES=true",
      "TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED=true",
      `TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION=${sourceRevision}`,
      `TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON='${JSON.stringify(["safe"])}'`,
      `TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON='${JSON.stringify(frame)}'`,
      `TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE=${environment.TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE}`,
      `TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_FILE=${environment.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_FILE}`,
      "",
    ].join("\n"));
    await writeFile(files.profile, `${JSON.stringify(profile)}\n`);
    const processStatus = groups => [
      "Name:\tnode", "Uid:\t1701\t1701\t1701\t1701",
      "Gid:\t1702\t1702\t1702\t1702",
      ...(groups === null ? [] : [`Groups:\t${groups}`]),
      "NoNewPrivs:\t1", "CapEff:\t0000000000000000", "",
    ].join("\n");
    await writeFile(files.processStatus, processStatus("1702"));
    await writeFile(files.processCommand, Buffer.from(
      "/usr/bin/node\0/opt/tomverse-amux-v22/read-only-api-sidecar.mjs\0"));
    await writeFile(files.processEnvironment, Buffer.from(
      `${Object.entries(environment).map(([name, value]) => `${name}=${value}`).join("\0")}\0`));
    const fixed = {
      "/etc/systemd/system/amux-v22-read-only-api-sidecar@.service": files.unit,
      "/usr/bin/node": files.node,
      "/opt/tomverse-amux-v22/read-only-api-sidecar.mjs": files.artifact,
      [`/etc/tomverse-amux-v22/read-only-api@${worker}.env`]: files.environment,
      [environment.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_FILE]: files.profile,
      "/srv/tomverse-amux-v22-read-only-api/repository": files.repository,
      "/proc/4242/status": files.processStatus,
      "/proc/4242/cmdline": files.processCommand,
      "/proc/4242/environ": files.processEnvironment,
    };
    const modes = new Map([
      [files.unit, 0o644], [files.node, 0o555], [files.artifact, 0o555],
      [files.environment, 0o644], [files.profile, 0o644],
      [files.repository, 0o755],
    ]);
    const mappedLstat = async path => {
      const target = fixed[path] ?? path;
      const info = await lstat(target);
      info.uid = 0;
      info.mode = (info.mode & ~0o777) | (modes.get(target) ?? 0o755);
      return info;
    };
    const mappedOpen = async (path, flags) => {
      const target = fixed[path] ?? path;
      const handle = await openFile(target, flags);
      const stat = handle.stat.bind(handle);
      handle.stat = async () => {
        const info = await stat();
        info.uid = 0;
        info.mode = (info.mode & ~0o777) | (modes.get(target) ?? 0o755);
        return info;
      };
      return handle;
    };
    const unit = { Id: `amux-v22-read-only-api-sidecar@${worker}.service`,
      LoadState: "loaded", ActiveState: "active", SubState: "running",
      MainPID: "4242", InvocationID: "a".repeat(32),
      User: "tomverse-amux-v22-api", Group: "amux-v22-ipc",
      ExecStart: "{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/tomverse-amux-v22/read-only-api-sidecar.mjs ; ignore_errors=no ; start_time=[n/a] ; }",
      EnvironmentFiles: `/etc/tomverse-amux-v22/read-only-api@${worker}.env`,
      FragmentPath: "/etc/systemd/system/amux-v22-read-only-api-sidecar@.service",
      DropInPaths: "", Restart: "no", RuntimeMaxUSec: "30min" };
    const inactiveCliUnit = {
      Id: `tomverse-amux-v22-sidecar@${worker}.service`, LoadState: "loaded",
      ActiveState: "inactive", SubState: "dead", MainPID: "0", Job: "",
    };
    let providerCalls = 0;
    const options = { testOnly: true, syntheticPlatform: true, now,
      showUnit: async () => ({ ...unit }),
      showInactiveCliUnit: async () => ({ ...inactiveCliUnit }),
      readlink: async () => "/usr/bin/node",
      createSnapshotManifest: async () => ({ gitProofDigest: "b".repeat(64),
        snapshotDigest: "a".repeat(64) }),
      inspectDedicatedCredential: async () => ({ identityDigest: "c".repeat(64) }),
      inspectApiStateDirectory: async () => "e".repeat(64),
      rootProtectedPath: async () => true, lstat: mappedLstat, open: mappedOpen,
      fetcher: async () => { providerCalls += 1; },
    };
    const state = await readAmuxV22ReadOnlyApiLauncherState(worker, frame, options);
    assert.equal(state.worker, worker);
    assert.match(state.serviceConfigDigest, /^[a-f0-9]{64}$/);
    assert.equal(Object.values(state).some(value => typeof value === "string" &&
      (value.includes("/etc/") || value.includes("4242"))), false);
    assert.equal(providerCalls, 0);
    const current = await inspectAmuxV22ReadOnlyApiLauncher(worker, frame, options);
    assert.equal(current.current, true);
    await writeFile(files.artifact, "drifted sidecar artifact\n");
    await assert.rejects(readAmuxV22ReadOnlyApiLauncherState(worker, frame, options),
      /executor artifact drift/);
    await writeFile(files.artifact, "fixed sidecar artifact\n");
    await writeFile(files.profile, `${JSON.stringify({ ...profile, shared: true })}\n`);
    await assert.rejects(readAmuxV22ReadOnlyApiLauncherState(worker, frame, options),
      /invalid dedicated credential metadata/);
    await writeFile(files.profile, `${JSON.stringify(profile)}\n`);
    await assert.rejects(readAmuxV22ReadOnlyApiLauncherState(worker, frame, {
      ...options, showUnit: async () => ({ ...unit,
        DropInPaths: "/etc/systemd/system/amux-v22-read-only-api-sidecar@.service.d/drift.conf" }),
    }), /unit state drift/);
    await assert.rejects(readAmuxV22ReadOnlyApiLauncherState(worker, frame, {
      ...options, showInactiveCliUnit: async () => ({ ...inactiveCliUnit,
        ActiveState: "active", SubState: "running", MainPID: "99" }),
    }), /not safely stopped/);
    await assert.rejects(readAmuxV22ReadOnlyApiLauncherState(worker, frame, {
      ...options, inspectApiStateDirectory: async () => {
        throw new TypeError("read-only API sidecar has other work");
      },
    }), /has other work/);
    for (const groups of [
      null, "1703", "1702 27", "1702 1702", "1702 invalid", "0", "01702",
    ]) {
      await writeFile(files.processStatus, processStatus(groups));
      await assert.rejects(readAmuxV22ReadOnlyApiLauncherState(worker, frame, options),
        /process group drift/, `unsafe process Groups state must fail closed: ${groups}`);
    }
    await writeFile(files.processStatus, processStatus("1702"));
    let processReads = 0;
    const processBasis = { uid: 1701, executable: "/usr/bin/node",
      argv: ["/usr/bin/node", "/opt/tomverse-amux-v22/read-only-api-sidecar.mjs"],
      environment: { ...environment } };
    await assert.rejects(readAmuxV22ReadOnlyApiLauncherState(worker, frame, {
      ...options, readProcessState: async () => processReads++ === 0
        ? { ...processBasis, gid: 1702, groups: [1702] }
        : { ...processBasis, gid: 1703, groups: [1703] },
    }), /launcher changed during inspection/,
    "the actual process group identity must remain stable across the proof");
    assert.throws(() => amuxV22ReadOnlyApiCredentialMetadataDigest({ ...profile,
      shared: true }), /invalid dedicated credential metadata/);
    assert.equal(providerCalls, 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a later launch proof accepts only completed model-access journals in the sidecar state", async () => {
  const dir = "/var/lib/tomverse-amux-v22-claude-investigate";
  const uid = 1234;
  const request = "00000000-0000-4000-8000-0000000000b1";
  const other = "00000000-0000-4000-8000-0000000000b2";
  const fake = (names, overrides = {}) => ({
    realpath: async (value) => value,
    readdir: async () => names,
    lstat: async (value) => {
      if (value === dir) return { isDirectory: () => true, isSymbolicLink: () => false,
        uid, mode: 0o40700, dev: 1, ino: 2, size: 4096, ctimeMs: 5 };
      const name = value.split(/[\\/]/).pop();
      return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid,
        mode: 0o100600, dev: 1, ino: name.length, size: 64, ctimeMs: 6,
        ...(overrides[name] ?? {}) };
    },
  });
  const empty = await inspectAmuxV22ReadOnlyApiStateDirectory(dir, uid, fake([]));
  assert.match(empty, /^[a-f0-9]{64}$/);
  const completed = [request + ".model-access-claimed", request + ".model-access-result"];
  const withJournal = await inspectAmuxV22ReadOnlyApiStateDirectory(dir, uid, fake(completed));
  assert.match(withJournal, /^[a-f0-9]{64}$/);
  assert.notEqual(withJournal, empty, "the digest still names what is on disk");
  for (const [label, names, overrides] of [
    ["claim without result", [request + ".model-access-claimed"]],
    ["result without claim", [request + ".model-access-result"]],
    ["temporary result", [...completed, request + ".model-access-result.tmp"]],
    ["attempt journal", [...completed, request + ".claimed"]],
    ["second request in flight", [...completed, other + ".model-access-claimed"]],
    ["foreign name", ["notes.txt"]],
    ["group-readable result", completed, { [completed[1]]: { mode: 0o100640 } }],
    ["linked result", completed, { [completed[1]]: { nlink: 2 } }],
    ["foreign owner", completed, { [completed[0]]: { uid: 0 } }],
    ["symbolic link", completed, { [completed[1]]: { isFile: () => false,
      isSymbolicLink: () => true } }],
  ])
    await assert.rejects(inspectAmuxV22ReadOnlyApiStateDirectory(dir, uid,
      fake(names, overrides)), /has other work/, label);
});

test("the real sidecar's model-access journal leaves a state a fresh launch proof accepts", {
  skip: process.platform !== "linux" ? "requires Linux file modes" : undefined,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-api-proof-state-"));
  try {
    await chmod(stateDir, 0o700);
    const uid = process.getuid();
    const request = { version: 1, requestId: "00000000-0000-4000-8000-0000000000b3",
      taskId: "c48886b9-86f8-4631-8db8-c0b288a707af",
      priorAttemptId: "97858395-3d66-42fa-9bfb-0e5a6cba39d8", worker,
      provider: "anthropic", selectedModelId: "claude-opus-5-5",
      launchProofId: "00000000-0000-4000-8000-0000000000b3",
      launchProofDigest: "1".repeat(64), apiExecutionFrameDigest: "2".repeat(64),
      credentialMetadataDigest: "3".repeat(64), launcherConfigDigest: "4".repeat(64) };
    const handler = createAmuxV22SidecarHandler({ worker, stateDir,
      run: async () => { throw new Error("paid path must remain closed"); },
      modelAccess: async () => { throw new Error("provider unavailable"); },
      protocolCapabilities: () => ["read_only_api_retry_v1"] });
    const result = await handler({ op: "api_model_access", ...request });
    assert.equal(result.access, "unknown");
    assert.match(await inspectAmuxV22ReadOnlyApiStateDirectory(stateDir, uid), /^[a-f0-9]{64}$/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
