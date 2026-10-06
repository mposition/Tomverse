import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

test("v22 Task Todo needs a bound receipt while the legacy lane is unchanged", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const db = new pg.Client({ connectionString: databaseUrl });
  const taskId = randomUUID();
  const featureId = randomUUID();
  const epicId = randomUUID();
  const initiativeId = randomUUID();
  const digest = "a".repeat(64);
  const cipher = Buffer.from("synthetic-only", "utf8");
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = '10s'");
    for (const [id, level, parentId] of [
      [initiativeId, "initiative", null], [epicId, "epic", initiativeId],
      [featureId, "feature", epicId],
    ]) {
      await db.query(`INSERT INTO public."AmuxPortfolioNode"
        ("id", "level", "parentId", "state", "revision", "titleCiphertext",
         "contentKeyId", "contentKeyVersion", "contentDigest",
         "contentDigestKeyId", "approvedByUserId", "authorizationAuditLogId",
         "updatedAt") VALUES ($1, $2, $3, 'active', 0, $4,
         'synthetic', 1, $5, 'synthetic', 'synthetic-owner', $6,
         CURRENT_TIMESTAMP)`, [id, level, parentId, cipher, digest,
        randomUUID()]);
    }
    await db.query(`INSERT INTO public."AmuxWorkItem"
      ("id", "title", "status", "sourceSystem", "sourceKey",
       "sourceVersion", "sourceDigest", "sourceSnapshot", "cardType",
       "parentFeatureNodeId", "v4TitleCiphertext", "v4TitleKeyId",
       "v4TitleKeyVersion", "v4TitleDigest", "v4TitleDigestKeyId",
       "v4BodyCiphertext", "v4BodyKeyId", "v4BodyKeyVersion",
       "v4BodyDigest", "v4BodyDigestKeyId", "v4BriefCiphertext",
       "v4BriefKeyId", "v4BriefKeyVersion", "v4BriefDigest",
       "v4BriefDigestKeyId", "v4SourceApprovalId", "taskRole",
       "executionGrade", "updatedAt")
      VALUES ($1, 'AMUX Task', 'backlog', 'admin-idea-v4', $2,
        'v1', $3, $4::jsonb, 'task', $5, $6, 'synthetic', 1,
        $3, 'synthetic', $6, 'synthetic', 1, $3, 'synthetic',
        $6, 'synthetic', 1, $3, 'synthetic', $7, 'implement',
        'medium', CURRENT_TIMESTAMP)`,
    [taskId, randomUUID().replaceAll("-", "").toUpperCase(), digest,
      JSON.stringify({ schemaVersion: "amux-v4", ideaId: randomUUID(),
        approvalId: randomUUID() }), featureId, cipher, randomUUID()]);

    async function rejects(action, allowedConstraints) {
      await db.query("SAVEPOINT rejected");
      let error;
      try { await action(); }
      catch (caught) { error = caught; }
      await db.query("ROLLBACK TO SAVEPOINT rejected");
      await db.query("RELEASE SAVEPOINT rejected");
      assert.ok(error, "invalid promotion write succeeded");
      assert.ok(allowedConstraints.includes(error.constraint), error.message);
    }

    await rejects(() => db.query(`UPDATE public."AmuxWorkItem"
      SET "status" = 'todo' WHERE "id" = $1`, [taskId]),
    ["AmuxWorkItem_sourced_todo_has_brief_check",
      "AmuxWorkItem_v4_execution_shape_check"]);

    await rejects(async () => {
      await db.query(`UPDATE public."AmuxWorkItem"
        SET "status" = 'todo', "v22ReceiptId" = $2
        WHERE "id" = $1`, [taskId, randomUUID()]);
      await db.query("SET CONSTRAINTS amux_v22_card_receipt_guard_trigger IMMEDIATE");
    }, ["AmuxV22PromotionReceipt_binding_check",
      "AmuxWorkItem_v22ReceiptId_fkey"]);

    await rejects(() => db.query(`UPDATE public."AmuxWorkItem"
      SET "owner" = 'worker-one', "claimedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1`, [taskId]),
    ["AmuxWorkItem_v4_execution_shape_check",
      "AmuxWorkItem_backlog_unowned_check"]);
    await rejects(() => db.query(`UPDATE public."AmuxWorkItem"
      SET "status" = 'todo', "owner" = 'worker-one',
        "claimedAt" = CURRENT_TIMESTAMP, "v22ReceiptId" = $2
      WHERE "id" = $1`, [taskId, randomUUID()]),
    ["AmuxWorkItem_v4_execution_shape_check"]);

    await db.query(`INSERT INTO public."AmuxWorkItem"
      ("id", "title", "status", "updatedAt")
      VALUES ($1, 'legacy Todo', 'todo', CURRENT_TIMESTAMP)`,
    ["legacy_" + randomUUID()]);
    await rejects(() => db.query(`UPDATE public."AmuxV22PromotionReceipt"
      SET "scoreTotal" = 0 WHERE false`),
    ["AmuxV22Promotion_append_only_check"]);
    await rejects(() => db.query(`DELETE FROM public."AmuxV22PromotionUnknown"
      WHERE false`), ["AmuxV22Promotion_append_only_check"]);
    await rejects(() => db.query(`UPDATE public."AmuxV22WorkerAssignment"
      SET "lane" = 'sev1' WHERE false`),
    ["AmuxV22Assignment_append_only_check"]);
    await rejects(() => db.query(`DELETE FROM public."AmuxV22LaneDecision"
      WHERE false`), ["AmuxV22Assignment_append_only_check"]);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
});

test("v22 and legacy promotion transactions use one exclusive queue lock", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const first = new pg.Client({ connectionString: databaseUrl });
  const second = new pg.Client({ connectionString: databaseUrl });
  await Promise.all([first.connect(), second.connect()]);
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    await first.query(`SELECT pg_advisory_xact_lock(
      hashtext('tomverse-amux-recommendation:queue'))`);
    const contended = await second.query(`SELECT pg_try_advisory_xact_lock(
      hashtext('tomverse-amux-recommendation:queue')) AS acquired`);
    assert.equal(contended.rows[0].acquired, false);
    await first.query("COMMIT");
    const released = await second.query(`SELECT pg_try_advisory_xact_lock(
      hashtext('tomverse-amux-recommendation:queue')) AS acquired`);
    assert.equal(released.rows[0].acquired, true);
  } finally {
    await Promise.all([first.query("ROLLBACK").catch(() => undefined),
      second.query("ROLLBACK").catch(() => undefined)]);
    await Promise.all([first.end(), second.end()]);
  }
});
