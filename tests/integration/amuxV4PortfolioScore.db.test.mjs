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

    // A12: a score is not promotion authority by itself. A separate v22
    // system receipt may use the exact owner approval, score and brief only.
    const ideaId = randomUUID();
    const unitId = randomUUID();
    const previewId = randomUUID();
    await client.query(`INSERT INTO public."AmuxIdeaSubmission"
      ("id", "requestId", "actorUserId", "state", "submittedAt",
       "analysisDeadlineAt", "updatedAt") VALUES
      ($1, $2, 'synthetic-owner', 'analyzing', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`,
    [ideaId, randomUUID()]);
    await client.query(`INSERT INTO public."AmuxIdeaAnalysisChunk"
      ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
       "leaseGeneration", "analysisCompletedAt", "updatedAt") VALUES
      ($1, 'synthetic-owner', 0, 'draft_ready', 0, 0,
       CURRENT_TIMESTAMP - INTERVAL '1 second', CURRENT_TIMESTAMP)`,
    [ideaId]);
    await client.query(`INSERT INTO public."AmuxIdeaTransferPreview"
      ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId",
       "templateVersion", "payloadDigest", "payloadDigestKeyId", "expiresAt",
       "confirmedAt", "confirmExpiresAt", "confirmedByUserId",
       "confirmationAuditLogId", "updatedAt") VALUES
      ($1, $2, 0, 1, 'completed', 'synthetic-model', 'synthetic-template',
       $3, 'synthetic', CURRENT_TIMESTAMP + INTERVAL '1 day',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
       'synthetic-owner', $4, CURRENT_TIMESTAMP)`,
    [previewId, ideaId, digest, randomUUID()]);
    await client.query(`UPDATE public."AmuxIdeaAnalysisChunk"
      SET "currentPreviewId" = $2 WHERE "ideaId" = $1`,
    [ideaId, previewId]);
    await client.query(`INSERT INTO public."AmuxIdeaDraftUnit"
      ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex",
       "localRef", "unitKind", "state", "bodyCiphertext", "bodyKeyId",
       "bodyKeyVersion", "bodyDigest", "bodyDigestKeyId", "updatedAt")
      VALUES ($1, $2, 'synthetic-owner', 0, 0, 'c0:card-0', 'card',
       'proposed', $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
    [unitId, ideaId, synthetic, digest]);
    const prepareAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
      targetType: "AmuxIdeaUnitDecision", targetId: ids.sourceApproval,
      summary: "synthetic preparation",
    });
    await client.query(`INSERT INTO public."AmuxIdeaUnitDecision"
      ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
       "prepareRequestId", "action", "state", "ownerSessionDigest",
       "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
       "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
       "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
       "baseNodeId", "baseNodeRevision", "baseNodeDigest", "baseNodeDigestKeyId",
       "preparedAt", "expiresAt", "prepareAuditLogId", "updatedAt")
      VALUES ($1, $2, $3, 'synthetic-owner', 0, $4, 'register_card',
       'prepared', $5, 'synthetic', $5, 'synthetic', $5, 'synthetic',
       $6::jsonb, $7, $5, 'synthetic', $8, 0, $5, 'synthetic',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
       $9, CURRENT_TIMESTAMP)`,
    [ids.sourceApproval, ideaId, unitId, randomUUID(), digest,
      JSON.stringify({ card: { cardType: "task", dependencies: [] } }),
      previewId, ids.feature, prepareAudit]);
    const consumeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
      targetType: "AmuxIdeaUnitDecision", targetId: ids.sourceApproval,
      summary: "synthetic consumption",
    });
    await client.query(`UPDATE public."AmuxIdeaUnitDecision"
      SET "state" = 'consumed', "consumeRequestId" = $2,
          "consumedAt" = CURRENT_TIMESTAMP, "registeredWorkItemId" = $3,
          "finalAuditLogId" = $4 WHERE "id" = $1`,
    [ids.sourceApproval, randomUUID(), ids.task, consumeAudit]);
    await client.query(`UPDATE public."AmuxIdeaDraftUnit"
      SET "state" = 'approved' WHERE "id" = $1`, [unitId]);
    const receiptId = randomUUID();
    const receiptAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: null, action: "amux.v22.auto_promotion.consumed",
      targetType: "AmuxV22PromotionReceipt", targetId: receiptId,
      summary: "synthetic v22 promotion",
      metadata: { systemActor: "amux-v22-auto-admit" },
    });
    await client.query(`INSERT INTO public."AmuxV22PromotionReceipt"
      ("id", "workItemId", "sourceApprovalId", "sourceApprovalDigest",
       "briefDigest", "parentFeatureNodeId", "taskRevision",
       "scoreSnapshotId", "scoreVersion", "scoreTotal", "capacityWipLimit",
       "capacityOccupied", "verifiedWorkerCount", "queueLimit",
       "normalLimit", "parallelReserved", "sev1Reserved", "costCents",
       "policyVersion", "authorizationAuditLogId", "promotedAt") VALUES
      ($1, $2, $3, $4, $5, $6, 0, $7, 'amux-v4-portfolio-v1', 64,
       9, 0, 3, 9, 7, 1, 1, 0, 22, $8, CURRENT_TIMESTAMP)`,
    [receiptId, ids.task, ids.sourceApproval, digest, digest,
      ids.feature, scoreId, receiptAudit]);
    await client.query(`UPDATE public."AmuxWorkItem"
      SET "status" = 'todo', "v22ReceiptId" = $2, "revision" = 1
      WHERE "id" = $1`, [ids.task, receiptId]);
    await client.query("SET CONSTRAINTS amux_v22_card_receipt_guard_trigger IMMEDIATE");
    const moved = await client.query(`SELECT "status", "v22ReceiptId"
      FROM public."AmuxWorkItem" WHERE "id" = $1`, [ids.task]);
    assert.equal(moved.rows[0].status, "todo");
    assert.equal(moved.rows[0].v22ReceiptId, receiptId);
    await rejects(`UPDATE public."AmuxWorkItem"
      SET "v4BriefDigest" = $2 WHERE "id" = $1`,
    [ids.task, "e".repeat(64)], "AmuxV4TaskDag_binding_check");

    // A13: owner lane evidence and a system assignment receipt are separate
    // from promotion. The accepted card stays Todo; it cannot execute here.
    const laneSeq = (await client.query(`SELECT nextval(pg_get_serial_sequence(
      'public."AmuxV22LaneDecision"', 'sequence')) AS sequence`)).rows[0].sequence;
    const laneAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v22.lane.declared",
      targetType: "AmuxV22LaneDecision", targetId: String(laneSeq),
      summary: "synthetic SEV1 declaration",
      metadata: { taskId: ids.task, lane: "sev1" },
    });
    await client.query(`INSERT INTO public."AmuxV22LaneDecision"
      ("sequence", "workItemId", "lane", "approvedByUserId",
       "authorizationAuditLogId", "decidedAt")
      VALUES ($1, $2, 'sev1', 'synthetic-owner', $3, CURRENT_TIMESTAMP)`,
    [laneSeq, ids.task, laneAudit]);
    await client.query("SET CONSTRAINTS amux_v22_lane_guard_trigger IMMEDIATE");
    const assignmentId = randomUUID();
    const assignmentAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: null, action: "amux.v22.worker.assigned",
      targetType: "AmuxV22WorkerAssignment", targetId: assignmentId,
      summary: "synthetic v22 assignment", metadata: {
        systemActor: "amux-v22-worker-claim", taskId: ids.task,
        workerName: "worker-one", lane: "sev1" },
    });
    await client.query(`INSERT INTO public."AmuxV22WorkerAssignment"
      ("id", "workItemId", "promotionReceiptId", "laneDecisionSequence",
       "lane", "taskRevision", "workerName", "workerInstanceId",
       "workerGeneration", "provider", "modelId", "role", "grade",
       "routeId", "routePolicyDigest", "catalogApprovalId",
       "catalogVersion", "costReceiptDigest", "perAttemptMicroUsd",
       "authorizationAuditLogId", "assignedAt") VALUES
      ($1, $2, $3, $4, 'sev1', 1, 'worker-one', 'instance-one',
       1, 'openai', 'model-one', 'implement', 'medium', 'route-one', $5,
       'catalog-one', 'v1', $5, 1000, $6, CURRENT_TIMESTAMP)`,
    [assignmentId, ids.task, receiptId, laneSeq, digest, assignmentAudit]);
    await client.query(`UPDATE public."AmuxWorkItem"
      SET "owner" = 'worker-one', "claimedAt" = CURRENT_TIMESTAMP,
        "v22AssignmentId" = $2, "revision" = 2
      WHERE "id" = $1`, [ids.task, assignmentId]);
    await client.query(`SET CONSTRAINTS amux_v22_assignment_guard_trigger,
      amux_v22_assignment_row_guard_trigger IMMEDIATE`);
    const assigned = await client.query(`SELECT "status", "owner",
      "v22AssignmentId" FROM public."AmuxWorkItem" WHERE "id" = $1`,
    [ids.task]);
    assert.deepEqual(assigned.rows[0], { status: "todo", owner: "worker-one",
      v22AssignmentId: assignmentId });

    // A15: the Doing transition and exactly one assignment-bound execution
    // attempt must commit together; neither half is a valid standalone write.
    await rejects(`UPDATE public."AmuxWorkItem"
      SET "status" = 'doing', "revision" = 3 WHERE "id" = $1`,
    [ids.task], "AmuxWorkItem_v22_doing_check",
    "amux_v22_doing_guard_trigger");
    const attemptId = randomUUID();
    await client.query(`UPDATE public."AmuxWorkItem"
      SET "status" = 'doing', "revision" = 3 WHERE "id" = $1`,
    [ids.task]);
    await client.query(`INSERT INTO public."AmuxExecutionAttempt"
      ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
       "taskRevision", "attemptNumber", "reservedCostMicrousd",
       "heartbeatAt", "leaseExpiresAt", "startedAt", "v22AssignmentId",
       "updatedAt") VALUES ($1, $2, 'worker-one', 'instance-one', 1,
       3, 1, 1000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '90 seconds',
       CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP)`,
    [attemptId, ids.task, assignmentId]);
    await client.query(`SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger,
      amux_v22_doing_guard_trigger IMMEDIATE`);
    await rejects(`UPDATE public."AmuxExecutionAttempt"
      SET "workerGeneration" = 2 WHERE "id" = $1`,
    [attemptId], "AmuxExecutionAttempt_v22_binding_check",
    "amux_v22_execution_attempt_guard_trigger");
    await rejects(`INSERT INTO public."AmuxExecutionAttempt"
      ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
       "taskRevision", "attemptNumber", "reservedCostMicrousd",
       "heartbeatAt", "leaseExpiresAt", "startedAt",
       "v22AssignmentId", "updatedAt")
      VALUES ($1, $2, 'worker-one', 'instance-one', 1, 3, 2, 1000,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '90 seconds',
       CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP)`,
    [randomUUID(), ids.task, assignmentId],
    "AmuxExecutionAttempt_v22AssignmentId_key");
    await rejects(`UPDATE public."AmuxWorkItem"
      SET "status" = 'review', "owner" = NULL, "claimedAt" = NULL,
          "v22AssignmentId" = NULL, "revision" = 4
      WHERE "id" = $1`, [ids.task], "AmuxWorkItem_v22_live_attempt_check",
    "amux_v22_doing_guard_trigger");
    await client.query(`SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger,
      amux_v22_doing_guard_trigger DEFERRED`);
    await client.query(`UPDATE public."AmuxWorkItem"
      SET "status" = 'review', "owner" = NULL, "claimedAt" = NULL,
          "v22AssignmentId" = NULL, "revision" = 4
      WHERE "id" = $1`, [ids.task]);
    await client.query(`UPDATE public."AmuxExecutionAttempt"
      SET "endedAt" = CURRENT_TIMESTAMP, "leaseExpiresAt" = NULL,
          "outcome" = 'succeeded', "toStatus" = 'review',
          "endedBy" = 'worker-one' WHERE "id" = $1`, [attemptId]);
    await client.query(`SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger,
      amux_v22_doing_guard_trigger IMMEDIATE`);
    const ended = await client.query(`SELECT "status", "owner",
      "v22AssignmentId" FROM public."AmuxWorkItem" WHERE "id" = $1`,
    [ids.task]);
    assert.deepEqual(ended.rows[0], { status: "review", owner: null,
      v22AssignmentId: null });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
