import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Real PostgreSQL, rollback-only. A rejected v52 review's findings are one
// sealed content unit beside the append-only review record (owner decision
// 2026-11-15): bound to a rejected record, readable newest first for a Task's
// cards and prompts, cleared once by the retention purge, and its key
// deletion is queued in the content key retirement ledger.

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

async function inRollback(work) {
  const { prisma } = await import("../../lib/prisma.ts");
  const rollback = new Error("synthetic review findings rollback");
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '10000', true)`;
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      await work(tx, prismaQueryAdapter(tx));
      throw rollback;
    }, { timeout: 60_000 }), (error) => error === rollback);
  } finally {
    await prisma.$disconnect();
  }
}

const owner = "synthetic-owner";
const JOB_ID = "r-20261115-072108-90c5fc";

async function recordReview(db, { attemptId, taskId, verdict }) {
  const auditLogId = await appendSyntheticAdminAudit(db, {
    actorUserId: owner, action: "amux.v52.review.recorded",
    targetType: "AmuxExecutionAttempt", targetId: attemptId,
    summary: "synthetic v52 review",
  });
  await db.query(`INSERT INTO public."AmuxV52ReviewRecord"
    ("attemptId", "taskId", "jobId", "baseSha", "commitSha", "verdict",
     "authorVendor", "reviewerVendors", "touchesContract", "requestDigest",
     "auditLogId") VALUES ($1, $2, $3, $4, $5, $6, 'anthropic',
     ARRAY['moonshot']::text[], false, $7, $8)`,
  [attemptId, taskId, JOB_ID, "a".repeat(40), "c".repeat(40), verdict,
    "d".repeat(64), auditLogId]);
}

async function expectError(db, sql, params, code, constraint) {
  await db.query("SAVEPOINT probe");
  let error;
  try { await db.query(sql, params); } catch (caught) { error = caught; }
  await db.query("ROLLBACK TO SAVEPOINT probe");
  await db.query("RELEASE SAVEPOINT probe");
  const found = error?.code ?? error?.meta?.code ?? String(error?.message);
  assert.ok(error, `${sql.slice(0, 60)} did not fail`);
  assert.match(String(found) + String(error.message), new RegExp(code), String(error.message));
  if (constraint) assert.match(String(error.message), new RegExp(constraint));
}

test("findings belong to a rejected review, read back newest first, and are cleared once", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const core = await import("../../lib/amux/v52ReviewFindingsCore.ts");
  const store = await import("../../lib/amux/v52ReviewFindingsStore.ts");
  const crypto = await import("../../lib/amux/ideaCrypto.ts");
  const keys = { masterKeyId: `amux2-${"k".repeat(20)}`, masterKeyVersion: 1,
    masterKey: randomBytes(32), digestKeyId: "digest-one", digestKey: randomBytes(32) };
  const doc = core.normalizeAmuxV52FindingsDoc({ version: 1, reviewers: [{ vendor: "moonshot",
    verdict: "reject", findings: [
      { severity: "major", summary: "The output is written after the redirect.", file: "lib/image/out.ts", line: 17 },
      { severity: "minor", summary: "The test misses the empty trailer." }] }] });

  await inRollback(async (tx, db) => {
    const { taskId, priorAttemptId, ideaId } = await seedAmuxV4PortfolioRecoveryPrerequisites(db, {
      attemptNumber: 1, settlementStatus: "blocked", settlementOutcome: "succeeded",
      settlementReason: "review_server_rejected_twice",
      afterAttempt: ({ ids, attemptId }) => recordReview(db, { attemptId, taskId: ids.task, verdict: "reject" }),
    });
    // A row with a body that is neither whole nor purged, or a digest that is not one, is refused.
    await expectError(db, `INSERT INTO public."AmuxV52ReviewFindings"
      ("attemptId", "taskId", "ideaId", "digest", "digestKeyId", "byteLength", "findingCount")
      VALUES ($1, $2, $3, $4, 'd', 10, 1)`, [priorAttemptId, taskId, ideaId, "a".repeat(64)],
    "AmuxV52ReviewFindings_body_check");
    await expectError(db, `INSERT INTO public."AmuxV52ReviewFindings"
      ("attemptId", "taskId", "ideaId", "ciphertext", "keyId", "keyVersion", "digest",
       "digestKeyId", "byteLength", "findingCount") VALUES ($1, $2, $3, $4, 'k', 1, 'not-a-digest', 'd', 10, 1)`,
    [priorAttemptId, taskId, ideaId, Buffer.from("x")], "AmuxV52ReviewFindings_digest_check");
    const sealed = store.sealAmuxV52ReviewFindings(doc, priorAttemptId, keys);
    await store.createAmuxV52ReviewFindingsRow(tx, { attemptId: priorAttemptId, taskId, ideaId, sealed, repeatsPrior: true });

    // 1. The task's rejected reviews come back with their sealed body, and the body opens to the document.
    const history = await store.readAmuxV52ReviewHistory(tx, taskId);
    assert.equal(history.length, 1);
    assert.equal(history[0].verdict, "reject");
    assert.equal(history[0].attemptNumber, 1);
    assert.equal(history[0].sealed.ideaId, ideaId);
    assert.equal(history[0].findingsSummary, null);
    const plain = crypto.openAmuxContent({ ciphertext: Buffer.from(history[0].sealed.ciphertext),
      keyId: history[0].sealed.keyId, keyVersion: history[0].sealed.keyVersion },
    "review_findings", priorAttemptId, keys);
    assert.deepEqual(core.decodeAmuxV52FindingsDoc(plain), doc);
    assert.equal(plain.includes(Buffer.from("lib/image/out.ts")), true);
    assert.equal(Buffer.from(history[0].sealed.ciphertext).includes(Buffer.from("lib/image/out.ts")), false,
      "the stored body is sealed");
    const rejected = await store.readAmuxV52RejectedReviews(tx, [taskId, randomUUID()]);
    assert.deepEqual(rejected.map((row) => [row.taskId, row.attemptId]), [[taskId, priorAttemptId]]);
    assert.equal((await store.readAmuxV52RejectedReviews(tx, [])).length, 0);

    // 2. The row is bound to a rejected record, one per attempt, and its body is immutable.
    const [row] = await tx.$queryRaw`SELECT "findingCount", "byteLength", "repeatsPrior" FROM "AmuxV52ReviewFindings"
      WHERE "attemptId" = ${priorAttemptId}`;
    assert.deepEqual([row.findingCount, row.byteLength > 0, row.repeatsPrior], [2, true, true]);
    await expectError(db, `UPDATE public."AmuxV52ReviewFindings" SET "repeatsPrior" = false
      WHERE "attemptId" = $1`, [priorAttemptId], "immutable");
    const insert = `INSERT INTO public."AmuxV52ReviewFindings"
      ("attemptId", "taskId", "ideaId", "ciphertext", "keyId", "keyVersion", "digest",
       "digestKeyId", "byteLength", "findingCount") VALUES ($1, $2, $3, $4, 'k', 1, $5, 'd', 10, 1)`;
    await expectError(db, insert, [priorAttemptId, taskId, ideaId, Buffer.from("x"), "a".repeat(64)],
      "23505|duplicate", "AmuxV52ReviewFindings");
    await expectError(db, `UPDATE public."AmuxV52ReviewFindings" SET "ciphertext" = $2
      WHERE "attemptId" = $1`, [priorAttemptId, Buffer.from("tampered")], "immutable");
    await expectError(db, `UPDATE public."AmuxV52ReviewFindings" SET "digest" = $2
      WHERE "attemptId" = $1`, [priorAttemptId, "b".repeat(64)], "immutable");
    await expectError(db, `DELETE FROM public."AmuxV52ReviewFindings" WHERE "attemptId" = $1`,
      [priorAttemptId], "immutable");
    await expectError(db, `UPDATE public."AmuxV52ReviewFindings" SET "ciphertext" = NULL
      WHERE "attemptId" = $1`, [priorAttemptId], "immutable");

    // 3. The retention purge clears the body once, the way the result's purge does.
    await db.query(`UPDATE public."AmuxV52ReviewFindings" SET "ciphertext" = NULL, "keyId" = NULL,
      "keyVersion" = NULL, "bodyPurgedAt" = CURRENT_TIMESTAMP WHERE "attemptId" = $1`, [priorAttemptId]);
    const purged = await store.readAmuxV52ReviewHistory(tx, taskId);
    assert.equal(purged[0].sealed.ciphertext, null);
    assert.ok(purged[0].sealed.bodyPurgedAt instanceof Date);
    await expectError(db, `UPDATE public."AmuxV52ReviewFindings" SET "bodyPurgedAt" = CURRENT_TIMESTAMP
      WHERE "attemptId" = $1`, [priorAttemptId], "immutable");

    // 4. Its key's deletion is queued in the same ledger as every other content unit.
    const purgeAudit = await appendSyntheticAdminAudit(db, { actorUserId: owner,
      action: "amux.v4.content.purged", targetType: "AmuxIdeaContentKeyRetirement",
      targetId: `${ideaId}:review_findings:${priorAttemptId}`, summary: "synthetic purge" });
    await db.query(`INSERT INTO public."AmuxIdeaContentKeyRetirement"
      ("ideaId", "purpose", "subjectId", "bodyPurgedAt", "purgeAuditLogId")
      VALUES ($1, 'review_findings', $2, CURRENT_TIMESTAMP, $3)`, [ideaId, priorAttemptId, purgeAudit]);
    await expectError(db, `INSERT INTO public."AmuxIdeaContentKeyRetirement"
      ("ideaId", "purpose", "subjectId", "bodyPurgedAt", "purgeAuditLogId")
      VALUES ($1, 'review_findingz', $2, CURRENT_TIMESTAMP, $3)`, [ideaId, priorAttemptId, purgeAudit],
    "AmuxIdeaContentKeyRetirement_purpose_check");
  });
});

test("findings cannot be stored for a review that did not reject", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  await inRollback(async (tx, db) => {
    const { taskId, priorAttemptId, ideaId } = await seedAmuxV4PortfolioRecoveryPrerequisites(db, {
      attemptNumber: 1, settlementStatus: "review", settlementOutcome: "succeeded",
      afterAttempt: ({ ids, attemptId }) => recordReview(db, { attemptId, taskId: ids.task, verdict: "accept" }),
    });
    await expectError(db, `INSERT INTO public."AmuxV52ReviewFindings"
      ("attemptId", "taskId", "ideaId", "ciphertext", "keyId", "keyVersion", "digest",
       "digestKeyId", "byteLength", "findingCount") VALUES ($1, $2, $3, $4, 'k', 1, $5, 'd', 10, 1)`,
    [priorAttemptId, taskId, ideaId, Buffer.from("x"), "a".repeat(64)], "belong to a rejected review");
    assert.equal((await tx.$queryRaw`SELECT count(*)::int AS n FROM "AmuxV52ReviewFindings"`)[0].n, 0);
  });
});
