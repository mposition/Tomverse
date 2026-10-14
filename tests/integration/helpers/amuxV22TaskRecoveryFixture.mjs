import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmuxV22SidecarHandler } from "../../../lib/amux/v22OneShotSidecar.mjs";
import { amuxV22ReadOnlyLaunchScope, amuxV22ReadOnlyLaunchScopeDigest,
  amuxV22RecoveryDigest } from
  "../../../lib/amux/v22TaskRecoveryCore.ts";
import { probeAmuxV22ReadOnlyApiModelAccess } from
  "../../../lib/amux/v22ReadOnlyApiHost.mjs";
import { amuxV22ApiModelAccessEvidenceDigest } from
  "../../../lib/amux/v22ApiModelAccessProtocol.mjs";
import { AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiNominalLaunchScope } from
  "../../../lib/amux/v22ReadOnlyApiProtocol.mjs";

/** The recovery guards require the audit row's top-level transaction XID.
 * Assert rollback-only transaction ownership before inserting, and release
 * the probe savepoint first so xmin is not a subtransaction XID. */
async function appendRecoveryFixtureAudit(db, input) {
  await db.query("SAVEPOINT recovery_audit_transaction_required");
  await db.query("RELEASE SAVEPOINT recovery_audit_transaction_required");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))");
  const id = randomUUID();
  const entryHash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  await db.query(`WITH head AS (
    SELECT "entryHash", "createdAt" FROM public."AdminAuditLog" WHERE "entryHash" IS NOT NULL
    ORDER BY "createdAt" DESC, "id" DESC LIMIT 1)
    INSERT INTO public."AdminAuditLog"
      ("id", "actorUserId", "action", "targetType", "targetId", "summary", "metadata", "previousHash", "entryHash", "createdAt")
    SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,(SELECT "entryHash" FROM head),$8,
      GREATEST((clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
        COALESCE((SELECT "createdAt" FROM head) + interval '1 millisecond', '-infinity'::timestamp))`,
  [id, input.actorUserId, input.action, input.targetType, input.targetId, input.summary,
    JSON.stringify(input.metadata), entryHash]);
  const sameTransaction = await db.query(`SELECT xmin = pg_current_xact_id()::xid AS same
    FROM public."AdminAuditLog" WHERE "id"=$1`, [id]);
  assert.equal(sameTransaction.rows[0].same, true);
  return id;
}

/** Real migrated tables and triggers, rollback-only synthetic metadata. The
 * host proof and audit hashes are synthetic; this does not attest a live host
 * or test source decryption/current-ready, which the service contract tests
 * cover separately. All original source/promotion/assignment guards stay on.
 * `positiveOnly` skips refusal probes but keeps the valid second attempt and
 * awaits `afterReadOnlyAttemptStarted` inside the caller's transaction. */
export async function exerciseAmuxV22TaskRecoveryFixture(db, input) {
  const { taskId, priorAttemptId, priorAssignmentId, promotionId, instanceId,
    recoveryInstanceId, laneSequence, digest, sourceApprovalId,
    readOnlyExecutorKind = "read_only_api_retry_v1" } = input;
  const positiveOnly = input.positiveOnly === true;
  assert.ok(["read_only_retry_v1", "read_only_api_retry_v1"]
    .includes(readOnlyExecutorKind));
  const apiExecutor = readOnlyExecutorKind === "read_only_api_retry_v1";
  const inspectionId = randomUUID(); let evidenceId; const approvalId = randomUUID();
  async function insert(table, data) {
    const keys = Object.keys(data);
    return db.query(`INSERT INTO public."${table}" (${keys.map((key) => `"${key}"`).join(",")})
      VALUES (${keys.map((_key, index) => `$${index + 1}`).join(",")})`, Object.values(data));
  }
  async function reject(callback, expectedConstraint, expectedCode = "23514") {
    if (positiveOnly) return;
    await db.query("SAVEPOINT recovery_probe"); let error;
    try { await callback(); } catch (caught) { error = caught; }
    await db.query("ROLLBACK TO SAVEPOINT recovery_probe"); await db.query("RELEASE SAVEPOINT recovery_probe");
    assert.equal(error?.code, expectedCode, error?.message);
    if (Array.isArray(expectedConstraint))
      assert.ok(expectedConstraint.includes(error.constraint), error.message);
    else if (expectedConstraint) assert.equal(error.constraint, expectedConstraint, error.message);
  }
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  // Make this prior synthetic attempt unknown without touching any real data.
  await db.query(`UPDATE public."AmuxExecutionAttempt" SET "outcome"='expired',
    "toStatus"='blocked', "reason"='outcome_unknown' WHERE "id"=$1`, [priorAttemptId]);
  await db.query(`UPDATE public."AmuxWorkItem" SET "status"='blocked' WHERE "id"=$1`, [taskId]);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  const binding = { inspectionId, taskId, taskRevision: 4, priorAttemptId, priorAttemptTaskRevision: 3,
    workerName: "worker-one", workerInstanceId: instanceId, workerGeneration: 1, targetHost: "amux-ubuntu" };
  const requestDigest = amuxV22RecoveryDigest("inspection", binding);
  const ownerRequestId = randomUUID();
  const requestAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: "synthetic-owner",
    action: "amux.v22.recovery.requested", targetType: "AmuxV22TaskRecoveryInspectionRequest", targetId: inspectionId,
    summary: "synthetic fixed-host inspection request", metadata: { ...binding, requestDigest, ownerRequestId } });
  const requestedAt = (await db.query(`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)).rows[0].now;
  const requestRow = { id: inspectionId, ownerRequestId, taskId, taskRevision: 4,
    priorAttemptId, priorAttemptTaskRevision: 3, workerName: "worker-one", workerInstanceId: instanceId,
    workerGeneration: 1, targetHost: "amux-ubuntu", requestDigest,
    requestedByUserId: "synthetic-owner", authorizationAuditLogId: requestAuditId, requestedAt };
  await insert("AmuxV22TaskRecoveryInspectionRequest", requestRow);
  const oldAttempt = (await db.query(`SELECT * FROM public."AmuxExecutionAttempt" WHERE "id"=$1`, [priorAttemptId])).rows[0];
  const oldLedger = (await db.query(`SELECT * FROM public."AmuxCostLedgerEntry" WHERE "attemptId"=$1`, [priorAttemptId])).rows;
  const oldUsage = (await db.query(`SELECT * FROM public."AmuxCliUsageEvent" WHERE "attemptId"=$1`, [priorAttemptId])).rows;
  const oldSourceApproval = (await db.query(`SELECT * FROM public."AmuxIdeaUnitDecision" WHERE "id"=$1`,
    [sourceApprovalId])).rows[0];
  assert.equal(BigInt(oldAttempt.reservedCostMicrousd), 3_400_000n);
  assert.equal(oldLedger.length, 1); assert.equal(BigInt(oldLedger[0].amountMicrousd), 3_400_000n);
  assert.equal(oldUsage.length, 1); assert.equal(oldUsage[0].completeness, "unknown");
  assert.ok(oldSourceApproval, "source approval fixture is required");
  await reject(() => db.query(`UPDATE public."AmuxExecutionAttempt" SET "reservedCostMicrousd"=0 WHERE "id"=$1`, [priorAttemptId]),
    "AmuxV22Recovery_prior_attempt_immutable_check");
  await reject(() => db.query(`DELETE FROM public."AmuxExecutionAttempt" WHERE "id"=$1`, [priorAttemptId]),
    "AmuxV22Recovery_prior_attempt_immutable_check");
  // Actual no-memory host producer: this synthetic fixture invokes the real
  // sidecar handler but does not attest a live Linux process or kernel state.
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v39-db-no-memory-"));
  let providerCalls = 0;
  let report;
  try {
    const handler = createAmuxV22SidecarHandler({ worker: "worker-one", stateDir,
      run: async () => { providerCalls += 1; throw new Error("provider must not run"); } });
    report = await handler({ op: "inspect_recovery", ...binding, requestDigest,
      requestedAt: requestedAt.toISOString() });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
  evidenceId = report.evidenceId;
  assert.equal(report.reason, "legacy_invocation_unbound");
  assert.equal(report.proof.externalEffectsKnown, false);
  assert.equal(report.usage.status, "unknown");
  assert.equal(providerCalls, 0);
  const evidenceDigest = amuxV22RecoveryDigest("evidence", report);
  const evidenceAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.recovery.inspected", targetType: "AmuxV22TaskRecoveryEvidence", targetId: evidenceId,
    summary: "synthetic content-free proof", metadata: { systemActor: "amux-v22-recovery-checker",
      taskId, inspectionId, priorAttemptId, evidenceDigest } });
  const evidenceRow = { id: evidenceId, inspectionId, hostInvocationId: report.hostInvocationId,
    report, evidenceDigest, verified: false, reason: "legacy_invocation_unbound", authorizationAuditLogId: evidenceAuditId,
    recordedAt: new Date("2000-01-01T00:00:00.000Z") };
  await reject(() => insert("AmuxV22TaskRecoveryEvidence", { ...evidenceRow, report: { ...report, stdout: "forbidden" } }),
    "AmuxV22RecoveryEvidence_binding_check");
  await insert("AmuxV22TaskRecoveryEvidence", evidenceRow);
  const evidence = (await db.query(`SELECT * FROM public."AmuxV22TaskRecoveryEvidence" WHERE "id"=$1`, [evidenceId])).rows[0];
  assert.ok(evidence.recordedAt.getTime() >= requestedAt.getTime(), "DB must replace caller timestamp");

  const taskBeforeRisk = (await db.query(`SELECT * FROM public."AmuxWorkItem" WHERE "id"=$1`,
    [taskId])).rows[0];
  const countsBeforeRisk = (await db.query(`SELECT
    (SELECT count(*)::int FROM public."AmuxExecutionAttempt" WHERE "taskId"=$1) attempts,
    (SELECT count(*)::int FROM public."AmuxV22WorkerAssignment" WHERE "workItemId"=$1) assignments,
    (SELECT count(*)::int FROM public."AmuxWorkDelivery" WHERE "taskId"=$1) deliveries,
    (SELECT count(*)::int FROM public."AmuxCostLedgerEntry" WHERE "taskId"=$1) ledger`,
  [taskId])).rows[0];
  const riskAcceptanceId = randomUUID(); const launchBindingId = randomUUID();
  const riskOwnerRequestId = randomUUID();
  const riskBinding = { acceptanceId: riskAcceptanceId, ownerRequestId: riskOwnerRequestId,
    taskId, taskRevision: 4, priorAttemptId, priorAttemptTaskRevision: 3,
    sourceEvidenceId: evidenceId, sourceEvidenceDigest: evidenceDigest,
    briefDigest: digest, launchBindingId, oldHeldMicroUsd: "3400000",
    additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000" };
  const acceptanceDigest = amuxV22RecoveryDigest("unknown-prior-risk-acceptance", riskBinding);
  const riskAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: "synthetic-owner",
    action: "amux.v22.recovery.unknown_prior_risk_accepted",
    targetType: "AmuxV22TaskRecoveryRiskAcceptance", targetId: riskAcceptanceId,
    summary: "synthetic exact UNKNOWN-risk acceptance", metadata: { ...riskBinding,
      acceptanceDigest, policyVersion: 40, priorEffects: "unknown",
      executionStarted: false, reservationCreated: false } });
  const riskRow = { id: riskAcceptanceId, ownerRequestId: riskOwnerRequestId,
    taskId, taskRevision: 4, priorAttemptId, priorAttemptTaskRevision: 3,
    sourceEvidenceId: evidenceId, sourceEvidenceDigest: evidenceDigest,
    briefDigest: digest, launchBindingId, oldHeldMicroUsd: "3400000",
    additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
    acceptanceDigest, acceptedByUserId: "synthetic-owner",
    authorizationAuditLogId: riskAuditId, acceptedAt: requestedAt };
  await insert("AmuxV22TaskRecoveryRiskAcceptance", riskRow);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxWorkItem" WHERE "id"=$1`,
    [taskId])).rows[0], taskBeforeRisk, "risk acceptance must not mutate the Task");
  assert.deepEqual((await db.query(`SELECT
    (SELECT count(*)::int FROM public."AmuxExecutionAttempt" WHERE "taskId"=$1) attempts,
    (SELECT count(*)::int FROM public."AmuxV22WorkerAssignment" WHERE "workItemId"=$1) assignments,
    (SELECT count(*)::int FROM public."AmuxWorkDelivery" WHERE "taskId"=$1) deliveries,
    (SELECT count(*)::int FROM public."AmuxCostLedgerEntry" WHERE "taskId"=$1) ledger`,
  [taskId])).rows[0], countsBeforeRisk,
  "risk acceptance must create no reservation, assignment, delivery or execution");
  const duplicateRiskId = randomUUID();
  const duplicateRiskAuditId = await appendRecoveryFixtureAudit(db, {
    actorUserId: "synthetic-owner", action: "amux.v22.recovery.unknown_prior_risk_accepted",
    targetType: "AmuxV22TaskRecoveryRiskAcceptance", targetId: duplicateRiskId,
    summary: "synthetic duplicate UNKNOWN-risk acceptance", metadata: { ...riskBinding,
      acceptanceId: duplicateRiskId, ownerRequestId: randomUUID(), acceptanceDigest,
      policyVersion: 40, priorEffects: "unknown", executionStarted: false,
      reservationCreated: false },
  });
  await reject(() => insert("AmuxV22TaskRecoveryRiskAcceptance", { ...riskRow,
    id: duplicateRiskId, ownerRequestId: randomUUID(), authorizationAuditLogId: duplicateRiskAuditId }),
  ["AmuxV22TaskRecoveryRiskAcceptance_launchBindingId_key",
    "AmuxV22TaskRecoveryRiskAcceptance_acceptanceDigest_key",
    "AmuxV22RiskAcceptance_task_attempt_key"], "23505");
  await reject(() => insert("AmuxV22TaskRecoveryRiskAcceptance", { ...riskRow,
    id: randomUUID(), ownerRequestId: randomUUID(), taskId: randomUUID(),
    authorizationAuditLogId: randomUUID() }), "AmuxV22RiskAcceptance_exact_target_check");

  const safeStopInspectionId = randomUUID(); const safeStopEvidenceId = randomUUID();
  const safeStopOwnerRequestId = randomUUID(); const workerProfileAlias = "legacy-worker-one";
  const profileWorkerNames = ["worker-one"];
  const targetUnit = `tomverse-amux-v22-sidecar@${workerProfileAlias}.service`;
  const profileConfigDigest = amuxV22RecoveryDigest("worker-profile-config", {
    version: 1, profiles: [{ alias: workerProfileAlias, workerNames: profileWorkerNames }],
  });
  // Policy v45: when the worker re-registered after the prior attempt, the
  // safe stop binds its live runtime; the attempt-time runtime is refused.
  const liveRuntime = input.liveRuntime ?? null;
  const stopInstanceId = liveRuntime?.instanceId ?? instanceId;
  const stopGeneration = liveRuntime?.generation ?? 1;
  const safeStopBindingFor = (id, workerInstanceId, workerGeneration) => ({
    inspectionId: id, requestKind: "safe_stop",
    taskId, taskRevision: 4, priorAttemptId, priorAttemptTaskRevision: 3,
    workerName: "worker-one", workerInstanceId, workerGeneration,
    targetHost: "amux-ubuntu", sourceEvidenceId: evidenceId,
    sourceEvidenceDigest: evidenceDigest, workerProfileAlias, profileWorkerNames,
    targetUnit, profileConfigDigest, riskAcceptanceId, riskAcceptanceDigest: acceptanceDigest });
  // The audit row needs the top-level transaction XID, so it is written before
  // any probe savepoint; only the request insert runs inside the probe.
  async function prepareSafeStopRequest(id, ownerRequestId, workerInstanceId, workerGeneration) {
    const binding = safeStopBindingFor(id, workerInstanceId, workerGeneration);
    const requestDigest = amuxV22RecoveryDigest("inspection", binding);
    const auditId = await appendRecoveryFixtureAudit(db, {
      actorUserId: "synthetic-owner", action: "amux.v22.recovery.safe_stop_requested",
      targetType: "AmuxV22TaskRecoveryInspectionRequest", targetId: id,
      summary: "synthetic fixed-profile safe-stop request",
      metadata: { ...binding, ownerRequestId, requestDigest },
    });
    const requestedAt = (await db.query(`SELECT
      (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)).rows[0].now;
    return {
      id, ownerRequestId, requestKind: "safe_stop", taskId, taskRevision: 4, priorAttemptId,
      priorAttemptTaskRevision: 3, workerName: "worker-one", workerInstanceId,
      workerGeneration, targetHost: "amux-ubuntu", requestDigest,
      sourceEvidenceId: evidenceId, sourceEvidenceDigest: evidenceDigest,
      workerProfileAlias, profileWorkerNames, targetUnit, profileConfigDigest,
      riskAcceptanceId, riskAcceptanceDigest: acceptanceDigest,
      requestedByUserId: "synthetic-owner", authorizationAuditLogId: auditId, requestedAt,
    };
  }
  if (liveRuntime) {
    await db.query(`UPDATE public."AmuxWorkerRuntime" SET "instanceId"=$1, "generation"=$2
      WHERE "workerName"='worker-one'`, [liveRuntime.instanceId, liveRuntime.generation]);
    const attemptBound = await prepareSafeStopRequest(randomUUID(), randomUUID(), instanceId, 1);
    await reject(() => insert("AmuxV22TaskRecoveryInspectionRequest", attemptBound),
      "AmuxV22LegacySafeStop_request_guard_check");
  }
  const safeStopBinding = safeStopBindingFor(safeStopInspectionId, stopInstanceId, stopGeneration);
  const safeStopRequestDigest = amuxV22RecoveryDigest("inspection", safeStopBinding);
  const safeStopRequestAuditId = await appendRecoveryFixtureAudit(db, {
    actorUserId: "synthetic-owner", action: "amux.v22.recovery.safe_stop_requested",
    targetType: "AmuxV22TaskRecoveryInspectionRequest", targetId: safeStopInspectionId,
    summary: "synthetic fixed-profile safe-stop request",
    metadata: { ...safeStopBinding, ownerRequestId: safeStopOwnerRequestId,
      requestDigest: safeStopRequestDigest },
  });
  const safeStopRequestedAt = (await db.query(`SELECT
    (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)).rows[0].now;
  await insert("AmuxV22TaskRecoveryInspectionRequest", {
    id: safeStopInspectionId, ownerRequestId: safeStopOwnerRequestId,
    requestKind: "safe_stop", taskId, taskRevision: 4, priorAttemptId,
    priorAttemptTaskRevision: 3, workerName: "worker-one", workerInstanceId: stopInstanceId,
    workerGeneration: stopGeneration, targetHost: "amux-ubuntu", requestDigest: safeStopRequestDigest,
    sourceEvidenceId: evidenceId, sourceEvidenceDigest: evidenceDigest,
    workerProfileAlias, profileWorkerNames, targetUnit, profileConfigDigest,
    riskAcceptanceId, riskAcceptanceDigest: acceptanceDigest,
    requestedByUserId: "synthetic-owner", authorizationAuditLogId: safeStopRequestAuditId,
    requestedAt: safeStopRequestedAt,
  });
  const journalBindingDigest = amuxV22RecoveryDigest("stop-journal-binding", {
    taskId, priorAttemptId, workerProfileAlias, targetUnit,
  });
  const journalEntryDigest = amuxV22RecoveryDigest("stop-journal-entry", {
    version: 1, journalBindingDigest, taskId, priorAttemptId, workerProfileAlias, targetUnit,
  });
  const safeStopReportBinding = { ...safeStopBinding };
  delete safeStopReportBinding.riskAcceptanceId;
  delete safeStopReportBinding.riskAcceptanceDigest;
  const safeStopReport = { ...safeStopReportBinding, evidenceId: safeStopEvidenceId,
    requestDigest: safeStopRequestDigest, hostInvocationId: null, modelOutcome: "unknown",
    stopProof: { journalBindingDigest, journalEntryDigest,
      journalDisposition: "not_needed_already_gone", stopAcknowledgement: "not_issued",
      processState: "gone", fixedUnit: true, rootOwnedConfig: true, profileUnique: true,
      noOtherWork: true, restartDisabled: true, journalBound: true, mainPidAbsent: true,
      controlGroupEmpty: true, kernelProofFresh: true },
    usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "safe_stop_process_gone" };
  const safeStopEvidenceDigest = amuxV22RecoveryDigest("evidence", safeStopReport);
  const safeStopEvidenceAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.recovery.safe_stop_reported", targetType: "AmuxV22TaskRecoveryEvidence",
    targetId: safeStopEvidenceId, summary: "synthetic content-free process-gone proof",
    metadata: { systemActor: "amux-v22-recovery-controller", taskId,
      inspectionId: safeStopInspectionId, priorAttemptId,
      evidenceDigest: safeStopEvidenceDigest, stopJournalBindingDigest: journalBindingDigest,
      stopJournalEntryDigest: journalEntryDigest, stopAcknowledgement: "not_issued",
      processState: "gone" },
  });
  await insert("AmuxV22TaskRecoveryEvidence", {
    id: safeStopEvidenceId, inspectionId: safeStopInspectionId, requestKind: "safe_stop",
    sourceEvidenceId: evidenceId, sourceEvidenceDigest: evidenceDigest, hostInvocationId: null,
    stopJournalBindingDigest: journalBindingDigest, stopJournalEntryDigest: journalEntryDigest,
    stopAcknowledgement: "not_issued", processState: "gone", report: safeStopReport,
    evidenceDigest: safeStopEvidenceDigest, verified: true, reason: null,
    authorizationAuditLogId: safeStopEvidenceAuditId,
    recordedAt: new Date("2000-01-01T00:00:00.000Z"),
  });
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");

  const launchCheckId = randomUUID();
  const routePolicyDigest = "b".repeat(64); const costDigest = "f".repeat(64);
  const readOnlyProfileConfigDigest = amuxV22RecoveryDigest("worker-profile-config", {
    version: 1, profiles: [{ alias: "read-only-worker-two", workerNames: ["worker-two"] }],
  });
  const apiExecutionFrame = {
    version: 1, executorKind: "read_only_api_retry_v1", provider: "anthropic",
    modelId: "claude-opus-5-5", routeId: "read-only-route", routePolicyDigest,
    catalogApprovalId: "catalog-one", catalogVersion: "v1",
    catalogDigest: "c".repeat(64), pricingVersion: "synthetic-price-v1",
    pricingSource: "synthetic-approved-catalog",
    pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
    pricingExpiresAt: "2027-01-11T00:00:00.000Z",
    uncachedInputMicroUsdPerMillion: 15_000_000,
    cacheReadMicroUsdPerMillion: 1_500_000,
    cacheWriteMicroUsdPerMillion: 18_750_000,
    outputMicroUsdPerMillion: 75_000_000,
    tokenLimits: { uncachedInputTokens: 10_000, cacheReadTokens: 10_000,
      cacheWriteTokens: 10_000, outputTokens: 20_000 },
    maxProviderTurns: 8, maxOutputTokensPerTurn: 20_000, maxRetries: 0,
    maximumCostMicroUsd: 3_400_000, credentialProfileId: "synthetic-dedicated-api",
    credentialMetadataDigest: "1".repeat(64), executorArtifactDigest: "2".repeat(64),
    settingsDigest: AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
    repositoryScopeDigest: "3".repeat(64),
    brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
    toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  };
  const nominalScope = apiExecutor ? amuxV22ReadOnlyApiNominalLaunchScope(
    apiExecutionFrame, "6".repeat(64)) : amuxV22ReadOnlyLaunchScope({
    profileConfigDigest: readOnlyProfileConfigDigest });
  const nominalScopeDigest = amuxV22ReadOnlyLaunchScopeDigest(nominalScope);
  const launchBinding = { requestKind: "read_only_launch_check", launchCheckId,
    taskId, taskRevision: 4, priorAttemptId, workerName: "worker-two",
    workerInstanceId: recoveryInstanceId, workerGeneration: 1,
    targetHost: "amux-ubuntu", sourceEvidenceId: safeStopEvidenceId,
    sourceEvidenceDigest: safeStopEvidenceDigest, riskAcceptanceId,
    riskAcceptanceDigest: acceptanceDigest, launchBindingId, briefDigest: digest,
    provider: "anthropic", modelId: "claude-opus-5-5", routeId: "read-only-route",
    routePolicyDigest, catalogApprovalId: "catalog-one", catalogVersion: "v1",
    pricingVersion: "synthetic-price-v1", costReceiptDigest: digest,
    additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
    launchScope: nominalScope, ...(apiExecutor ? { apiExecutionFrame } : {}) };
  const launchRequestDigest = amuxV22RecoveryDigest("read-only-launch-check", launchBinding);
  const launchAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.recovery.read_only_launch_requested",
    targetType: "AmuxV22ReadOnlyLaunchCheck", targetId: launchCheckId,
    summary: "synthetic read-only launch preflight request", metadata: {
      systemActor: "amux-v22-recovery-controller", taskId, priorAttemptId,
      sourceEvidenceId: safeStopEvidenceId, riskAcceptanceId, requestDigest: launchRequestDigest,
      launchBindingId, launchScopeDigest: nominalScopeDigest, workerName: "worker-two",
      provider: "anthropic", modelId: "claude-opus-5-5", routeId: "read-only-route",
      routePolicyDigest, catalogApprovalId: "catalog-one", catalogVersion: "v1",
      pricingVersion: "synthetic-price-v1", costReceiptDigest: digest, costDigest,
      additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
      policyVersion: 40, executionStarted: false, reservationCreated: false,
    } });
  const launchRequestedAt = new Date((await db.query(`SELECT
    ((clock_timestamp() AT TIME ZONE 'UTC') - interval '2 minutes')::timestamp(3) AS now`)).rows[0].now);
  const launchRow = { id: launchCheckId, requestDigest: launchRequestDigest,
    riskAcceptanceId, riskAcceptanceDigest: acceptanceDigest,
    sourceEvidenceId: safeStopEvidenceId, sourceEvidenceDigest: safeStopEvidenceDigest,
    taskId, taskRevision: 4, priorAttemptId, workerName: "worker-two",
    workerInstanceId: recoveryInstanceId, workerGeneration: 1, targetHost: "amux-ubuntu",
    launchBindingId, briefDigest: digest, provider: "anthropic",
    modelId: "claude-opus-5-5", routeId: "read-only-route", routePolicyDigest,
    catalogApprovalId: "catalog-one", catalogVersion: "v1",
    pricingVersion: "synthetic-price-v1", costReceiptDigest: digest, costDigest,
    additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
    launchScope: nominalScope, launchScopeDigest: nominalScopeDigest,
    authorizationAuditLogId: launchAuditId, requestedAt: launchRequestedAt };
  await reject(async () => {
    await db.query(`UPDATE public."AmuxWorkerRuntime"
      SET "protocolCapabilities"=ARRAY[]::text[] WHERE "workerName"='worker-two'`);
    await insert("AmuxV22ReadOnlyLaunchCheck", launchRow);
    await db.query("SET CONSTRAINTS amux_v22_v39_launch_capability_guard_trigger IMMEDIATE");
  }, "AmuxV22ReadOnlyLaunchCheck_current_capability_check");
  if (apiExecutor) {
    const missingFrameDigest = { ...nominalScope };
    delete missingFrameDigest.apiExecutionFrameDigest;
    for (const malformedScope of [
      missingFrameDigest,
      { ...nominalScope, executorKind: "unknown_read_only_executor_v1" },
      { ...nominalScope, unexpected: true },
    ]) {
      await reject(() => insert("AmuxV22ReadOnlyLaunchCheck", {
        ...launchRow, launchScope: malformedScope,
      }), "AmuxV22ReadOnlyLaunchCheck_shape_check");
    }
  }
  await reject(() => insert("AmuxV22ReadOnlyLaunchCheck", { ...launchRow,
    id: randomUUID(), requestDigest: "d".repeat(64), sourceEvidenceId: evidenceId,
    additionalCapMicroUsd: "3400001", worstExposureMicroUsd: "6800001",
    authorizationAuditLogId: randomUUID() }), "AmuxV22ReadOnlyLaunchCheck_shape_check");
  await insert("AmuxV22ReadOnlyLaunchCheck", launchRow);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  const storedLaunch = (await db.query(`SELECT "launchScope" FROM
    public."AmuxV22ReadOnlyLaunchCheck" WHERE "id"=$1`, [launchCheckId])).rows[0];
  assert.deepEqual(storedLaunch.launchScope, nominalScope);

  const actualScope = { ...nominalScope, launcherConfigDigest: "7".repeat(64) };
  const actualScopeDigest = amuxV22ReadOnlyLaunchScopeDigest(actualScope);
  const proofReport = { ...launchBinding, requestDigest: launchRequestDigest,
    launchProofId: randomUUID(), observation: "current", launchScope: actualScope };
  async function appendProofAudit(proofId, proofDigestValue, verified) {
    return appendRecoveryFixtureAudit(db, { actorUserId: null,
      action: "amux.v22.recovery.read_only_launch_observed",
      targetType: "AmuxV22ReadOnlyLaunchProof", targetId: proofId,
      summary: "synthetic trusted read-only launch observation", metadata: {
        systemActor: "amux-v22-recovery-controller", taskId, priorAttemptId,
        launchCheckId, launchBindingId, riskAcceptanceId,
        sourceEvidenceId: safeStopEvidenceId, launchProofDigest: proofDigestValue,
        launchScopeDigest: actualScopeDigest,
        launcherConfigDigest: actualScope.launcherConfigDigest,
        observation: "current", verified, reason: null, policyVersion: 40,
        executionStarted: false,
      } });
  }
  async function appendApprovalAudit(id, ownerRequestId, proofId, proofDigestValue) {
    return appendRecoveryFixtureAudit(db, { actorUserId: "synthetic-owner",
      action: "amux.v22.recovery.approved", targetType: "AmuxV22TaskRecoveryApproval",
      targetId: id, summary: "synthetic exact read-only retry consent", metadata: {
        taskId, inspectionId: safeStopInspectionId, evidenceId: safeStopEvidenceId,
        priorAttemptId, evidenceDigest: safeStopEvidenceDigest, costDigest,
        oldHeldMicroUsd: "3400000", additionalCapMicroUsd: "3400000",
        ownerRequestId, riskAcceptanceId, riskAcceptanceDigest: acceptanceDigest,
        launchProofId: proofId, launchProofDigest: proofDigestValue,
        launchBindingId, launchScopeDigest: actualScopeDigest,
        policyVersion: 40,
      } });
  }
  async function dbNow(offsetMs = 0) {
    return (await db.query(`SELECT ((clock_timestamp() AT TIME ZONE 'UTC') +
      make_interval(secs => $1::double precision / 1000))::timestamp(3) AS now`,
    [offsetMs])).rows[0].now;
  }
  /** The real non-root producer (fixed metadata GET answered by a synthetic
   * active ModelInfo), its canonical digest, and the same-transaction audit the
   * service writes. The audit is appended outside any probe savepoint because
   * the guard requires the top-level transaction XID. */
  async function produceModelAccess(proofId, proofDigestValue) {
    const request = { version: 1, requestId: proofId, taskId, priorAttemptId,
      worker: "worker-two", provider: "anthropic", selectedModelId: "claude-opus-5-5",
      launchProofId: proofId, launchProofDigest: proofDigestValue,
      apiExecutionFrameDigest: actualScope.apiExecutionFrameDigest,
      credentialMetadataDigest: apiExecutionFrame.credentialMetadataDigest,
      launcherConfigDigest: actualScope.launcherConfigDigest };
    let calls = 0;
    const result = await probeAmuxV22ReadOnlyApiModelAccess(request, {
      worker: "worker-two", frame: { provider: "anthropic", modelId: "claude-opus-5-5",
        credentialMetadataDigest: apiExecutionFrame.credentialMetadataDigest },
      apiExecutionFrameDigest: actualScope.apiExecutionFrameDigest,
      launcherConfigDigest: actualScope.launcherConfigDigest,
      apiKey: "synthetic-dedicated-key-not-a-secret" }, { testOnly: true,
      fetcher: async () => { calls += 1; return new Response(JSON.stringify({
        id: "claude-opus-5-5", type: "model", display_name: "Synthetic",
        created_at: "2026-10-01T00:00:00Z", lifecycle: "active" }), { status: 200 }); } });
    assert.equal(calls, 1);
    assert.equal(result.access, "verified");
    const evidenceDigest = amuxV22ApiModelAccessEvidenceDigest(result);
    const auditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
      action: "amux.v22.recovery.api_model_access_observed",
      targetType: "AmuxV22ApiModelAccessEvidence", targetId: proofId,
      summary: "synthetic content-free API model-access observation", metadata: {
        systemActor: "amux-v22-api-model-access", taskId, priorAttemptId,
        workerName: "worker-two", launchProofId: proofId,
        launchProofDigest: proofDigestValue,
        apiExecutionFrameDigest: result.apiExecutionFrameDigest,
        credentialMetadataDigest: result.credentialMetadataDigest,
        launcherConfigDigest: result.launcherConfigDigest,
        selectedModelId: result.selectedModelId,
        canonicalModelId: result.canonicalModelId, access: result.access,
        reason: result.reason, balanceKnown: false,
        maximumCostMicroUsd: result.maximumCostMicroUsd,
        worstExposureMicroUsd: result.worstExposureMicroUsd, evidenceDigest } });
    return { result, evidenceDigest, auditId };
  }
  async function insertModelAccess(produced) {
    const { result, evidenceDigest, auditId } = produced;
    await insert("AmuxV22ApiModelAccessEvidence", { id: result.requestId,
      launchProofId: result.launchProofId, taskId: result.taskId,
      priorAttemptId: result.priorAttemptId, workerName: result.worker,
      workerInstanceId: recoveryInstanceId, workerGeneration: 1,
      provider: result.provider, providerHost: result.providerHost,
      selectedModelId: result.selectedModelId,
      canonicalModelId: result.canonicalModelId,
      apiExecutionFrameDigest: result.apiExecutionFrameDigest,
      credentialMetadataDigest: result.credentialMetadataDigest,
      launcherConfigDigest: result.launcherConfigDigest,
      accessState: result.access, reason: result.reason, balanceKnown: false,
      maximumCostMicroUsd: String(result.maximumCostMicroUsd),
      worstExposureMicroUsd: String(result.worstExposureMicroUsd), evidenceDigest,
      authorizationAuditLogId: auditId, recordedAt: await dbNow() });
    return { apiModelAccessEvidenceId: result.requestId,
      apiModelAccessEvidenceDigest: evidenceDigest,
      canonicalModelId: result.canonicalModelId };
  }
  const approvalAt = (await db.query(`SELECT
    (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)).rows[0].now;
  const approvalBase = { inspectionId: safeStopInspectionId,
    evidenceId: safeStopEvidenceId, taskId, beforeRevision: 4, afterRevision: 5,
    priorAttemptId, evidenceDigest: safeStopEvidenceDigest, costDigest,
    catalogApprovalId: "catalog-one", catalogVersion: "v1",
    pricingVersion: "synthetic-price-v1", costReceiptDigest: digest,
    costReceipt: { synthetic: true, actualProducer: false }, historicalAttempts: 1,
    nextAttemptNumber: 2, oldHeldMicroUsd: "3400000",
    additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
    riskAcceptanceId, riskAcceptanceDigest: acceptanceDigest,
    launchBindingId, launchScopeDigest: actualScopeDigest, workerName: "worker-two",
    provider: "anthropic", modelId: "claude-opus-5-5", routeId: "read-only-route",
    routePolicyDigest, briefDigest: digest,
    profileConfigDigest: apiExecutor ? null : readOnlyProfileConfigDigest,
    approvedByUserId: "synthetic-owner", approvedAt: approvalAt };
  const staleProofId = proofReport.launchProofId;
  const staleProofDigest = amuxV22RecoveryDigest("read-only-launch-proof", proofReport);
  const staleProofAuditId = await appendProofAudit(staleProofId, staleProofDigest, true);
  const staleApprovalId = randomUUID(); const staleApprovalRequestId = randomUUID();
  const staleApprovalAuditId = await appendApprovalAudit(staleApprovalId,
    staleApprovalRequestId, staleProofId, staleProofDigest);
  await reject(async () => {
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    await insert("AmuxV22ReadOnlyLaunchProof", { id: staleProofId, launchCheckId,
      proofDigest: staleProofDigest, observation: "current", report: proofReport,
      verified: true, reason: null, authorizationAuditLogId: staleProofAuditId,
      recordedAt: new Date(launchRequestedAt.getTime() + 1_000) });
    await insert("AmuxV22TaskRecoveryApproval", { ...approvalBase, id: staleApprovalId,
      ownerRequestId: staleApprovalRequestId, launchProofId: staleProofId,
      launchProofDigest: staleProofDigest, authorizationAuditLogId: staleApprovalAuditId });
    await db.query(`UPDATE public."AmuxWorkItem" SET "status"='todo', "revision"=5
      WHERE "id"=$1 AND "status"='blocked' AND "revision"=4`, [taskId]);
    await db.query("SET CONSTRAINTS amux_v22_v39_approval_guard_trigger IMMEDIATE");
  // An API approval of a stale proof cannot carry model-access evidence at all:
  // the evidence insert guard refuses a proof older than 90 seconds, so the
  // BEFORE INSERT access guard refuses first. The deferred v39 freshness check
  // is reached by the CLI executor run (AMUX_RECOVERY_FIXTURE_EXECUTOR_KIND).
  }, apiExecutor ? "AmuxV22RecoveryApproval_api_access_binding_check" :
    "AmuxV22RecoveryApproval_v39_binding_check");

  if (apiExecutor && !positiveOnly) {
    // Policy v42 late report: proof at T0, cached model-access result reported
    // near T0+85 s. The evidence is fresh, but claim and start must still close
    // 90 seconds after the proof, never 90 seconds after the report.
    const originalForProbe = (await db.query(`SELECT * FROM public."AmuxV22WorkerAssignment"
      WHERE "id"=$1`, [priorAssignmentId])).rows[0];
    for (const stage of ["claim", "start"]) {
      const lateProofId = randomUUID();
      const lateReport = { ...proofReport, launchProofId: lateProofId };
      const lateDigest = amuxV22RecoveryDigest("read-only-launch-proof", lateReport);
      const lateProofAuditId = await appendProofAudit(lateProofId, lateDigest, true);
      const lateAccess = await produceModelAccess(lateProofId, lateDigest);
      const lateApprovalId = randomUUID(); const lateRequestId = randomUUID();
      const lateApprovalAuditId = await appendApprovalAudit(lateApprovalId,
        lateRequestId, lateProofId, lateDigest);
      const lateAssignmentId = randomUUID();
      const lateAssignmentAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
        action: "amux.v22.worker.assigned", targetType: "AmuxV22WorkerAssignment",
        targetId: lateAssignmentId, summary: "synthetic late-report assignment probe",
        metadata: { systemActor: "amux-v22-worker-claim", taskId,
          workerName: "worker-two", lane: "sev1", recoveryApprovalId: lateApprovalId,
          recoveryCostDigest: costDigest } });
      await reject(async () => {
        await db.query("SET CONSTRAINTS ALL DEFERRED");
        await insert("AmuxV22ReadOnlyLaunchProof", { id: lateProofId, launchCheckId,
          proofDigest: lateDigest, observation: "current", report: lateReport,
          verified: true, reason: null, authorizationAuditLogId: lateProofAuditId,
          recordedAt: await dbNow(-85_000) });
        const binding = await insertModelAccess(lateAccess);
        await insert("AmuxV22TaskRecoveryApproval", { ...approvalBase, ...binding,
          id: lateApprovalId, ownerRequestId: lateRequestId, launchProofId: lateProofId,
          launchProofDigest: lateDigest, authorizationAuditLogId: lateApprovalAuditId,
          approvedAt: await dbNow() });
        assert.equal((await db.query(`UPDATE public."AmuxWorkItem" SET "status"='todo',
          "revision"=5 WHERE "id"=$1 AND "status"='blocked' AND "revision"=4`,
        [taskId])).rowCount, 1);
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        const lateAssignment = { ...originalForProbe, id: lateAssignmentId,
          promotionReceiptId: promotionId, laneDecisionSequence: laneSequence,
          taskRevision: 5, workerName: "worker-two", workerInstanceId: recoveryInstanceId,
          workerGeneration: 1, provider: "anthropic", modelId: "claude-opus-5-5",
          routeId: "read-only-route", routePolicyDigest, catalogApprovalId: "catalog-one",
          catalogVersion: "v1", costReceiptDigest: digest, perAttemptMicroUsd: "3400000",
          recoveryApprovalId: lateApprovalId, authorizationAuditLogId: lateAssignmentAuditId };
        if (stage === "claim") {
          await db.query("SELECT pg_sleep(6)");
          await db.query("SET CONSTRAINTS ALL DEFERRED");
          await insert("AmuxV22WorkerAssignment", { ...lateAssignment,
            assignedAt: await dbNow() });
          return;
        }
        await db.query("SET CONSTRAINTS ALL DEFERRED");
        const assignedAt = await dbNow();
        await insert("AmuxV22WorkerAssignment", { ...lateAssignment, assignedAt });
        await db.query(`UPDATE public."AmuxWorkItem" SET "owner"='worker-two', "claimedAt"=$3,
          "v22AssignmentId"=$2, "revision"=6 WHERE "id"=$1`, [taskId, lateAssignmentId, assignedAt]);
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        await db.query("SELECT pg_sleep(6)");
        await db.query("SET CONSTRAINTS ALL DEFERRED");
        await db.query(`UPDATE public."AmuxWorkItem" SET "status"='doing', "revision"=7
          WHERE "id"=$1`, [taskId]);
        const startedAt = await dbNow();
        await insert("AmuxExecutionAttempt", { ...oldAttempt, id: randomUUID(),
          taskRevision: 7, attemptNumber: 2, worker: "worker-two",
          workerInstanceId: recoveryInstanceId, workerGeneration: 1, endedAt: null,
          outcome: null, toStatus: null, endedBy: null, reason: null,
          heartbeatAt: startedAt, startedAt,
          leaseExpiresAt: new Date(startedAt.getTime() + 90_000),
          v22AssignmentId: lateAssignmentId });
        await db.query("SET CONSTRAINTS amux_v22_v42_attempt_launch_proof_deadline IMMEDIATE");
      }, "AmuxV22Recovery_api_launch_proof_deadline_check");
    }
  }

  const launchProofId = randomUUID();
  const currentProofReport = { ...proofReport, launchProofId };
  const launchProofDigest = amuxV22RecoveryDigest("read-only-launch-proof", currentProofReport);
  const proofAuditId = await appendProofAudit(launchProofId, launchProofDigest, true);
  const proofRecordedAt = (await db.query(`SELECT
    (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)).rows[0].now;
  await insert("AmuxV22ReadOnlyLaunchProof", { id: launchProofId, launchCheckId,
    proofDigest: launchProofDigest, observation: "current", report: currentProofReport,
    verified: true, reason: null, authorizationAuditLogId: proofAuditId,
    recordedAt: proofRecordedAt });
  const accessBinding = apiExecutor ? await insertModelAccess(
    await produceModelAccess(launchProofId, launchProofDigest)) : {};
  // The API approval must follow its model-access evidence (approvedAt >= recordedAt).
  const mainApprovalAt = apiExecutor ? await dbNow() : approvalAt;

  const ownerApprovalRequestId = randomUUID();
  const approvalAuditId = await appendApprovalAudit(approvalId,
    ownerApprovalRequestId, launchProofId, launchProofDigest);
  const approvalRow = { ...approvalBase, ...accessBinding, id: approvalId,
    ownerRequestId: ownerApprovalRequestId, launchProofId, launchProofDigest,
    authorizationAuditLogId: approvalAuditId, approvedAt: mainApprovalAt };
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  await insert("AmuxV22TaskRecoveryApproval", approvalRow);
  const cas = await db.query(`UPDATE public."AmuxWorkItem" SET "status"='todo', "revision"=5
    WHERE "id"=$1 AND "status"='blocked' AND "revision"=4 AND "owner" IS NULL
      AND "claimedAt" IS NULL AND "v22AssignmentId" IS NULL`, [taskId]);
  assert.equal(cas.rowCount, 1);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  const storedApproval = (await db.query(`SELECT * FROM public."AmuxV22TaskRecoveryApproval"
    WHERE "id"=$1`, [approvalId])).rows[0];
  assert.equal(BigInt(storedApproval.oldHeldMicroUsd), 3_400_000n);
  assert.equal(BigInt(storedApproval.additionalCapMicroUsd), 3_400_000n);
  assert.equal(BigInt(storedApproval.worstExposureMicroUsd), 6_800_000n);
  assert.equal((await db.query(`UPDATE public."AmuxWorkItem" SET "revision"=5
    WHERE "id"=$1 AND "status"='blocked' AND "revision"=4`, [taskId])).rowCount, 0);
  for (const table of ["AmuxV22TaskRecoveryInspectionRequest", "AmuxV22TaskRecoveryEvidence",
    "AmuxV22TaskRecoveryApproval"]) {
    await reject(() => db.query(`UPDATE public."${table}" SET "id"="id" WHERE false`), "AmuxV22Recovery_append_only_check");
    await reject(() => db.query(`DELETE FROM public."${table}" WHERE false`), "AmuxV22Recovery_append_only_check");
  }
  for (const [table, id] of [
    ["AmuxV22TaskRecoveryRiskAcceptance", riskAcceptanceId],
    ["AmuxV22ReadOnlyLaunchCheck", launchCheckId],
    ["AmuxV22ReadOnlyLaunchProof", launchProofId],
  ]) {
    await reject(() => db.query(`UPDATE public."${table}" SET "id"="id" WHERE "id"=$1`, [id]),
      "AmuxV22V39_append_only_check");
    await reject(() => db.query(`DELETE FROM public."${table}" WHERE "id"=$1`, [id]),
      "AmuxV22V39_append_only_check");
  }
  await reject(() => db.query(`DELETE FROM public."AdminAuditLog" WHERE "id"=$1`, [approvalAuditId]),
    null);
  await reject(() => insert("AmuxV22TaskRecoveryApproval", { ...approvalRow, id: randomUUID(), nextAttemptNumber: 6 }),
    "AmuxV22RecoveryApproval_shape_check");
  const duplicateApprovalId = randomUUID(); const duplicateOwnerRequestId = randomUUID();
  const duplicateApprovalAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: "synthetic-owner",
    action: "amux.v22.recovery.approved", targetType: "AmuxV22TaskRecoveryApproval",
    targetId: duplicateApprovalId, summary: "synthetic duplicate additional attempt probe",
    metadata: { taskId, inspectionId: safeStopInspectionId, evidenceId: safeStopEvidenceId,
      priorAttemptId, evidenceDigest: safeStopEvidenceDigest, costDigest,
      oldHeldMicroUsd: "3400000", additionalCapMicroUsd: "3400000",
      ownerRequestId: duplicateOwnerRequestId },
  });
  await reject(() => insert("AmuxV22TaskRecoveryApproval", { ...approvalRow,
    id: duplicateApprovalId, ownerRequestId: duplicateOwnerRequestId,
    authorizationAuditLogId: duplicateApprovalAuditId }),
  ["AmuxV22TaskRecoveryApproval_inspectionId_key",
    "AmuxV22TaskRecoveryApproval_evidenceId_key"], "23505");
  const assignmentId = randomUUID();
  const originalAssignment = (await db.query(`SELECT * FROM public."AmuxV22WorkerAssignment" WHERE "id"=$1`, [priorAssignmentId])).rows[0];
  const assignmentAt = mainApprovalAt;
  const assignmentBase = { ...originalAssignment,
    promotionReceiptId: promotionId, laneDecisionSequence: laneSequence, taskRevision: 5,
    workerName: "worker-two", workerInstanceId: recoveryInstanceId, workerGeneration: 1,
    provider: "anthropic", modelId: "claude-opus-5-5", routeId: "read-only-route",
    routePolicyDigest, catalogApprovalId: "catalog-one", catalogVersion: "v1",
    costReceiptDigest: digest, perAttemptMicroUsd: "3400000", assignedAt: assignmentAt };
  const unapprovedAssignmentId = randomUUID();
  const unapprovedAuditId = positiveOnly ? null : await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.worker.assigned", targetType: "AmuxV22WorkerAssignment",
    targetId: unapprovedAssignmentId, summary: "synthetic unapproved assignment probe",
    metadata: { systemActor: "amux-v22-worker-claim", taskId,
      workerName: "worker-two", lane: "sev1" } });
  await reject(async () => {
    await db.query(`SET CONSTRAINTS
      amux_v22_assignment_row_guard_trigger,
      amux_v22_recovery_assignment_guard_trigger,
      amux_v22_v39_assignment_guard_trigger,
      amux_v22_v39_assignment_capability_guard_trigger DEFERRED`);
    await insert("AmuxV22WorkerAssignment", { ...assignmentBase,
      id: unapprovedAssignmentId, recoveryApprovalId: null,
      authorizationAuditLogId: unapprovedAuditId });
    await db.query("SET CONSTRAINTS amux_v22_v39_attempt_guard_trigger DEFERRED");
    await insert("AmuxExecutionAttempt", { ...oldAttempt, id: randomUUID(),
      taskRevision: 7, attemptNumber: 2, worker: "worker-two",
      workerInstanceId: recoveryInstanceId, workerGeneration: 1,
      endedAt: assignmentAt, outcome: "failed", toStatus: "todo",
      endedBy: "worker-two", reason: "reported_result",
      heartbeatAt: assignmentAt, leaseExpiresAt: null, startedAt: assignmentAt,
      v22AssignmentId: unapprovedAssignmentId });
    await db.query("SET CONSTRAINTS amux_v22_v39_attempt_guard_trigger IMMEDIATE");
  }, "AmuxV22RecoveryAttempt_v39_limit_check");
  const assignmentAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.worker.assigned", targetType: "AmuxV22WorkerAssignment", targetId: assignmentId,
    summary: "synthetic recovery assignment", metadata: { systemActor: "amux-v22-worker-claim", taskId,
      workerName: "worker-two", lane: "sev1", recoveryApprovalId: approvalId, recoveryCostDigest: costDigest } });
  const recoveryAssignment = { ...assignmentBase, id: assignmentId,
    recoveryApprovalId: approvalId, authorizationAuditLogId: assignmentAuditId, assignedAt: assignmentAt };
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  await insert("AmuxV22WorkerAssignment", recoveryAssignment);
  await db.query(`UPDATE public."AmuxWorkItem" SET "owner"='worker-two', "claimedAt"=$3,
    "v22AssignmentId"=$2, "revision"=6 WHERE "id"=$1`, [taskId, assignmentId, assignmentAt]);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  await reject(() => insert("AmuxV22WorkerAssignment", { ...recoveryAssignment, id: randomUUID(),
    recoveryApprovalId: approvalId, authorizationAuditLogId: randomUUID() }),
    "AmuxV22WorkerAssignment_recoveryApprovalId_key", "23505");
  const newAttemptId = randomUUID();
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  await db.query(`UPDATE public."AmuxWorkItem" SET "status"='doing', "revision"=7 WHERE "id"=$1`, [taskId]);
  const newAttempt = { ...oldAttempt, id: newAttemptId, taskRevision: 7, attemptNumber: 2,
    worker: "worker-two", workerInstanceId: recoveryInstanceId, workerGeneration: 1,
    endedAt: null, outcome: null, toStatus: null, endedBy: null, reason: null,
    heartbeatAt: assignmentAt, leaseExpiresAt: new Date(assignmentAt.getTime() + 90_000), startedAt: assignmentAt,
    v22AssignmentId: assignmentId };
  await insert("AmuxExecutionAttempt", newAttempt);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  await insert("AmuxWorkDelivery", { attemptId: newAttemptId, taskId, worker: "worker-two",
    workerInstanceId: recoveryInstanceId, workerGeneration: 1, taskRevision: 7,
    prompt: "synthetic", status: "queued", receiptId: null, leasedAt: null,
    leaseExpiresAt: null, acknowledgedAt: null, cancelledAt: null,
    createdAt: assignmentAt, updatedAt: assignmentAt });
  await input.afterReadOnlyAttemptStarted?.({ attemptId: newAttemptId,
    approvalId, taskId, taskRevision: 7, assignmentId, worker: "worker-two",
    attemptStartedAt: new Date(newAttempt.startedAt),
    launchScopeDigest: actualScopeDigest,
    apiExecutionFrame: apiExecutor ? currentProofReport.apiExecutionFrame : null });
  const fenceState = await db.query(`SELECT
    amux_v22_legacy_safe_stop_worker_fenced('worker-one') AS physical_fenced,
    amux_v22_legacy_safe_stop_worker_fenced('worker-two') AS recovery_fenced`);
  assert.deepEqual(fenceState.rows[0], { physical_fenced: true, recovery_fenced: false });
  const recoveredTask = (await db.query(`SELECT "status", "owner", "v22AssignmentId"
    FROM public."AmuxWorkItem" WHERE "id"=$1`, [taskId])).rows[0];
  assert.deepEqual(recoveredTask, { status: "doing", owner: "worker-two", v22AssignmentId: assignmentId });
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxExecutionAttempt" WHERE "id"=$1`, [priorAttemptId])).rows[0], oldAttempt);
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxCostLedgerEntry" WHERE "attemptId"=$1`, [priorAttemptId])).rows, oldLedger);
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxCliUsageEvent" WHERE "attemptId"=$1`, [priorAttemptId])).rows, oldUsage);
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxIdeaUnitDecision" WHERE "id"=$1`, [sourceApprovalId])).rows[0], oldSourceApproval);
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxV22TaskRecoveryApproval" WHERE "id"=$1`, [approvalId])).rows[0], storedApproval);
  assert.equal((await db.query(`SELECT sum("reservedCostMicrousd")::text AS held FROM public."AmuxExecutionAttempt" WHERE "taskId"=$1`, [taskId])).rows[0].held, "6800000");
  await reject(() => insert("AmuxExecutionAttempt", { ...newAttempt, id: randomUUID(), attemptNumber: 3 }),
    "AmuxExecutionAttempt_v22AssignmentId_key", "23505");
  const thirdAssignmentId = randomUUID();
  const thirdAuditId = positiveOnly ? null : await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.worker.assigned", targetType: "AmuxV22WorkerAssignment",
    targetId: thirdAssignmentId, summary: "synthetic third assignment probe",
    metadata: { systemActor: "amux-v22-worker-claim", taskId,
      workerName: "worker-two", lane: "sev1" } });
  await reject(async () => {
    await db.query(`SET CONSTRAINTS
      amux_v22_assignment_row_guard_trigger,
      amux_v22_recovery_assignment_guard_trigger,
      amux_v22_v39_assignment_guard_trigger,
      amux_v22_v39_assignment_capability_guard_trigger DEFERRED`);
    await insert("AmuxV22WorkerAssignment", { ...assignmentBase,
      id: thirdAssignmentId, recoveryApprovalId: null,
      authorizationAuditLogId: thirdAuditId });
    await db.query("SET CONSTRAINTS amux_v22_v39_attempt_guard_trigger DEFERRED");
    await insert("AmuxExecutionAttempt", { ...newAttempt, id: randomUUID(),
      attemptNumber: 3, endedAt: assignmentAt, outcome: "failed",
      toStatus: "todo", endedBy: "worker-two", reason: "reported_result",
      leaseExpiresAt: null, v22AssignmentId: thirdAssignmentId });
    await db.query("SET CONSTRAINTS amux_v22_v39_attempt_guard_trigger IMMEDIATE");
  }, "AmuxV22RecoveryAttempt_v39_limit_check");
  await reject(async () => {
    await insert("AmuxExecutionAttempt", { ...newAttempt, id: randomUUID(),
      attemptNumber: 3, v22AssignmentId: null });
    await db.query("SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger IMMEDIATE");
  }, "AmuxExecutionAttempt_v22_binding_check");
  return { safeStopFenceInput: { safeStopRequestId: safeStopInspectionId,
    assignmentTemplateId: priorAssignmentId, attemptTemplateId: priorAttemptId,
    deliveryTemplateAttemptId: priorAttemptId } };
}

/** Rollback-only Phase 3 helper. The caller supplies one already-inserted
 * safe-stop request plus representative rows to clone. A different runtime
 * identity and generation must not release the permanent physical fence. */
export async function exerciseAmuxV22LegacySafeStopFenceFixture(db, input) {
  const request = await db.query(`SELECT "profileWorkerNames", "taskId"
    FROM public."AmuxV22TaskRecoveryInspectionRequest"
    WHERE "id"=$1 AND "requestKind"='safe_stop'`, [input.safeStopRequestId]);
  assert.equal(request.rowCount, 1, "safe-stop request fixture is required");
  const workers = request.rows[0].profileWorkerNames;
  const taskId = request.rows[0].taskId;
  assert.ok(Array.isArray(workers) && workers.length > 0);
  const worker = workers[0];
  async function rejectFence(callback) {
    await db.query("SAVEPOINT safe_stop_fence_probe"); let error;
    try { await callback(); } catch (caught) { error = caught; }
    await db.query("ROLLBACK TO SAVEPOINT safe_stop_fence_probe");
    await db.query("RELEASE SAVEPOINT safe_stop_fence_probe");
    assert.equal(error?.code, "23514", error?.message);
    assert.equal(error?.constraint, "AmuxV22LegacySafeStop_worker_fenced_check",
      error?.message);
  }
  await rejectFence(() => db.query(`INSERT INTO public."AmuxV22WorkerAssignment"
    SELECT (jsonb_populate_record(NULL::public."AmuxV22WorkerAssignment",
      to_jsonb(source) || jsonb_build_object('id',$2::uuid,'workerName',$1::text,
        'workerInstanceId',$3::text,'workerGeneration',2147483647,
        'authorizationAuditLogId',$4::text,'recoveryApprovalId',NULL))).*
    FROM public."AmuxV22WorkerAssignment" source WHERE source."id"=$5`,
  [worker, randomUUID(), randomUUID(), randomUUID(), input.assignmentTemplateId]));
  await rejectFence(() => db.query(`INSERT INTO public."AmuxExecutionAttempt"
    SELECT (jsonb_populate_record(NULL::public."AmuxExecutionAttempt",
      to_jsonb(source) || jsonb_build_object('id',$2::text,'worker',$1::text,
        'workerInstanceId',$3::text,'workerGeneration',2147483647,
        'v22AssignmentId',NULL))).*
    FROM public."AmuxExecutionAttempt" source WHERE source."id"=$4`,
  [worker, randomUUID(), randomUUID(), input.attemptTemplateId]));
  await rejectFence(() => db.query(`INSERT INTO public."AmuxWorkDelivery"
    SELECT (jsonb_populate_record(NULL::public."AmuxWorkDelivery",
      to_jsonb(source) || jsonb_build_object('attemptId',$2::text,'worker',$1::text,
        'workerInstanceId',$3::text,'workerGeneration',2147483647,'receiptId',NULL))).*
    FROM public."AmuxWorkDelivery" source WHERE source."attemptId"=$4`,
  [worker, randomUUID(), randomUUID(), input.deliveryTemplateAttemptId]));
  await rejectFence(() => db.query(`UPDATE public."AmuxWorkDelivery"
    SET "worker"=$1, "workerInstanceId"=$2, "workerGeneration"=2147483647,
      "status"='leased', "receiptId"=$3, "leasedAt"=clock_timestamp(),
      "leaseExpiresAt"=clock_timestamp() + interval '30 seconds'
    WHERE "attemptId"=$4`,
  [worker, randomUUID(), randomUUID(), input.deliveryTemplateAttemptId]));
  await rejectFence(() => db.query(`UPDATE public."AmuxWorkItem"
    SET "owner"=$1, "claimedAt"=clock_timestamp(), "revision"="revision"+1
    WHERE "id"=$2`, [worker, taskId]));
  await rejectFence(() => db.query(`UPDATE public."AmuxWorkItem"
    SET "owner"=$1, "status"='doing', "revision"="revision"+1
    WHERE "id"=$2`, [worker, taskId]));
}
