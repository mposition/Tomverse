import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { appendSyntheticAdminAudit } from "./helpers/appendSyntheticAdminAudit.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const isolationMarker = `${databaseName}_${url.searchParams.get("schema") || ""}`;
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(isolationMarker);
})();

test("AMUX v4 source-plan revisions enforce identity, order and plan-bound chunks", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const ideaId = randomUUID();
  const otherIdeaId = randomUUID();
  const planId = randomUUID();
  const secondPlanId = randomUUID();
  const owner = "synthetic-owner";
  const digest = "a".repeat(64);
  const secondDigest = "b".repeat(64);

  async function expectRejected(sql, params, constraint) {
    await client.query("SAVEPOINT reject_probe");
    let error;
    try {
      await client.query(sql, params);
    } catch (caught) {
      error = caught;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT reject_probe");
      await client.query("RELEASE SAVEPOINT reject_probe");
    }
    assert.ok(error, "database write unexpectedly succeeded");
    assert.equal(error.constraint, constraint, error.message);
  }

  async function expectAcceptedRollback(sql, params) {
    await client.query("SAVEPOINT accepted_probe");
    try {
      const result = await client.query(sql, params);
      assert.equal(result.rowCount, 1);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT accepted_probe");
      await client.query("RELEASE SAVEPOINT accepted_probe");
    }
  }

  async function addAudit(targetId) {
    return appendSyntheticAdminAudit(client, {
      actorUserId: owner, action: "amux.v4.plan.create",
      targetType: "AmuxIdeaSourcePlanRevision", targetId,
      summary: "synthetic source-plan probe",
    });
  }

  const insertPlan = `INSERT INTO public."AmuxIdeaSourcePlanRevision"
    ("id", "ideaId", "actorUserId", "revisionNumber", "startChunkIndex",
     "sourceUnitCount", "unitDigests", "manifestDigest", "manifestDigestKeyId",
     "state", "predecessorId", "creationAuditLogId")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'synthetic-key', 'prepared', $9, $10)`;

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    for (const id of [ideaId, otherIdeaId]) {
      await client.query(
        `INSERT INTO public."AmuxIdeaSubmission"
         ("id", "requestId", "actorUserId", "state", "submittedAt", "analysisDeadlineAt", "updatedAt")
         VALUES ($1, $2, $3, 'submitted', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`,
        [id, randomUUID(), owner],
      );
    }
    const auditId = await addAudit(planId);
    await expectRejected(insertPlan,
      [planId, ideaId, owner, 1, 0, 2, [digest, null], digest, null, auditId],
      "AmuxIdeaSourcePlanRevision_position_check");
    await expectRejected(insertPlan,
      [planId, ideaId, owner, 1, 0, 1, ["not-a-digest"], digest, null, auditId],
      "AmuxIdeaSourcePlanRevision_position_check");
    await expectRejected(insertPlan,
      [planId, ideaId, owner, 1, 0, 1, [digest], digest, planId, auditId],
      "AmuxIdeaSourcePlanRevision_predecessor_order_check");
    await client.query(insertPlan,
      [planId, ideaId, owner, 1, 0, 1, [digest], digest, null, auditId]);
    await expectRejected(
      `DELETE FROM public."AmuxIdeaSourcePlanRevision" WHERE "id" = $1`,
      [planId], "AmuxIdeaSourcePlanRevision_no_delete_check");
    await expectRejected(
      `UPDATE public."AmuxIdeaSourcePlanRevision" SET "unitDigests" = $2 WHERE "id" = $1`,
      [planId, [secondDigest]], "AmuxIdeaSourcePlanRevision_identity_immutable_check");
    await expectRejected(
      `UPDATE public."AmuxIdeaSubmission" SET "currentSourcePlanRevisionId" = $2 WHERE "id" = $1`,
      [otherIdeaId, planId], "AmuxIdeaSubmission_currentSourcePlanRevisionId_id_fkey");
    await client.query(
      `UPDATE public."AmuxIdeaSubmission" SET "currentSourcePlanRevisionId" = $2 WHERE "id" = $1`,
      [ideaId, planId]);
    await client.query(
      `UPDATE public."AmuxIdeaSourcePlanRevision" SET "state" = 'active' WHERE "id" = $1`,
      [planId]);
    await expectRejected(
      `UPDATE public."AmuxIdeaSourcePlanRevision" SET "state" = 'prepared' WHERE "id" = $1`,
      [planId], "AmuxIdeaSourcePlanRevision_transition_check");

    const secondAuditId = await addAudit(secondPlanId);
    await expectRejected(insertPlan,
      [secondPlanId, ideaId, owner, 2, 1, 1, [secondDigest], secondDigest, planId, secondAuditId],
      "AmuxIdeaSourcePlanRevision_predecessor_order_check");
    await client.query(
      `UPDATE public."AmuxIdeaSourcePlanRevision" SET "state" = 'awaiting_owner' WHERE "id" = $1`,
      [planId]);
    await client.query(insertPlan,
      [secondPlanId, ideaId, owner, 2, 1, 1, [secondDigest], secondDigest, planId, secondAuditId]);

    const cancelledPlanId = randomUUID();
    const afterCancelId = randomUUID();
    await client.query(insertPlan,
      [cancelledPlanId, otherIdeaId, owner, 1, 0, 1, [digest], digest, null,
        await addAudit(cancelledPlanId)]);
    await client.query(
      `UPDATE public."AmuxIdeaSourcePlanRevision" SET "state" = 'cancelled' WHERE "id" = $1`,
      [cancelledPlanId]);
    await client.query(insertPlan,
      [afterCancelId, otherIdeaId, owner, 2, 1, 1, [secondDigest], secondDigest,
        cancelledPlanId, await addAudit(afterCancelId)]);

    const insertChunk = `INSERT INTO public."AmuxIdeaAnalysisChunk"
      ("ideaId", "actorUserId", "chunkIndex", "state", "attempt", "leaseGeneration",
       "sourcePlanRevisionId", "planStartChunkIndex", "revisionChunkIndex", "updatedAt")
      VALUES ($1, $2, $3, 'pending', 0, 0, $4, $5, $6, CURRENT_TIMESTAMP)`;
    await expectRejected(insertChunk, [ideaId, owner, 0, planId, 1, 0],
      "AmuxIdeaAnalysisChunk_plan_position_check");
    await client.query(insertChunk, [ideaId, owner, 0, planId, 0, 0]);
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "coverageStatus" = 'more', "coveredStartOrdinal" = 0,
           "coveredEndOrdinal" = 0, "remainingStartOrdinal" = 1,
           "remainingEndOrdinal" = 1, "outputPartIndex" = 0,
           "outputPending" = false
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ideaId], "AmuxIdeaAnalysisChunk_cursor_check");
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "continuationKind" = 'input', "coveredStartOrdinal" = 0,
           "coveredEndOrdinal" = 0, "remainingStartOrdinal" = 1,
           "remainingEndOrdinal" = 1, "outputPartIndex" = 0,
           "outputPending" = false
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ideaId], "AmuxIdeaAnalysisChunk_cursor_check");
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "coverageStatus" = 'needs_owner_input', "continuationKind" = 'garbage',
           "coveredStartOrdinal" = 0, "coveredEndOrdinal" = 0,
           "outputPartIndex" = 0, "outputPending" = false
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ideaId], "AmuxIdeaAnalysisChunk_cursor_check");
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "coverageStatus" = 'complete', "coveredStartOrdinal" = 0,
           "coveredEndOrdinal" = 0, "remainingStartOrdinal" = 0,
           "remainingEndOrdinal" = 0, "outputPartIndex" = 0,
           "outputPending" = false
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ideaId], "AmuxIdeaAnalysisChunk_cursor_check");
    const validCursor = `UPDATE public."AmuxIdeaAnalysisChunk"
      SET "coverageStatus" = $2, "continuationKind" = $3,
          "coveredStartOrdinal" = 0, "coveredEndOrdinal" = 0,
          "remainingStartOrdinal" = $4, "remainingEndOrdinal" = $5,
          "outputPartIndex" = 0, "outputPending" = $6
      WHERE "ideaId" = $1 AND "chunkIndex" = 0`;
    await expectAcceptedRollback(validCursor, [ideaId, "more", "input", 1, 1, false]);
    await expectAcceptedRollback(validCursor, [ideaId, "more", "output", 0, 0, true]);
    await expectAcceptedRollback(validCursor, [ideaId, "needs_owner_input", null, null, null, false]);
    await expectAcceptedRollback(validCursor, [ideaId, "needs_owner_input", "input", 1, 1, false]);
    await client.query(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "coverageStatus" = 'complete', "coveredStartOrdinal" = 0,
           "coveredEndOrdinal" = 0, "outputPartIndex" = 0, "outputPending" = false
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ideaId]);
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk" SET "outputPartIndex" = 1
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ideaId], "AmuxIdeaAnalysisChunk_cursor_immutable_check");
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk" SET "sourcePlanRevisionId" = $2 WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ideaId, secondPlanId], "AmuxIdeaAnalysisChunk_plan_immutable_check");
    await expectRejected(
      `INSERT INTO public."AmuxIdeaTransferPreview"
       ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId", "templateVersion",
        "payloadDigest", "payloadDigestKeyId", "expiresAt", "sourcePlanRevisionId",
        "sourceUnitOrdinal", "updatedAt")
       VALUES ($1, $2, 0, 1, 'prepared', 'synthetic-model', 'synthetic-template',
               $3, 'synthetic', CURRENT_TIMESTAMP + INTERVAL '1 day', $4, 0, CURRENT_TIMESTAMP)`,
      [randomUUID(), ideaId, digest, secondPlanId],
      "AmuxIdeaTransferPreview_chunk_plan_fkey");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
