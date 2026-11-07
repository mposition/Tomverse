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
async function ownerRetries(db, taskId, attemptId, reason = "cli_turn_limit") {
  const escalationId = randomUUID();
  await db.query(`INSERT INTO public."AmuxHumanEscalation"
    ("id", "taskId", "reason", "status", "openedBy", "openedTaskRevision",
     "updatedAt") VALUES ($1, $2, $3, 'open',
     'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`,
  [escalationId, taskId, reason]);
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

// AMUX-FILEGEN-003 (review r-20261107-061707-e4a9a6): the bridge stores the
// final result and reports CLI usage after it. A lease that expired between
// the two leaves an expired attempt with a stored result and no usage row at
// all; the owner may retry it (#3419), and the claim must then reach it.

/** Settles the seeded attempt the way the v22 reaper does, with no usage row. */
function seedExpiredWithoutUsage(db) {
  return seedAmuxV4PortfolioRecoveryPrerequisites(db, {
    settlementStatus: "blocked", settlementOutcome: "expired",
    settlementReason: "outcome_unknown", usageReported: false,
  });
}

async function storeResult(db, seed, attemptId, age = "0 seconds") {
  await db.query(`INSERT INTO public."AmuxV22TaskResult"
    ("attemptId", "taskId", "ideaId", "ciphertext", "keyId", "keyVersion",
     "digest", "digestKeyId", "sourceSha256", "byteLength", "createdAt")
    VALUES ($1, $2, $3, convert_to('synthetic-only', 'UTF8'), 'synthetic', 1,
      $4, 'synthetic', $4, 14, CURRENT_TIMESTAMP - $5::interval)`,
  [attemptId, seed.taskId, seed.ideaId, "d".repeat(64), age]);
}

/** A second, finished attempt on the same Task, on another worker, started
 * before or after the seeded one (the review proposal binds the latest). Its
 * v22 binding trigger is deferred and the transaction never commits; it only
 * gives a proposal or a result a different attempt to be bound to. */
async function otherAttemptOnTask(db, seed, startedOffset) {
  const id = randomUUID();
  await db.query("SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger DEFERRED");
  await db.query(`INSERT INTO public."AmuxExecutionAttempt"
    ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
     "taskRevision", "attemptNumber", "reservedCostMicrousd", "heartbeatAt",
     "startedAt", "endedAt", "outcome", "toStatus", "endedBy", "updatedAt")
    VALUES ($1, $2, 'worker-two', $3, 1, 3, 2, 0, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + $4::interval, CURRENT_TIMESTAMP + $4::interval,
      'succeeded', 'review', 'worker-two', CURRENT_TIMESTAMP)`,
  [id, seed.taskId, seed.recoveryInstanceId, startedOffset]);
  return id;
}

/** The review rule's own read: reviewApproval.ts takes the Task's latest
 * stored v22 result in this order. */
async function latestResultAttemptId(tx, taskId) {
  const [row] = await tx.$queryRaw`SELECT "attemptId" FROM "AmuxV22TaskResult"
    WHERE "taskId" = ${taskId} ORDER BY "createdAt" DESC, "attemptId" DESC LIMIT 1`;
  return row?.attemptId ?? null;
}

test("an owner retry of an expired attempt with a stored result reaches the claim; other Tasks still wait", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ amuxV22RoutesWithSettledUsage }, { amuxV22ReviewRetryHasVerifiedOutcome }] =
    await Promise.all([import("../../lib/amux/v22WorkerUsageGate.ts"),
      import("../../lib/amux/reviewApprovalCore.ts")]);
  await inRollback(async (tx, db) => {
    // 1. Result stored, usage missing, lease expired.
    const seed = await seedExpiredWithoutUsage(db);
    const { taskId, priorAttemptId } = seed;
    await storeResult(db, seed, priorAttemptId);
    const [attempt] = await tx.$queryRaw`SELECT "id", "v22AssignmentId", "outcome",
      "toStatus", "reason" FROM "AmuxExecutionAttempt" WHERE "id" = ${priorAttemptId}`;
    assert.equal(attempt.outcome, "expired");
    assert.deepEqual(await tx.$queryRaw`SELECT "id" FROM "AmuxCliUsageEvent"
      WHERE "attemptId" = ${priorAttemptId}`, []);
    // Review offers the retry on exactly this evidence.
    assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({ sourceSystem: "admin-idea-v4",
      attempt, storedResultAttemptId: await latestResultAttemptId(tx, taskId) }), true);
    // No decision yet: the worker is refused for every Task, this one included.
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null, taskId),
      { routes: [], unsettled: true });

    // 2. The owner retries from review.
    await ownerRetries(db, taskId, priorAttemptId, "outcome_unknown");

    // 3. Reassignment to the same worker for the retried Task only.
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null, taskId),
      { routes, unsettled: false });
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      `other-${randomUUID()}`), { routes: [], unsettled: true });
    // Nothing was written for the attempt's usage.
    assert.deepEqual(await tx.$queryRaw`SELECT "id" FROM "AmuxCliUsageEvent"
      WHERE "attemptId" = ${priorAttemptId}`, []);
  });
});

test("a retry decision bound to another attempt does not release an expired attempt", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const { amuxV22RoutesWithSettledUsage } =
    await import("../../lib/amux/v22WorkerUsageGate.ts");
  await inRollback(async (tx, db) => {
    const seed = await seedExpiredWithoutUsage(db);
    await storeResult(db, seed, seed.priorAttemptId);
    // A later attempt the owner's retry is bound to instead.
    const otherAttemptId = await otherAttemptOnTask(db, seed, "1 minute");
    await ownerRetries(db, seed.taskId, otherAttemptId, "outcome_unknown");
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      seed.taskId), { routes: [], unsettled: true });
  });
});

test("an expired attempt whose Task's latest stored result is another attempt's stays refused", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const { amuxV22RoutesWithSettledUsage } =
    await import("../../lib/amux/v22WorkerUsageGate.ts");
  await inRollback(async (tx, db) => {
    const seed = await seedExpiredWithoutUsage(db);
    // An earlier attempt on the Task; the expired one stays the latest.
    const otherAttemptId = await otherAttemptOnTask(db, seed, "-1 minute");
    await ownerRetries(db, seed.taskId, seed.priorAttemptId, "outcome_unknown");
    // No result at all: an expired attempt is an unknown outcome.
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      seed.taskId), { routes: [], unsettled: true });
    // A result stored for another attempt is not this attempt's evidence.
    await storeResult(db, seed, otherAttemptId);
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      seed.taskId), { routes: [], unsettled: true });
    // Nor is an older result of its own when the latest one is another's.
    await storeResult(db, seed, seed.priorAttemptId, "1 minute");
    assert.equal(await latestResultAttemptId(tx, seed.taskId), otherAttemptId);
    assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx, routes, null,
      seed.taskId), { routes: [], unsettled: true });
  });
});
