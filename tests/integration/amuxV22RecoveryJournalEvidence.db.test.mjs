import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";

import { createAmuxV22SidecarHandler } from "../../lib/amux/v22OneShotSidecar.mjs";
import { amuxV22RecoveryDigest } from "../../lib/amux/v22TaskRecoveryCore.ts";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

/** The evidence guard requires the audit row of this top-level transaction. */
async function appendAudit(db, input) {
  await db.query("SAVEPOINT journal_audit_transaction_required");
  await db.query("RELEASE SAVEPOINT journal_audit_transaction_required");
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
  return id;
}

// Owner decision 2026-11-07: a sidecar that restarted after the prior run
// proves that run's end from the terminal journal it wrote. The database
// admits that reason as verified only with every stop proof and a clean
// checkout, and never lets stopped_proven skip the same live invocation.
test("the evidence guard admits a journal-proven terminal and nothing weaker", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-journal-db-"));
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(client, {
      recoveryExecutorKind: "read_only_api_retry_v1" });
    const { taskId, priorAttemptId, instanceId } = seed;
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`UPDATE public."AmuxExecutionAttempt" SET "outcome"='expired',
      "toStatus"='blocked', "reason"='outcome_unknown' WHERE "id"=$1`, [priorAttemptId]);
    await client.query(`UPDATE public."AmuxWorkItem" SET "status"='blocked' WHERE "id"=$1`, [taskId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");

    const inspectionId = randomUUID();
    const binding = { inspectionId, taskId, taskRevision: 4, priorAttemptId,
      priorAttemptTaskRevision: 3, workerName: "worker-one", workerInstanceId: instanceId,
      workerGeneration: 1, targetHost: "amux-ubuntu" };
    const requestDigest = amuxV22RecoveryDigest("inspection", binding);
    const ownerRequestId = randomUUID();
    const requestAuditId = await appendAudit(client, { actorUserId: "synthetic-owner",
      action: "amux.v22.recovery.requested", targetType: "AmuxV22TaskRecoveryInspectionRequest",
      targetId: inspectionId, summary: "synthetic fixed-host inspection request",
      metadata: { ...binding, requestDigest, ownerRequestId } });
    const requestedAt = (await client.query(
      `SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)).rows[0].now;
    await client.query(`INSERT INTO public."AmuxV22TaskRecoveryInspectionRequest"
      ("id","ownerRequestId","taskId","taskRevision","priorAttemptId","priorAttemptTaskRevision",
       "workerName","workerInstanceId","workerGeneration","targetHost","requestDigest",
       "requestedByUserId","authorizationAuditLogId","requestedAt")
      VALUES ($1,$2,$3,4,$4,3,'worker-one',$5,1,'amux-ubuntu',$6,'synthetic-owner',$7,$8)`,
    [inspectionId, ownerRequestId, taskId, priorAttemptId, instanceId, requestDigest,
      requestAuditId, requestedAt]);

    // The real producer: an earlier invocation's terminal, read after a restart.
    const journal = (path) => readFile(path, "utf8").catch(() => null);
    const earlier = createAmuxV22SidecarHandler({ worker: "worker-one", stateDir,
      invocationId: "a".repeat(32), recoveryJournal: journal,
      run: async () => ({ kind: "failed", attemptId: priorAttemptId, cliStarted: true }) });
    await earlier({ op: "execute", version: 1, attemptId: priorAttemptId, worker: "worker-one",
      role: "investigate", modelId: "claude-opus-5-5", budgetMicrousd: 3_400_000,
      prompt: "Private synthetic prompt", recoveryBinding: { version: 1, taskId,
        taskRevision: 3, workerInstanceId: instanceId, workerGeneration: 1,
        targetHost: "amux-ubuntu" } });
    for (const deadline = Date.now() + 10_000;
      (await earlier({ op: "readback", attemptId: priorAttemptId })).kind === "in_progress";) {
      if (Date.now() > deadline) throw new Error("synthetic terminal was not durable");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const restarted = createAmuxV22SidecarHandler({ worker: "worker-one", stateDir,
      invocationId: "c".repeat(32), recoveryJournal: journal,
      recoveryUnit: async () => ({ rootOwnedUnit: true, controlGroupBound: true,
        processTreeStopped: true }),
      recoveryWorkspace: async () => ({ ok: true, baseSha: "d".repeat(40) }),
      run: async () => { throw new Error("provider must not run"); } });
    const proven = await restarted({ op: "inspect_recovery", ...binding, requestDigest,
      requestedAt: requestedAt.toISOString() });
    assert.equal(proven.reason, "terminal_journal_proven");
    assert.equal(proven.proof.sameLiveInvocation, false);

    async function insertEvidence(report, verified, reason) {
      const id = randomUUID(); const evidence = { ...report, evidenceId: id };
      const evidenceDigest = amuxV22RecoveryDigest("evidence", evidence);
      const auditId = await appendAudit(client, { actorUserId: null,
        action: "amux.v22.recovery.inspected", targetType: "AmuxV22TaskRecoveryEvidence",
        targetId: id, summary: "synthetic content-free proof",
        metadata: { systemActor: "amux-v22-recovery-checker", taskId, inspectionId,
          priorAttemptId, evidenceDigest } });
      await client.query(`INSERT INTO public."AmuxV22TaskRecoveryEvidence"
        ("id","inspectionId","hostInvocationId","report","evidenceDigest","verified","reason",
         "authorizationAuditLogId","recordedAt") VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
      [id, inspectionId, evidence.hostInvocationId, JSON.stringify(evidence), evidenceDigest,
        verified, reason, auditId, new Date("2000-01-01T00:00:00.000Z")]);
    }
    async function refused(report) {
      await client.query("SAVEPOINT journal_probe"); let error;
      try { await insertEvidence(report, true, null); } catch (caught) { error = caught; }
      await client.query("ROLLBACK TO SAVEPOINT journal_probe");
      await client.query("RELEASE SAVEPOINT journal_probe");
      assert.equal(error?.code, "23514", error?.message);
      assert.equal(error.constraint, "AmuxV22RecoveryEvidence_binding_check", error.message);
    }
    await refused({ ...proven, proof: { ...proven.proof, workspaceClean: false } });
    await refused({ ...proven, proof: { ...proven.proof, noActiveExecution: false } });
    await refused({ ...proven, proof: { ...proven.proof, processTreeStopped: false } });
    await refused({ ...proven, reason: "stopped_proven" });
    await refused({ ...proven, reason: "inspection_unverified" });
    await refused({ ...proven, proof: { ...proven.proof, terminalOutcome: "succeeded" } });

    await insertEvidence(proven, true, null);
    const stored = (await client.query(`SELECT "verified", "reason", "hostInvocationId",
      "report"->>'reason' AS "reportReason" FROM public."AmuxV22TaskRecoveryEvidence"
      WHERE "inspectionId"=$1`, [inspectionId])).rows;
    assert.deepEqual(stored, [{ verified: true, reason: null, hostInvocationId: "a".repeat(32),
      reportReason: "terminal_journal_proven" }]);
    // The prior attempt and its reservation are untouched.
    const attempt = (await client.query(`SELECT "reservedCostMicrousd" FROM
      public."AmuxExecutionAttempt" WHERE "id"=$1`, [priorAttemptId])).rows[0];
    assert.equal(BigInt(attempt.reservedCostMicrousd), 3_400_000n);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
    await rm(stateDir, { recursive: true, force: true });
  }
});
