import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Real PostgreSQL, rollback-only. An implement run whose patch the v52 review
// server rejected a second time settles `succeeded` -> blocked with
// review_server_rejected_twice. The owner may retry it (owner decision
// 2026-11-07, AMUX-ROUTERFAIL-004): the review offers retry only on that
// attempt's own reject record, the DB guards accept the retry, the claim
// reaches the same worker, the next run carries the latest findings, and its
// first rejection returns to the same grade once more.

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
const JOB_ID = "r-20261107-061748-c125b8";

async function recordReview(db, { attemptId, taskId, verdict, jobId }) {
  const auditLogId = await appendSyntheticAdminAudit(db, {
    actorUserId: owner, action: "amux.v52.review.recorded",
    targetType: "AmuxExecutionAttempt", targetId: attemptId,
    summary: "synthetic v52 review",
  });
  await db.query(`INSERT INTO public."AmuxV52ReviewRecord"
    ("attemptId", "taskId", "jobId", "baseSha", "commitSha", "verdict",
     "authorVendor", "reviewerVendors", "touchesContract", "requestDigest",
     "auditLogId") VALUES ($1, $2, $3, $4, $5, $6, 'openai',
     ARRAY['anthropic']::text[], false, $7, $8)`,
  [attemptId, taskId, jobId, "a".repeat(40), "c".repeat(40), verdict,
    "d".repeat(64), auditLogId]);
}

/** The rows resolveAmuxReview writes for an owner retry, in its order. */
async function ownerRetries(db, taskId, attemptId) {
  const escalationId = randomUUID();
  await db.query(`INSERT INTO public."AmuxHumanEscalation"
    ("id", "taskId", "reason", "status", "openedBy", "openedTaskRevision",
     "updatedAt") VALUES ($1, $2, 'review_server_rejected_twice', 'open',
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
    "resolutionOutcome" = 'retry', "resolution" = 'Retry the rejected patch.',
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
  const rollback = new Error("synthetic rejected-twice retry rollback");
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

const seedRejected = (db, { reason = "review_server_rejected_twice",
  verdict = "reject", jobId = JOB_ID, attemptNumber = 1 } = {}) =>
  seedAmuxV4PortfolioRecoveryPrerequisites(db, { attemptNumber,
    settlementStatus: "blocked", settlementOutcome: "succeeded",
    settlementReason: reason,
    afterAttempt: ({ ids, attemptId }) => verdict === null ? undefined :
      recordReview(db, { attemptId, taskId: ids.task, verdict, jobId }),
  });

const modules = () => Promise.all([
  import("../../lib/amux/v22WorkerUsageGate.ts"),
  import("../../lib/amux/reviewApprovalCore.ts"),
  import("../../lib/amux/v52ReviewRejections.ts"),
  import("../../lib/amux/v52ReviewCore.ts"),
]);

test("a twice-rejected run reaches an owner retry, the claim and a fresh first rejection", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ amuxV22RoutesWithSettledUsage }, { amuxV22ReviewRetryHasVerifiedOutcome },
    { amuxV52PriorReviewRejections, amuxV52RejectedTwiceReviewAttemptId,
      amuxV52ReviewFeedbackJobId }, { decideAmuxV52ReviewDisposition }] =
    await modules();
  await inRollback(async (tx, db) => {
    const { taskId, priorAttemptId } = await seedRejected(db);
    const [attempt] = await tx.$queryRaw`SELECT "id", "v22AssignmentId",
      "outcome", "toStatus", "reason" FROM "AmuxExecutionAttempt"
      WHERE "id" = ${priorAttemptId}`;
    assert.deepEqual([attempt.outcome, attempt.toStatus, attempt.reason],
      ["succeeded", "blocked", "review_server_rejected_twice"]);

    // 1. The review offers retry on this attempt's own reject record.
    const rejectedReviewAttemptId =
      await amuxV52RejectedTwiceReviewAttemptId(tx, taskId, attempt);
    assert.equal(rejectedReviewAttemptId, priorAttemptId);
    assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
      sourceSystem: "admin-idea-v4", attempt, rejectedReviewAttemptId }), true);
    // Its usage is unreported, so the worker is held for every Task until then.
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null, taskId),
      { routes: [], unsettled: true });
    // Without an owner retry, a further rejection would still be the second.
    assert.equal(await amuxV52PriorReviewRejections(tx, taskId, "next-attempt"), 1);

    // 2. The owner retries; the review DB guards accept it.
    await ownerRetries(db, taskId, priorAttemptId);
    const [task] = await tx.$queryRaw`SELECT "status", "revision"
      FROM "AmuxWorkItem" WHERE "id" = ${taskId}`;
    assert.deepEqual(task, { status: "todo", revision: 5 });

    // 3. The claim may give the retried Task the same worker; no other Task.
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null, taskId),
      { routes, unsettled: false });
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      `other-${randomUUID()}`), { routes: [], unsettled: true });

    // 4. The next run's prompt carries the latest rejection's findings.
    assert.equal(await amuxV52ReviewFeedbackJobId(tx, taskId), JOB_ID);

    // 5. Its first rejection returns to the same grade once more.
    const prior = await amuxV52PriorReviewRejections(tx, taskId, "next-attempt");
    assert.equal(prior, 0);
    assert.deepEqual(decideAmuxV52ReviewDisposition("reject", prior),
      { status: "todo", reason: "review_server_rejected" });
  });
});

test("an unknown review result keeps retry closed even with a retry decision", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ amuxV22RoutesWithSettledUsage }, { amuxV22ReviewRetryHasVerifiedOutcome },
    { amuxV52RejectedTwiceReviewAttemptId }] = await modules();
  await inRollback(async (tx, db) => {
    const { taskId, priorAttemptId } = await seedRejected(db, {
      reason: "review_server_unknown", verdict: "unknown", jobId: null });
    const [attempt] = await tx.$queryRaw`SELECT "id", "v22AssignmentId",
      "outcome", "toStatus", "reason" FROM "AmuxExecutionAttempt"
      WHERE "id" = ${priorAttemptId}`;
    const rejectedReviewAttemptId =
      await amuxV52RejectedTwiceReviewAttemptId(tx, taskId, attempt);
    assert.equal(rejectedReviewAttemptId, null);
    assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
      sourceSystem: "admin-idea-v4", attempt, rejectedReviewAttemptId }), false);
    await ownerRetries(db, taskId, priorAttemptId);
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null, taskId),
      { routes: [], unsettled: true });
  });
});

test("a twice-rejected reason without its reject record is not retryable", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [, { amuxV22ReviewRetryHasVerifiedOutcome },
    { amuxV52RejectedTwiceReviewAttemptId }] = await modules();
  await inRollback(async (tx, db) => {
    const { taskId, priorAttemptId } = await seedRejected(db, { verdict: null });
    const [attempt] = await tx.$queryRaw`SELECT "id", "v22AssignmentId",
      "outcome", "toStatus", "reason" FROM "AmuxExecutionAttempt"
      WHERE "id" = ${priorAttemptId}`;
    const rejectedReviewAttemptId =
      await amuxV52RejectedTwiceReviewAttemptId(tx, taskId, attempt);
    assert.equal(rejectedReviewAttemptId, null);
    assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
      sourceSystem: "admin-idea-v4", attempt, rejectedReviewAttemptId }), false);
  });
});

test("a used-up attempt budget refuses the retry at the DB edge", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  await inRollback(async (tx, db) => {
    // The same budget the review snapshot reads (decideAmuxAttemptBudget):
    // the greatest attempt number counts as attempts used.
    const { taskId, priorAttemptId } = await seedRejected(db, { attemptNumber: 5 });
    const { decideAmuxAttemptBudget } =
      await import("../../lib/amux/executionBudgetCore.ts");
    assert.equal(decideAmuxAttemptBudget({ historical_rows: 1,
      greatest_attempt_number: 5 }).allowed, false);
    await assert.rejects(ownerRetries(db, taskId, priorAttemptId),
      /AMUX review retry attempt budget exhausted/);
  });
});
