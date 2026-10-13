import assert from "node:assert/strict";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { amuxV22RecoveryDigest, amuxV22SafeStopEvidenceSchema } from "../lib/amux/v22TaskRecoveryCore.ts";
import { AMUX_V22_RECOVERY_INTENT_DIR, bindAmuxV22StopIntent,
  executeAmuxV22SafeStop, inspectAmuxV22SafeStopCgroupEmpty, inspectAmuxV22SafeStopUnit,
  parseAmuxV22RecoveryProfiles, parseAmuxV22SafeStopRequest,
  runAmuxV22RecoveryControllerOnce } from "../lib/amux/v22RecoveryController.mjs";

const profileConfig = { version: 1, profiles: [
  { alias: "claude-maintenance", workerNames: ["claude-chore", "claude-security"] },
] };
const profileConfigDigest = amuxV22RecoveryDigest("worker-profile-config", profileConfig);
const request = { inspectionId: "00000000-0000-4000-8000-000000000001", requestKind: "safe_stop",
  requestDigest: "a".repeat(64), taskId: "task-1", taskRevision: 5,
  priorAttemptId: "00000000-0000-4000-8000-000000000002", priorAttemptTaskRevision: 4,
  workerName: "claude-chore", workerInstanceId: "00000000-0000-4000-8000-000000000003",
  workerGeneration: 7, targetHost: "amux-ubuntu",
  sourceEvidenceId: "00000000-0000-4000-8000-000000000004",
  sourceEvidenceDigest: "b".repeat(64), workerProfileAlias: "claude-maintenance",
  profileWorkerNames: ["claude-chore", "claude-security"],
  targetUnit: "tomverse-amux-v22-sidecar@claude-maintenance.service",
  profileConfigDigest, requestedAt: "2026-10-13T01:02:03.000Z" };
const bootId = "11111111-2222-3333-4444-555555555555";
const capturedControlGroup = `/system.slice/${request.targetUnit}`;
const activeCapture = { bootId, controlGroup: capturedControlGroup, invocationId: "c".repeat(32) };
const bindingBasis = value => ({ taskId: value.taskId, priorAttemptId: value.priorAttemptId,
  workerProfileAlias: value.workerProfileAlias, targetUnit: value.targetUnit });
const intentFor = (value, capture = activeCapture) => {
  const journalBindingDigest = amuxV22RecoveryDigest("stop-journal-binding", bindingBasis(value));
  const basis = { version: 2, journalBindingDigest, ...bindingBasis(value), targetHost: value.targetHost,
    profileConfigDigest: value.profileConfigDigest, bootId: capture.bootId,
    capturedControlGroup: capture.controlGroup, capturedInvocationId: capture.invocationId };
  return { ...basis, journalEntryDigest: amuxV22RecoveryDigest("stop-journal-entry", basis) };
};
const unitState = (active = true) => ({ Id: request.targetUnit, LoadState: "loaded",
  InvocationID: active ? activeCapture.invocationId : "", ControlGroup: active ? capturedControlGroup : "",
  MainPID: active ? "4321" : "0", KillMode: "control-group", Delegate: "no", Restart: "no",
  FragmentPath: "/etc/systemd/system/tomverse-amux-v22-sidecar@.service", DropInPaths: "",
  ActiveState: active ? "active" : "inactive", SubState: active ? "running" : "dead" });
const inspected = state => ({ state, fixedUnit: true, rootOwnedConfig: true,
  controlGroupBound: state.ControlGroup === capturedControlGroup, restartDisabled: true });
const baseOptions = overrides => ({ platform: "linux",
  readProfiles: async () => ({ value: profileConfig, digest: profileConfigDigest }),
  readBootId: async () => bootId,
  bindIntent: async (value, capture) => ({ entry: intentFor(value, capture),
    disposition: "intent_recorded", mayStop: true }),
  cgroupEmpty: async () => true, now: (() => { let value = 0; return () => value += 10; })(),
  ...overrides });

test("safe-stop request and profile parsers reject commands, paths, aliases and collisions", () => {
  assert.deepEqual(parseAmuxV22SafeStopRequest(request), request);
  for (const extra of [{ command: "restart" }, { path: "/etc/passwd" },
    { targetUnit: "tomverse-amux-v22-sidecar@other.service" }, { workerName: "other" },
    { profileWorkerNames: ["claude-security", "claude-chore"] }])
    assert.throws(() => parseAmuxV22SafeStopRequest({ ...request, ...extra }));
  assert.deepEqual(parseAmuxV22RecoveryProfiles(profileConfig).value, profileConfig);
  assert.throws(() => parseAmuxV22RecoveryProfiles({ version: 1, profiles: [
    { alias: "one", workerNames: ["shared"] }, { alias: "two", workerNames: ["shared"] },
  ] }), /profile not unique/);
});

test("synthetic show verifies fixed argv, effective restart and every protected fragment parent", async () => {
  const dropIn = `/etc/systemd/system/${request.targetUnit}.d/10-recovery.conf`;
  const state = { ...unitState(true), DropInPaths: dropIn };
  const calls = [];
  const directory = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
    uid: 0, mode: 0o40755, nlink: 1, size: 0 };
  const file = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true,
    uid: 0, mode: 0o100644, nlink: 1, size: 100 };
  const run = async (command, args) => { calls.push([command, args]);
    return { stdout: `${Object.entries(state).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, stderr: "" }; };
  const lstat = async path => path.endsWith(".service") || path.endsWith(".conf") ? file : directory;
  const verified = await inspectAmuxV22SafeStopUnit(request.targetUnit,
    { platform: "linux", run, lstat });
  assert.equal(verified.fixedUnit, true); assert.equal(verified.rootOwnedConfig, true);
  assert.equal(verified.controlGroupBound, true); assert.equal(verified.restartDisabled, true);
  assert.deepEqual(calls[0], ["/usr/bin/systemctl", ["show", request.targetUnit,
    "--property=Id,LoadState,InvocationID,ControlGroup,MainPID,KillMode,Delegate,Restart,FragmentPath,DropInPaths,ActiveState,SubState",
    "--no-pager"]]);
  const foreignParent = await inspectAmuxV22SafeStopUnit(request.targetUnit, { platform: "linux", run,
    lstat: async path => path === "/etc/systemd" ? { ...directory, uid: 1000 } : lstat(path) });
  assert.equal(foreignParent.rootOwnedConfig, false);
  const restarting = await inspectAmuxV22SafeStopUnit(request.targetUnit, { platform: "linux",
    run: async () => ({ stdout: `${Object.entries({ ...state, Restart: "on-failure" })
      .map(([key, value]) => `${key}=${value}`).join("\n")}\n`, stderr: "" }), lstat });
  assert.equal(restarting.restartDisabled, false);
  const stopped = unitState(false);
  const inactive = await inspectAmuxV22SafeStopUnit(request.targetUnit, { platform: "linux",
    run: async () => ({ stdout: `${Object.entries(stopped)
      .map(([key, value]) => `${key}=${value}`).join("\n")}\n`, stderr: "" }), lstat });
  assert.equal(inactive.fixedUnit, true); assert.equal(inactive.controlGroupBound, false);
});

test("synthetic captured cgroup proof recursively distinguishes empty and present descendants", async () => {
  const group = `/system.slice/${request.targetUnit}`;
  const directory = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
    uid: 0, mode: 0o40755, nlink: 1, size: 0 };
  const child = { name: "child.scope", isSymbolicLink: () => false, isDirectory: () => true };
  const options = { lstat: async () => directory,
    readdir: async path => path.endsWith(request.targetUnit) ? [child] : [],
    readText: async () => "" };
  assert.equal(await inspectAmuxV22SafeStopCgroupEmpty(group, request.targetUnit, options), true);
  assert.equal(await inspectAmuxV22SafeStopCgroupEmpty(group, request.targetUnit,
    { ...options, readText: async path => path.endsWith("child.scope/cgroup.procs") ? "4321\n" : "" }), false);
});

test("one recorded intent issues only the fixed systemctl stop argv and proves the process gone", async () => {
  const states = [unitState(true), unitState(false), unitState(false)]; const calls = [];
  const report = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async unit => { assert.equal(unit, request.targetUnit); return inspected(states.shift()); },
    run: async (...args) => { calls.push(args); return { stdout: "", stderr: "" }; },
  }));
  assert.equal(report.reason, "safe_stop_process_gone");
  assert.equal(report.stopProof.stopAcknowledgement, "acknowledged");
  assert.equal(report.stopProof.processState, "gone");
  assert.equal(report.stopProof.journalBound, true);
  assert.equal(amuxV22SafeStopEvidenceSchema.safeParse(report).success, true);
  assert.deepEqual(calls.map(([file, args]) => [file, args]),
    [["/usr/bin/systemctl", ["stop", request.targetUnit]]]);
  assert.deepEqual(report.modelOutcome, "unknown");
  assert.deepEqual(report.usage, { status: "unknown", projectedCostMicroUsd: null });
  for (const forbidden of ["4321", "/system.slice", "stderr", "Private output"])
    assert.equal(JSON.stringify(report).includes(forbidden), false);
});

test("unknown or reused intent never reissues stop", async () => {
  let stops = 0;
  const unknown = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(unitState(true)), bindIntent: async () => { throw new Error("partial"); },
    stopUnit: async () => { stops += 1; },
  }));
  assert.equal(unknown.reason, "safe_stop_journal_unverified"); assert.equal(stops, 0);
  const states = [unitState(true), unitState(true), unitState(true)];
  const reused = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(states.shift()),
    bindIntent: async value => ({ entry: intentFor(value), disposition: "intent_reused", mayStop: false }),
    cgroupEmpty: async () => false, stopUnit: async () => { stops += 1; },
  }));
  assert.equal(reused.reason, "safe_stop_process_present");
  assert.equal(reused.stopProof.stopAcknowledgement, "outcome_unknown"); assert.equal(stops, 0);
});

test("a mismatched profile alias closes as non-unique after read-only unit verification and never stops", async () => {
  let stops = 0;
  const report = await executeAmuxV22SafeStop(request, baseOptions({
    readProfiles: async () => ({ value: { version: 1, profiles: [
      { alias: "another-profile", workerNames: ["claude-chore", "claude-security"] },
    ] }, digest: profileConfigDigest }),
    inspectUnit: async () => inspected(unitState(true)), stopUnit: async () => { stops += 1; },
  }));
  assert.equal(report.reason, "safe_stop_profile_not_unique");
  assert.equal(report.stopProof.fixedUnit, true); assert.equal(report.stopProof.restartDisabled, true);
  assert.equal(report.stopProof.profileUnique, false); assert.equal(stops, 0);
});

test("a lost stop acknowledgement remains separate from fresh kernel proof", async () => {
  const states = [unitState(true), unitState(false), unitState(false)];
  const report = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(states.shift()),
    stopUnit: async () => { throw new Error("ack lost after stop"); },
  }));
  assert.equal(report.reason, "safe_stop_process_gone");
  assert.equal(report.stopProof.stopAcknowledgement, "outcome_unknown");
  assert.equal(report.stopProof.processState, "gone");
});

test("concurrent consumers share one durable binding and issue stop at most once", async () => {
  let stored, alive = true, stops = 0;
  const bindIntent = async (value, capture) => {
    if (!stored) {
      stored = intentFor(value, capture);
      return { entry: stored, disposition: "intent_recorded", mayStop: true };
    }
    return { entry: stored, disposition: "intent_reused", mayStop: false };
  };
  const options = baseOptions({ bindIntent,
    inspectUnit: async () => inspected(unitState(alive)),
    stopUnit: async unit => { assert.equal(unit, request.targetUnit); stops += 1; alive = false; },
  });
  const first = await executeAmuxV22SafeStop(request, options);
  const second = await executeAmuxV22SafeStop({ ...request,
    inspectionId: "00000000-0000-4000-8000-000000000009", requestDigest: "d".repeat(64) }, options);
  assert.equal(first.reason, "safe_stop_process_gone"); assert.equal(second.reason, "safe_stop_process_gone");
  assert.equal(second.stopProof.journalDisposition, "intent_reused"); assert.equal(stops, 1);
});

test("inactive empty ControlGroup recheck uses only the boot-bound captured journal cgroup and issues stop zero times", async () => {
  let stops = 0; const seenGroups = [];
  const report = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(unitState(false)),
    bindIntent: async value => ({ entry: intentFor(value), disposition: "intent_reused", mayStop: false }),
    cgroupEmpty: async group => { seenGroups.push(group); return true; },
    stopUnit: async () => { stops += 1; },
  }));
  assert.equal(report.reason, "safe_stop_process_gone");
  assert.equal(report.stopProof.fixedUnit, true); assert.equal(report.stopProof.controlGroupEmpty, true);
  assert.deepEqual(seenGroups, [capturedControlGroup]); assert.equal(stops, 0);
});

test("inactive empty ControlGroup without a verified journal and a changed boot fail closed without stop", async () => {
  let stops = 0;
  const missing = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(unitState(false)),
    bindIntent: async () => { throw new Error("missing"); },
    stopUnit: async () => { stops += 1; },
  }));
  assert.equal(missing.reason, "safe_stop_journal_unverified");
  const changedBoot = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(unitState(false)),
    bindIntent: async value => ({ entry: intentFor(value, { ...activeCapture,
      bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }), disposition: "intent_reused", mayStop: false }),
    stopUnit: async () => { stops += 1; },
  }));
  assert.equal(changedBoot.reason, "safe_stop_journal_unverified"); assert.equal(stops, 0);
  const boots = [bootId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"];
  const rebootedDuringProof = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(unitState(false)), readBootId: async () => boots.shift(),
    bindIntent: async value => ({ entry: intentFor(value), disposition: "intent_reused", mayStop: false }),
    stopUnit: async () => { stops += 1; },
  }));
  assert.equal(rebootedDuringProof.reason, "safe_stop_identity_changed"); assert.equal(stops, 0);
});

test("stale proof, changed identity and unverified restart policy fail closed", async () => {
  const staleStates = [unitState(true), unitState(false), unitState(false)]; let clock = 0;
  const stale = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(staleStates.shift()), stopUnit: async () => {},
    now: () => (clock += 6_000), proofFreshMs: 5_000,
  }));
  assert.equal(stale.reason, "safe_stop_kernel_proof_stale");
  const changed = [unitState(true), { ...unitState(false), InvocationID: "e".repeat(32) }, unitState(false)];
  const identity = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => inspected(changed.shift()), stopUnit: async () => {},
  }));
  assert.equal(identity.reason, "safe_stop_identity_changed");
  const bad = await executeAmuxV22SafeStop(request, baseOptions({
    inspectUnit: async () => ({ ...inspected(unitState(true)), restartDisabled: false }),
  }));
  assert.equal(bad.reason, "safe_stop_config_unverified");
});

test("root controller is default-off, refuses non-root, and rejects a multi-task queue without stopping", async () => {
  let fetches = 0, stops = 0;
  const config = { recoveryEnabled: "false", safeStopEnabled: "false", internalUrl: "https://internal.test/",
    controllerSecret: "s".repeat(32) };
  assert.deepEqual(await runAmuxV22RecoveryControllerOnce(config,
    { platform: "linux", uid: 0, fetcher: async () => { fetches += 1; } }), { state: "disabled" });
  assert.equal(fetches, 0);
  assert.deepEqual(await runAmuxV22RecoveryControllerOnce({ ...config, recoveryEnabled: "true", safeStopEnabled: "true" },
    { platform: "linux", uid: 1000 }), { state: "unavailable" });
  const result = await runAmuxV22RecoveryControllerOnce({ ...config, recoveryEnabled: "true", safeStopEnabled: "true" }, {
    platform: "linux", uid: 0, stopUnit: async () => { stops += 1; },
    fetcher: async () => Response.json({ requests: [request, { ...request, taskId: "task-2" }] }),
  });
  assert.deepEqual(result, { state: "unavailable" }); assert.equal(stops, 0);
});

test("root controller uses only its dedicated route secret and accepts one strict report receipt", async () => {
  const states = [unitState(true), unitState(false), unitState(false)]; let calls = 0;
  const secret = "controller-only-secret-value-000001";
  const result = await runAmuxV22RecoveryControllerOnce({ recoveryEnabled: "true", safeStopEnabled: "true",
    internalUrl: "https://internal.test/", controllerSecret: secret }, baseOptions({ platform: "linux", uid: 0,
    inspectUnit: async () => inspected(states.shift()), stopUnit: async () => {},
    fetcher: async (url, init) => {
      calls += 1; assert.equal(String(url).split("?")[0], "https://internal.test/api/internal/amux/v22/recovery-controller");
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      if (init.method === "GET") return Response.json({ requests: [request] });
      const report = JSON.parse(String(init.body));
      assert.equal(amuxV22SafeStopEvidenceSchema.safeParse(report).success, true);
      return Response.json({ recorded: true, evidenceId: report.evidenceId, verified: true,
        evidenceDigest: "f".repeat(64), reason: null, retryWrite: false });
    },
  }));
  assert.equal(result.state, "reported"); assert.equal(result.verified, true); assert.equal(calls, 2);
});

test("root controller gives POST a fresh timeout signal after GET and kernel proof", async () => {
  const states = [unitState(true), unitState(false), unitState(false)];
  const controllers = []; const signals = [];
  const result = await runAmuxV22RecoveryControllerOnce({ recoveryEnabled: "true", safeStopEnabled: "true",
    internalUrl: "https://internal.test/", controllerSecret: "s".repeat(32) }, baseOptions({
    platform: "linux", uid: 0, inspectUnit: async () => inspected(states.shift()),
    timeoutSignal: milliseconds => {
      assert.equal(milliseconds, 10_000);
      const controller = new AbortController(); controllers.push(controller); return controller.signal;
    },
    stopUnit: async () => { controllers[0].abort(); },
    fetcher: async (_url, init) => {
      signals.push(init.signal);
      if (init.method === "GET") return Response.json({ requests: [request] });
      assert.equal(init.signal.aborted, false);
      const report = JSON.parse(String(init.body));
      return Response.json({ recorded: true, evidenceId: report.evidenceId, verified: true,
        evidenceDigest: "f".repeat(64), reason: null, retryWrite: false });
    },
  }));
  assert.equal(result.state, "reported"); assert.equal(controllers.length, 2);
  assert.notEqual(signals[0], signals[1]); assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test("root controller accepts only service-compatible verified and unverified receipt reasons", async () => {
  const receipts = [
    { verified: false, reason: "safe_stop_config_unverified", expected: "reported" },
    { verified: true, reason: "safe_stop_process_gone", expected: "outcome_unknown" },
    { verified: false, reason: null, expected: "outcome_unknown" },
    { verified: false, reason: "not_a_closed_reason", expected: "outcome_unknown" },
  ];
  for (const receipt of receipts) {
    const result = await runAmuxV22RecoveryControllerOnce({ recoveryEnabled: "true", safeStopEnabled: "true",
      internalUrl: "https://internal.test/", controllerSecret: "s".repeat(32) }, baseOptions({
      platform: "linux", uid: 0,
      inspectUnit: async () => ({ ...inspected(unitState(true)), restartDisabled: false }),
      fetcher: async (_url, init) => {
        if (init.method === "GET") return Response.json({ requests: [request] });
        const report = JSON.parse(String(init.body));
        return Response.json({ recorded: true, evidenceId: report.evidenceId,
          evidenceDigest: "f".repeat(64), verified: receipt.verified, reason: receipt.reason,
          retryWrite: false });
      },
    }));
    assert.equal(result.state, receipt.expected);
    if (receipt.expected === "reported") assert.equal(result.verified, false);
  }
});

test("journal preparation captures boot and cgroup with O_EXCL, fsyncs, and refuses a partial intent", async () => {
  const entry = intentFor(request); const bytes = Buffer.from(JSON.stringify(entry));
  const calls = []; let fileSynced = 0, directorySynced = 0;
  const rootDirectory = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false,
    uid: 0, mode: 0o40700, nlink: 1, size: 0 };
  const rootFile = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true,
    uid: 0, mode: 0o100600, nlink: 1, size: bytes.length };
  const lstat = async path => path.endsWith(".json") ? rootFile : rootDirectory;
  const file = { writeFile: async value => { calls.push(Buffer.from(value)); }, sync: async () => { fileSynced += 1; },
    stat: async () => rootFile, close: async () => {} };
  const directory = { sync: async () => { directorySynced += 1; }, close: async () => {} };
  const open = async (path, flags) => {
    if (path === AMUX_V22_RECOVERY_INTENT_DIR) return directory;
    assert.equal(Boolean(flags & constants.O_EXCL), true); return file;
  };
  const created = await bindAmuxV22StopIntent(request, activeCapture, { lstat, open });
  assert.equal(created.disposition, "intent_recorded"); assert.equal(created.mayStop, true);
  assert.equal(created.entry.bootId, bootId);
  assert.equal(created.entry.capturedControlGroup, capturedControlGroup);
  assert.equal(created.entry.capturedInvocationId, activeCapture.invocationId);
  assert.equal(fileSynced, 1); assert.equal(directorySynced, 1); assert.equal(calls.length, 1);
  await assert.rejects(() => bindAmuxV22StopIntent(request,
    { ...activeCapture, controlGroup: "" }, { lstat, open }), /journal unverified/);

  const partial = async (path, flags) => {
    if (flags & constants.O_EXCL) { const error = new Error("exists"); error.code = "EEXIST"; throw error; }
    throw new Error(`unexpected read ${path}`);
  };
  await assert.rejects(() => bindAmuxV22StopIntent(request, activeCapture, {
    lstat: async path => path.endsWith(".json") ? { ...rootFile, size: 0 } : rootDirectory, open: partial,
  }), /journal unverified/);
});

test("install preparation remains manual, disabled and without start/restart/enable", async () => {
  const [service, installer, env] = await Promise.all([
    readFile(new URL("../scripts/systemd/amux-v22-recovery-controller.service", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-amux-v22-recovery-controller.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/systemd/amux-v22-recovery-controller.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(service, /^Restart=no$/m); assert.doesNotMatch(service, /^\[Install\]$/m);
  assert.doesNotMatch(installer, /systemctl\s+(?:start|restart|enable)/);
  assert.match(installer, /systemctl daemon-reload/);
  assert.match(env, /TASK_RECOVERY_ENABLED=false/); assert.match(env, /LEGACY_SAFE_STOP_ENABLED=false/);
  assert.doesNotMatch(env, /DATABASE_URL|GITHUB_TOKEN|AMUX_SYNC_SECRET|API_KEY/);
});
