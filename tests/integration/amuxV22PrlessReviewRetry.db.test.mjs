import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Real PostgreSQL, rollback-only. A v22 implement run that settled succeeded
// -> review with no pull request (its patch stayed private, or it left no
// change) could only be blocked by the owner. The owner may now run it again
// from review (owner decision 2026-11-08, AMUX-FILEGEN-003): the proposal
// CHECK, the issue guard and the decision guard accept review -> retry ->
// todo, and still refuse every other new pairing.

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
  const rollback = new Error("synthetic prless review retry rollback");
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

const insertProposal = (db, { taskId, attemptId, escalationId, outcome,
  targetStatus, proposalId = randomUUID(), decisionId = randomUUID() }) =>
  db.query(`INSERT INTO public."AmuxReviewProposal"
    ("id", "decisionId", "escalationId", "taskId", "taskRevision", "outcome",
     "sourceStatus", "targetStatus", "subjectDigest", "attemptId",
     "issuedAt", "expiresAt") VALUES ($1, $2::uuid, $3, $4, 4, $5,
     'review', $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [proposalId, decisionId, escalationId, taskId, outcome, targetStatus,
    "f".repeat(64), attemptId]);

/** Inside a savepoint, so a refused insert does not abort the transaction. */
async function refused(tx, db, write) {
  await tx.$executeRawUnsafe("SAVEPOINT refused_write");
  await assert.rejects(write(), /check_violation|23514|transition_check/);
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT refused_write");
}

test("an owner retries a PR-less v22 review result back to todo", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  await inRollback(async (tx, db) => {
    const { taskId, priorAttemptId } =
      await seedAmuxV4PortfolioRecoveryPrerequisites(db);
    const [before] = await tx.$queryRaw`SELECT w."status", w."revision",
      w."reviewPrNumber", a."outcome", a."toStatus"
      FROM "AmuxWorkItem" w JOIN "AmuxExecutionAttempt" a ON a."id" = ${priorAttemptId}
      WHERE w."id" = ${taskId}`;
    assert.deepEqual(before, { status: "review", revision: 4, reviewPrNumber: null,
      outcome: "succeeded", toStatus: "review" });
    const escalationId = await openEscalation(db, taskId);

    // Only the new pairing is admitted; the rest of the check is unchanged.
    await refused(tx, db, () => insertProposal(db, { taskId,
      attemptId: priorAttemptId, escalationId, outcome: "retry",
      targetStatus: "blocked" }));
    await refused(tx, db, () => insertProposal(db, { taskId,
      attemptId: priorAttemptId, escalationId, outcome: "approve",
      targetStatus: "todo" }));

    // The rows resolveAmuxReview writes for the retry, in its order.
    const proposalId = randomUUID();
    const decisionId = randomUUID();
    await insertProposal(db, { taskId, attemptId: priorAttemptId, escalationId,
      outcome: "retry", targetStatus: "todo", proposalId, decisionId });
    await db.query(`UPDATE public."AmuxWorkItem" SET "status" = 'todo',
      "revision" = 5, "owner" = NULL, "claimedAt" = NULL, "reviewPrNumber" = NULL
      WHERE "id" = $1 AND "revision" = 4 AND "status" = 'review'`, [taskId]);
    await db.query(`UPDATE public."AmuxHumanEscalation" SET "status" = 'resolved',
      "resolutionOutcome" = 'retry', "resolution" = 'Run it again with tests.',
      "resolvedById" = $2, "resolvedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [escalationId, owner]);
    const auditLogId = await appendSyntheticAdminAudit(db, {
      actorUserId: owner, action: "amux.human_escalation.resolved",
      targetType: "AmuxWorkItem", targetId: taskId,
      summary: "Resolved an AMUX human review escalation.",
      metadata: { decision_id: decisionId, proposal_id: proposalId,
        escalation_id: escalationId, outcome: "retry", review_base_sha: null,
        subject_digest: "f".repeat(64) },
    });
    await db.query(`INSERT INTO public."AmuxReviewDecision"
      ("id", "proposalId", "escalationId", "outcome", "requestDigest",
       "idempotencyKeyHash", "actorUserId", "auditLogId") VALUES
      ($1::uuid, $2, $3, 'retry', $4, $5, $6, $7)`,
    [decisionId, proposalId, escalationId, "b".repeat(64), "c".repeat(64),
      owner, auditLogId]);
    const [after] = await tx.$queryRaw`SELECT "status", "revision"
      FROM "AmuxWorkItem" WHERE "id" = ${taskId}`;
    assert.deepEqual(after, { status: "todo", revision: 5 });
  });
});

test("a PR-less review retry is still refused once the attempt budget is spent", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  await inRollback(async (tx, db) => {
    const { taskId, priorAttemptId } =
      await seedAmuxV4PortfolioRecoveryPrerequisites(db, { attemptNumber: 5 });
    const escalationId = await openEscalation(db, taskId);
    await refused(tx, db, () => insertProposal(db, { taskId,
      attemptId: priorAttemptId, escalationId, outcome: "retry",
      targetStatus: "todo" }));
  });
});
