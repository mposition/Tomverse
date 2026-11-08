import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

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

async function appendAudit(db, input) {
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

const OWNER = "synthetic-owner";
const ADDITIONAL = 4_100_000n;
const proof = { terminalOutcome: "unknown", sameLiveInvocation: true, noActiveExecution: true,
  processTreeStopped: true, rootOwnedUnit: true, controlGroupBound: true, journalBound: true,
  socketTerminal: true, externalEffectsKnown: true, workspaceClean: true };

// Owner decision 2026-11-08: one click records an exact, human-audited
// consent; the approval it opens is the system's, bound to that consent, and
// only over evidence recorded after it and before it expired. Each scenario
// runs in its own transaction against a freshly seeded blocked Task.
test("the database opens one approval from an exact, unexpired, audited pre-approval and nothing else", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // The guards bind audits by top-level transaction id, so every scenario
    // is its own transaction over a freshly seeded blocked Task.
    let taskId, priorAttemptId, instanceId, task, attempt, budget, held;
    async function setup() {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '20s'");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      ({ taskId, priorAttemptId, instanceId } =
        await seedAmuxV4PortfolioRecoveryPrerequisites(client));
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(`UPDATE public."AmuxExecutionAttempt" SET "outcome"='expired',
        "toStatus"='blocked', "reason"='outcome_unknown' WHERE "id"=$1`, [priorAttemptId]);
      await client.query(`UPDATE public."AmuxWorkItem" SET "status"='blocked' WHERE "id"=$1`, [taskId]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      task = (await client.query(`SELECT "revision" FROM public."AmuxWorkItem" WHERE "id"=$1`,
        [taskId])).rows[0];
      attempt = (await client.query(`SELECT "taskRevision", "worker", "workerGeneration"
        FROM public."AmuxExecutionAttempt" WHERE "id"=$1`, [priorAttemptId])).rows[0];
      budget = (await client.query(`SELECT count(*)::int AS used,
        greatest(count(*)::int, coalesce(max("attemptNumber"),0)) + 1 AS next,
        coalesce(sum("reservedCostMicrousd"),0)::text AS held
        FROM public."AmuxExecutionAttempt" WHERE "taskId"=$1`, [taskId])).rows[0];
      held = BigInt(budget.held);
    }
    const dbNow = async (offsetMs = 0) => (await client.query(
      `SELECT ((clock_timestamp() AT TIME ZONE 'UTC') + $1::int * interval '1 millisecond')::timestamp(3) AS at`,
      [offsetMs])).rows[0].at;

    // Each production step commits on its own; fire its deferred guards now.
    const flush = async () => {
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
    };
    async function inspection(offsetMs = 0) {
      const inspectionId = randomUUID(); const ownerRequestId = randomUUID();
      const binding = { inspectionId, taskId, taskRevision: task.revision, priorAttemptId,
        priorAttemptTaskRevision: attempt.taskRevision, workerName: attempt.worker,
        workerInstanceId: instanceId, workerGeneration: attempt.workerGeneration,
        targetHost: "amux-ubuntu" };
      const requestDigest = amuxV22RecoveryDigest("inspection", binding);
      const auditId = await appendAudit(client, { actorUserId: OWNER,
        action: "amux.v22.recovery.requested", targetType: "AmuxV22TaskRecoveryInspectionRequest",
        targetId: inspectionId, summary: "synthetic inspection request",
        metadata: { ...binding, requestDigest, ownerRequestId } });
      const requestedAt = await dbNow(offsetMs);
      await client.query(`INSERT INTO public."AmuxV22TaskRecoveryInspectionRequest"
        ("id","ownerRequestId","taskId","taskRevision","priorAttemptId","priorAttemptTaskRevision",
         "workerName","workerInstanceId","workerGeneration","targetHost","requestDigest",
         "requestedByUserId","authorizationAuditLogId","requestedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'amux-ubuntu',$10,$11,$12,$13)`,
      [inspectionId, ownerRequestId, taskId, task.revision, priorAttemptId, attempt.taskRevision,
        attempt.worker, instanceId, attempt.workerGeneration, requestDigest, OWNER, auditId,
        requestedAt]);
      await flush();
      return { inspectionId, ownerRequestId, binding, requestDigest, requestedAt };
    }
    async function consent(request, change = {}) {
      const id = randomUUID();
      const costDigest = change.costDigest ?? "c".repeat(64);
      const expiresAt = new Date(request.requestedAt.getTime() + 30 * 60_000);
      const auditId = await appendAudit(client, { actorUserId: change.auditActor ?? OWNER,
        action: change.auditAction ?? "amux.v22.recovery.preapproved",
        targetType: "AmuxV22TaskRecoveryPreApproval", targetId: id,
        summary: "synthetic one-click consent",
        metadata: { inspectionId: request.inspectionId, costDigest,
          additionalCapMicroUsd: ADDITIONAL.toString(), expiresAt: expiresAt.toISOString() } });
      await client.query(`INSERT INTO public."AmuxV22TaskRecoveryPreApproval"
        ("id","ownerRequestId","inspectionId","taskId","taskRevision","priorAttemptId","costDigest",
         "catalogApprovalId","catalogVersion","pricingVersion","costReceiptDigest","oldHeldMicroUsd",
         "additionalCapMicroUsd","worstExposureMicroUsd","requestedByUserId","authorizationAuditLogId",
         "requestedAt","expiresAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,'catalog-approval','catalog-v1','pricing-v1',$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, request.ownerRequestId, request.inspectionId, taskId, task.revision, priorAttemptId,
        costDigest, "b".repeat(64), held, ADDITIONAL, held + ADDITIONAL, OWNER, auditId,
        request.requestedAt, expiresAt]);
      await flush();
      return { id, costDigest, auditId };
    }
    async function evidence(request, { verified = true, recordedAt } = {}) {
      const id = randomUUID();
      const report = { ...request.binding, evidenceId: id, requestDigest: request.requestDigest,
        hostInvocationId: "a".repeat(32),
        proof: verified ? proof : { ...proof, terminalOutcome: "succeeded" },
        usage: { status: "unknown", projectedCostMicroUsd: null },
        reason: verified ? "stopped_proven" : "terminal_success" };
      const evidenceDigest = amuxV22RecoveryDigest("evidence", report);
      const auditId = await appendAudit(client, { actorUserId: null,
        action: "amux.v22.recovery.inspected", targetType: "AmuxV22TaskRecoveryEvidence",
        targetId: id, summary: "synthetic content-free proof",
        metadata: { systemActor: "amux-v22-recovery-checker", taskId,
          inspectionId: request.inspectionId, priorAttemptId, evidenceDigest } });
      await client.query(`INSERT INTO public."AmuxV22TaskRecoveryEvidence"
        ("id","inspectionId","hostInvocationId","report","evidenceDigest","verified","reason",
         "authorizationAuditLogId","recordedAt") VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
      [id, request.inspectionId, "a".repeat(32), JSON.stringify(report), evidenceDigest,
        verified, verified ? null : "terminal_success", auditId,
        recordedAt ?? new Date("2000-01-01T00:00:00.000Z")]);
      await flush();
      return { id, evidenceDigest };
    }
    async function approve(request, proofRow, pre, change = {}) {
      const id = randomUUID();
      const costDigest = change.costDigest ?? pre?.costDigest ?? "c".repeat(64);
      const metadata = { evidenceDigest: proofRow.evidenceDigest, costDigest,
        oldHeldMicroUsd: held.toString(), additionalCapMicroUsd: ADDITIONAL.toString(),
        ownerRequestId: request.ownerRequestId };
      const auditId = pre ? await appendAudit(client, { actorUserId: null,
        action: "amux.v22.recovery.preapproval_applied", targetType: "AmuxV22TaskRecoveryApproval",
        targetId: id, summary: "synthetic applied consent",
        metadata: { ...metadata, systemActor: change.systemActor ?? "amux-v22-recovery-preapproval",
          preApprovalId: pre.id } }) :
        await appendAudit(client, { actorUserId: OWNER, action: "amux.v22.recovery.approved",
          targetType: "AmuxV22TaskRecoveryApproval", targetId: id,
          summary: "synthetic manual approval", metadata });
      await client.query(`INSERT INTO public."AmuxV22TaskRecoveryApproval"
        ("id","ownerRequestId","inspectionId","evidenceId","taskId","beforeRevision","afterRevision",
         "priorAttemptId","evidenceDigest","costDigest","catalogApprovalId","catalogVersion",
         "pricingVersion","costReceiptDigest","costReceipt","historicalAttempts","nextAttemptNumber",
         "oldHeldMicroUsd","additionalCapMicroUsd","worstExposureMicroUsd","preApprovalId",
         "approvedByUserId","authorizationAuditLogId","approvedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'catalog-approval','catalog-v1','pricing-v1',$11,
          '{}'::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,clock_timestamp() AT TIME ZONE 'UTC')`,
      [id, request.ownerRequestId, request.inspectionId, proofRow.id, taskId, task.revision,
        task.revision + 1, priorAttemptId, proofRow.evidenceDigest, costDigest, "b".repeat(64),
        budget.used, budget.next, held, ADDITIONAL, held + ADDITIONAL, pre?.id ?? null, OWNER, auditId]);
      await client.query(`UPDATE public."AmuxWorkItem" SET "status"='todo', "revision"="revision"+1
        WHERE "id"=$1`, [taskId]);
      if (pre) await result(pre, "applied", id);
      return id;
    }
    async function result(pre, outcome, approvalId = null) {
      const id = randomUUID();
      const auditId = await appendAudit(client, { actorUserId: null,
        action: "amux.v22.recovery.preapproval_settled",
        targetType: "AmuxV22TaskRecoveryPreApprovalResult", targetId: id,
        summary: "synthetic result", metadata: { systemActor: "amux-v22-recovery-preapproval",
          preApprovalId: pre.id, outcome } });
      await client.query(`INSERT INTO public."AmuxV22TaskRecoveryPreApprovalResult"
        ("id","preApprovalId","outcome","reason","approvalId","authorizationAuditLogId","recordedAt")
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp() AT TIME ZONE 'UTC')`,
      [id, pre.id, outcome, outcome === "refused" ? "preapproval_expired" : null, approvalId, auditId]);
    }
    async function scenario(name, run, expected) {
      await setup(); let error;
      try { await run(); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); }
      catch (caught) { error = caught; }
      await client.query("ROLLBACK");
      if (expected) {
        assert.equal(error?.code, expected.code ?? "23514", `${name}: ${error?.message}`);
        if (expected.constraint) assert.equal(error.constraint, expected.constraint, name);
      } else assert.equal(error, undefined, `${name}: ${error?.message}`);
    }

    await scenario("verified evidence after the consent opens one approval", async () => {
      const request = await inspection(); const pre = await consent(request);
      const approvalId = await approve(request, await evidence(request), pre);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const rows = (await client.query(`SELECT a."preApprovalId", r."outcome", r."approvalId",
        w."status", w."revision" FROM public."AmuxV22TaskRecoveryApproval" a
        JOIN public."AmuxV22TaskRecoveryPreApprovalResult" r ON r."preApprovalId" = a."preApprovalId"
        JOIN public."AmuxWorkItem" w ON w."id" = a."taskId" WHERE a."id"=$1`, [approvalId])).rows;
      assert.deepEqual(rows, [{ preApprovalId: pre.id, outcome: "applied", approvalId,
        status: "todo", revision: task.revision + 1 }]);
      const actions = (await client.query(`SELECT "action" FROM public."AdminAuditLog"
        WHERE "targetId" = ANY($1::text[]) ORDER BY "createdAt", "id"`,
      [[request.inspectionId, pre.id, approvalId]])).rows.map((row) => row.action);
      assert.deepEqual(actions, ["amux.v22.recovery.requested", "amux.v22.recovery.preapproved",
        "amux.v22.recovery.preapproval_applied"]);
      // The consent is spent: no second result, no second approval from it.
      await client.query("SAVEPOINT reuse");
      await assert.rejects(result(pre, "refused"), (error) => error.code === "23505");
      await client.query("ROLLBACK TO SAVEPOINT reuse");
      await assert.rejects(client.query(`UPDATE public."AmuxV22TaskRecoveryPreApproval"
        SET "expiresAt" = "expiresAt" WHERE "id"=$1`, [pre.id]),
      (error) => error.constraint === "AmuxV22Recovery_append_only_check");
      await client.query("ROLLBACK TO SAVEPOINT reuse");
      // Nor can another approval name the same consent: preApprovalId is unique.
      const unique = (await client.query(`SELECT count(*)::int AS n FROM pg_indexes
        WHERE tablename = 'AmuxV22TaskRecoveryApproval'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%("preApprovalId")'`)).rows[0].n;
      assert.equal(unique, 1);
      await client.query("ROLLBACK TO SAVEPOINT reuse");
      await client.query("RELEASE SAVEPOINT reuse");
    });
    await scenario("an expired consent opens nothing", async () => {
      const request = await inspection(-31 * 60_000); const pre = await consent(request);
      await approve(request, await evidence(request), pre);
    }, { constraint: "AmuxV22RecoveryApproval_binding_check" });
    await scenario("a failed proof opens nothing", async () => {
      const request = await inspection(); const pre = await consent(request);
      await approve(request, await evidence(request, { verified: false }), pre);
    }, { constraint: "AmuxV22RecoveryApproval_binding_check" });
    await scenario("a changed revision opens nothing", async () => {
      const request = await inspection(); const pre = await consent(request);
      const proofRow = await evidence(request);
      await client.query(`UPDATE public."AmuxWorkItem" SET "revision"="revision"+1 WHERE "id"=$1`, [taskId]);
      await approve(request, proofRow, pre);
    }, { constraint: "AmuxV22RecoveryApproval_binding_check" });
    await scenario("another cost than the consent named opens nothing", async () => {
      const request = await inspection(); const pre = await consent(request);
      await approve(request, await evidence(request), pre, { costDigest: "d".repeat(64) });
    }, { constraint: "AmuxV22RecoveryApproval_binding_check" });
    await scenario("another system actor cannot apply a consent", async () => {
      const request = await inspection(); const pre = await consent(request);
      await approve(request, await evidence(request), pre, { systemActor: "amux-v22-recovery-checker" });
    }, { constraint: "AmuxV22RecoveryApproval_binding_check" });
    await scenario("a consent needs the owner's own same-transaction audit", async () => {
      const request = await inspection();
      await consent(request, { auditAction: "amux.v22.recovery.requested" });
    }, { constraint: "AmuxV22RecoveryPreApproval_binding_check" });
    await scenario("a consent cannot be recorded for another person's inspection", async () => {
      const request = await inspection();
      await consent(request, { auditActor: "someone-else" });
    }, { constraint: "AmuxV22RecoveryPreApproval_binding_check" });
    await scenario("an applied result needs its approval; a refused one forbids it", async () => {
      const request = await inspection(); const pre = await consent(request);
      await result(pre, "applied", null);
    }, { constraint: "AmuxV22RecoveryPreApprovalResult_shape_check" });
    await scenario("a refused consent records its result and opens nothing", async () => {
      const request = await inspection(); const pre = await consent(request);
      await evidence(request, { verified: false });
      await result(pre, "refused");
    });

    // The manual inspect approval: 15 minutes for a person to read evidence.
    // Inside each scenario transaction only: let the test set recordedAt.
    const freezeEvidenceClock = () => client.query(`ALTER TABLE public."AmuxV22TaskRecoveryEvidence"
      DISABLE TRIGGER amux_v22_recovery_evidence_db_clock_trigger`);
    await scenario("a manual approval accepts inspect evidence ten minutes old", async () => {
      await freezeEvidenceClock(); const request = await inspection(-20 * 60_000);
      await approve(request, await evidence(request, { recordedAt: await dbNow(-10 * 60_000) }), null);
    });
    await scenario("a manual approval refuses inspect evidence sixteen minutes old", async () => {
      await freezeEvidenceClock(); const request = await inspection(-20 * 60_000);
      await approve(request, await evidence(request, { recordedAt: await dbNow(-16 * 60_000) }), null);
    }, { constraint: "AmuxV22RecoveryApproval_binding_check" });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
