import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { amuxV22RecoveryDigest } from "../../../lib/amux/v22TaskRecoveryCore.ts";

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
 * cover separately. All original source/promotion/assignment guards stay on. */
export async function exerciseAmuxV22TaskRecoveryFixture(db, input) {
  const { taskId, priorAttemptId, priorAssignmentId, promotionId, instanceId,
    recoveryInstanceId, laneSequence, digest, sourceApprovalId } = input;
  const inspectionId = randomUUID(); const evidenceId = randomUUID(); const approvalId = randomUUID();
  async function insert(table, data) {
    const keys = Object.keys(data);
    return db.query(`INSERT INTO public."${table}" (${keys.map((key) => `"${key}"`).join(",")})
      VALUES (${keys.map((_key, index) => `$${index + 1}`).join(",")})`, Object.values(data));
  }
  async function reject(callback, expectedConstraint, expectedCode = "23514") {
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
  const report = { ...binding, evidenceId, requestDigest, hostInvocationId: null,
    proof: { terminalOutcome: "unknown", sameLiveInvocation: false, noActiveExecution: false,
      processTreeStopped: false, rootOwnedUnit: true, controlGroupBound: true, journalBound: true,
      socketTerminal: false, externalEffectsKnown: true, workspaceClean: true },
    usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "legacy_invocation_unbound" };
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

  const safeStopInspectionId = randomUUID(); const safeStopEvidenceId = randomUUID();
  const safeStopOwnerRequestId = randomUUID(); const workerProfileAlias = "legacy-worker-one";
  const profileWorkerNames = ["worker-one"];
  const targetUnit = `tomverse-amux-v22-sidecar@${workerProfileAlias}.service`;
  const profileConfigDigest = amuxV22RecoveryDigest("worker-profile-config", {
    version: 1, profiles: [{ alias: workerProfileAlias, workerNames: profileWorkerNames }],
  });
  const safeStopBinding = { inspectionId: safeStopInspectionId, requestKind: "safe_stop",
    taskId, taskRevision: 4, priorAttemptId, priorAttemptTaskRevision: 3,
    workerName: "worker-one", workerInstanceId: instanceId, workerGeneration: 1,
    targetHost: "amux-ubuntu", sourceEvidenceId: evidenceId,
    sourceEvidenceDigest: evidenceDigest, workerProfileAlias, profileWorkerNames,
    targetUnit, profileConfigDigest };
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
    priorAttemptTaskRevision: 3, workerName: "worker-one", workerInstanceId: instanceId,
    workerGeneration: 1, targetHost: "amux-ubuntu", requestDigest: safeStopRequestDigest,
    sourceEvidenceId: evidenceId, sourceEvidenceDigest: evidenceDigest,
    workerProfileAlias, profileWorkerNames, targetUnit, profileConfigDigest,
    requestedByUserId: "synthetic-owner", authorizationAuditLogId: safeStopRequestAuditId,
    requestedAt: safeStopRequestedAt,
  });
  const journalBindingDigest = amuxV22RecoveryDigest("stop-journal-binding", {
    taskId, priorAttemptId, workerProfileAlias, targetUnit,
  });
  const journalEntryDigest = amuxV22RecoveryDigest("stop-journal-entry", {
    version: 1, journalBindingDigest, taskId, priorAttemptId, workerProfileAlias, targetUnit,
  });
  const safeStopReport = { ...safeStopBinding, evidenceId: safeStopEvidenceId,
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
  const approvalAt = (await db.query(`SELECT
    (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)).rows[0].now;
  const costDigest = "f".repeat(64); const ownerApprovalRequestId = randomUUID();
  const approvalAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: "synthetic-owner",
    action: "amux.v22.recovery.approved", targetType: "AmuxV22TaskRecoveryApproval", targetId: approvalId,
    summary: "synthetic exact additional attempt cap", metadata: { taskId,
      inspectionId: safeStopInspectionId, evidenceId: safeStopEvidenceId,
      priorAttemptId, evidenceDigest: safeStopEvidenceDigest, costDigest,
      oldHeldMicroUsd: "3400000", additionalCapMicroUsd: "3400000",
      ownerRequestId: ownerApprovalRequestId } });
  const approvalRow = { id: approvalId, ownerRequestId: ownerApprovalRequestId,
    inspectionId: safeStopInspectionId, evidenceId: safeStopEvidenceId, taskId,
    beforeRevision: 4, afterRevision: 5, priorAttemptId,
    evidenceDigest: safeStopEvidenceDigest, costDigest, catalogApprovalId: "catalog-one",
    catalogVersion: "v1", pricingVersion: "synthetic-price-v1", costReceiptDigest: digest,
    costReceipt: { synthetic: true }, historicalAttempts: 1, nextAttemptNumber: 2,
    oldHeldMicroUsd: "3400000", additionalCapMicroUsd: "3400000",
    worstExposureMicroUsd: "6800000", approvedByUserId: "synthetic-owner",
    authorizationAuditLogId: approvalAuditId, approvedAt: approvalAt };
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
  for (const table of ["AmuxV22TaskRecoveryInspectionRequest", "AmuxV22TaskRecoveryEvidence", "AmuxV22TaskRecoveryApproval"]) {
    await reject(() => db.query(`UPDATE public."${table}" SET "id"="id" WHERE false`), "AmuxV22Recovery_append_only_check");
    await reject(() => db.query(`DELETE FROM public."${table}" WHERE false`), "AmuxV22Recovery_append_only_check");
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
  const assignmentAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.worker.assigned", targetType: "AmuxV22WorkerAssignment", targetId: assignmentId,
    summary: "synthetic recovery assignment", metadata: { systemActor: "amux-v22-worker-claim", taskId,
      workerName: "worker-two", lane: "sev1", recoveryApprovalId: approvalId, recoveryCostDigest: costDigest } });
  const originalAssignment = (await db.query(`SELECT * FROM public."AmuxV22WorkerAssignment" WHERE "id"=$1`, [priorAssignmentId])).rows[0];
  const assignmentAt = approvalAt;
  const recoveryAssignment = { ...originalAssignment, id: assignmentId,
    promotionReceiptId: promotionId, laneDecisionSequence: laneSequence, taskRevision: 5,
    workerName: "worker-two", workerInstanceId: recoveryInstanceId, workerGeneration: 1,
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
  await reject(async () => {
    await insert("AmuxExecutionAttempt", { ...newAttempt, id: randomUUID(),
      attemptNumber: 6, v22AssignmentId: null });
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
