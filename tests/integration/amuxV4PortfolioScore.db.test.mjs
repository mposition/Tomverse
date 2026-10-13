import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

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
