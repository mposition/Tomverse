import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
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

test("v52 grade escalation requires one current-attempt audit and leaves other approval bindings immutable", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = '10s'");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const originalReceiptDigest = "d".repeat(64);
    const frontierReceiptDigest = "e".repeat(64);
    async function rejects(sql, values) {
      await db.query("SAVEPOINT grade_probe");
      let error;
      try { await db.query(sql, values); }
      catch (caught) { error = caught; }
      await db.query("ROLLBACK TO SAVEPOINT grade_probe");
      await db.query("RELEASE SAVEPOINT grade_probe");
      assert.ok(error, "unbound grade change succeeded");
      assert.equal(error.constraint, "AmuxV4TaskDag_binding_check",
        error.message);
    }
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(db, {
      executionGrade: "routine", costReceiptDigest: originalReceiptDigest,
      settlementStatus: "todo", settlementGrade: "frontier",
      afterAttempt: async ({ ids }) => {
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "status" = 'todo', "owner" = NULL, "claimedAt" = NULL,
              "v22AssignmentId" = NULL, "executionGrade" = 'frontier',
              "revision" = 4 WHERE "id" = $1`, [ids.task]);
      },
      beforeSettlement: async ({ ids }) => {
        const task = (await db.query(`SELECT "v22AssignmentId", "revision"
          FROM public."AmuxWorkItem" WHERE "id" = $1`, [ids.task])).rows[0];
        const attempt = (await db.query(`SELECT "id" FROM
          public."AmuxExecutionAttempt" WHERE "taskId" = $1`,
        [ids.task])).rows[0];
        await appendSyntheticAdminAudit(db, {
          actorUserId: null, action: "amux.grade.escalated",
          targetType: "AmuxWorkItem", targetId: ids.task,
          summary: "synthetic v52 grade escalation",
          metadata: { systemActor: "tomverse-amux-orchestrator",
            attemptId: attempt.id, assignmentId: task.v22AssignmentId,
            fromRevision: task.revision, reason: "contract_path_touched",
            previousGrade: "routine", nextGrade: "frontier",
            originalReceiptDigest,
            newReceipt: { role: "investigate", grade: "frontier",
              receiptDigest: frontierReceiptDigest },
            classificationFailure: true }, useSavepoint: false,
        });
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "executionGrade" = 'frontier' WHERE "id" = $1`, [ids.task]);
        await db.query("SAVEPOINT duplicate_grade_audit");
        await appendSyntheticAdminAudit(db, {
          actorUserId: null, action: "amux.grade.escalated",
          targetType: "AmuxWorkItem", targetId: ids.task,
          summary: "duplicate synthetic escalation",
          metadata: { systemActor: "tomverse-amux-orchestrator" },
          useSavepoint: false,
        });
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "status" = 'todo', "owner" = NULL, "claimedAt" = NULL,
              "v22AssignmentId" = NULL, "executionGrade" = 'frontier',
              "revision" = 4 WHERE "id" = $1`, [ids.task]);
        await db.query("ROLLBACK TO SAVEPOINT duplicate_grade_audit");
        await db.query("RELEASE SAVEPOINT duplicate_grade_audit");
      },
      afterSettlement: async ({ ids }) => {
        const result = (await db.query(`SELECT "status", "executionGrade"
          FROM public."AmuxWorkItem" WHERE "id" = $1`, [ids.task])).rows[0];
        assert.deepEqual(result, { status: "todo", executionGrade: "frontier" });
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "taskRole" = 'design' WHERE "id" = $1`, [ids.task]);
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "executionGrade" = 'advanced' WHERE "id" = $1`, [ids.task]);
      },
    });
    assert.ok(seed.taskId);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
});
