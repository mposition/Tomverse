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
  return (
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(isolationMarker)
  );
})();

test("AMUX v4 schema rejects hierarchy, source-shape and premature Todo writes", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const ids = {
    idea: randomUUID(),
    initiative: randomUUID(),
    epic: randomUUID(),
    feature: randomUUID(),
    archivedInitiative: randomUUID(),
    story: randomUUID(),
  };
  const digest = "a".repeat(64);
  const titleDigest = "b".repeat(64);
  const sourceKey = randomUUID().replaceAll("-", "").toUpperCase();
  const title = Buffer.from("synthetic-only", "utf8");

  async function addNode(id, level, parentId = null) {
    await client.query(
      `INSERT INTO public."AmuxPortfolioNode"
       ("id", "level", "parentId", "state", "revision", "titleCiphertext",
        "contentKeyId", "contentKeyVersion", "contentDigest", "contentDigestKeyId",
        "approvedByUserId", "authorizationAuditLogId", "updatedAt")
       VALUES ($1, $2, $3, 'active', 0, $4, 'synthetic', 1, $5, 'synthetic',
               'synthetic', $6, CURRENT_TIMESTAMP)`,
      [id, level, parentId, title, digest, randomUUID()],
    );
  }

  async function expectRejected(query, params, expectedConstraint) {
    await client.query("SAVEPOINT reject_probe");
    let error;
    try {
      await client.query(query, params);
    } catch (caught) {
      error = caught;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT reject_probe");
      await client.query("RELEASE SAVEPOINT reject_probe");
    }
    assert.ok(error, "database write unexpectedly succeeded");
    if (expectedConstraint) assert.equal(error.constraint, expectedConstraint, error.message);
    return error;
  }

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");

    const insertIdea = `INSERT INTO public."AmuxIdeaSubmission"
      ("id", "requestId", "actorUserId", "state", "rawCiphertext", "rawKeyId", "rawKeyVersion",
       "rawDigest", "rawDigestKeyId", "submittedAt", "analysisDeadlineAt",
       "rawPurgeAfter", "updatedAt")
      VALUES ($1, $2, 'synthetic-owner', 'submitted', $3, $4, $5, $6, $7,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '7 days',
              CASE WHEN $3::bytea IS NOT NULL THEN CURRENT_TIMESTAMP + INTERVAL '7 days' ELSE NULL END,
              CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertIdea,
      [randomUUID(), randomUUID(), title, "", 1, null, null],
      "AmuxIdeaSubmission_raw_key_pair_check",
    );
    await expectRejected(
      insertIdea,
      [randomUUID(), randomUUID(), null, null, null, digest, null],
      "AmuxIdeaSubmission_raw_digest_check",
    );
    const firstRequestId = randomUUID();
    await client.query(insertIdea, [ids.idea, firstRequestId, null, null, null, null, null]);
    await expectRejected(
      insertIdea,
      [randomUUID(), firstRequestId, null, null, null, null, null],
      "AmuxIdeaSubmission_requestId_key",
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaSubmission"
       SET "submittedAt" = "submittedAt" + INTERVAL '1 day',
           "analysisDeadlineAt" = "analysisDeadlineAt" + INTERVAL '1 day'
       WHERE "id" = $1`,
      [ids.idea],
      "AmuxIdeaSubmission_identity_immutable_check",
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaSubmission"
       SET "state" = 'awaiting_owner', "analysisCompletedAt" = "analysisDeadlineAt"
       WHERE "id" = $1`,
      [ids.idea],
      "AmuxIdeaSubmission_completion_before_deadline_check",
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaSubmission"
       SET "rawCiphertext" = $2, "rawKeyId" = 'synthetic',
           "rawKeyVersion" = 1, "rawPurgeAfter" = "analysisDeadlineAt" + INTERVAL '1 day'
       WHERE "id" = $1`,
      [ids.idea, title],
      "AmuxIdeaSubmission_raw_purge_bound_check",
    );
    await client.query(
      `UPDATE public."AmuxIdeaSubmission"
       SET "rawCiphertext" = $2, "rawKeyId" = 'synthetic',
           "rawKeyVersion" = 1, "rawPurgeAfter" = "analysisDeadlineAt" - INTERVAL '1 day'
       WHERE "id" = $1`,
      [ids.idea, title],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaSubmission"
       SET "rawPurgeAfter" = "analysisDeadlineAt" WHERE "id" = $1`,
      [ids.idea],
      "AmuxIdeaSubmission_raw_purge_monotonic_check",
    );

    const expiredIdeaId = randomUUID();
    await client.query(
      `INSERT INTO public."AmuxIdeaSubmission"
       ("id", "requestId", "actorUserId", "state", "submittedAt",
        "analysisDeadlineAt", "updatedAt")
       VALUES ($1, $2, 'synthetic-owner', 'submitted',
               CURRENT_TIMESTAMP - INTERVAL '8 days',
               CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP)`,
      [expiredIdeaId, randomUUID()],
    );
    await client.query(
      `INSERT INTO public."AmuxIdeaAnalysisChunk"
       ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
        "leaseGeneration", "updatedAt")
       VALUES ($1, 'synthetic-owner', 0, 'pending', 0, 0, CURRENT_TIMESTAMP)`,
      [expiredIdeaId],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "state" = 'draft_ready',
           "analysisCompletedAt" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '2 days'
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [expiredIdeaId],
      "AmuxIdeaAnalysisChunk_completion_deadline_check",
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "state" = 'partially_decided',
           "analysisCompletedAt" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '2 days'
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [expiredIdeaId],
      "AmuxIdeaAnalysisChunk_completion_deadline_check",
    );
    await expectRejected(
      `INSERT INTO public."AmuxIdeaAnalysisChunk"
       ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
        "leaseGeneration", "analysisCompletedAt", "updatedAt")
       VALUES ($1, 'synthetic-owner', 1, 'draft_ready', 0, 0,
               (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '2 days',
               CURRENT_TIMESTAMP)`,
      [expiredIdeaId],
      "AmuxIdeaAnalysisChunk_completion_deadline_check",
    );

    const nearDeadlineIdeaId = randomUUID();
    await client.query(
      `WITH tick AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS now)
       INSERT INTO public."AmuxIdeaSubmission"
       ("id", "requestId", "actorUserId", "state", "submittedAt",
        "analysisDeadlineAt", "updatedAt")
       SELECT $1, $2, 'synthetic-owner', 'submitted',
              tick.now - INTERVAL '7 days' + INTERVAL '2 seconds',
              tick.now + INTERVAL '2 seconds', tick.now FROM tick`,
      [nearDeadlineIdeaId, randomUUID()],
    );
    await client.query(
      `INSERT INTO public."AmuxIdeaAnalysisChunk"
       ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
        "leaseGeneration", "analysisCompletedAt", "updatedAt")
       VALUES ($1, 'synthetic-owner', 0, 'expired', 0, 0,
               (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3), CURRENT_TIMESTAMP),
              ($1, 'synthetic-owner', 1, 'draft_ready', 0, 0,
               (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3), CURRENT_TIMESTAMP)`,
      [nearDeadlineIdeaId],
    );
    await client.query("SELECT pg_sleep(3)");
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk" SET "state" = 'partially_decided'
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [nearDeadlineIdeaId],
      "AmuxIdeaAnalysisChunk_completion_deadline_check",
    );
    await client.query(
      `UPDATE public."AmuxIdeaAnalysisChunk" SET "state" = 'partially_decided'
       WHERE "ideaId" = $1 AND "chunkIndex" = 1`,
      [nearDeadlineIdeaId],
    );

    const insertChunk = `INSERT INTO public."AmuxIdeaAnalysisChunk"
      ("ideaId", "actorUserId", "chunkIndex", "state", "attempt", "leaseGeneration",
       "coveredStartOrdinal", "coveredEndOrdinal", "remainingStartOrdinal",
       "remainingEndOrdinal", "updatedAt")
      VALUES ($1, $2, 0, 'pending', 0, 0, $3, $4, $5, $6, CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertChunk,
      [ids.idea, "synthetic-owner", 5, null, null, null],
      "AmuxIdeaAnalysisChunk_covered_ordinals_check",
    );
    await expectRejected(
      insertChunk,
      [ids.idea, "synthetic-owner", null, null, null, 5],
      "AmuxIdeaAnalysisChunk_remaining_ordinals_check",
    );
    await expectRejected(
      insertChunk,
      [ids.idea, "not-the-owner", null, null, null, null],
      "AmuxIdeaAnalysisChunk_ideaId_actorUserId_fkey",
    );
    await client.query(insertChunk, [ids.idea, "synthetic-owner", null, null, null, null]);
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "analysisCompletedAt" = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 day'
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ids.idea],
      "AmuxIdeaAnalysisChunk_completion_future_check",
    );
    await expectRejected(
      `INSERT INTO public."AmuxIdeaAnalysisChunk"
       ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
        "leaseGeneration", "analysisCompletedAt", "updatedAt")
       VALUES ($1, 'synthetic-owner', 2, 'draft_ready', 0, 0,
               (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 day', CURRENT_TIMESTAMP)`,
      [ids.idea],
      "AmuxIdeaAnalysisChunk_completion_future_check",
    );

    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "draftCiphertext" = $2, "draftKeyId" = 'synthetic', "draftKeyVersion" = 1
       WHERE "ideaId" = $1`,
      [ids.idea, title],
      "AmuxIdeaAnalysisChunk_no_monolithic_draft_check",
    );
    await client.query(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "state" = 'draft_ready', "analysisCompletedAt" = CURRENT_TIMESTAMP
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ids.idea],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaAnalysisChunk"
       SET "analysisCompletedAt" = "analysisCompletedAt" + INTERVAL '1 day'
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ids.idea],
      "AmuxIdeaAnalysisChunk_completion_immutable_check",
    );

    // Dark v4 owner-decision ledger: exercise the real PostgreSQL trigger,
    // including source/audit binding and the no-commit unknown-outcome path.
    const decisionUnitId = randomUUID();
    const decisionPreviewId = randomUUID();
    const decisionId = randomUUID();
    const decisionAudit = async (action, actorUserId, metadata = null) => {
      return appendSyntheticAdminAudit(client, {
        actorUserId, action, targetType: "AmuxIdeaUnitDecision",
        targetId: decisionId, summary: "synthetic decision probe", metadata,
      });
    };
    await client.query(
      `INSERT INTO public."AmuxIdeaTransferPreview"
       ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId", "templateVersion",
        "payloadDigest", "payloadDigestKeyId", "expiresAt", "confirmedAt",
        "confirmExpiresAt", "confirmedByUserId", "confirmationAuditLogId", "updatedAt")
       VALUES ($1, $2, 0, 99, 'completed', 'synthetic-model', 'synthetic-template',
               $3, 'synthetic', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP,
               CURRENT_TIMESTAMP + INTERVAL '15 minutes', 'synthetic-owner', $4, CURRENT_TIMESTAMP)`,
      [decisionPreviewId, ids.idea, digest, randomUUID()],
    );
    await client.query(
      `UPDATE public."AmuxIdeaAnalysisChunk" SET "currentPreviewId" = $2
       WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
      [ids.idea, decisionPreviewId],
    );
    await client.query(
      `INSERT INTO public."AmuxIdeaDraftUnit"
       ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
        "unitKind", "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
        "bodyDigest", "bodyDigestKeyId", "updatedAt")
       VALUES ($1, $2, 'synthetic-owner', 0, 99, 'c0:card-99', 'card', 'proposed',
               $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
      [decisionUnitId, ids.idea, title, digest],
    );
    const prepareAuditId = await decisionAudit("amux.v4.unit.prepare", "synthetic-owner");
    const insertDecision = `INSERT INTO public."AmuxIdeaUnitDecision"
      ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex", "prepareRequestId",
       "action", "state", "ownerSessionDigest", "ownerSessionDigestKeyId",
       "unitDigest", "unitDigestKeyId", "confirmationDigest", "confirmationDigestKeyId",
       "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
       "preparedAt", "expiresAt", "prepareAuditLogId", "updatedAt")
      VALUES ($1, $2, $3, 'synthetic-owner', $4, $5,
              'reject_unit', 'prepared', $6, 'synthetic',
              $7, 'synthetic', $8, 'synthetic', $9, $10, 'synthetic',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes', $11, CURRENT_TIMESTAMP)`;
    const decisionParams = [decisionId, ids.idea, decisionUnitId, 0, randomUUID(),
      "c".repeat(64), digest, "d".repeat(64), decisionPreviewId, digest, prepareAuditId];
    await expectRejected(insertDecision, [...decisionParams.slice(0, 3), 1, ...decisionParams.slice(4)],
      "AmuxIdeaUnitDecision_unit_binding_check");
    await client.query(insertDecision, decisionParams);
    await expectRejected(insertDecision, [randomUUID(), ...decisionParams.slice(1, 4), randomUUID(),
      ...decisionParams.slice(5)], "AmuxIdeaUnitDecision_prepare_audit_check");
    const unknownAuditId = await decisionAudit("amux.v4.unit.outcome_unknown", null,
      { systemActor: "tomverse-amux-orchestrator" });
    await client.query(
      `UPDATE public."AmuxIdeaUnitDecision"
       SET "outcomeUnknownAt" = CURRENT_TIMESTAMP,
           "outcomeUnknownConsumeRequestId" = $2,
           "outcomeUnknownAuditLogId" = $3
       WHERE "id" = $1`,
      [decisionId, randomUUID(), unknownAuditId],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'consumed',
       "consumeRequestId" = $2, "finalAuditLogId" = $3 WHERE "id" = $1`,
      [decisionId, randomUUID(), randomUUID()],
      "AmuxIdeaUnitDecision_unknown_freeze_check",
    );
    const resolvedAuditId = await decisionAudit("amux.v4.unit.no_commit_confirmed", "synthetic-owner");
    await client.query(
      `UPDATE public."AmuxIdeaUnitDecision"
       SET "outcomeUnknownResolvedAt" = CURRENT_TIMESTAMP,
           "outcomeUnknownResolution" = 'no_commit',
           "outcomeUnknownResolvedAuditLogId" = $2 WHERE "id" = $1`,
      [decisionId, resolvedAuditId],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'consumed',
       "consumeRequestId" = $2, "finalAuditLogId" = $3 WHERE "id" = $1`,
      [decisionId, randomUUID(), randomUUID()],
      "AmuxIdeaUnitDecision_consume_boundary_check",
    );
    const invalidateAuditId = await decisionAudit("amux.v4.unit.invalidate", null,
      { systemActor: "tomverse-amux-orchestrator" });
    await client.query(
      `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'invalidated',
       "finalAuditLogId" = $2 WHERE "id" = $1`,
      [decisionId, invalidateAuditId],
    );
    await expectRejected(
      `DELETE FROM public."AmuxIdeaUnitDecision" WHERE "id" = $1`,
      [decisionId], "AmuxIdeaUnitDecision_no_delete_check",
    );
    await expectRejected(
      `TRUNCATE TABLE public."AmuxIdeaUnitDecision"`,
      [], "AmuxIdeaUnitDecision_no_truncate_check",
    );
    await expectRejected(
      `TRUNCATE TABLE public."AmuxIdeaSubmission" CASCADE`,
      [], "AmuxIdeaUnitDecision_no_truncate_check",
    );
    const retainedDecision = await client.query(
      `SELECT "id" FROM public."AmuxIdeaUnitDecision" WHERE "id" = $1`,
      [decisionId],
    );
    assert.equal(retainedDecision.rowCount, 1, "cascading truncate must retain the decision");

    await client.query(
      `INSERT INTO public."AmuxIdeaAnalysisChunk"
       ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
        "leaseGeneration", "analysisCompletedAt", "updatedAt")
       VALUES ($1, 'synthetic-owner', 1, 'draft_ready', 0, 0,
               (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '30 days' + INTERVAL '5 seconds',
               CURRENT_TIMESTAMP)`,
      [ids.idea],
    );

    const insertUnit = `INSERT INTO public."AmuxIdeaDraftUnit"
      ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef", "unitKind",
       "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
       "bodyDigest", "bodyDigestKeyId", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $8, 'card', 'proposed', $6, 'synthetic', 1,
              $7, 'synthetic', CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "not-the-owner", 1, 0, title, digest, "c1:card-0"],
      "AmuxIdeaDraftUnit_ideaId_actorUserId_fkey",
    );
    const firstUnitId = randomUUID();
    const secondUnitId = randomUUID();
    await client.query(insertUnit, [firstUnitId, ids.idea, "synthetic-owner", 1, 0, title, digest, "c1:card-0"]);
    await client.query(insertUnit, [secondUnitId, ids.idea, "synthetic-owner", 1, 1, title, digest, "c1:card-1"]);
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, null],
      "AmuxIdeaDraftUnit_local_ref_required_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, "c01:card-2"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, "c0:card-2"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, "c1:node-2"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, "c1:card-10000"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await client.query(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 3, title, digest, "c1:card-9999"],
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, `c1:card-${"9".repeat(122)}`],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, "c1:card-0"],
      "AmuxIdeaDraftUnit_ideaId_localRef_key",
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit" SET "localRef" = 'c1:card-9' WHERE "id" = $1`,
      [firstUnitId],
      "AmuxIdeaDraftUnit_local_ref_immutable_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 1, title, digest, "c1:card-9"],
      "AmuxIdeaDraftUnit_ideaId_chunkIndex_unitIndex_key",
    );
    await client.query("SELECT pg_sleep(5.5)");
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit" SET "state" = 'approved' WHERE "id" = $1`,
      [firstUnitId],
      "AmuxIdeaDraftUnit_decision_expired_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest, "c1:card-2"],
      "AmuxIdeaDraftUnit_insert_expired_check",
    );
    await expectRejected(
      `DELETE FROM public."AmuxIdeaDraftUnit" WHERE "id" = $1`,
      [firstUnitId],
      "AmuxIdeaDraftUnit_no_delete_check",
    );
    await client.query(
      `UPDATE public."AmuxIdeaDraftUnit"
       SET "state" = 'expired'
       WHERE "id" = $1`,
      [firstUnitId],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit" SET "state" = 'proposed' WHERE "id" = $1`,
      [firstUnitId],
      "AmuxIdeaDraftUnit_transition_check",
    );
    await client.query(
      `UPDATE public."AmuxIdeaDraftUnit"
       SET "bodyCiphertext" = NULL, "bodyKeyId" = NULL, "bodyKeyVersion" = NULL
       WHERE "id" = $1`,
      [firstUnitId],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit" SET "bodyCiphertext" = $2,
        "bodyKeyId" = 'synthetic', "bodyKeyVersion" = 1 WHERE "id" = $1`,
      [firstUnitId, title],
      "AmuxIdeaDraftUnit_no_resurrection_check",
    );
    const units = await client.query(
      `SELECT "id", "bodyCiphertext", "bodyPurgedAt", "bodyPurgeAfter", "expiresAt"
       FROM public."AmuxIdeaDraftUnit" WHERE "id" IN ($1, $2) ORDER BY "id"`,
      [firstUnitId, secondUnitId],
    );
    const first = units.rows.find((row) => row.id === firstUnitId);
    const second = units.rows.find((row) => row.id === secondUnitId);
    assert.equal(first?.bodyCiphertext, null);
    assert.ok(first?.bodyPurgedAt);
    assert.equal(first?.bodyPurgeAfter?.getTime(), first?.expiresAt?.getTime());
    const expiryClock = await client.query(
      `SELECT u."expiresAt" = c."analysisCompletedAt" + INTERVAL '30 days' AS "clockOk"
       FROM public."AmuxIdeaDraftUnit" u
       JOIN public."AmuxIdeaAnalysisChunk" c
         ON c."ideaId" = u."ideaId" AND c."chunkIndex" = u."chunkIndex"
       WHERE u."id" = $1`,
      [firstUnitId],
    );
    assert.equal(expiryClock.rows[0].clockOk, true);
    assert.deepEqual(second?.bodyCiphertext, title);
    assert.equal(second?.bodyPurgedAt, null);

    const currentUnitId = randomUUID();
    await client.query(insertUnit, [currentUnitId, ids.idea, "synthetic-owner", 0, 0, title, digest, "c0:card-0"]);
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit"
       SET "expiresAt" = "expiresAt" + INTERVAL '1 day' WHERE "id" = $1`,
      [currentUnitId],
      "AmuxIdeaDraftUnit_identity_immutable_check",
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit" SET "state" = 'expired' WHERE "id" = $1`,
      [currentUnitId],
      "AmuxIdeaDraftUnit_early_expiry_check",
    );
    await client.query(
      `UPDATE public."AmuxIdeaDraftUnit" SET "state" = 'approved' WHERE "id" = $1`,
      [currentUnitId],
    );
    const approvedClock = await client.query(
      `SELECT "bodyPurgeAfter" = "finalDecisionAt" + INTERVAL '30 days' AS "clockOk"
       FROM public."AmuxIdeaDraftUnit" WHERE "id" = $1`,
      [currentUnitId],
    );
    assert.equal(approvedClock.rows[0].clockOk, true);
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit"
       SET "bodyCiphertext" = NULL, "bodyKeyId" = NULL, "bodyKeyVersion" = NULL
       WHERE "id" = $1`,
      [currentUnitId],
      "AmuxIdeaDraftUnit_early_purge_check",
    );

    const insertPreview = `INSERT INTO public."AmuxIdeaTransferPreview"
      ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId",
       "templateVersion", "payloadDigest", "payloadDigestKeyId", "expiresAt",
       "confirmedAt", "confirmExpiresAt", "confirmedByUserId",
       "confirmationAuditLogId", "updatedAt")
      VALUES ($1, $2, 0, $3, 'confirmed', 'synthetic-model', 'v1', $4,
              'synthetic', CURRENT_TIMESTAMP + INTERVAL '1 hour',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes',
              $5, $6, CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertPreview,
      [randomUUID(), ids.idea, 1, digest, "not-the-owner", randomUUID()],
      "AmuxIdeaTransferPreview_ideaId_confirmedByUserId_fkey",
    );
    await client.query(insertPreview, [
      randomUUID(), ids.idea, 1, digest, "synthetic-owner", randomUUID(),
    ]);
    await expectRejected(
      insertPreview,
      [randomUUID(), ids.idea, 2, digest, "synthetic-owner", randomUUID()],
      "AmuxIdeaTransferPreview_one_active_per_chunk",
    );

    await addNode(ids.initiative, "initiative");
    await addNode(ids.epic, "epic", ids.initiative);
    await addNode(ids.feature, "feature", ids.epic);
    await addNode(ids.archivedInitiative, "initiative");
    const insertNodeWithClock = `INSERT INTO public."AmuxPortfolioNode"
      ("id", "level", "state", "revision", "titleCiphertext", "contentKeyId",
       "contentKeyVersion", "contentDigest", "contentDigestKeyId", "approvedByUserId",
       "authorizationAuditLogId", "archivedAt", "contentPurgeAfter", "updatedAt")
      VALUES ($1, 'initiative', $2, 0, $3, 'synthetic', 1, $4, 'synthetic',
              'synthetic', $5, $6, $7, CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertNodeWithClock,
      [randomUUID(), "archived", title, digest, randomUUID(), null, null],
      "AmuxPortfolioNode_retention_insert_check",
    );
    await expectRejected(
      insertNodeWithClock,
      [randomUUID(), "active", title, digest, randomUUID(), new Date(), null],
      "AmuxPortfolioNode_retention_insert_check",
    );
    await expectRejected(
      insertNodeWithClock,
      [randomUUID(), "active", title, digest, randomUUID(), null, new Date()],
      "AmuxPortfolioNode_retention_insert_check",
    );
    await expectRejected(
      `UPDATE public."AmuxPortfolioNode"
       SET "state" = 'archived', "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [ids.archivedInitiative],
      "AmuxPortfolioNode_retention_clock_immutable_check",
    );
    await expectRejected(
      `UPDATE public."AmuxPortfolioNode"
       SET "state" = 'archived', "contentPurgeAfter" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [ids.archivedInitiative],
      "AmuxPortfolioNode_retention_clock_immutable_check",
    );
    const beforeArchive = await client.query(
      `SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "moment"`,
    );
    await client.query(
      `UPDATE public."AmuxPortfolioNode" SET "state" = 'archived'
       WHERE "id" = $1`,
      [ids.archivedInitiative],
    );
    const afterArchive = await client.query(
      `SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "moment"`,
    );
    const archiveClock = await client.query(
      `SELECT "archivedAt", "archivedAt" IS NOT NULL AS "recorded",
              "contentPurgeAfter" = "archivedAt" + INTERVAL '90 days' AS "dueAt90Days"
       FROM public."AmuxPortfolioNode" WHERE "id" = $1`,
      [ids.archivedInitiative],
    );
    assert.equal(archiveClock.rows[0].recorded, true);
    assert.equal(archiveClock.rows[0].dueAt90Days, true);
    assert.ok(archiveClock.rows[0].archivedAt.getTime() >= beforeArchive.rows[0].moment.getTime() - 1);
    assert.ok(archiveClock.rows[0].archivedAt.getTime() <= afterArchive.rows[0].moment.getTime() + 1);
    await client.query(
      `UPDATE public."AmuxPortfolioNode" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [ids.archivedInitiative],
    );
    const unchangedArchiveClock = await client.query(
      `SELECT "archivedAt" FROM public."AmuxPortfolioNode" WHERE "id" = $1`,
      [ids.archivedInitiative],
    );
    assert.equal(unchangedArchiveClock.rows[0].archivedAt.getTime(), archiveClock.rows[0].archivedAt.getTime());
    const reactivateError = await expectRejected(
      `UPDATE public."AmuxPortfolioNode" SET "state" = 'active' WHERE "id" = $1`,
      [ids.archivedInitiative],
    );
    assert.match(reactivateError.message, /reactivation requires/);
    const clearClockError = await expectRejected(
      `UPDATE public."AmuxPortfolioNode"
       SET "state" = 'active', "archivedAt" = NULL, "contentPurgeAfter" = NULL WHERE "id" = $1`,
      [ids.archivedInitiative],
    );
    assert.match(clearClockError.message, /reactivation requires/);
    await expectRejected(
      `UPDATE public."AmuxPortfolioNode"
       SET "archivedAt" = "archivedAt" + INTERVAL '1 day' WHERE "id" = $1`,
      [ids.archivedInitiative],
      "AmuxPortfolioNode_retention_clock_immutable_check",
    );
    await expectRejected(
      `UPDATE public."AmuxPortfolioNode"
       SET "contentPurgeAfter" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [ids.initiative],
      "AmuxPortfolioNode_retention_clock_immutable_check",
    );

    // A temporary table with the same name must not shadow the trigger's
    // authorized public schema relation.
    await client.query(
      `CREATE TEMP TABLE "AmuxPortfolioNode"
       ("id" text, "level" text, "state" text, "parentId" text)
       ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO pg_temp."AmuxPortfolioNode"
       ("id", "level", "state") VALUES ($1, 'initiative', 'active')`,
      [ids.archivedInitiative],
    );
    const archiveError = await expectRejected(
      `UPDATE public."AmuxPortfolioNode" SET "state" = 'archived' WHERE "id" = $1`,
      [ids.initiative],
    );
    assert.equal(archiveError.code, "P0001");
    assert.match(archiveError.message, /active child prevents/);
    const parentError = await expectRejected(
      `INSERT INTO public."AmuxPortfolioNode"
       ("id", "level", "parentId", "state", "revision", "titleCiphertext",
        "contentKeyId", "contentKeyVersion", "contentDigest", "contentDigestKeyId",
        "approvedByUserId", "authorizationAuditLogId", "updatedAt")
       VALUES ($1, 'epic', $2, 'active', 0, $3, 'synthetic', 1, $4,
               'synthetic', 'synthetic', $5, CURRENT_TIMESTAMP)`,
      [randomUUID(), ids.archivedInitiative, title, digest, randomUUID()],
    );
    assert.equal(parentError.code, "P0001");
    assert.match(parentError.message, /epic requires an active initiative parent/);
    const deleteError = await expectRejected(
      `DELETE FROM public."AmuxPortfolioNode" WHERE "id" = $1`,
      [ids.archivedInitiative],
    );
    assert.equal(deleteError.code, "P0001");
    assert.match(deleteError.message, /require archival/);

    const insertStory = `INSERT INTO public."AmuxWorkItem"
      ("id", "title", "status", "sourceSystem", "sourceKey", "sourceVersion",
       "sourceDigest", "sourceSnapshot", "cardType", "storyKind", "parentFeatureNodeId",
       "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion",
       "v4TitleDigest", "v4TitleDigestKeyId", "v4SourceApprovalId", "updatedAt")
      VALUES ($1, 'AMUX Story', 'backlog', 'admin-idea-v4', $2, 'v1', $3,
              $4::jsonb, 'story', 'general', $5, $6, 'synthetic', 1, $7, 'synthetic',
              'synthetic-approval', CURRENT_TIMESTAMP)`;
    const storyParams = [
      ids.story, sourceKey, digest,
      JSON.stringify({ schemaVersion: null, ideaId: null, approvalId: null }),
      ids.feature, title, titleDigest,
    ];
    await expectRejected(
      insertStory,
      storyParams,
      "AmuxWorkItem_v4_source_snapshot_shape_check",
    );
    storyParams[3] = JSON.stringify({
      schemaVersion: "amux-v4",
      ideaId: "synthetic_idea_01",
      approvalId: "synthetic_approval_01",
    });
    await client.query(insertStory, storyParams);
    await expectRejected(
      `UPDATE public."AmuxWorkItem" SET "storyKind" = NULL WHERE "id" = $1`,
      [ids.story], "AmuxWorkItem_v4_story_kind_check",
    );
    const todoError = await expectRejected(
      `UPDATE public."AmuxWorkItem" SET "status" = 'todo' WHERE "id" = $1`,
      [ids.story],
    );
    assert.equal(todoError.code, "23514");

    // Empty-table fixture cleanup is the sole allowed TRUNCATE path.
    await client.query("ROLLBACK");
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query(`TRUNCATE TABLE public."AmuxIdeaUnitDecision"`);
    await client.query("ROLLBACK");

    // A fixed older snapshot must never take the empty-table exception. It
    // could predate another transaction's first committed decision.
    for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
      await client.query(`BEGIN ISOLATION LEVEL ${level}`);
      await client.query("SELECT 1");
      await expectRejected(
        `TRUNCATE TABLE public."AmuxIdeaUnitDecision"`,
        [], "AmuxIdeaUnitDecision_no_truncate_check",
      );
      await client.query("ROLLBACK");
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
