import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
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
  const ids = { initiative: randomUUID(), epic: randomUUID(),
    feature: randomUUID(), task: randomUUID(), sourceApproval: randomUUID() };
  const digest = "a".repeat(64);
  const titleDigest = "b".repeat(64);
  const inputDigest = "c".repeat(64);
  const expectedComponents = { initiative: 16, epic: 9, feature: 10,
    story: 0, task: 24, urgency: 6, dependency: 2, worker: 2,
    effortPenalty: 4, riskPenalty: 1, uncertaintyPenalty: 0 };
  const synthetic = Buffer.from("synthetic-only", "utf8");
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    for (const [id, level, parentId] of [
      [ids.initiative, "initiative", null],
      [ids.epic, "epic", ids.initiative],
      [ids.feature, "feature", ids.epic],
    ]) {
      await client.query(`INSERT INTO public."AmuxPortfolioNode"
        ("id", "level", "parentId", "state", "revision",
         "titleCiphertext", "contentKeyId", "contentKeyVersion",
         "contentDigest", "contentDigestKeyId", "approvedByUserId",
         "authorizationAuditLogId", "updatedAt")
        VALUES ($1, $2, $3, 'active', 0, $4, 'synthetic', 1,
                $5, 'synthetic', 'synthetic-owner', $6, CURRENT_TIMESTAMP)`,
      [id, level, parentId, synthetic, digest, randomUUID()]);
    }
    await client.query(`INSERT INTO public."AmuxWorkItem"
      ("id", "title", "status", "sourceSystem", "sourceKey", "sourceVersion",
       "sourceDigest", "sourceSnapshot", "cardType", "parentFeatureNodeId",
       "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion",
       "v4TitleDigest", "v4TitleDigestKeyId", "v4BodyCiphertext",
       "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest",
       "v4BodyDigestKeyId", "v4BriefCiphertext", "v4BriefKeyId",
       "v4BriefKeyVersion", "v4BriefDigest", "v4BriefDigestKeyId",
       "v4SourceApprovalId", "taskRole", "executionGrade", "updatedAt")
       VALUES ($1, 'AMUX Task', 'backlog', 'admin-idea-v4', $2, 'v1', $3,
               $4::jsonb, 'task', $5, $6, 'synthetic', 1,
               $7, 'synthetic', $6, 'synthetic', 1, $3, 'synthetic',
               $6, 'synthetic', 1, $3, 'synthetic', $8,
               'implement', 'medium', CURRENT_TIMESTAMP)`,
      [ids.task, randomUUID().replaceAll("-", "").toUpperCase(), digest,
        JSON.stringify({ schemaVersion: "amux-v4", ideaId: randomUUID(),
          approvalId: ids.sourceApproval }), ids.feature, synthetic,
        titleDigest, ids.sourceApproval]);

    async function rejects(sql, values, constraint) {
      await client.query("SAVEPOINT reject_probe");
      let error;
      try { await client.query(sql, values); }
      catch (caught) { error = caught; }
      await client.query("ROLLBACK TO SAVEPOINT reject_probe");
      await client.query("RELEASE SAVEPOINT reject_probe");
      assert.ok(error, "invalid portfolio write succeeded");
      assert.equal(error.constraint, constraint, error.message);
    }

    const assessments = {};
    for (const [kind, subjectId, metrics] of [
      ["initiative", ids.initiative, { value: 4 }],
      ["epic", ids.epic, { value: 3 }],
      ["feature", ids.feature, { value: 5 }],
      ["task", ids.task, { contribution: 4, urgency: 3,
        dependencyUnlock: 2, workerCoverage: 2, effort: 2, deliveryRisk: 1 }],
    ]) {
      const id = randomUUID();
      assessments[kind] = id;
      const auditId = await appendSyntheticAdminAudit(client, {
        actorUserId: "synthetic-owner",
        action: "amux.v4.portfolio.assessment.approve",
        targetType: "AmuxPortfolioAssessment", targetId: id,
        summary: "synthetic assessment",
      });
      await client.query(`INSERT INTO public."AmuxPortfolioAssessment"
        ("id", "requestId", "nodeId", "cardId", "subjectKind",
         "subjectRevision", "subjectDigest", "subjectDigestKeyId",
         "assessmentVersion", "metrics", "uncertainty", "evidenceRefs",
         "evidenceAsOf", "reasonCode", "confirmationDigest",
         "confirmationDigestKeyId", "approvedByUserId",
         "approvalAuditLogId", "approvedAt")
        VALUES ($1, $2, $3, $4, $5, 0, $6, 'synthetic', 1,
                $7::jsonb, 'low', '["proof_0001"]'::jsonb,
                CURRENT_TIMESTAMP - INTERVAL '1 day', 'initial', $8,
                'synthetic', 'synthetic-owner', $9, CURRENT_TIMESTAMP)`,
        [id, randomUUID(), kind === "task" ? null : subjectId,
          kind === "task" ? subjectId : null, kind, digest,
          JSON.stringify(metrics), inputDigest, auditId]);
    }
    await rejects(`UPDATE public."AmuxPortfolioAssessment"
      SET "metrics" = '{}'::jsonb WHERE "id" = $1`, [assessments.task],
    "AmuxPortfolioAssessment_immutable_check");

    const scoreId = randomUUID();
    const scoreAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.portfolio.score.confirm",
      targetType: "AmuxPortfolioScoreSnapshot", targetId: scoreId,
      summary: "synthetic score",
    });
    const insertScore = `INSERT INTO public."AmuxPortfolioScoreSnapshot"
      ("id", "requestId", "taskId", "taskRevision", "sourceApprovalId",
       "initiativeAssessmentId", "epicAssessmentId", "featureAssessmentId",
       "storyAssessmentId", "taskAssessmentId", "scoreVersion", "scoreTotal",
       "components", "inputDigest", "inputDigestKeyId", "evidenceAsOf",
       "activeStaleAt", "baselineStaleAt", "approvedByUserId",
       "approvalAuditLogId", "computedAt")
      VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9,
              'amux-v4-portfolio-v1', $12, $13::jsonb, $10, 'synthetic',
              CURRENT_TIMESTAMP - INTERVAL '1 day',
              CURRENT_TIMESTAMP + INTERVAL '6 days',
              CURRENT_TIMESTAMP + INTERVAL '27 days',
              'synthetic-owner', $11, CURRENT_TIMESTAMP)`;
    const values = [scoreId, randomUUID(), ids.task, ids.sourceApproval,
      assessments.initiative, assessments.epic, assessments.feature,
      null, assessments.task, inputDigest, scoreAudit, 64,
      JSON.stringify(expectedComponents)];
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
    await client.query(insertScore, values);
    await rejects(`UPDATE public."AmuxPortfolioScoreSnapshot"
      SET "scoreTotal" = 43 WHERE "id" = $1`, [scoreId],
    "AmuxPortfolioScoreSnapshot_immutable_check");
    await rejects(`DELETE FROM public."AmuxPortfolioScoreSnapshot"
      WHERE "id" = $1`, [scoreId],
    "AmuxPortfolioScoreSnapshot_immutable_check");
    await rejects(`TRUNCATE public."AmuxPortfolioScoreSnapshot"`, [],
      "AmuxPortfolioScoring_no_truncate_check");
    const newerId = randomUUID();
    const newerAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner",
      action: "amux.v4.portfolio.assessment.approve",
      targetType: "AmuxPortfolioAssessment", targetId: newerId,
      summary: "synthetic updated evidence",
    });
    const insertNewEvidence = `INSERT INTO public."AmuxPortfolioAssessment"
      ("id", "requestId", "cardId", "subjectKind", "subjectRevision",
       "subjectDigest", "subjectDigestKeyId", "assessmentVersion",
       "metrics", "uncertainty", "evidenceRefs", "evidenceAsOf",
       "reasonCode", "confirmationDigest", "confirmationDigestKeyId",
       "modelProposalDigest",
       "priorAssessmentId", "approvedByUserId", "approvalAuditLogId",
       "approvedAt")
      VALUES ($1, $2, $3, 'task', 0, $4, 'synthetic', 2, $8::jsonb,
              'medium', '["proof_0002"]'::jsonb,
              CURRENT_TIMESTAMP, 'new_evidence', $5, 'synthetic', $9, $6,
              'synthetic-owner', $7, CURRENT_TIMESTAMP)`;
    const newEvidenceParams = [newerId, randomUUID(), ids.task, digest,
      inputDigest, assessments.task, newerAudit,
      JSON.stringify({ contribution: 5, urgency: 3, dependencyUnlock: 2,
        workerCoverage: 2, effort: 2, deliveryRisk: 1 }), null];
    await rejects(insertNewEvidence,
      [...newEvidenceParams.slice(0, 7), JSON.stringify({ contribution: 8,
        urgency: 3, dependencyUnlock: 2, workerCoverage: 2,
        effort: 2, deliveryRisk: 1 }), null],
      "AmuxPortfolioAssessment_metrics_check");
    await rejects(insertNewEvidence,
      [...newEvidenceParams.slice(0, 8), "d".repeat(64)],
      "AmuxPortfolioAssessment_model_binding_check");
    await client.query(insertNewEvidence, newEvidenceParams);
    await rejects(insertScore,
      [randomUUID(), randomUUID(), ...values.slice(2)],
      "AmuxPortfolioScoreSnapshot_latest_check");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
