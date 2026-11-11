import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Real PostgreSQL, rollback-only. A v22 implement run whose worker found the
// change already in place settled succeeded -> review with no pull request,
// and the owner could only block it or run it again (AMUX-ARTFMT-002). The
// owner may now complete it as "no change needed" (owner decision
// 2026-11-11): the existing approve outcome, review -> done with no PR. The
// installed PR-less guard admits it only on the attempt's own retained result,
// a known usage outcome and no publication work that may still open a PR.

const raw = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!raw || process.env.DATABASE_URL !== raw) return false;
  const value = new URL(raw);
  return ["localhost", "127.0.0.1"].includes(value.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(value.pathname);
})();

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

const owner = "synthetic-owner";

async function inRollback(work) {
  const { prisma } = await import("../../lib/prisma.ts");
  const rollback = new Error("synthetic no-change completion rollback");
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

async function openEscalation(db, taskId) {
  const escalationId = randomUUID();
  await db.query(`INSERT INTO public."AmuxHumanEscalation"
    ("id", "taskId", "reason", "status", "openedBy", "openedTaskRevision",
     "updatedAt") VALUES ($1, $2, 'human_review_required', 'open',
     'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`, [escalationId, taskId]);
  return escalationId;
}

async function storeResult(db, seed) {
  await db.query(`INSERT INTO public."AmuxV22TaskResult"
    ("attemptId", "taskId", "ideaId", "ciphertext", "keyId", "keyVersion",
     "digest", "digestKeyId", "sourceSha256", "byteLength", "createdAt")
    VALUES ($1, $2, $3, convert_to('synthetic-only', 'UTF8'), 'synthetic', 1,
      $4, 'synthetic', $4, 14, CURRENT_TIMESTAMP)`,
  [seed.priorAttemptId, seed.taskId, seed.ideaId, "d".repeat(64)]);
}

const insertApproval = (db, { taskId, attemptId, escalationId,
  proposalId = randomUUID(), decisionId = randomUUID() }) =>
  db.query(`INSERT INTO public."AmuxReviewProposal"
    ("id", "decisionId", "escalationId", "taskId", "taskRevision", "outcome",
     "sourceStatus", "targetStatus", "subjectDigest", "attemptId",
     "issuedAt", "expiresAt") VALUES ($1, $2::uuid, $3, $4, 4, 'approve',
     'review', 'done', $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [proposalId, decisionId, escalationId, taskId, "f".repeat(64), attemptId]);

/** Inside a savepoint, so a refused insert does not abort the transaction. */
async function refused(tx, write) {
  await tx.$executeRawUnsafe("SAVEPOINT refused_write");
  await assert.rejects(write(), /check_violation|23514|no-change completion|PR-less approval/);
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT refused_write");
}

test("an owner completes a no-change implement Task as done, with the basis audited", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  await inRollback(async (tx, db) => {
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(db,
      { taskRole: "implement", settlementReason: "reported_result" });
    const { taskId, priorAttemptId } = seed;
    const escalationId = await openEscalation(db, taskId);

    // Without the attempt's own retained result there is nothing to stand in for a PR.
    await refused(tx, () => insertApproval(db, { taskId, attemptId: priorAttemptId,
      escalationId }));
    await storeResult(db, seed);

    // The rows resolveAmuxReview writes for the approval, in its order.
    const proposalId = randomUUID();
    const decisionId = randomUUID();
    await insertApproval(db, { taskId, attemptId: priorAttemptId, escalationId,
      proposalId, decisionId });
    await db.query(`UPDATE public."AmuxWorkItem" SET "status" = 'done',
      "revision" = 5, "v4TerminalAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "revision" = 4 AND "status" = 'review'`, [taskId]);
    await db.query(`UPDATE public."AmuxHumanEscalation" SET "status" = 'resolved',
      "resolutionOutcome" = 'approve',
      "resolution" = 'no change needed (owner verified)',
      "resolvedById" = $2, "resolvedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [escalationId, owner]);
    const auditLogId = await appendSyntheticAdminAudit(db, {
      actorUserId: owner, action: "amux.human_escalation.resolved",
      targetType: "AmuxWorkItem", targetId: taskId,
      summary: "Completed an AMUX implement Task: no change needed (owner verified).",
      metadata: { decision_id: decisionId, proposal_id: proposalId,
        escalation_id: escalationId, outcome: "approve", review_base_sha: null,
        subject_digest: "f".repeat(64), approval_basis: "no_change_owner_verified" },
    });
    await db.query(`INSERT INTO public."AmuxReviewDecision"
      ("id", "proposalId", "escalationId", "outcome", "requestDigest",
       "idempotencyKeyHash", "actorUserId", "auditLogId") VALUES
      ($1::uuid, $2, $3, 'approve', $4, $5, $6, $7)`,
    [decisionId, proposalId, escalationId, "b".repeat(64), "c".repeat(64),
      owner, auditLogId]);

    const [task] = await tx.$queryRaw`SELECT "status", "revision", "reviewPrNumber",
      "v4TerminalAt" IS NOT NULL AS "terminal" FROM "AmuxWorkItem" WHERE "id" = ${taskId}`;
    assert.deepEqual(task, { status: "done", revision: 5, reviewPrNumber: null, terminal: true });
    const [escalation] = await tx.$queryRaw`SELECT "status", "resolutionOutcome"
      FROM "AmuxHumanEscalation" WHERE "id" = ${escalationId}`;
    assert.deepEqual(escalation, { status: "resolved", resolutionOutcome: "approve" });
    const [audit] = await tx.$queryRaw`SELECT "metadata"->>'approval_basis' AS "basis"
      FROM "AdminAuditLog" WHERE "id" = ${auditLogId}`;
    assert.equal(audit.basis, "no_change_owner_verified");
  });
});

test("a no-change completion is refused while the run's usage outcome is unknown", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  await inRollback(async (tx, db) => {
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(db,
      { taskRole: "implement", settlementReason: "usage_outcome_unknown" });
    await storeResult(db, seed);
    const escalationId = await openEscalation(db, seed.taskId);
    await refused(tx, () => insertApproval(db, { taskId: seed.taskId,
      attemptId: seed.priorAttemptId, escalationId }));
  });
});
