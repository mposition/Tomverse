import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amuxCliUsageReceiptDigest } from "../lib/amux/cliUsageLedgerCore.ts";
import { createAmuxV22SidecarHandler } from "../lib/amux/v22OneShotSidecar.mjs";
import { parseAmuxV22RecoveryInspectionRequest, runAmuxV22RecoveryCheckerOnce,
  inspectAmuxV22RecoveryUnit, readAmuxV22RecoveryJournal } from "../lib/amux/v22RecoveryHost.mjs";

const attemptId = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000002";
const binding = { version: 1, taskId: "task-1", taskRevision: 4,
  workerInstanceId: instanceId, workerGeneration: 3, targetHost: "amux-ubuntu" };
const execute = { op: "execute", version: 1, attemptId, worker: "claude-chore",
  role: "review", modelId: "claude-opus-5-5", budgetMicrousd: 3_400_000,
  prompt: "Private synthetic prompt", recoveryBinding: binding };
const request = { inspectionId: "00000000-0000-4000-8000-000000000003",
  taskId: binding.taskId, taskRevision: binding.taskRevision + 1,
  priorAttemptTaskRevision: binding.taskRevision, priorAttemptId: attemptId,
  workerName: execute.worker, workerInstanceId: instanceId, workerGeneration: 3,
  targetHost: "amux-ubuntu", requestDigest: "a".repeat(64),
  requestedAt: "2026-10-13T00:00:00.000Z" };
const invocationId = "b".repeat(32);
const unitProof = { rootOwnedUnit: true, controlGroupBound: true, processTreeStopped: true };
const syntheticJournal = path => readFile(path, "utf8").catch(() => null);
async function finished(handler) {
  for (let count = 0; count < 100; count += 1) {
    if ((await handler({ op: "readback", attemptId })).kind !== "in_progress") return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("synthetic terminal was not durable");
}
test("fixed inspection refuses paths, commands and foreign worker bindings", () => {
  assert.deepEqual(parseAmuxV22RecoveryInspectionRequest(request, execute.worker), request);
  for (const extra of [{ path: "/etc/passwd" }, { command: "systemctl restart" },
    { workerName: "another-worker" }, { targetHost: "other-host" }])
    assert.throws(() => parseAmuxV22RecoveryInspectionRequest({ ...request, ...extra }, execute.worker));
});
test("only current live invocation terminal and exact local binding prove stopped", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-recovery-host-"));
  try {
    let runs = 0;
    const handler = createAmuxV22SidecarHandler({ worker: execute.worker, stateDir,
      invocationId, recoveryUnit: async () => unitProof, recoveryJournal: syntheticJournal,
      run: async () => { runs += 1; return { kind: "failed", attemptId,
        resultText: "Private output", cliStarted: true }; } });
    await handler(execute); await finished(handler);
    const evidence = await handler({ op: "inspect_recovery", ...request });
    assert.equal(evidence.reason, "stopped_proven");
    assert.equal(evidence.hostInvocationId, invocationId);
    assert.equal(evidence.proof.sameLiveInvocation, true);
    assert.equal(evidence.proof.noActiveExecution, true);
    assert.equal(evidence.usage.status, "unknown");
    assert.equal(evidence.usage.projectedCostMicroUsd, null);
    assert.equal(runs, 1);
    for (const secret of [execute.prompt, "Private output", stateDir, "resultText", "usageReceipt"])
      assert.equal(JSON.stringify(evidence).includes(secret), false);
    assert.equal(JSON.parse(await readFile(join(stateDir, `${attemptId}.result`), "utf8"))
      .recovery.invocationId, invocationId);
    const restarted = createAmuxV22SidecarHandler({ worker: execute.worker, stateDir,
      invocationId: "c".repeat(32), recoveryUnit: async () => unitProof,
      recoveryJournal: syntheticJournal, run: async () => { runs += 1; } });
    assert.equal((await restarted({ op: "inspect_recovery", ...request })).reason, "legacy_invocation_unbound");
    assert.equal((await handler({ op: "inspect_recovery", ...request, workerGeneration: 4 })).reason,
      "legacy_invocation_unbound");
    assert.equal((await handler({ op: "inspect_recovery", ...request,
      workerInstanceId: "00000000-0000-4000-8000-000000000099" })).reason,
      "legacy_invocation_unbound");
    assert.equal((await handler({ op: "inspect_recovery", ...request,
      priorAttemptTaskRevision: 3 })).reason, "legacy_invocation_unbound");
    assert.equal(runs, 1);
    const terminalPath = join(stateDir, `${attemptId}.result`);
    const terminal = JSON.parse(await readFile(terminalPath, "utf8"));
    terminal.usageReceipt = { completeness: "reported_complete", projectedCostMicrousd: "0" };
    await writeFile(terminalPath, JSON.stringify(terminal));
    assert.equal((await handler({ op: "inspect_recovery", ...request })).reason,
      "legacy_invocation_unbound", "journal tampering never changes the current handler's terminal fact");
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
test("active, claim-only, legacy and terminal success never permit retry", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-recovery-active-"));
  let release;
  try {
    const gate = new Promise(resolve => { release = resolve; });
    const handler = createAmuxV22SidecarHandler({ worker: execute.worker, stateDir,
      invocationId, recoveryUnit: async () => unitProof, recoveryJournal: syntheticJournal,
      run: async () => { await gate; return { kind: "succeeded", attemptId }; } });
    await handler(execute);
    const active = await handler({ op: "inspect_recovery", ...request });
    assert.equal(active.proof.noActiveExecution, false);
    assert.notEqual(active.reason, "stopped_proven");
    release(); await finished(handler);
    assert.equal((await handler({ op: "inspect_recovery", ...request })).reason, "terminal_success");
    await writeFile(join(stateDir, `${attemptId}.result`), JSON.stringify({ kind: "failed", attemptId }));
    assert.equal((await handler({ op: "inspect_recovery", ...request })).reason, "legacy_invocation_unbound");
  } finally { release?.(); await rm(stateDir, { recursive: true, force: true }); }
});
test("a claim-only orphan is unknown even when the current service has no child", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-recovery-orphan-"));
  try {
    await writeFile(join(stateDir, `${attemptId}.claimed`), `${"a".repeat(64)}\n`);
    let runs = 0;
    const handler = createAmuxV22SidecarHandler({ worker: execute.worker, stateDir,
      invocationId, recoveryJournal: syntheticJournal, recoveryUnit: async () => unitProof,
      run: async () => { runs += 1; } });
    const result = await handler({ op: "inspect_recovery", ...request });
    assert.equal(result.proof.noActiveExecution, true);
    assert.equal(result.proof.sameLiveInvocation, false);
    assert.equal(result.reason, "legacy_invocation_unbound"); assert.equal(runs, 0);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
test("complete local receipt remains complete while unobserved price is null and raw counts stay local", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-recovery-usage-"));
  try {
    const receipt = { version: 1, invocationId: attemptId,
      binding: { kind: "task_attempt", attemptId }, worker: execute.worker,
      cli: "claude", provider: "anthropic", selectedModelId: "claude-opus-5-5",
      actualModelId: "claude-opus-5-5", cliVersion: null, authentication: "unknown",
      startedAt: "2026-10-13T00:00:00.000Z", endedAt: "2026-10-13T00:01:00.000Z",
      status: "failed", completeness: "reported_complete", source: "claude_result",
      observed: { inputTokens: 7, outputTokens: 11, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, reasoningOutputTokens: null }, inputTokensIncludeCacheRead: false,
      inputTokensIncludeCacheWrite: false, reasoningOutputIncludedInOutput: null, completedTurns: 1 };
    const handler = createAmuxV22SidecarHandler({ worker: execute.worker, stateDir,
      invocationId, recoveryJournal: syntheticJournal, recoveryUnit: async () => unitProof,
      run: async () => ({ kind: "failed", attemptId, usageReceipt: receipt,
        usageReceiptDigest: amuxCliUsageReceiptDigest(receipt) }) });
    await handler(execute); await finished(handler);
    const result = await handler({ op: "inspect_recovery", ...request });
    assert.deepEqual(result.usage, { status: "reported_complete", projectedCostMicroUsd: null });
    assert.equal(JSON.stringify(result).includes("inputTokens"), false);
    assert.equal(JSON.stringify(result).includes("outputTokens"), false);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
test("checker is off by default, pulls once, uses a fixed socket and never retries unknown POST", async () => {
  const config = { workerName: execute.worker, socketPath: "/run/amux-v22/claude-chore/worker.sock",
    internalUrl: "https://tomverse.example", syncSecret: "x".repeat(32) };
  let calls = 0, sockets = 0;
  const dependencies = { fetcher: async (_url, init) => {
    calls += 1;
    if (init.method === "POST") throw new Error("unknown post");
    return Response.json({ requests: [request] });
  }, inspectSocket: async (path, body) => {
    sockets += 1; assert.equal(path, config.socketPath); assert.equal(body.op, "inspect_recovery");
    const identity = { ...request }; delete identity.requestedAt;
    return { ...identity, evidenceId: "00000000-0000-4000-8000-000000000004", hostInvocationId: null,
      proof: { terminalOutcome: "unknown", sameLiveInvocation: false, noActiveExecution: false,
        ...unitProof, journalBound: false, socketTerminal: false,
        externalEffectsKnown: false, workspaceClean: false },
      usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "legacy_invocation_unbound" };
  } };
  assert.deepEqual(await runAmuxV22RecoveryCheckerOnce(config, dependencies), { state: "disabled" });
  assert.equal(calls, 0);
  assert.deepEqual(await runAmuxV22RecoveryCheckerOnce({ ...config, enabled: "1" }, dependencies),
    { state: "outcome_unknown" });
  assert.equal(calls, 2); assert.equal(sockets, 1);
});
test("unit proof fails closed on missing protected scope without executing a service mutation", async () => {
  const result = await inspectAmuxV22RecoveryUnit({ worker: execute.worker, invocationId },
    { platform: "win32" });
  assert.deepEqual(result, { rootOwnedUnit: false, controlGroupBound: false, processTreeStopped: false });
});
test("fixed unit and complete cgroup proof reject children, foreign units and writable ancestors", async () => {
  const unit = "tomverse-amux-v22-sidecar@claude-chore.service";
  const properties = { InvocationID: invocationId, ControlGroup: `/system.slice/${unit}`,
    MainPID: "123", KillMode: "control-group", Delegate: "no",
    FragmentPath: "/etc/systemd/system/tomverse-amux-v22-sidecar@.service",
    DropInPaths: `/etc/systemd/system/${unit}.d/override.conf`, ActiveState: "active", SubState: "running" };
  const config = { worker: execute.worker, invocationId };
  const options = { platform: "linux", pid: 123,
    run: async (binary, args) => { assert.equal(binary, "/usr/bin/systemctl");
      assert.equal(args[0], "show"); assert.equal(args[1], unit);
      return { stdout: Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n") }; },
    stat: async () => ({ uid: 0, mode: 0o755, isSymbolicLink: () => false,
      isDirectory: () => true, isFile: () => true }),
    read: async path => path === "/proc/self/cgroup" ? `0::/system.slice/${unit}\n` : "123\n",
    list: async () => [] };
  assert.deepEqual(await inspectAmuxV22RecoveryUnit(config, options), unitProof);
  const direct = properties.ControlGroup;
  properties.ControlGroup = `/system.slice/system-tomverse\\x2damux\\x2dv22\\x2dsidecar.slice/${unit}`;
  assert.deepEqual(await inspectAmuxV22RecoveryUnit(config, { ...options,
    read: async path => path === "/proc/self/cgroup" ? `0::${properties.ControlGroup}\n` : "123\n" }), unitProof);
  properties.ControlGroup = direct;
  const children = await inspectAmuxV22RecoveryUnit(config, { ...options,
    read: async path => path === "/proc/self/cgroup" ? `0::/system.slice/${unit}\n` : "123\n456\n" });
  assert.equal(children.processTreeStopped, false);
  for (const key of ["Delegate", "KillMode", "InvocationID", "ControlGroup", "FragmentPath"]) {
    const before = properties[key]; properties[key] = "foreign";
    assert.equal((await inspectAmuxV22RecoveryUnit(config, options)).processTreeStopped, false);
    properties[key] = before;
  }
  for (const unsafe of [{ uid: 1000 }, { mode: 0o777 }, { isSymbolicLink: () => true }])
    assert.equal((await inspectAmuxV22RecoveryUnit(config, { ...options,
      stat: async path => ({ ...await options.stat(path), ...(path === "/etc/systemd" ? unsafe : {}) }) }))
      .rootOwnedUnit, false);
  assert.equal((await inspectAmuxV22RecoveryUnit(config, { ...options,
    stat: async path => ({ ...await options.stat(path), isFile: () => false }) })).rootOwnedUnit, false);
});
test("journal proof requires owner, file type, bounds, current ctime and a stable opened inode", async () => {
  const info = { uid: 12, nlink: 1, mode: 0o600, size: 3, ctimeMs: 200,
    dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false };
  const options = { stat: async () => info,
    open: async () => ({ stat: async () => info, close: async () => {},
      read: async buffer => { Buffer.from("abc").copy(buffer); return { bytesRead: 3 }; } }) };
  assert.equal(await readAmuxV22RecoveryJournal("/fixed/journal", 65, 12, 100, options), "abc");
  for (const unsafe of [{ uid: 13 }, { nlink: 2 }, { mode: 0o622 }, { size: 66 },
    { ctimeMs: 99 }, { isFile: () => false }, { isSymbolicLink: () => true }])
    assert.equal(await readAmuxV22RecoveryJournal("/fixed/journal", 65, 12, 100,
      { ...options, stat: async () => ({ ...info, ...unsafe }) }), null);
  assert.equal(await readAmuxV22RecoveryJournal("/fixed/journal", 65, 12, 100,
    { ...options, open: async () => ({ ...await options.open(), stat: async () => ({ ...info, ino: 3 }) }) }), null);
});
