import assert from "node:assert/strict";
import test from "node:test";
import { amuxV22RecoveryAdminSchema, amuxV22RecoveryEvidenceSchema,
  amuxV22RecoveryProofReason, amuxV22RecoveryCost, amuxV22RecoveryStartAllowed,
  amuxV22TaskRecoveryEnabled, amuxV22LegacySafeStopEnabled,
  amuxV22ReadOnlyApiExecutorEnabled, configuredAmuxV22ReadOnlyApiMetadata,
  configuredAmuxV22RecoveryProfiles, configuredAmuxV22RecoveryProfile,
  amuxV22SafeStopEvidenceSchema, amuxV22SafeStopJournalBinding,
  amuxV22SafeStopProofReason, isAmuxV22RecoveryControllerAuthorized,
  amuxV22ReadOnlyLaunchCheckSchema, amuxV22ReadOnlyLaunchProofSchema,
  amuxV22ReadOnlyRetryRouteCost, amuxV22ReadOnlyLaunchScope,
  amuxV22ReadOnlyLaunchProofScope, amuxV22ReadOnlyLaunchScopeMatchesIntent,
  AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID } from
  "../lib/amux/v22TaskRecoveryCore.ts";
import { AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST } from
  "../lib/amux/v22ReadOnlyApiProtocol.mjs";
const uuid = "8b465370-568a-4a78-b9dd-31dfd5413f95";
test("recovery capability defaults off and only the exact master value opens it", () => {
  assert.equal(amuxV22TaskRecoveryEnabled("true"), true);
  for (const value of [undefined, "", "enabled", "1", "TRUE", " true", "false"])
    assert.equal(amuxV22TaskRecoveryEnabled(value), false);
});
test("legacy safe-stop defaults off and rejects reuse of the broad sync secret", () => {
  assert.equal(amuxV22LegacySafeStopEnabled("true"), true);
  for (const value of [undefined, "", "1", "TRUE", " true", "false"])
    assert.equal(amuxV22LegacySafeStopEnabled(value), false);
  const own = "r".repeat(40); const broad = "s".repeat(40);
  const request = (secret) => new Request("https://tomverse.test", {
    headers: { authorization: `Bearer ${secret}` } });
  assert.equal(isAmuxV22RecoveryControllerAuthorized(request(own), {
    TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET: own,
    TOMVERSE_AMUX_SYNC_SECRET: broad,
  }), true);
  assert.equal(isAmuxV22RecoveryControllerAuthorized(request(own), {
    TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET: own,
    TOMVERSE_AMUX_SYNC_SECRET: own,
  }), false);
  assert.equal(isAmuxV22RecoveryControllerAuthorized(request(own), {
    TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET: own,
    TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET: own,
    TOMVERSE_AMUX_SYNC_SECRET: broad,
  }), false);
  assert.equal(isAmuxV22RecoveryControllerAuthorized(request(broad), {
    TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET: own,
    TOMVERSE_AMUX_SYNC_SECRET: broad,
  }), false);
});

test("read-only API execution needs an exact enable value and complete non-secret metadata", () => {
  assert.equal(amuxV22ReadOnlyApiExecutorEnabled("true"), true);
  for (const value of [undefined, "", "enabled", "1", "TRUE", " true", "false"])
    assert.equal(amuxV22ReadOnlyApiExecutorEnabled(value), false);
  const env = {
    TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID: "first-task-anthropic",
    TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST: "1".repeat(64),
    TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST: "2".repeat(64),
    TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST: "4".repeat(64),
  };
  assert.deepEqual(configuredAmuxV22ReadOnlyApiMetadata(env), {
    credentialProfileId: "first-task-anthropic",
    credentialMetadataDigest: "1".repeat(64),
    executorArtifactDigest: "2".repeat(64),
    settingsDigest: AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
    repositoryScopeDigest: "4".repeat(64),
    brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
    toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  });
  for (const key of Object.keys(env)) {
    const missing = { ...env }; delete missing[key];
    assert.equal(configuredAmuxV22ReadOnlyApiMetadata(missing), null, key);
  }
  assert.equal(configuredAmuxV22ReadOnlyApiMetadata({ ...env,
    TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID: "/secret/key/path" }), null);
  assert.equal(configuredAmuxV22ReadOnlyApiMetadata({ ...env,
    TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST: "not-a-digest" }), null);
});

const profileConfig = { version: 1, profiles: [
  { alias: "claude-chore", workerNames: ["claude-chore", "claude-test"] },
] };
test("operator-owned recovery profiles are canonical, unique, and unavailable by default", () => {
  assert.equal(configuredAmuxV22RecoveryProfiles(undefined), null);
  const configured = configuredAmuxV22RecoveryProfiles(JSON.stringify(profileConfig));
  assert.ok(configured); assert.equal(configured.profileConfigDigest.length, 64);
  assert.deepEqual(configuredAmuxV22RecoveryProfile("claude-test",
    JSON.stringify(profileConfig)), { ...profileConfig.profiles[0],
    targetUnit: "tomverse-amux-v22-sidecar@claude-chore.service",
    profileConfigDigest: configured.profileConfigDigest });
  for (const invalid of [
    { version: 1, profiles: [{ alias: "claude-chore", workerNames: ["z", "a"] }] },
    { version: 1, profiles: [{ alias: "b", workerNames: ["same"] },
      { alias: "a", workerNames: ["other"] }] },
    { version: 1, profiles: [{ alias: "a", workerNames: ["same"] },
      { alias: "b", workerNames: ["same"] }] },
    { version: 1, profiles: [{ alias: "a", workerNames: ["Worker-One"] }] },
    { version: 1, profiles: [{ alias: "a", workerNames: ["a0", "a-1"] }] },
  ]) assert.equal(configuredAmuxV22RecoveryProfiles(JSON.stringify(invalid)), null);
});

const safeStopReport = () => {
  const targetUnit = "tomverse-amux-v22-sidecar@claude-chore.service";
  const binding = { taskId: "task-1234", priorAttemptId: uuid,
    workerProfileAlias: "claude-chore", targetUnit };
  return { inspectionId: uuid, evidenceId: uuid, requestKind: "safe_stop",
    requestDigest: "a".repeat(64), taskId: binding.taskId, taskRevision: 8,
    priorAttemptId: uuid, priorAttemptTaskRevision: 7, workerName: "claude-test",
    workerInstanceId: uuid, workerGeneration: 2, targetHost: "amux-ubuntu",
    sourceEvidenceId: uuid, sourceEvidenceDigest: "b".repeat(64),
    workerProfileAlias: binding.workerProfileAlias,
    profileWorkerNames: ["claude-chore", "claude-test"], targetUnit,
    profileConfigDigest: "c".repeat(64), hostInvocationId: null,
    modelOutcome: "unknown", stopProof: {
      journalBindingDigest: amuxV22SafeStopJournalBinding(binding),
      journalEntryDigest: "d".repeat(64), journalDisposition: "intent_recorded",
      stopAcknowledgement: "outcome_unknown", processState: "gone",
      fixedUnit: true, rootOwnedConfig: true, profileUnique: true,
      noOtherWork: true, restartDisabled: true, journalBound: true,
      mainPidAbsent: true, controlGroupEmpty: true, kernelProofFresh: true,
    }, usage: { status: "unknown", projectedCostMicroUsd: null },
    reason: "safe_stop_process_gone" };
};
test("safe-stop report is an exact content-free 23/14-key proof", () => {
  const report = safeStopReport();
  assert.equal(Object.keys(report).length, 23);
  assert.equal(Object.keys(report.stopProof).length, 14);
  assert.equal(amuxV22SafeStopEvidenceSchema.safeParse(report).success, true);
  assert.equal(amuxV22SafeStopProofReason(report), null);
  for (const extra of [{ stdout: "secret" }, { path: "/private" },
    { hostInvocationId: "e".repeat(32) }, { modelOutcome: "succeeded" },
    { profileWorkerNames: ["CLAUDE-TEST"] },
    { usage: { status: "unknown", projectedCostMicroUsd: "0" } }])
    assert.equal(amuxV22SafeStopEvidenceSchema.safeParse({ ...report, ...extra }).success, false);
  const unbound = { ...report, stopProof: { ...report.stopProof,
    journalBound: false }, reason: "safe_stop_journal_unverified" };
  assert.equal(amuxV22SafeStopProofReason(unbound), "safe_stop_journal_unverified");
});
const report = () => ({ inspectionId: uuid, evidenceId: uuid, requestDigest: "a".repeat(64),
  taskId: "task-1234", taskRevision: 8, priorAttemptId: uuid, priorAttemptTaskRevision: 7, workerName: "claude-test",
  workerInstanceId: uuid, workerGeneration: 2, targetHost: "amux-ubuntu", hostInvocationId: "b".repeat(32),
  proof: { terminalOutcome: "unknown", sameLiveInvocation: true, noActiveExecution: true,
    processTreeStopped: true, rootOwnedUnit: true, controlGroupBound: true, journalBound: true,
    socketTerminal: true, externalEffectsKnown: true, workspaceClean: true },
  usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "stopped_proven" });

test("recovery accepts only content-free exact fixed-host evidence", () => {
  assert.equal(amuxV22RecoveryEvidenceSchema.safeParse(report()).success, true);
  assert.equal(amuxV22RecoveryEvidenceSchema.safeParse({ ...report(),
    usage: { status: "reported_complete", projectedCostMicroUsd: null } }).success, true);
  for (const mutation of [{ stdout: "secret" }, { targetHost: "another-host" },
    { hostInvocationId: "not-an-invocation" }, { workerInstanceId: "host-name" },
    { usage: { status: "unknown", projectedCostMicroUsd: "0" } },
    { proof: { ...report().proof, path: "/private" } }]) {
    assert.equal(amuxV22RecoveryEvidenceSchema.safeParse({ ...report(), ...mutation }).success, false);
  }
  assert.equal(amuxV22RecoveryAdminSchema.safeParse({ action: "request_inspection", taskId: "task-1234",
    expectedRevision: 8, priorAttemptId: uuid, requestId: uuid, command: "restart" }).success, false);
});
test("unknown cost can stay held but every stopped proof and external-effect guard is required", () => {
  assert.equal(amuxV22RecoveryProofReason(report(), "design"), null);
  for (const key of ["sameLiveInvocation", "noActiveExecution", "processTreeStopped", "rootOwnedUnit",
    "controlGroupBound", "journalBound", "socketTerminal", "externalEffectsKnown"]) {
    const input = report(); input.proof[key] = false;
    assert.notEqual(amuxV22RecoveryProofReason(input, "design"), null, key);
  }
  const legacy = { ...report(), hostInvocationId: null, reason: "legacy_invocation_unbound" };
  assert.equal(amuxV22RecoveryProofReason(legacy, "design"), "legacy_invocation_unbound");
  const success = report(); success.proof.terminalOutcome = "succeeded";
  assert.equal(amuxV22RecoveryProofReason(success, "design"), "terminal_success");
  const dirty = report(); dirty.proof.workspaceClean = false;
  assert.equal(amuxV22RecoveryProofReason(dirty, "implement"), "workspace_unverified");
});
const receipt = { role: "design", grade: "small", catalogVersion: "catalog-1", catalogDigest: "c".repeat(64),
  pricingVersion: "price-1", gradeRulesVersion: "grade-1", calculatedAtIso: "2026-10-13T01:00:00.000Z",
  caps: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, maxAttempts: 1 },
  routes: [{ routeId: "route-1", workerName: "claude-test", provider: "anthropic", modelId: "claude-opus",
    routePolicyDigest: "d".repeat(64), perAttemptMicroUsd: "3400000" }], ceilingMicroUsd: "3400000", receiptDigest: "e".repeat(64) };
test("additional cap comes from exact catalog routes and conservatively retains all prior reservations", () => {
  const quote = amuxV22RecoveryCost({ priorReservedMicroUsd: 3_400_000n, catalogApprovalId: "catalog-id", receipt });
  assert.equal(quote.oldHeldMicroUsd, "3400000");
  assert.equal(quote.additionalCapMicroUsd, "3400000");
  assert.equal(quote.worstExposureMicroUsd, "6800000");
  const later = amuxV22RecoveryCost({ priorReservedMicroUsd: 3_400_000n, catalogApprovalId: "catalog-id",
    receipt: { ...receipt, calculatedAtIso: "2026-10-13T02:00:00.000Z", receiptDigest: "f".repeat(64) } });
  assert.equal(later.costDigest, quote.costDigest);
  for (const changed of [{ ...receipt, catalogVersion: "catalog-2" },
    { ...receipt, caps: { ...receipt.caps, outputTokens: 2 } },
    { ...receipt, routes: [{ ...receipt.routes[0], perAttemptMicroUsd: "3400001" }] }]) {
    assert.notEqual(amuxV22RecoveryCost({ priorReservedMicroUsd: 3_400_000n,
      catalogApprovalId: "catalog-id", receipt: changed }).costDigest, quote.costDigest);
  }
  assert.throws(() => amuxV22RecoveryCost({ priorReservedMicroUsd: 0n, catalogApprovalId: "catalog-id", receipt }));
});
test("one approval cannot authorize another revision, route amount, catalog, or attempt", () => {
  const approval = { taskId: "task-1234", afterRevision: 9, historicalAttempts: 1,
    nextAttemptNumber: 2, oldHeldMicroUsd: 3_400_000n, additionalCapMicroUsd: 3_400_000n,
    catalogApprovalId: "catalog-id", costDigest: "a".repeat(64) };
  const input = { approval, taskId: approval.taskId, assignmentRevision: 9, historicalAttempts: 1,
    nextAttemptNumber: 2, priorReservedMicroUsd: 3_400_000n, assignedMicroUsd: 3_400_000n,
    catalogApprovalId: approval.catalogApprovalId, costDigest: approval.costDigest };
  assert.equal(amuxV22RecoveryStartAllowed(input), true);
  for (const change of [{ taskId: "task-other" }, { assignmentRevision: 10 },
    { historicalAttempts: 2 }, { nextAttemptNumber: 3 }, { priorReservedMicroUsd: 0n },
    { assignedMicroUsd: 3_400_001n }, { catalogApprovalId: "other" }, { costDigest: "f".repeat(64) }])
    assert.equal(amuxV22RecoveryStartAllowed({ ...input, ...change }), false);
});
test("v39 launch authority is exact to the FIRST Task, one route, and the 6.80 USD exposure", () => {
  const investigateReceipt = { ...receipt, role: "investigate",
    routes: [{ ...receipt.routes[0], routeId: "route-1", workerName: "claude-test",
      provider: "anthropic", modelId: "claude-opus", perAttemptMicroUsd: "3400000" }] };
  const cost = amuxV22ReadOnlyRetryRouteCost({ priorReservedMicroUsd: 3_400_000n,
    catalogApprovalId: "catalog-id", receipt: investigateReceipt,
    routeId: "route-1", workerName: "claude-test", provider: "anthropic",
    modelId: "claude-opus" });
  assert.equal(cost.oldHeldMicroUsd, "3400000");
  assert.equal(cost.additionalCapMicroUsd, "3400000");
  assert.equal(cost.worstExposureMicroUsd, "6800000");
  const check = { requestKind: "read_only_launch_check", launchCheckId: uuid,
    requestDigest: "1".repeat(64), taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID,
    taskRevision: 8, priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    workerName: "claude-test", workerInstanceId: uuid, workerGeneration: 2,
    targetHost: "amux-ubuntu", sourceEvidenceId: uuid,
    sourceEvidenceDigest: "2".repeat(64), riskAcceptanceId: uuid,
    riskAcceptanceDigest: "3".repeat(64), launchBindingId: uuid,
    briefDigest: "4".repeat(64), provider: "anthropic", modelId: "claude-opus",
    routeId: "route-1", routePolicyDigest: "5".repeat(64),
    catalogApprovalId: "catalog-id", catalogVersion: investigateReceipt.catalogVersion,
    pricingVersion: investigateReceipt.pricingVersion,
    costReceiptDigest: investigateReceipt.receiptDigest,
    additionalCapMicroUsd: cost.additionalCapMicroUsd,
    worstExposureMicroUsd: cost.worstExposureMicroUsd,
    launchScope: amuxV22ReadOnlyLaunchScope({ profileConfigDigest: "6".repeat(64) }) };
  assert.equal(amuxV22ReadOnlyLaunchCheckSchema.safeParse(check).success, true);
  const actualScope = { ...check.launchScope, launcherConfigDigest: "7".repeat(64) };
  const proof = { ...check, launchScope: actualScope,
    launchProofId: uuid, observation: "current" };
  assert.equal(amuxV22ReadOnlyLaunchProofSchema.safeParse(proof).success, true);
  assert.equal(amuxV22ReadOnlyLaunchScopeMatchesIntent(check.launchScope, actualScope), true);
  assert.equal(amuxV22ReadOnlyLaunchProofScope(proof)?.launchScope.launcherConfigDigest,
    "7".repeat(64));
  assert.equal(amuxV22ReadOnlyLaunchScopeMatchesIntent(check.launchScope,
    { ...actualScope, toolPolicyDigest: "8".repeat(64) }), false);
  for (const changed of [{ taskId: "task-outside-approved-scope" },
    { priorAttemptId: uuid }, { additionalCapMicroUsd: "3400001" },
    { worstExposureMicroUsd: "6800001" }, { command: "claude --dangerously-skip-permissions" }])
    assert.equal(amuxV22ReadOnlyLaunchCheckSchema.safeParse({ ...check, ...changed }).success, false);
  assert.throws(() => amuxV22ReadOnlyRetryRouteCost({ priorReservedMicroUsd: 3_400_000n,
    catalogApprovalId: "catalog-id", receipt: { ...investigateReceipt,
      routes: [{ ...investigateReceipt.routes[0], perAttemptMicroUsd: "3400001" }] },
    routeId: "route-1", workerName: "claude-test", provider: "anthropic",
    modelId: "claude-opus" }));
});
