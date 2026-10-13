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
  const { taskId, priorAttemptId, priorAssignmentId, promotionId, instanceId, laneSequence, digest } = input;
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
    if (expectedConstraint) assert.equal(error.constraint, expectedConstraint, error.message);
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
  await reject(() => db.query(`UPDATE public."AmuxExecutionAttempt" SET "reservedCostMicrousd"=0 WHERE "id"=$1`, [priorAttemptId]),
    "AmuxV22Recovery_prior_attempt_immutable_check");
  await reject(() => db.query(`DELETE FROM public."AmuxExecutionAttempt" WHERE "id"=$1`, [priorAttemptId]),
    "AmuxV22Recovery_prior_attempt_immutable_check");
  const report = { ...binding, evidenceId, requestDigest, hostInvocationId: "e".repeat(32),
    proof: { terminalOutcome: "unknown", sameLiveInvocation: true, noActiveExecution: true,
      processTreeStopped: true, rootOwnedUnit: true, controlGroupBound: true, journalBound: true,
      socketTerminal: true, externalEffectsKnown: true, workspaceClean: true },
    usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "stopped_proven" };
  const evidenceDigest = amuxV22RecoveryDigest("evidence", report);
  const evidenceAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.recovery.inspected", targetType: "AmuxV22TaskRecoveryEvidence", targetId: evidenceId,
    summary: "synthetic content-free proof", metadata: { systemActor: "amux-v22-recovery-checker",
      taskId, inspectionId, priorAttemptId, evidenceDigest } });
  const evidenceRow = { id: evidenceId, inspectionId, hostInvocationId: report.hostInvocationId,
    report, evidenceDigest, verified: true, reason: null, authorizationAuditLogId: evidenceAuditId,
    recordedAt: new Date("2000-01-01T00:00:00.000Z") };
  await reject(() => insert("AmuxV22TaskRecoveryEvidence", { ...evidenceRow, report: { ...report, stdout: "forbidden" } }),
    "AmuxV22RecoveryEvidence_binding_check");
  await insert("AmuxV22TaskRecoveryEvidence", evidenceRow);
  const evidence = (await db.query(`SELECT * FROM public."AmuxV22TaskRecoveryEvidence" WHERE "id"=$1`, [evidenceId])).rows[0];
  assert.ok(evidence.recordedAt.getTime() >= requestedAt.getTime(), "DB must replace caller timestamp");
  const costDigest = "f".repeat(64); const ownerApprovalRequestId = randomUUID();
  const approvalAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: "synthetic-owner",
    action: "amux.v22.recovery.approved", targetType: "AmuxV22TaskRecoveryApproval", targetId: approvalId,
    summary: "synthetic exact additional attempt cap", metadata: { taskId, inspectionId, evidenceId,
      priorAttemptId, evidenceDigest, costDigest, oldHeldMicroUsd: "1000", additionalCapMicroUsd: "1000",
      ownerRequestId: ownerApprovalRequestId } });
  const approvalRow = { id: approvalId, ownerRequestId: ownerApprovalRequestId, inspectionId, evidenceId, taskId,
    beforeRevision: 4, afterRevision: 5, priorAttemptId, evidenceDigest, costDigest, catalogApprovalId: "catalog-one",
    catalogVersion: "v1", pricingVersion: "synthetic-price-v1", costReceiptDigest: digest,
    costReceipt: { synthetic: true }, historicalAttempts: 1, nextAttemptNumber: 2,
    oldHeldMicroUsd: "1000", additionalCapMicroUsd: "1000", worstExposureMicroUsd: "2000",
    approvedByUserId: "synthetic-owner", authorizationAuditLogId: approvalAuditId, approvedAt: requestedAt };
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  await insert("AmuxV22TaskRecoveryApproval", approvalRow);
  const cas = await db.query(`UPDATE public."AmuxWorkItem" SET "status"='todo', "revision"=5
    WHERE "id"=$1 AND "status"='blocked' AND "revision"=4 AND "owner" IS NULL
      AND "claimedAt" IS NULL AND "v22AssignmentId" IS NULL`, [taskId]);
  assert.equal(cas.rowCount, 1);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
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
  const assignmentId = randomUUID();
  const assignmentAuditId = await appendRecoveryFixtureAudit(db, { actorUserId: null,
    action: "amux.v22.worker.assigned", targetType: "AmuxV22WorkerAssignment", targetId: assignmentId,
    summary: "synthetic recovery assignment", metadata: { systemActor: "amux-v22-worker-claim", taskId,
      workerName: "worker-one", lane: "sev1", recoveryApprovalId: approvalId, recoveryCostDigest: costDigest } });
  const originalAssignment = (await db.query(`SELECT * FROM public."AmuxV22WorkerAssignment" WHERE "id"=$1`, [priorAssignmentId])).rows[0];
  const assignmentAt = requestedAt;
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  await insert("AmuxV22WorkerAssignment", { ...originalAssignment, id: assignmentId,
    promotionReceiptId: promotionId, laneDecisionSequence: laneSequence, taskRevision: 5,
    recoveryApprovalId: approvalId, authorizationAuditLogId: assignmentAuditId, assignedAt: assignmentAt });
  await db.query(`UPDATE public."AmuxWorkItem" SET "owner"='worker-one', "claimedAt"=$3,
    "v22AssignmentId"=$2, "revision"=6 WHERE "id"=$1`, [taskId, assignmentId, assignmentAt]);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  await reject(() => insert("AmuxV22WorkerAssignment", { ...originalAssignment, id: randomUUID(),
    recoveryApprovalId: approvalId, authorizationAuditLogId: randomUUID() }),
    "AmuxV22WorkerAssignment_recoveryApprovalId_key", "23505");
  const newAttemptId = randomUUID();
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  await db.query(`UPDATE public."AmuxWorkItem" SET "status"='doing', "revision"=7 WHERE "id"=$1`, [taskId]);
  const newAttempt = { ...oldAttempt, id: newAttemptId, taskRevision: 7, attemptNumber: 2,
    endedAt: null, outcome: null, toStatus: null, endedBy: null, reason: null,
    heartbeatAt: requestedAt, leaseExpiresAt: new Date(requestedAt.getTime() + 90_000), startedAt: requestedAt,
    v22AssignmentId: assignmentId };
  await insert("AmuxExecutionAttempt", newAttempt);
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxExecutionAttempt" WHERE "id"=$1`, [priorAttemptId])).rows[0], oldAttempt);
  assert.deepEqual((await db.query(`SELECT * FROM public."AmuxCostLedgerEntry" WHERE "attemptId"=$1`, [priorAttemptId])).rows, oldLedger);
  assert.equal((await db.query(`SELECT sum("reservedCostMicrousd")::text AS held FROM public."AmuxExecutionAttempt" WHERE "taskId"=$1`, [taskId])).rows[0].held, "2000");
  await reject(() => insert("AmuxExecutionAttempt", { ...newAttempt, id: randomUUID(), attemptNumber: 3 }),
    "AmuxExecutionAttempt_v22AssignmentId_key", "23505");
}
