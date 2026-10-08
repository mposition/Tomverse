import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { appendSyntheticAdminAudit } from "./helpers/appendSyntheticAdminAudit.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

test("v4 Task DAG matches the owner receipt while legacy edges stay unchanged", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const db = new pg.Client({ connectionString: databaseUrl });
  const ideaId = randomUUID();
  const previewId = randomUUID();
  const featureId = randomUUID();
  const digest = "a".repeat(64);
  const cipher = Buffer.from("synthetic-only", "utf8");
  let unitIndex = 0;
  await db.connect();
  async function rejects(action, constraint) {
    await db.query("SAVEPOINT rejected");
    let error;
    try {
      await action();
      await db.query("SET CONSTRAINTS amux_v4_task_dag_edge, amux_v4_task_dag_decision IMMEDIATE");
    } catch (caught) { error = caught; }
    await db.query("ROLLBACK TO SAVEPOINT rejected");
    await db.query("RELEASE SAVEPOINT rejected");
    assert.ok(error, "invalid DAG write succeeded");
    assert.equal(error.constraint, constraint, error.message);
  }
  async function prepareTask(dependencyIds = [], options = {}) {
    const index = unitIndex++;
    const unitId = randomUUID();
    const decisionId = randomUUID();
    const cardId = options.cardId ?? randomUUID();
    await db.query(`INSERT INTO public."AmuxIdeaDraftUnit"
      ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
       "unitKind", "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
       "bodyDigest", "bodyDigestKeyId", "updatedAt")
      VALUES ($1, $2, 'synthetic-owner', 0, $3, $4, 'card', 'proposed',
        $5, 'synthetic', 1, $6, 'synthetic', CURRENT_TIMESTAMP)`,
    [unitId, ideaId, index, `c0:card-${index}`, cipher, digest]);
    const prepareAudit = await appendSyntheticAdminAudit(db, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
      targetType: "AmuxIdeaUnitDecision", targetId: decisionId,
      summary: "synthetic Task preparation",
    });
    await db.query(`INSERT INTO public."AmuxIdeaUnitDecision"
      ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
       "prepareRequestId", "action", "state", "ownerSessionDigest",
       "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
       "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
       "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
       "baseNodeId", "baseNodeRevision", "baseNodeDigest", "baseNodeDigestKeyId",
       "preparedAt", "expiresAt", "prepareAuditLogId", "updatedAt")
      VALUES ($1, $2, $3, 'synthetic-owner', 0, $4,
        'register_card', 'prepared', $5, 'synthetic', $5, 'synthetic',
        $5, 'synthetic', $6::jsonb, $7, $5, 'synthetic',
        $8, 0, $5, 'synthetic', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '15 minutes', $9, CURRENT_TIMESTAMP)`,
    [decisionId, ideaId, unitId, randomUUID(), digest,
      JSON.stringify({ card: { cardType: "task", dependencies: dependencyIds.map(
        (id) => ({ id, cardType: "task", sourceSystem: "admin-idea-v4" })) } }),
      previewId, featureId, prepareAudit]);
    await db.query(`INSERT INTO public."AmuxWorkItem"
      ("id", "title", "status", "sourceSystem", "sourceKey", "sourceVersion",
       "sourceDigest", "sourceSnapshot", "cardType", "parentFeatureNodeId",
       "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion",
       "v4TitleDigest", "v4TitleDigestKeyId", "v4BodyCiphertext",
       "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest", "v4BodyDigestKeyId",
       "v4BriefCiphertext", "v4BriefKeyId", "v4BriefKeyVersion",
       "v4BriefDigest", "v4BriefDigestKeyId", "v4SourceApprovalId",
       "taskRole", "executionGrade", "updatedAt")
      VALUES ($1, 'AMUX Task', 'backlog', 'admin-idea-v4', $2, '1', $3,
        $4::jsonb, 'task', $5, $6, 'synthetic', 1, $3, 'synthetic',
        $6, 'synthetic', 1, $3, 'synthetic', $6, 'synthetic', 1,
        $3, 'synthetic', $7, 'implement', 'advanced', CURRENT_TIMESTAMP)`,
    [cardId, unitId.toUpperCase(), digest,
      JSON.stringify({ schemaVersion: "amux-v4", ideaId,
        approvalId: decisionId }), featureId, cipher, decisionId]);
    for (const dependencyId of options.deferEdges ? [] : dependencyIds) {
      await db.query(`INSERT INTO public."AmuxWorkDependency"
        ("taskId", "dependencyId") VALUES ($1, $2)`,
      [cardId, dependencyId]);
    }
    return { cardId, decisionId, unitId };
  }
  async function consumeTask(task) {
    const auditId = await appendSyntheticAdminAudit(db, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
      targetType: "AmuxIdeaUnitDecision", targetId: task.decisionId,
      summary: "synthetic Task consumption",
    });
    await db.query(`UPDATE public."AmuxIdeaUnitDecision"
      SET "state" = 'consumed', "consumeRequestId" = $2,
          "consumedAt" = CURRENT_TIMESTAMP, "registeredWorkItemId" = $3,
          "finalAuditLogId" = $4 WHERE "id" = $1`,
    [task.decisionId, randomUUID(), task.cardId, auditId]);
    await db.query(`UPDATE public."AmuxIdeaDraftUnit"
      SET "state" = 'approved' WHERE "id" = $1`, [task.unitId]);
  }
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = '10s'");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    await db.query(`INSERT INTO public."AmuxIdeaSubmission"
      ("id", "requestId", "actorUserId", "state", "submittedAt",
       "analysisDeadlineAt", "updatedAt")
      VALUES ($1, $2, 'synthetic-owner', 'analyzing', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`,
    [ideaId, randomUUID()]);
    await db.query(`INSERT INTO public."AmuxIdeaAnalysisChunk"
      ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
       "leaseGeneration", "analysisCompletedAt", "updatedAt")
      VALUES ($1, 'synthetic-owner', 0, 'draft_ready', 0, 0,
        (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 second',
        CURRENT_TIMESTAMP)`, [ideaId]);
    await db.query(`INSERT INTO public."AmuxIdeaTransferPreview"
      ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId",
       "templateVersion", "payloadDigest", "payloadDigestKeyId", "expiresAt",
       "confirmedAt", "confirmExpiresAt", "confirmedByUserId",
       "confirmationAuditLogId", "updatedAt")
      VALUES ($1, $2, 0, 1, 'completed', 'synthetic-model', 'synthetic-template',
        $3, 'synthetic', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '15 minutes', 'synthetic-owner', $4,
        CURRENT_TIMESTAMP)`, [previewId, ideaId, digest, randomUUID()]);
    await db.query(`UPDATE public."AmuxIdeaAnalysisChunk"
      SET "currentPreviewId" = $2 WHERE "ideaId" = $1`, [ideaId, previewId]);
    const initiative = randomUUID();
    const epic = randomUUID();
    for (const [id, level, parentId] of [
      [initiative, "initiative", null], [epic, "epic", initiative],
      [featureId, "feature", epic],
    ]) {
      await db.query(`INSERT INTO public."AmuxPortfolioNode"
        ("id", "level", "parentId", "state", "revision", "titleCiphertext",
         "contentKeyId", "contentKeyVersion", "contentDigest",
         "contentDigestKeyId", "approvedByUserId", "authorizationAuditLogId",
         "updatedAt") VALUES ($1, $2, $3, 'active', 0, $4,
         'synthetic', 1, $5, 'synthetic', 'synthetic-owner', $6,
         CURRENT_TIMESTAMP)`, [id, level, parentId, cipher, digest, randomUUID()]);
    }
    const predecessor = await prepareTask();
    await consumeTask(predecessor);
    const successor = await prepareTask([predecessor.cardId]);
    await consumeTask(successor);
    await db.query("SET CONSTRAINTS amux_v4_task_dag_edge, amux_v4_task_dag_decision IMMEDIATE");
    await rejects(() => db.query(`DELETE FROM public."AmuxWorkDependency"
      WHERE "taskId" = $1`, [successor.cardId]), "AmuxV4TaskDag_edges_check");
    await rejects(() => db.query(`INSERT INTO public."AmuxWorkDependency"
      ("taskId", "dependencyId") VALUES ($1, $2)`,
    [predecessor.cardId, successor.cardId]), "AmuxV4TaskDag_edges_check");
    await rejects(() => db.query(`UPDATE public."AmuxWorkItem"
      SET "v4BriefDigest" = $2 WHERE "id" = $1`,
    [successor.cardId, "b".repeat(64)]), "AmuxV4TaskDag_binding_check");
    await rejects(() => db.query(`TRUNCATE public."AmuxWorkDependency"`),
      "AmuxV4TaskDag_no_truncate_check");
    await db.query("SET CONSTRAINTS amux_v4_task_dag_edge, amux_v4_task_dag_decision DEFERRED");
    await db.query("SAVEPOINT cycle_probe");
    const leftId = randomUUID();
    const rightId = randomUUID();
    const left = await prepareTask([rightId], { cardId: leftId,
      deferEdges: true });
    const right = await prepareTask([leftId], { cardId: rightId,
      deferEdges: true });
    await db.query(`INSERT INTO public."AmuxWorkDependency"
      ("taskId", "dependencyId") VALUES ($1, $2), ($2, $1)`,
    [leftId, rightId]);
    await consumeTask(left);
    await consumeTask(right);
    let cycleError;
    try {
      await db.query("SET CONSTRAINTS amux_v4_task_dag_edge, amux_v4_task_dag_decision IMMEDIATE");
    } catch (error) { cycleError = error; }
    assert.ok(cycleError, "owner-confirmed cycle was accepted");
    assert.equal(cycleError.constraint, "AmuxV4TaskDag_cycle_check");
    await db.query("ROLLBACK TO SAVEPOINT cycle_probe");
    await db.query("RELEASE SAVEPOINT cycle_probe");
    await db.query(`INSERT INTO public."AmuxWorkItem"
      ("id", "title", "status", "updatedAt")
      VALUES ($1, 'legacy A', 'backlog', CURRENT_TIMESTAMP),
             ($2, 'legacy B', 'backlog', CURRENT_TIMESTAMP)`,
    ["legacy_" + randomUUID(), "legacy_" + randomUUID()]);
    const legacy = await db.query(`SELECT "id" FROM public."AmuxWorkItem"
      WHERE "title" IN ('legacy A', 'legacy B') ORDER BY "title"`);
    await db.query(`INSERT INTO public."AmuxWorkDependency"
      ("taskId", "dependencyId") VALUES ($1, $2), ($2, $1)`,
    [legacy.rows[0].id, legacy.rows[1].id]);
    await db.query("SET CONSTRAINTS amux_v4_task_dag_edge IMMEDIATE");
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
});
