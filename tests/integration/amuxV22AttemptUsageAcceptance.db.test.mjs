import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Real PostgreSQL, rollback-only. Owner decision 2026-11-10: the owner may
// accept that an ended v22 attempt's CLI usage stays unknown, and an
// owner-approved retry accepts the Task's earlier unknown attempts. From
// 2026-11-09 19:54 AEST three such attempts held codex-impl, codex-chore and
// claude-impl and no Task was assigned. An accepted attempt leaves the worker
// usage gate; its cost is unchanged; any other unknown attempt still holds.

const raw = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!raw || process.env.DATABASE_URL !== raw) return false;
  const value = new URL(raw);
  return ["localhost", "127.0.0.1"].includes(value.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(value.pathname);
})();
const skip = allowed ? undefined : "requires a dedicated loopback test database";

function prismaQueryAdapter(tx) {
  return { query: async (sql, params = []) => {
    if (/^\s*SELECT\s+pg_advisory_xact_lock\b/i.test(sql)) {
      const rowCount = await tx.$executeRawUnsafe(sql, ...params);
      return { rows: [], rowCount };
    }
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(sql)) {
      const rows = await tx.$queryRawUnsafe(sql, ...params);
      return { rows, rowCount: rows.length };
    }
    const rowCount = await tx.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount };
  } };
}

async function inRollback(work) {
  const { prisma } = await import("../../lib/prisma.ts");
  const rollback = new Error("synthetic usage acceptance rollback");
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '10000', true)`;
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      await work(tx, prismaQueryAdapter(tx));
      throw rollback;
    }, { timeout: 30_000 }), (error) => error === rollback);
  } finally {
    await prisma.$disconnect();
  }
}

const owner = "synthetic-owner";
const GUARD = "amux_v22_attempt_usage_acceptance_guard_trigger";

/** Seeds a blocked v4 Task whose one attempt ended with no usage row: the
 * Codex login expiry of 2026-11-09 (usage_outcome_unknown). */
async function seedUnknownAttempt(db) {
  const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(db, {
    settlementStatus: "blocked", settlementOutcome: "blocked",
    settlementReason: "usage_outcome_unknown", usageReported: false,
  });
  const [attempt] = (await db.query(`SELECT "worker", "reservedCostMicrousd"::text AS "reserved",
    "settledCostMicrousd"::text AS "settled", "costConfirmed", "endedAt"
    FROM public."AmuxExecutionAttempt" WHERE "id" = $1`, [seed.priorAttemptId])).rows;
  assert.ok(attempt.endedAt);
  return { ...seed, worker: attempt.worker, attempt };
}

/** The owner's own audit for one attempt, in this (top-level) transaction:
 * the guard compares the audit row's xmin with it, so no savepoint. */
function ownerAcceptAudit(db, taskId, attemptId, overrides = {}) {
  return appendSyntheticAdminAudit(db, { actorUserId: owner,
    action: "amux.v22.attempt_usage.unknown_accepted", targetType: "AmuxExecutionAttempt",
    targetId: attemptId, summary: "Accepted unknown usage.",
    metadata: { taskId, attemptId, costChanged: false }, useSavepoint: false, ...overrides });
}

async function settledFor(tx, worker, taskId) {
  const { amuxV22RoutesWithSettledUsage } = await import("../../lib/amux/v22WorkerUsageGate.ts");
  return (await amuxV22RoutesWithSettledUsage(tx, [{ workerName: worker }], null, taskId)).unsettled === false;
}

/** Fires the deferred guard now; returns its refusal, or null. */
async function checkGuard(tx, db, write = async () => {}) {
  await db.query("SAVEPOINT usage_acceptance_guard");
  try {
    // A refused write is undone with its savepoint; its audit stays outside.
    await write();
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ${GUARD} IMMEDIATE`);
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ${GUARD} DEFERRED`);
    await db.query("RELEASE SAVEPOINT usage_acceptance_guard");
    return null;
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT usage_acceptance_guard");
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ${GUARD} DEFERRED`);
    // Prisma wraps the raw failure (P2010); the guard names its constraint.
    return /AmuxV22AttemptUsageAcceptance_binding_check|not exact and owner audited/
      .test(String(error?.message)) ? "refused" : String(error?.message ?? error);
  }
}

test("an owner-accepted attempt no longer holds its worker for any Task, and its cost is unchanged", { skip }, async () => {
  const { amuxV22TaskUnknownUsageAttemptIds, recordAmuxV22UsageAcceptances } =
    await import("../../lib/amux/v22AttemptUsageAcceptance.ts");
  await inRollback(async (tx, db) => {
    const seed = await seedUnknownAttempt(db);
    const other = `other-${randomUUID()}`;
    assert.equal(await settledFor(tx, seed.worker, other), false);
    assert.equal(await settledFor(tx, seed.worker, seed.taskId), false);
    assert.deepEqual(await amuxV22TaskUnknownUsageAttemptIds(tx, seed.taskId), [seed.priorAttemptId]);

    const auditLogId = await ownerAcceptAudit(db, seed.taskId, seed.priorAttemptId);
    await recordAmuxV22UsageAcceptances(tx, { taskId: seed.taskId,
      attemptIds: [seed.priorAttemptId], source: "owner_accept", acceptedByUserId: owner,
      auditLogId, now: new Date() });
    assert.equal(await checkGuard(tx, db), null);

    assert.equal(await settledFor(tx, seed.worker, other), true);
    assert.equal(await settledFor(tx, seed.worker, seed.taskId), true);
    assert.deepEqual(await amuxV22TaskUnknownUsageAttemptIds(tx, seed.taskId), []);
    // Nothing about the cost moved: the cap is held, the cost unconfirmed,
    // and no usage row was invented.
    const [after] = (await db.query(`SELECT "worker", "reservedCostMicrousd"::text AS "reserved",
      "settledCostMicrousd"::text AS "settled", "costConfirmed", "endedAt"
      FROM public."AmuxExecutionAttempt" WHERE "id" = $1`, [seed.priorAttemptId])).rows;
    assert.deepEqual(after, seed.attempt);
    assert.equal(after.costConfirmed, false);
    assert.deepEqual((await db.query(`SELECT 1 FROM public."AmuxCliUsageEvent"
      WHERE "attemptId" = $1`, [seed.priorAttemptId])).rows, []);

    // The acceptance is append-only.
    await db.query("SAVEPOINT append_only");
    await assert.rejects(db.query(`UPDATE public."AmuxV22AttemptUsageAcceptance"
      SET "source" = 'review_retry' WHERE "attemptId" = $1`, [seed.priorAttemptId]),
    /append-only/);
    await db.query("ROLLBACK TO SAVEPOINT append_only");
  });
});

test("accepting one attempt leaves another unknown attempt on the same worker holding it", { skip }, async () => {
  const { recordAmuxV22UsageAcceptances, amuxV22TaskUnknownUsageAttemptIds } =
    await import("../../lib/amux/v22AttemptUsageAcceptance.ts");
  await inRollback(async (tx, db) => {
    const seed = await seedUnknownAttempt(db);
    // A second ended run on the same worker with no usage (FILEGEN-003 had
    // two). Its own v22 binding trigger is deferred and never checked: the
    // transaction is rolled back.
    const secondId = randomUUID();
    await db.query("SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger DEFERRED");
    await db.query(`INSERT INTO public."AmuxExecutionAttempt"
      ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
       "taskRevision", "attemptNumber", "reservedCostMicrousd", "heartbeatAt",
       "startedAt", "endedAt", "outcome", "toStatus", "endedBy", "reason", "updatedAt")
      VALUES ($1, $2, $3, $4, 1, 3, 2, 0, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP - interval '2 hours', CURRENT_TIMESTAMP - interval '2 hours',
        'blocked', 'blocked', $3, 'usage_outcome_unknown', CURRENT_TIMESTAMP)`,
    [secondId, seed.taskId, seed.worker, seed.recoveryInstanceId]);
    assert.deepEqual((await amuxV22TaskUnknownUsageAttemptIds(tx, seed.taskId)).sort(),
      [seed.priorAttemptId, secondId].sort());

    const auditLogId = await ownerAcceptAudit(db, seed.taskId, seed.priorAttemptId);
    await recordAmuxV22UsageAcceptances(tx, { taskId: seed.taskId,
      attemptIds: [seed.priorAttemptId], source: "owner_accept", acceptedByUserId: owner,
      auditLogId, now: new Date() });
    assert.equal(await checkGuard(tx, db), null);
    assert.equal(await settledFor(tx, seed.worker, `other-${randomUUID()}`), false);
    assert.deepEqual(await amuxV22TaskUnknownUsageAttemptIds(tx, seed.taskId), [secondId]);
  });
});

test("the database refuses an acceptance its audit does not name exactly", { skip }, async () => {
  await inRollback(async (tx, db) => {
    const seed = await seedUnknownAttempt(db);
    const insert = (source, auditLogId, actor = owner) => db.query(`INSERT INTO
      public."AmuxV22AttemptUsageAcceptance" ("id", "attemptId", "taskId", "source",
      "acceptedByUserId", "authorizationAuditLogId", "acceptedAt")
      VALUES ($1::uuid, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
    [randomUUID(), seed.priorAttemptId, seed.taskId, source, actor, auditLogId]);

    // An owner audit for another attempt.
    { const auditLogId = await ownerAcceptAudit(db, seed.taskId, `other-${randomUUID()}`);
      assert.equal(await checkGuard(tx, db, () => insert("owner_accept", auditLogId)), "refused"); }
    // The right audit, but another person recorded as the accepter.
    { const auditLogId = await ownerAcceptAudit(db, seed.taskId, seed.priorAttemptId);
      assert.equal(await checkGuard(tx, db, () => insert("owner_accept", auditLogId, "someone-else")), "refused"); }
    // A system-written audit is not the owner's.
    { const auditLogId = await ownerAcceptAudit(db, seed.taskId, seed.priorAttemptId,
      { metadata: { taskId: seed.taskId, systemActor: "amux-v22-recovery-preapproval" } });
      assert.equal(await checkGuard(tx, db, () => insert("owner_accept", auditLogId)), "refused"); }
    // A review retry audit listing the attempt, with no retry decision bound to it.
    { const auditLogId = await appendSyntheticAdminAudit(db, { actorUserId: owner,
      action: "amux.human_escalation.resolved", targetType: "AmuxWorkItem", targetId: seed.taskId,
      summary: "Resolved an AMUX human review escalation.",
      metadata: { outcome: "retry", accepted_unknown_usage_attempt_ids: [seed.priorAttemptId] },
      useSavepoint: false });
      assert.equal(await checkGuard(tx, db, () => insert("review_retry", auditLogId)), "refused"); }
    // A recovery-approval audit listing the attempt, with no approval written.
    const approvalId = randomUUID();
    { const auditLogId = await appendSyntheticAdminAudit(db, { actorUserId: owner,
      action: "amux.v22.recovery.approved", targetType: "AmuxV22TaskRecoveryApproval",
      targetId: approvalId, summary: "Approved.",
      metadata: { taskId: seed.taskId, acceptedUnknownUsageAttemptIds: [seed.priorAttemptId] },
      useSavepoint: false });
      assert.equal(await checkGuard(tx, db, () => insert("recovery_approval", auditLogId)), "refused"); }
    // Nothing was accepted: the worker is still held.
    assert.equal(await settledFor(tx, seed.worker, `other-${randomUUID()}`), false);
  });
});

/** The rows resolveAmuxReview writes for an owner retry of a v4 Task, in its
 * order, with the Task's earlier unknown attempts listed in the audit and
 * accepted after the decision (lib/amux/reviewApproval.ts). */
async function ownerRetryAccepting(tx, db, seed) {
  const { amuxV22TaskUnknownUsageAttemptIds, recordAmuxV22UsageAcceptances } =
    await import("../../lib/amux/v22AttemptUsageAcceptance.ts");
  const escalationId = randomUUID();
  await db.query(`INSERT INTO public."AmuxHumanEscalation"
    ("id", "taskId", "reason", "status", "openedBy", "openedTaskRevision",
     "updatedAt") VALUES ($1, $2, 'usage_outcome_unknown', 'open',
     'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`, [escalationId, seed.taskId]);
  const proposalId = randomUUID();
  const decisionId = randomUUID();
  const subjectDigest = "f".repeat(64);
  await db.query(`INSERT INTO public."AmuxReviewProposal"
    ("id", "decisionId", "escalationId", "taskId", "taskRevision", "outcome",
     "sourceStatus", "targetStatus", "subjectDigest", "attemptId",
     "issuedAt", "expiresAt") VALUES ($1, $2::uuid, $3, $4, 4, 'retry',
     'blocked', 'todo', $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [proposalId, decisionId, escalationId, seed.taskId, subjectDigest, seed.priorAttemptId]);
  await db.query(`UPDATE public."AmuxWorkItem" SET "status" = 'todo',
    "revision" = 5, "owner" = NULL, "claimedAt" = NULL, "reviewPrNumber" = NULL
    WHERE "id" = $1 AND "revision" = 4 AND "status" = 'blocked'`, [seed.taskId]);
  await db.query(`UPDATE public."AmuxHumanEscalation" SET "status" = 'resolved',
    "resolutionOutcome" = 'retry', "resolution" = 'Retry.',
    "resolvedById" = $2, "resolvedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
  [escalationId, owner]);
  const accepted = await amuxV22TaskUnknownUsageAttemptIds(tx, seed.taskId);
  const auditLogId = await appendSyntheticAdminAudit(db, {
    actorUserId: owner, action: "amux.human_escalation.resolved",
    targetType: "AmuxWorkItem", targetId: seed.taskId,
    summary: "Resolved an AMUX human review escalation.",
    metadata: { decision_id: decisionId, proposal_id: proposalId,
      escalation_id: escalationId, outcome: "retry", review_base_sha: null,
      subject_digest: subjectDigest, accepted_unknown_usage_attempt_ids: accepted },
    useSavepoint: false,
  });
  await db.query(`INSERT INTO public."AmuxReviewDecision"
    ("id", "proposalId", "escalationId", "outcome", "requestDigest",
     "idempotencyKeyHash", "actorUserId", "auditLogId") VALUES
    ($1::uuid, $2, $3, 'retry', $4, $5, $6, $7)`,
  [decisionId, proposalId, escalationId, "b".repeat(64), "c".repeat(64), owner, auditLogId]);
  await recordAmuxV22UsageAcceptances(tx, { taskId: seed.taskId, attemptIds: accepted,
    source: "review_retry", acceptedByUserId: owner, auditLogId, now: new Date() });
  return { accepted, auditLogId };
}

test("an owner review retry accepts the Task's earlier unknown attempts in its own transaction", { skip }, async () => {
  await inRollback(async (tx, db) => {
    const seed = await seedUnknownAttempt(db);
    // Review offers no retry for usage_outcome_unknown on its own; this is
    // the decision's row shape, which the guard binds whatever the reason.
    const { accepted, auditLogId } = await ownerRetryAccepting(tx, db, seed);
    assert.deepEqual(accepted, [seed.priorAttemptId]);
    assert.equal(await checkGuard(tx, db), null);
    const [row] = (await db.query(`SELECT "source", "acceptedByUserId", "authorizationAuditLogId"
      FROM public."AmuxV22AttemptUsageAcceptance" WHERE "attemptId" = $1`, [seed.priorAttemptId])).rows;
    assert.deepEqual(row, { source: "review_retry", acceptedByUserId: owner,
      authorizationAuditLogId: auditLogId });
    assert.equal(await settledFor(tx, seed.worker, `other-${randomUUID()}`), true);
  });
});
