import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Real PostgreSQL, rollback-only. A failed Claude run whose CLI named the
// cause settles blocked with a partial receipt (#3407); the owner then retries
// it from review. That retry creates no recovery approval, so the claim's
// usage gate must not keep refusing the Task its own failed attempt
// (review r-20261107-015440-41ac19), while every other Task still waits.

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
const routes = [{ workerName: "worker-one", routeId: "route-one" }];

/** The rows resolveAmuxReview writes for an owner retry, in its order: the
 * proposal bound to the latest attempt, the task CAS to todo, the resolved
 * escalation, the audit entry and the decision. */
async function ownerRetries(db, taskId, attemptId) {
  const escalationId = randomUUID();
  await db.query(`INSERT INTO public."AmuxHumanEscalation"
    ("id", "taskId", "reason", "status", "openedBy", "openedTaskRevision",
     "updatedAt") VALUES ($1, $2, 'cli_turn_limit', 'open',
     'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`, [escalationId, taskId]);
  const proposalId = randomUUID();
  const decisionId = randomUUID();
  const subjectDigest = "f".repeat(64);
  await db.query(`INSERT INTO public."AmuxReviewProposal"
    ("id", "decisionId", "escalationId", "taskId", "taskRevision", "outcome",
     "sourceStatus", "targetStatus", "subjectDigest", "attemptId",
     "issuedAt", "expiresAt") VALUES ($1, $2::uuid, $3, $4, 4, 'retry',
     'blocked', 'todo', $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [proposalId, decisionId, escalationId, taskId, subjectDigest, attemptId]);
  await db.query(`UPDATE public."AmuxWorkItem" SET "status" = 'todo',
    "revision" = 5, "owner" = NULL, "claimedAt" = NULL, "reviewPrNumber" = NULL
    WHERE "id" = $1 AND "revision" = 4 AND "status" = 'blocked'`, [taskId]);
  await db.query(`UPDATE public."AmuxHumanEscalation" SET "status" = 'resolved',
    "resolutionOutcome" = 'retry', "resolution" = 'Retry the named failure.',
    "resolvedById" = $2, "resolvedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
  [escalationId, owner]);
  const auditLogId = await appendSyntheticAdminAudit(db, {
    actorUserId: owner, action: "amux.human_escalation.resolved",
    targetType: "AmuxWorkItem", targetId: taskId,
    summary: "Resolved an AMUX human review escalation.",
    metadata: { decision_id: decisionId, proposal_id: proposalId,
      escalation_id: escalationId, outcome: "retry", review_base_sha: null,
      subject_digest: subjectDigest },
  });
  await db.query(`INSERT INTO public."AmuxReviewDecision"
    ("id", "proposalId", "escalationId", "outcome", "requestDigest",
     "idempotencyKeyHash", "actorUserId", "auditLogId") VALUES
    ($1::uuid, $2, $3, 'retry', $4, $5, $6, $7)`,
  [decisionId, proposalId, escalationId, "b".repeat(64), "c".repeat(64),
    owner, auditLogId]);
}

async function inRollback(work) {
  const { prisma } = await import("../../lib/prisma.ts");
  const rollback = new Error("synthetic retry claim rollback");
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

test("an owner retry of a named Claude CLI failure reaches the claim; other Tasks still wait", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ amuxV22RoutesWithSettledUsage }, { amuxV22ReviewRetryHasVerifiedOutcome }] =
    await Promise.all([import("../../lib/amux/v22WorkerUsageGate.ts"),
      import("../../lib/amux/reviewApprovalCore.ts")]);
  await inRollback(async (tx, db) => {
    // 1. Failed settle: the CLI named a turn limit, the receipt is partial,
    // and the attempt ended blocked for that cause.
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(db, {
      settlementStatus: "blocked", settlementOutcome: "blocked",
      settlementReason: "cli_turn_limit", claudeCliFailure: "turn_limit",
    });
    const { taskId, priorAttemptId } = seed;
    const [attempt] = await tx.$queryRaw`SELECT "v22AssignmentId", "outcome",
      "toStatus", "reason" FROM "AmuxExecutionAttempt" WHERE "id" = ${priorAttemptId}`;
    assert.equal(attempt.reason, "cli_turn_limit");
    assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
      sourceSystem: "admin-idea-v4", attempt }), true);
    // Before the owner decides, the failed run holds its worker for every Task.
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null, taskId),
      { routes: [], unsettled: true });

    // 2. The owner retries from review.
    await ownerRetries(db, taskId, priorAttemptId);

    // 3. Reassignment: the same worker may take the retried Task ...
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null, taskId),
      { routes, unsettled: false });
    // ... but not any other Task, and the receipt is still partial.
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      `other-${randomUUID()}`), { routes: [], unsettled: true });
    const usage = await tx.$queryRaw`SELECT "completeness", "cliFailure"
      FROM "AmuxCliUsageEvent" WHERE "attemptId" = ${priorAttemptId}`;
    assert.deepEqual(usage, [{ completeness: "reported_partial", cliFailure: "turn_limit" }]);
  });
});

test("a retry decision does not release a failure whose cause is unknown", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const { amuxV22RoutesWithSettledUsage } =
    await import("../../lib/amux/v22WorkerUsageGate.ts");
  await inRollback(async (tx, db) => {
    // Review offers no retry for usage_outcome_unknown; even a recorded
    // retry bound to such an attempt leaves the worker refused.
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(db, {
      settlementStatus: "blocked", settlementOutcome: "blocked",
      settlementReason: "usage_outcome_unknown",
    });
    await ownerRetries(db, seed.taskId, seed.priorAttemptId);
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      seed.taskId), { routes: [], unsettled: true });
  });
});
