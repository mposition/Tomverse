import { randomUUID } from "node:crypto";

import { AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
  AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID } from
  "../../../lib/amux/v22TaskRecoveryCore.ts";
import { appendSyntheticAdminAudit } from
  "./appendSyntheticAdminAudit.mjs";

/** Positive rollback-only seed shared by the portfolio constraint test and
 * native recovery-writer integration test. Optional callbacks keep the
 * original negative probes at the exact lifecycle boundaries they exercise. */
export async function seedAmuxV4PortfolioRecoveryPrerequisites(db, input = {}) {
  const recoveryExecutorKind = input.recoveryExecutorKind ??
    "read_only_api_retry_v1";
  const executionGrade = input.executionGrade ?? "medium";
  const costReceiptDigest = input.costReceiptDigest ?? null;
  const settlementStatus = input.settlementStatus ?? "review";
  const settlementGrade = input.settlementGrade ?? executionGrade;
  const ids = { initiative: randomUUID(), epic: randomUUID(),
    feature: randomUUID(), task: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID,
    sourceApproval: randomUUID() };
  const ideaId = randomUUID();
  const unitId = randomUUID();
  const digest = "a".repeat(64);
  const titleDigest = "b".repeat(64);
  const inputDigest = "c".repeat(64);
  const expectedComponents = { initiative: 16, epic: 9, feature: 10,
    story: 0, task: 24, urgency: 6, dependency: 2, worker: 2,
    effortPenalty: 4, riskPenalty: 1, uncertaintyPenalty: 0 };
  const synthetic = Buffer.from("synthetic-only", "utf8");
  const instanceId = randomUUID();
  const recoveryInstanceId = randomUUID();

  for (const [id, level, parentId] of [
    [ids.initiative, "initiative", null],
    [ids.epic, "epic", ids.initiative],
    [ids.feature, "feature", ids.epic],
  ]) {
    await db.query(`INSERT INTO public."AmuxPortfolioNode"
      ("id", "level", "parentId", "state", "revision",
       "titleCiphertext", "contentKeyId", "contentKeyVersion",
       "contentDigest", "contentDigestKeyId", "approvedByUserId",
       "authorizationAuditLogId", "updatedAt")
      VALUES ($1, $2, $3, 'active', 0, $4, 'synthetic', 1,
              $5, 'synthetic', 'synthetic-owner', $6, CURRENT_TIMESTAMP)`,
    [id, level, parentId, synthetic, digest, randomUUID()]);
  }
  await db.query(`INSERT INTO public."AmuxWorkItem"
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
             'investigate', $9, CURRENT_TIMESTAMP)`,
    [ids.task, unitId.toUpperCase(), digest,
      JSON.stringify({ schemaVersion: "amux-v4", ideaId,
        approvalId: ids.sourceApproval }), ids.feature, synthetic,
      titleDigest, ids.sourceApproval, executionGrade]);

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
    const auditId = await appendSyntheticAdminAudit(db, {
      actorUserId: "synthetic-owner",
      action: "amux.v4.portfolio.assessment.approve",
      targetType: "AmuxPortfolioAssessment", targetId: id,
      summary: "synthetic assessment",
    });
    await db.query(`INSERT INTO public."AmuxPortfolioAssessment"
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
  await input.afterAssessments?.({ assessments });

  const scoreId = randomUUID();
  const scoreAudit = await appendSyntheticAdminAudit(db, {
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
  const scoreValues = [scoreId, randomUUID(), ids.task, ids.sourceApproval,
    assessments.initiative, assessments.epic, assessments.feature,
    null, assessments.task, inputDigest, scoreAudit, 64,
    JSON.stringify(expectedComponents)];
  await input.beforeScore?.({ insertScore, scoreValues, assessments,
    expectedComponents });
  await db.query(insertScore, scoreValues);
  await input.afterScore?.({ scoreId });

  const newerId = randomUUID();
  const newerAudit = await appendSyntheticAdminAudit(db, {
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
     "modelProposalDigest", "priorAssessmentId", "approvedByUserId",
     "approvalAuditLogId", "approvedAt")
    VALUES ($1, $2, $3, 'task', 0, $4, 'synthetic', 2, $8::jsonb,
            'medium', '["proof_0002"]'::jsonb,
            CURRENT_TIMESTAMP, 'new_evidence', $5, 'synthetic', $9, $6,
            'synthetic-owner', $7, CURRENT_TIMESTAMP)`;
  const newEvidenceParams = [newerId, randomUUID(), ids.task, digest,
    inputDigest, assessments.task, newerAudit,
    JSON.stringify({ contribution: 5, urgency: 3, dependencyUnlock: 2,
      workerCoverage: 2, effort: 2, deliveryRisk: 1 }), null];
  await input.beforeNewEvidence?.({ insertNewEvidence, newEvidenceParams });
  await db.query(insertNewEvidence, newEvidenceParams);
  await input.afterNewEvidence?.({ insertScore, scoreValues });

  const previewId = randomUUID();
  await db.query(`INSERT INTO public."AmuxIdeaSubmission"
    ("id", "requestId", "actorUserId", "state", "submittedAt",
     "analysisDeadlineAt", "updatedAt") VALUES
    ($1, $2, 'synthetic-owner', 'analyzing', CURRENT_TIMESTAMP,
     CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`,
  [ideaId, randomUUID()]);
  await db.query(`INSERT INTO public."AmuxIdeaAnalysisChunk"
    ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
     "leaseGeneration", "analysisCompletedAt", "updatedAt") VALUES
    ($1, 'synthetic-owner', 0, 'draft_ready', 0, 0,
     CURRENT_TIMESTAMP - INTERVAL '1 second', CURRENT_TIMESTAMP)`,
  [ideaId]);
  await db.query(`INSERT INTO public."AmuxIdeaTransferPreview"
    ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId",
     "templateVersion", "payloadDigest", "payloadDigestKeyId", "expiresAt",
     "confirmedAt", "confirmExpiresAt", "confirmedByUserId",
     "confirmationAuditLogId", "updatedAt") VALUES
    ($1, $2, 0, 1, 'completed', 'synthetic-model', 'synthetic-template',
     $3, 'synthetic', CURRENT_TIMESTAMP + INTERVAL '1 day',
     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
     'synthetic-owner', $4, CURRENT_TIMESTAMP)`,
  [previewId, ideaId, digest, randomUUID()]);
  await db.query(`UPDATE public."AmuxIdeaAnalysisChunk"
    SET "currentPreviewId" = $2 WHERE "ideaId" = $1`, [ideaId, previewId]);
  await db.query(`INSERT INTO public."AmuxIdeaDraftUnit"
    ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex",
     "localRef", "unitKind", "state", "bodyCiphertext", "bodyKeyId",
     "bodyKeyVersion", "bodyDigest", "bodyDigestKeyId", "updatedAt")
    VALUES ($1, $2, 'synthetic-owner', 0, 0, 'c0:card-0', 'card',
     'proposed', $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
  [unitId, ideaId, synthetic, digest]);
  const prepareAudit = await appendSyntheticAdminAudit(db, {
    actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
    targetType: "AmuxIdeaUnitDecision", targetId: ids.sourceApproval,
    summary: "synthetic preparation",
  });
  await db.query(`INSERT INTO public."AmuxIdeaUnitDecision"
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
    JSON.stringify({ card: { cardType: "task", dependencies: [],
      ...(costReceiptDigest ? { task: { costReceipt: {
        role: "investigate", grade: executionGrade,
        receiptDigest: costReceiptDigest,
      } } } : {}) } }),
    previewId, ids.feature, prepareAudit]);
  const consumeAudit = await appendSyntheticAdminAudit(db, {
    actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
    targetType: "AmuxIdeaUnitDecision", targetId: ids.sourceApproval,
    summary: "synthetic consumption",
  });
  await db.query(`UPDATE public."AmuxIdeaUnitDecision"
    SET "state" = 'consumed', "consumeRequestId" = $2,
        "consumedAt" = CURRENT_TIMESTAMP, "registeredWorkItemId" = $3,
        "finalAuditLogId" = $4 WHERE "id" = $1`,
  [ids.sourceApproval, randomUUID(), ids.task, consumeAudit]);
  await db.query(`UPDATE public."AmuxIdeaDraftUnit"
    SET "state" = 'approved' WHERE "id" = $1`, [unitId]);
  await db.query(`SET CONSTRAINTS amux_v4_consumed_decision_complete,
    amux_v4_registered_card_complete, amux_v4_task_dag_decision IMMEDIATE`);

  const receiptId = randomUUID();
  const receiptAudit = await appendSyntheticAdminAudit(db, {
    actorUserId: null, action: "amux.v22.auto_promotion.consumed",
    targetType: "AmuxV22PromotionReceipt", targetId: receiptId,
    summary: "synthetic v22 promotion",
    metadata: { systemActor: "amux-v22-auto-admit" },
  });
  await db.query(`INSERT INTO public."AmuxV22PromotionReceipt"
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
  await db.query(`UPDATE public."AmuxWorkItem"
    SET "status" = 'todo', "v22ReceiptId" = $2, "revision" = 1
    WHERE "id" = $1`, [ids.task, receiptId]);
  await db.query("SET CONSTRAINTS amux_v22_card_receipt_guard_trigger IMMEDIATE");
  await input.afterPromotion?.({ ids, receiptId });

  const laneSeq = (await db.query(`SELECT nextval(pg_get_serial_sequence(
    'public."AmuxV22LaneDecision"', 'sequence')) AS sequence`)).rows[0].sequence;
  const laneAudit = await appendSyntheticAdminAudit(db, {
    actorUserId: "synthetic-owner", action: "amux.v22.lane.declared",
    targetType: "AmuxV22LaneDecision", targetId: String(laneSeq),
    summary: "synthetic SEV1 declaration",
    metadata: { taskId: ids.task, lane: "sev1" },
  });
  await db.query(`INSERT INTO public."AmuxV22LaneDecision"
    ("sequence", "workItemId", "lane", "approvedByUserId",
     "authorizationAuditLogId", "decidedAt")
    VALUES ($1, $2, 'sev1', 'synthetic-owner', $3, CURRENT_TIMESTAMP)`,
  [laneSeq, ids.task, laneAudit]);
  await db.query("SET CONSTRAINTS amux_v22_lane_guard_trigger IMMEDIATE");

  const assignmentId = randomUUID();
  const assignmentAudit = await appendSyntheticAdminAudit(db, {
    actorUserId: null, action: "amux.v22.worker.assigned",
    targetType: "AmuxV22WorkerAssignment", targetId: assignmentId,
    summary: "synthetic v22 assignment", metadata: {
      systemActor: "amux-v22-worker-claim", taskId: ids.task,
      workerName: "worker-one", lane: "sev1" },
  });
  await db.query(`INSERT INTO public."AmuxV22WorkerAssignment"
    ("id", "workItemId", "promotionReceiptId", "laneDecisionSequence",
     "lane", "taskRevision", "workerName", "workerInstanceId",
     "workerGeneration", "provider", "modelId", "role", "grade",
     "routeId", "routePolicyDigest", "catalogApprovalId",
     "catalogVersion", "costReceiptDigest", "perAttemptMicroUsd",
     "authorizationAuditLogId", "assignedAt") VALUES
    ($1, $2, $3, $4, 'sev1', 1, 'worker-one', '${instanceId}',
     1, 'openai', 'model-one', 'investigate', $7, 'route-one', $5,
     'catalog-one', 'v1', $5, 3400000, $6, CURRENT_TIMESTAMP)`,
  [assignmentId, ids.task, receiptId, laneSeq, digest, assignmentAudit,
    executionGrade]);
  await db.query(`UPDATE public."AmuxWorkItem"
    SET "owner" = 'worker-one', "claimedAt" = CURRENT_TIMESTAMP,
      "v22AssignmentId" = $2, "revision" = 2
    WHERE "id" = $1`, [ids.task, assignmentId]);
  await db.query(`SET CONSTRAINTS amux_v22_assignment_guard_trigger,
    amux_v22_assignment_row_guard_trigger IMMEDIATE`);
  await input.afterAssignment?.({ ids, assignmentId });

  const attemptId = AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID;
  await db.query(`UPDATE public."AmuxWorkItem"
    SET "status" = 'doing', "revision" = 3 WHERE "id" = $1`, [ids.task]);
  await db.query(`INSERT INTO public."AmuxExecutionAttempt"
    ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
     "taskRevision", "attemptNumber", "reservedCostMicrousd",
     "heartbeatAt", "leaseExpiresAt", "startedAt", "v22AssignmentId",
     "updatedAt") VALUES ($1, $2, 'worker-one', '${instanceId}', 1,
     3, 1, 3400000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '90 seconds',
     CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP)`,
  [attemptId, ids.task, assignmentId]);
  await db.query(`SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger,
    amux_v22_doing_guard_trigger IMMEDIATE`);
  await input.afterAttempt?.({ ids, attemptId, assignmentId, instanceId });

  await db.query(`INSERT INTO public."AmuxCostLedgerEntry"
    ("id", "scope", "resourceKey", "budgetWindowStartsAt",
     "budgetWindowEndsAt", "taskId", "attemptId", "kind", "amountMicrousd")
    VALUES ($1, 'project', 'synthetic-recovery', date_trunc('month', CURRENT_TIMESTAMP),
      date_trunc('month', CURRENT_TIMESTAMP) + interval '1 month', $2, $3,
      'reservation', 3400000)`, [randomUUID(), ids.task, attemptId]);
  await db.query(`INSERT INTO public."AmuxCliUsageEvent"
    ("id", "invocationId", "receiptDigest", "bindingKind", "attemptId", "taskId",
     "worker", "cli", "provider", "selectedModelId", "authentication",
     "startedAt", "endedAt", "status", "completeness", "source",
     "inputTokensIncludeCacheRead", "inputTokensIncludeCacheWrite",
     "reasoningOutputIncludedInOutput", "completedTurns", "createdAt", "retentionUntil")
    VALUES ($1, $2, $3, 'task_attempt', $4, $5, 'worker-one', 'codex', 'openai',
      'model-one', 'subscription', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      'outcome_unknown', 'unknown', 'unreported', true, NULL, true, 0,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '13 months')`,
  [randomUUID(), `recovery-${randomUUID()}`, digest, attemptId, ids.task]);
  await db.query(`INSERT INTO public."AmuxWorkDelivery"
    ("attemptId", "taskId", "worker", "workerInstanceId", "workerGeneration",
     "taskRevision", "prompt", "status", "updatedAt")
    VALUES ($1, $2, 'worker-one', $3, 1, 3, 'synthetic', 'queued', CURRENT_TIMESTAMP)`,
  [attemptId, ids.task, instanceId]);
  const deliveryReceiptId = randomUUID();
  await db.query(`UPDATE public."AmuxWorkDelivery" SET "status"='leased',
    "receiptId"=$2, "leasedAt"=CURRENT_TIMESTAMP,
    "leaseExpiresAt"=CURRENT_TIMESTAMP + interval '30 seconds', "updatedAt"=CURRENT_TIMESTAMP
    WHERE "attemptId"=$1`, [attemptId, deliveryReceiptId]);
  await db.query(`UPDATE public."AmuxWorkDelivery" SET "status"='acknowledged',
    "leaseExpiresAt"=NULL, "acknowledgedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
    WHERE "attemptId"=$1`, [attemptId]);
  await input.beforeSettlement?.({ ids });

  await db.query(`SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger,
    amux_v22_doing_guard_trigger DEFERRED`);
  await db.query(`UPDATE public."AmuxWorkItem"
    SET "status" = $2, "owner" = NULL, "claimedAt" = NULL,
        "v22AssignmentId" = NULL, "executionGrade" = $3, "revision" = 4
    WHERE "id" = $1`, [ids.task, settlementStatus, settlementGrade]);
  await db.query(`UPDATE public."AmuxExecutionAttempt"
    SET "endedAt" = CURRENT_TIMESTAMP, "leaseExpiresAt" = NULL,
        "outcome" = 'succeeded', "toStatus" = $2,
        "endedBy" = 'worker-one' WHERE "id" = $1`,
  [attemptId, settlementStatus]);
  await db.query(`SET CONSTRAINTS amux_v22_execution_attempt_guard_trigger,
    amux_v22_doing_guard_trigger IMMEDIATE`);
  await input.afterSettlement?.({ ids });

  await db.query(`INSERT INTO public."AmuxWorkerRuntime"
    ("workerName", "instanceId", "generation", "status", "dispatchReady",
     "heartbeatAt", "leaseExpiresAt", "updatedAt", "protocolCapabilities") VALUES
    ('worker-one', $1, 1, 'idle', true, CURRENT_TIMESTAMP,
     CURRENT_TIMESTAMP + interval '90 seconds', CURRENT_TIMESTAMP, ARRAY[]::text[]),
    ('worker-two', $2, 1, 'idle', true, CURRENT_TIMESTAMP,
     CURRENT_TIMESTAMP + interval '90 seconds', CURRENT_TIMESTAMP,
     $3::text[])`,
  [instanceId, recoveryInstanceId, [recoveryExecutorKind]]);
  return { taskId: ids.task, priorAttemptId: attemptId,
    priorAssignmentId: assignmentId, promotionId: receiptId,
    instanceId, recoveryInstanceId, laneSequence: laneSeq, digest,
    sourceApprovalId: ids.sourceApproval, readOnlyExecutorKind: recoveryExecutorKind };
}
