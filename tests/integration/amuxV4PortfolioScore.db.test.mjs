import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";
import { exerciseAmuxV22LegacySafeStopFenceFixture,
  exerciseAmuxV22TaskRecoveryFixture } from
  "./helpers/amuxV22TaskRecoveryFixture.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const recoveryExecutorKind = process.env.AMUX_RECOVERY_FIXTURE_EXECUTOR_KIND ??
  "read_only_api_retry_v1";
assert.ok(["read_only_retry_v1", "read_only_api_retry_v1"]
  .includes(recoveryExecutorKind));
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

test("portfolio evidence and score history are audited, path-bound and append-only", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    async function rejects(sql, values, constraint, deferredTrigger = null) {
      await client.query("SAVEPOINT reject_probe");
      let error;
      try {
        await client.query(sql, values);
        if (deferredTrigger)
          await client.query(`SET CONSTRAINTS ${deferredTrigger} IMMEDIATE`);
      }
      catch (caught) { error = caught; }
      await client.query("ROLLBACK TO SAVEPOINT reject_probe");
      await client.query("RELEASE SAVEPOINT reject_probe");
      assert.ok(error, "invalid portfolio write succeeded");
      assert.ok(error.constraint === constraint ||
        (constraint === "AmuxPortfolioScoring_no_truncate_check" &&
          error.code === "0A000"), error.message);
    }

    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(client, {
      recoveryExecutorKind,
      afterAssessments: async ({ assessments }) => {
        await rejects(`UPDATE public."AmuxPortfolioAssessment"
          SET "metrics" = '{}'::jsonb WHERE "id" = $1`, [assessments.task],
        "AmuxPortfolioAssessment_immutable_check");
      },
      beforeScore: async ({ insertScore, scoreValues: values, assessments,
        expectedComponents }) => {
        await rejects(insertScore,
          [...values.slice(0, 4), assessments.feature, ...values.slice(5)],
          "AmuxPortfolioScoreSnapshot_assessments_check");
        await rejects(insertScore,
          [randomUUID(), randomUUID(), ...values.slice(2, 11), 63,
            values[12]],
          "AmuxPortfolioScoreSnapshot_calculation_check");
        await rejects(insertScore,
          [randomUUID(), randomUUID(), ...values.slice(2, 12),
            JSON.stringify({ ...expectedComponents, task: 25 })],
          "AmuxPortfolioScoreSnapshot_calculation_check");
      },
      afterScore: async ({ scoreId }) => {
        await rejects(`UPDATE public."AmuxPortfolioScoreSnapshot"
          SET "scoreTotal" = 43 WHERE "id" = $1`, [scoreId],
        "AmuxPortfolioScoreSnapshot_immutable_check");
        await rejects(`DELETE FROM public."AmuxPortfolioScoreSnapshot"
          WHERE "id" = $1`, [scoreId],
        "AmuxPortfolioScoreSnapshot_immutable_check");
        await rejects(`TRUNCATE public."AmuxPortfolioScoreSnapshot"`, [],
          "AmuxPortfolioScoring_no_truncate_check");
      },
      beforeNewEvidence: async ({ insertNewEvidence, newEvidenceParams }) => {
        await rejects(insertNewEvidence,
          [...newEvidenceParams.slice(0, 7), JSON.stringify({ contribution: 8,
            urgency: 3, dependencyUnlock: 2, workerCoverage: 2,
            effort: 2, deliveryRisk: 1 }), null],
          "AmuxPortfolioAssessment_metrics_check");
        await rejects(insertNewEvidence,
          [...newEvidenceParams.slice(0, 8), "d".repeat(64)],
          "AmuxPortfolioAssessment_model_binding_check");
      },
      afterNewEvidence: async ({ insertScore, scoreValues }) => {
        await rejects(insertScore,
          [randomUUID(), randomUUID(), ...scoreValues.slice(2)],
          "AmuxPortfolioScoreSnapshot_latest_check");
      },
      afterPromotion: async ({ ids, receiptId }) => {
        const moved = await client.query(`SELECT "status", "v22ReceiptId"
          FROM public."AmuxWorkItem" WHERE "id" = $1`, [ids.task]);
        assert.equal(moved.rows[0].status, "todo");
        assert.equal(moved.rows[0].v22ReceiptId, receiptId);
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "v4BriefDigest" = $2 WHERE "id" = $1`,
        [ids.task, "e".repeat(64)], "AmuxV4TaskDag_binding_check");
      },
      afterAssignment: async ({ ids, assignmentId }) => {
        const assigned = await client.query(`SELECT "status", "owner",
          "v22AssignmentId" FROM public."AmuxWorkItem" WHERE "id" = $1`,
        [ids.task]);
        assert.deepEqual(assigned.rows[0], { status: "todo", owner: "worker-one",
          v22AssignmentId: assignmentId });
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "status" = 'doing', "revision" = 3 WHERE "id" = $1`,
        [ids.task], "AmuxWorkItem_v22_doing_check",
        "amux_v22_doing_guard_trigger");
      },
      afterAttempt: async ({ ids, attemptId, assignmentId, instanceId }) => {
        await rejects(`UPDATE public."AmuxExecutionAttempt"
          SET "workerGeneration" = 2 WHERE "id" = $1`,
        [attemptId], "AmuxExecutionAttempt_v22_binding_check",
        "amux_v22_execution_attempt_guard_trigger");
        await rejects(`INSERT INTO public."AmuxExecutionAttempt"
          ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
           "taskRevision", "attemptNumber", "reservedCostMicrousd",
           "heartbeatAt", "leaseExpiresAt", "startedAt",
           "v22AssignmentId", "updatedAt")
          VALUES ($1, $2, 'worker-one', '${instanceId}', 1, 3, 2, 3400000,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '90 seconds',
           CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP)`,
        [randomUUID(), ids.task, assignmentId],
        "AmuxExecutionAttempt_v22AssignmentId_key");
      },
      beforeSettlement: async ({ ids }) => {
        await rejects(`UPDATE public."AmuxWorkItem"
          SET "status" = 'review', "owner" = NULL, "claimedAt" = NULL,
              "v22AssignmentId" = NULL, "revision" = 4
          WHERE "id" = $1`, [ids.task], "AmuxWorkItem_v22_live_attempt_check",
        "amux_v22_doing_guard_trigger");
      },
      afterSettlement: async ({ ids }) => {
        const ended = await client.query(`SELECT "status", "owner",
          "v22AssignmentId" FROM public."AmuxWorkItem" WHERE "id" = $1`,
        [ids.task]);
        assert.deepEqual(ended.rows[0], { status: "review", owner: null,
          v22AssignmentId: null });
      },
    });
    const recovery = await exerciseAmuxV22TaskRecoveryFixture(client, seed);
    await exerciseAmuxV22LegacySafeStopFenceFixture(client,
      recovery.safeStopFenceInput);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

test("only the system refresher extends an unchanged score's active window", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    async function rejects(sql, values, constraint) {
      await client.query("SAVEPOINT refresh_probe");
      let error;
      try { await client.query(sql, values); } catch (caught) { error = caught; }
      await client.query("ROLLBACK TO SAVEPOINT refresh_probe");
      await client.query("RELEASE SAVEPOINT refresh_probe");
      assert.ok(error, "invalid score refresh succeeded");
      assert.equal(error.constraint, constraint, error.message);
    }
    // The refresher's audit is a system entry in this very transaction: no
    // savepoint, so its xmin is the parent transaction's.
    const systemAudit = (targetId, systemActor = "amux-portfolio-scorer",
      action = "amux.v4.portfolio.score.refresh") =>
      appendSyntheticAdminAudit(client, { actorUserId: null, action,
        targetType: "AmuxPortfolioScoreSnapshot", targetId,
        summary: "synthetic refresh", metadata: { systemActor },
        useSavepoint: false });
    const humanAudit = (targetId, action) => appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action,
      targetType: "AmuxPortfolioScoreSnapshot", targetId,
      summary: "synthetic score" });
    await seedAmuxV4PortfolioRecoveryPrerequisites(client, {
      recoveryExecutorKind,
      afterScore: async ({ scoreId }) => {
        const prior = (await client.query(`SELECT * FROM
          public."AmuxPortfolioScoreSnapshot" WHERE "id" = $1`, [scoreId])).rows[0];
        // $1 id, $2 audit, $3 activeStaleAt offset, $4 approvedByUserId,
        // $5 computedAt offset. Everything else repeats the prior row.
        const insertRefresh = `INSERT INTO public."AmuxPortfolioScoreSnapshot"
          ("id", "requestId", "taskId", "taskRevision", "sourceApprovalId",
           "initiativeAssessmentId", "epicAssessmentId", "featureAssessmentId",
           "storyAssessmentId", "taskAssessmentId", "scoreVersion", "scoreTotal",
           "components", "inputDigest", "inputDigestKeyId", "evidenceAsOf",
           "activeStaleAt", "baselineStaleAt", "approvedByUserId",
           "approvalAuditLogId", "computedAt")
          SELECT $1, gen_random_uuid(), p."taskId", p."taskRevision",
            p."sourceApprovalId", p."initiativeAssessmentId", p."epicAssessmentId",
            p."featureAssessmentId", p."storyAssessmentId", p."taskAssessmentId",
            p."scoreVersion", p."scoreTotal", p."components", p."inputDigest",
            p."inputDigestKeyId", p."evidenceAsOf",
            c.now + $3::interval, p."baselineStaleAt", $4, $2,
            c.now + $5::interval
          FROM public."AmuxPortfolioScoreSnapshot" p,
            (SELECT date_trunc('milliseconds',
              clock_timestamp() AT TIME ZONE 'UTC') AS now) c
          WHERE p."id" = '${scoreId}'`;
        const probe = async (constraint, { audit = systemAudit,
          active = "7 days", owner = "synthetic-owner", computed = "0" } = {}) => {
          const id = randomUUID();
          const auditId = await audit(id);
          await rejects(insertRefresh, [id, auditId, active, owner, computed],
            constraint);
        };
        // A person may not write a refresh, nor another system actor.
        await probe("AmuxPortfolioScoreSnapshot_audit_check", {
          audit: (id) => humanAudit(id, "amux.v4.portfolio.score.refresh") });
        await probe("AmuxPortfolioScoreSnapshot_audit_check", {
          audit: (id) => systemAudit(id, "amux-v4-intake") });
        // A confirmation never opens more than the evidence's own window.
        await probe("AmuxPortfolioScoreSnapshot_refresh_check", {
          audit: (id) => humanAudit(id, "amux.v4.portfolio.score.confirm") });
        // The CHECK caps the window at the baseline and at computedAt + 7d.
        await probe("AmuxPortfolioScoreSnapshot_shape_check",
          { active: "30 days" });
        await probe("AmuxPortfolioScoreSnapshot_shape_check",
          { active: "7 days 1 second" });
        // No refresh that fails to move the deadline, changes the data
        // owner, or claims a computation time ahead of the database clock.
        await probe("AmuxPortfolioScoreSnapshot_refresh_check",
          { active: "5 days" });
        await probe("AmuxPortfolioScoreSnapshot_refresh_check",
          { owner: "someone-else" });
        await probe("AmuxPortfolioScoreSnapshot_refresh_check",
          { active: "8 days", computed: "1 day" });

        const refreshedId = randomUUID();
        await client.query(insertRefresh, [refreshedId,
          await systemAudit(refreshedId), "7 days", "synthetic-owner", "0"]);
        const refreshed = (await client.query(`SELECT "evidenceAsOf",
          "baselineStaleAt", "activeStaleAt" > $2 AS "extended"
          FROM public."AmuxPortfolioScoreSnapshot" WHERE "id" = $1`,
        [refreshedId, prior.activeStaleAt])).rows[0];
        assert.deepEqual(refreshed, { evidenceAsOf: prior.evidenceAsOf,
          baselineStaleAt: prior.baselineStaleAt, extended: true });
        // A second refresh must move past the first one's deadline.
        await probe("AmuxPortfolioScoreSnapshot_refresh_check",
          { active: "6 days" });
        await rejects(`UPDATE public."AmuxPortfolioScoreSnapshot"
          SET "activeStaleAt" = "activeStaleAt" + INTERVAL '1 day'
          WHERE "id" = $1`, [refreshedId],
        "AmuxPortfolioScoreSnapshot_immutable_check");
      },
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
