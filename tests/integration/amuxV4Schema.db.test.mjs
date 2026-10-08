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
    await expectRejected(
      `UPDATE public."AmuxIdeaUnitDecision"
       SET "confirmationSnapshot" = '{}'::jsonb WHERE "id" = $1`,
      [decisionId], "AmuxIdeaUnitDecision_confirmation_snapshot_immutable_check",
    );
    await expectRejected(insertDecision, [randomUUID(), ...decisionParams.slice(1, 4), randomUUID(),
      ...decisionParams.slice(5)], "AmuxIdeaUnitDecision_prepare_audit_check");
    const unknownAuditId = await decisionAudit("amux.v4.unit.outcome_unknown", null,
      { systemActor: "amux-v4-intake" });
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
      { systemActor: "amux-v4-intake" });
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

    const expiryIdeaId = randomUUID();
    await client.query(
      `INSERT INTO public."AmuxIdeaSubmission"
       ("id", "requestId", "actorUserId", "state", "submittedAt",
        "analysisDeadlineAt", "updatedAt")
       VALUES ($1, $2, 'synthetic-owner', 'analyzing', CURRENT_TIMESTAMP,
               CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`,
      [expiryIdeaId, randomUUID()],
    );
    await client.query(
      `INSERT INTO public."AmuxIdeaAnalysisChunk"
       ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
        "leaseGeneration", "analysisCompletedAt", "updatedAt")
       VALUES ($1, 'synthetic-owner', 0, 'draft_ready', 0, 0,
               (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '30 days' + INTERVAL '5 seconds',
               CURRENT_TIMESTAMP)`,
      [expiryIdeaId],
    );
    await client.query(
      `INSERT INTO public."AmuxIdeaAnalysisChunk"
       ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
        "leaseGeneration", "analysisCompletedAt", "updatedAt")
       VALUES ($1, 'synthetic-owner', 1, 'draft_ready', 0, 0,
               clock_timestamp() AT TIME ZONE 'UTC',
               CURRENT_TIMESTAMP)`,
      [expiryIdeaId],
    );

    const insertUnit = `INSERT INTO public."AmuxIdeaDraftUnit"
      ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef", "unitKind",
       "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
       "bodyDigest", "bodyDigestKeyId", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $8, 'card', 'proposed', $6, 'synthetic', 1,
              $7, 'synthetic', CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "not-the-owner", 1, 0, title, digest, "c1:card-0"],
      "AmuxIdeaDraftUnit_ideaId_actorUserId_fkey",
    );
    const firstUnitId = randomUUID();
    const secondUnitId = randomUUID();
    await client.query(insertUnit, [firstUnitId, expiryIdeaId, "synthetic-owner", 1, 0, title, digest, "c1:card-0"]);
    await client.query(insertUnit, [secondUnitId, expiryIdeaId, "synthetic-owner", 1, 1, title, digest, "c1:card-1"]);
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, null],
      "AmuxIdeaDraftUnit_local_ref_required_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, "c01:card-2"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, "c0:card-2"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, "c1:node-2"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, "c1:card-10000"],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await client.query(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 3, title, digest, "c1:card-9999"],
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, `c1:card-${"9".repeat(122)}`],
      "AmuxIdeaDraftUnit_local_ref_shape_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, "c1:card-0"],
      "AmuxIdeaDraftUnit_ideaId_localRef_key",
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaDraftUnit" SET "localRef" = 'c1:card-9' WHERE "id" = $1`,
      [firstUnitId],
      "AmuxIdeaDraftUnit_local_ref_immutable_check",
    );
    await expectRejected(
      insertUnit,
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 1, title, digest, "c1:card-9"],
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
      [randomUUID(), expiryIdeaId, "synthetic-owner", 1, 2, title, digest, "c1:card-2"],
      "AmuxIdeaDraftUnit_first_expiry_check",
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
         ON c."ideaId" = u."ideaId" AND c."chunkIndex" = 0
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
       "v4TitleDigest", "v4TitleDigestKeyId", "v4BodyCiphertext",
       "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest",
       "v4BodyDigestKeyId", "v4SourceApprovalId", "updatedAt")
      VALUES ($1, 'AMUX Story', 'backlog', 'admin-idea-v4', $2, 'v1', $3,
              $4::jsonb, 'story', 'general', $5, $6, 'synthetic', 1, $7, 'synthetic',
              $6, 'synthetic', 1, $7, 'synthetic',
              $8, CURRENT_TIMESTAMP)`;
    const storyParams = [
      ids.story, sourceKey, digest,
      JSON.stringify({ schemaVersion: null, ideaId: null, approvalId: null }),
      ids.feature, title, titleDigest, "synthetic-approval",
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
    await expectRejected(insertStory,
      [storyParams[0], String(storyParams[1]).toLowerCase(), ...storyParams.slice(2)],
      "AmuxWorkItem_source_complete_check");
    await client.query("SAVEPOINT initial_story_probe");
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
    await client.query("ROLLBACK TO SAVEPOINT initial_story_probe");
    await client.query("RELEASE SAVEPOINT initial_story_probe");

    // A09's inert registration must be an all-or-nothing decision/card/unit
    // write. The synthetic fixture does not grant route access or run a model.
    const registerDecisionId = randomUUID();
    const registeredStoryId = randomUUID();
    const registerPrepareAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
      targetType: "AmuxIdeaUnitDecision", targetId: registerDecisionId,
      summary: "synthetic story registration preparation", metadata: null,
    });
    await client.query(
      `INSERT INTO public."AmuxIdeaUnitDecision"
       ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
        "prepareRequestId", "action", "state", "ownerSessionDigest",
        "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
        "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
        "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
        "baseNodeId", "baseNodeRevision", "baseNodeDigest", "baseNodeDigestKeyId",
        "preparedAt", "expiresAt", "prepareAuditLogId", "updatedAt")
       VALUES ($1, $2, $3, 'synthetic-owner', 0, $4, 'register_card', 'prepared',
               $5, 'synthetic', $6, 'synthetic', $7, 'synthetic', $8::jsonb,
               $9, $10, 'synthetic', $11, 0, $12, 'synthetic',
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
               $13, CURRENT_TIMESTAMP)`,
      [registerDecisionId, ids.idea, decisionUnitId, randomUUID(),
        "e".repeat(64), digest, "f".repeat(64), JSON.stringify({ schemaVersion: 1 }),
        decisionPreviewId, digest, ids.feature, digest, registerPrepareAudit],
    );
    await client.query("SAVEPOINT registration_probe");
    const registeredStoryParams = [registeredStoryId, randomUUID().replaceAll("-", "").toUpperCase(),
      digest, JSON.stringify({ schemaVersion: "amux-v4", ideaId: ids.idea,
        approvalId: registerDecisionId }), ids.feature, title, titleDigest,
      registerDecisionId];
    await client.query(insertStory, registeredStoryParams);
    const registerConsumeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
      targetType: "AmuxIdeaUnitDecision", targetId: registerDecisionId,
      summary: "synthetic story registration consumption", metadata: null,
    });
    await client.query(
      `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'consumed',
       "consumeRequestId" = $2, "registeredWorkItemId" = $3,
       "finalAuditLogId" = $4 WHERE "id" = $1`,
      [registerDecisionId, randomUUID(), registeredStoryId, registerConsumeAudit],
    );
    await client.query(
      `UPDATE public."AmuxIdeaDraftUnit" SET "state" = 'approved'
       WHERE "id" = $1`, [decisionUnitId],
    );
    const registered = await client.query(
      `SELECT "status", "owner", "claimedAt" FROM public."AmuxWorkItem"
       WHERE "id" = $1`, [registeredStoryId],
    );
    assert.deepEqual(registered.rows[0], {
      status: "backlog", owner: null, claimedAt: null,
    });
    // A second proposal may link the existing card, but it cannot claim that
    // link is complete without finalizing its own draft in the same tx.
    const linkUnitId = randomUUID();
    const linkDecisionId = randomUUID();
    await client.query(
      `INSERT INTO public."AmuxIdeaDraftUnit"
       ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
        "unitKind", "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
        "bodyDigest", "bodyDigestKeyId", "updatedAt")
       VALUES ($1, $2, 'synthetic-owner', 0, 103, 'c0:card-103', 'card',
               'proposed', $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
      [linkUnitId, ids.idea, title, digest],
    );
    const linkPrepareAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
      targetType: "AmuxIdeaUnitDecision", targetId: linkDecisionId,
      summary: "synthetic card link preparation",
    });
    await client.query(
      `INSERT INTO public."AmuxIdeaUnitDecision"
       ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
        "prepareRequestId", "action", "state", "ownerSessionDigest",
        "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
        "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
        "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
        "baseWorkItemId", "baseWorkItemRevision", "baseWorkItemDigest",
        "baseWorkItemDigestKeyId", "preparedAt", "expiresAt",
        "prepareAuditLogId", "updatedAt")
       VALUES ($1, $2, $3, 'synthetic-owner', 0, $4,
               'link_existing_card', 'prepared', $5, 'synthetic', $6,
               'synthetic', $7, 'synthetic', $8::jsonb, $9, $10, 'synthetic',
               $11, 0, $12, 'synthetic', CURRENT_TIMESTAMP,
               CURRENT_TIMESTAMP + INTERVAL '15 minutes', $13, CURRENT_TIMESTAMP)`,
      [linkDecisionId, ids.idea, linkUnitId, randomUUID(),
        "c".repeat(64), digest, "d".repeat(64),
        JSON.stringify({ action: "link_existing_card",
          target: { id: registeredStoryId, revision: 0,
            content: { digest: titleDigest }, status: "backlog",
            cardType: "story", storyKind: "general",
            featureNodeId: ids.feature },
          decisionReason: { digest } }), decisionPreviewId, digest,
        registeredStoryId, titleDigest, linkPrepareAudit],
    );
    const linkConsumeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
      targetType: "AmuxIdeaUnitDecision", targetId: linkDecisionId,
      summary: "synthetic card link consumption",
    });
    const consumeLink = `UPDATE public."AmuxIdeaUnitDecision"
      SET "state" = 'consumed', "consumeRequestId" = $2,
          "linkedWorkItemId" = $3, "finalAuditLogId" = $4 WHERE "id" = $1`;
    await client.query("SAVEPOINT incomplete_card_link_probe");
    await client.query(consumeLink,
      [linkDecisionId, randomUUID(), registeredStoryId, linkConsumeAudit]);
    await expectRejected(
      `SET CONSTRAINTS amux_v4_linked_card_decision_complete IMMEDIATE`,
      [], "AmuxV4CardLink_consistency_check",
    );
    await client.query("ROLLBACK TO SAVEPOINT incomplete_card_link_probe");
    await client.query("RELEASE SAVEPOINT incomplete_card_link_probe");
    await client.query(consumeLink,
      [linkDecisionId, randomUUID(), registeredStoryId, linkConsumeAudit]);
    await client.query(`UPDATE public."AmuxIdeaDraftUnit"
      SET "state" = 'approved' WHERE "id" = $1`, [linkUnitId]);
    await client.query(`SET CONSTRAINTS amux_v4_linked_card_decision_complete IMMEDIATE`);
    const linkedCard = await client.query(
      `SELECT "linkedWorkItemId", "registeredWorkItemId"
       FROM public."AmuxIdeaUnitDecision" WHERE "id" = $1`, [linkDecisionId]);
    assert.deepEqual(linkedCard.rows[0], {
      linkedWorkItemId: registeredStoryId, registeredWorkItemId: null,
    });
    await client.query("ROLLBACK TO SAVEPOINT registration_probe");
    await client.query("RELEASE SAVEPOINT registration_probe");
    const rollbackProof = await client.query(
      `SELECT d."state" AS "decisionState", u."state" AS "unitState",
              w."id" AS "cardId"
       FROM public."AmuxIdeaUnitDecision" d
       JOIN public."AmuxIdeaDraftUnit" u ON u."id" = d."draftUnitId"
       LEFT JOIN public."AmuxWorkItem" w ON w."id" = $2
       WHERE d."id" = $1`, [registerDecisionId, registeredStoryId],
    );
    assert.deepEqual(rollbackProof.rows[0], {
      decisionState: "prepared", unitState: "proposed", cardId: null,
    });
    const registerCancelAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.cancel",
      targetType: "AmuxIdeaUnitDecision", targetId: registerDecisionId,
      summary: "synthetic cancellation of unconsumed confirmation", metadata: null,
    });
    await client.query(
      `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'cancelled',
       "finalAuditLogId" = $2 WHERE "id" = $1`,
      [registerDecisionId, registerCancelAudit],
    );
    await expectRejected(
      `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'consumed',
       "consumeRequestId" = $2, "registeredWorkItemId" = $3,
       "finalAuditLogId" = $4 WHERE "id" = $1`,
      [registerDecisionId, randomUUID(), registeredStoryId, registerConsumeAudit],
      "AmuxIdeaUnitDecision_terminal_immutable_check",
    );

    // A rejection is an audited final decision, not an approval cancellation.
    // The deferred guard rejects a consumed decision whose draft stayed open.
    await client.query("SAVEPOINT rejection_probe");
    const rejectUnitId = randomUUID();
    const rejectDecisionId = randomUUID();
    await client.query(
      `INSERT INTO public."AmuxIdeaDraftUnit"
       ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
        "unitKind", "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
        "bodyDigest", "bodyDigestKeyId", "updatedAt")
       VALUES ($1, $2, 'synthetic-owner', 0, 102, 'c0:card-102', 'card',
               'proposed', $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
      [rejectUnitId, ids.idea, title, digest],
    );
    const rejectPrepareAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
      targetType: "AmuxIdeaUnitDecision", targetId: rejectDecisionId,
      summary: "synthetic rejection preparation",
    });
    await client.query(
      `INSERT INTO public."AmuxIdeaUnitDecision"
       ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
        "prepareRequestId", "action", "state", "ownerSessionDigest",
        "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
        "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
        "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
        "preparedAt", "expiresAt", "prepareAuditLogId", "updatedAt")
       VALUES ($1, $2, $3, 'synthetic-owner', 0, $4,
               'reject_unit', 'prepared', $5, 'synthetic', $6, 'synthetic',
               $7, 'synthetic', $8::jsonb, $9, $10, 'synthetic',
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
               $11, CURRENT_TIMESTAMP)`,
      [rejectDecisionId, ids.idea, rejectUnitId, randomUUID(),
        "c".repeat(64), digest, "d".repeat(64),
        JSON.stringify({ action: "reject_unit", decisionReason: { digest } }),
        decisionPreviewId, digest, rejectPrepareAudit],
    );
    const rejectConsumeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
      targetType: "AmuxIdeaUnitDecision", targetId: rejectDecisionId,
      summary: "synthetic rejection consumption",
    });
    const consumeReject = `UPDATE public."AmuxIdeaUnitDecision"
      SET "state" = 'consumed', "consumeRequestId" = $2,
          "finalAuditLogId" = $3 WHERE "id" = $1`;
    await client.query("SAVEPOINT incomplete_rejection_probe");
    await client.query(consumeReject,
      [rejectDecisionId, randomUUID(), rejectConsumeAudit]);
    await expectRejected(`SET CONSTRAINTS amux_v4_rejected_decision_complete IMMEDIATE`,
      [], "AmuxV4Rejection_consistency_check");
    await client.query("ROLLBACK TO SAVEPOINT incomplete_rejection_probe");
    await client.query("RELEASE SAVEPOINT incomplete_rejection_probe");
    await client.query(consumeReject,
      [rejectDecisionId, randomUUID(), rejectConsumeAudit]);
    await client.query(`UPDATE public."AmuxIdeaDraftUnit"
      SET "state" = 'rejected' WHERE "id" = $1`, [rejectUnitId]);
    await client.query(`SET CONSTRAINTS amux_v4_rejected_decision_complete IMMEDIATE`);
    const rejected = await client.query(
      `SELECT d."state" AS "decisionState", u."state" AS "unitState"
       FROM public."AmuxIdeaUnitDecision" d
       JOIN public."AmuxIdeaDraftUnit" u ON u."id" = d."draftUnitId"
       WHERE d."id" = $1`, [rejectDecisionId]);
    assert.deepEqual(rejected.rows[0], {
      decisionState: "consumed", unitState: "rejected",
    });
    await client.query("ROLLBACK TO SAVEPOINT rejection_probe");
    await client.query("RELEASE SAVEPOINT rejection_probe");

    // An Initiative proposal must have its own decision. A node, its
    // revision, the consumed decision and the approved draft roll back as a
    // single unit; a Story approval cannot silently approve its parent.
    const nodeUnitId = randomUUID();
    const nodeDecisionId = randomUUID();
    const newInitiativeId = randomUUID();
    await client.query(
      `INSERT INTO public."AmuxIdeaDraftUnit"
       ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
        "unitKind", "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
        "bodyDigest", "bodyDigestKeyId", "updatedAt")
       VALUES ($1, $2, 'synthetic-owner', 0, 100, 'c0:node-100', 'node',
               'proposed', $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
      [nodeUnitId, ids.idea, title, digest],
    );
    const nodePrepareAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
      targetType: "AmuxIdeaUnitDecision", targetId: nodeDecisionId,
      summary: "synthetic node preparation", metadata: null,
    });
    await client.query(
      `INSERT INTO public."AmuxIdeaUnitDecision"
       ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
        "prepareRequestId", "action", "state", "ownerSessionDigest",
        "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
        "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
        "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
        "preparedAt", "expiresAt", "prepareAuditLogId", "updatedAt")
       VALUES ($1, $2, $3, 'synthetic-owner', 0, $4, 'create_node', 'prepared',
               $5, 'synthetic', $6, 'synthetic', $7, 'synthetic', $8::jsonb,
               $9, $10, 'synthetic', CURRENT_TIMESTAMP,
               CURRENT_TIMESTAMP + INTERVAL '15 minutes', $11, CURRENT_TIMESTAMP)`,
      [nodeDecisionId, ids.idea, nodeUnitId, randomUUID(),
        "1".repeat(64), digest, "2".repeat(64),
        JSON.stringify({ schemaVersion: 1 }), decisionPreviewId, digest,
        nodePrepareAudit],
    );
    await client.query("SAVEPOINT node_registration_probe");
    const nodeConsumeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
      targetType: "AmuxIdeaUnitDecision", targetId: nodeDecisionId,
      summary: "synthetic node consumption", metadata: null,
    });
    await client.query(
      `INSERT INTO public."AmuxPortfolioNode"
       ("id", "level", "state", "revision", "titleCiphertext",
        "descriptionCiphertext", "contentKeyId", "contentKeyVersion",
        "contentDigest", "contentDigestKeyId", "approvedByUserId",
        "authorizationAuditLogId", "updatedAt")
       VALUES ($1, 'initiative', 'active', 0, $2, $2, 'synthetic', 1,
               $3, 'synthetic', 'synthetic-owner', $4, CURRENT_TIMESTAMP)`,
      [newInitiativeId, title, digest, nodeConsumeAudit],
    );
    await client.query(
      `INSERT INTO public."AmuxPortfolioNodeRevision"
       ("id", "nodeId", "revision", "contentDigest", "contentDigestKeyId",
        "decisionId", "authorizationAuditLogId", "approvedAt")
       VALUES ($1, $2, 0, $3, 'synthetic', $4, $5, CURRENT_TIMESTAMP)`,
      [randomUUID(), newInitiativeId, digest, nodeDecisionId, nodeConsumeAudit],
    );
    await client.query(
      `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'consumed',
       "consumeRequestId" = $2, "resolvedNodeId" = $3,
       "finalAuditLogId" = $4 WHERE "id" = $1`,
      [nodeDecisionId, randomUUID(), newInitiativeId, nodeConsumeAudit],
    );
    await client.query(
      `UPDATE public."AmuxIdeaDraftUnit" SET "state" = 'approved'
       WHERE "id" = $1`, [nodeUnitId],
    );
    const createdNode = await client.query(
      `SELECT n."level", d."state" AS "decisionState",
              u."state" AS "unitState" FROM public."AmuxPortfolioNode" n
       JOIN public."AmuxIdeaUnitDecision" d ON d."resolvedNodeId" = n."id"
       JOIN public."AmuxIdeaDraftUnit" u ON u."id" = d."draftUnitId"
       WHERE n."id" = $1`, [newInitiativeId],
    );
    assert.deepEqual(createdNode.rows[0], {
      level: "initiative", decisionState: "consumed", unitState: "approved",
    });
    // Selecting the existing node adds a separate decision/link; no second
    // portfolio node is created, and an unapproved source draft cannot commit.
    const selectUnitId = randomUUID();
    const selectDecisionId = randomUUID();
    await client.query(
      `INSERT INTO public."AmuxIdeaDraftUnit"
       ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "localRef",
        "unitKind", "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
        "bodyDigest", "bodyDigestKeyId", "updatedAt")
       VALUES ($1, $2, 'synthetic-owner', 0, 101, 'c0:node-101', 'node',
               'proposed', $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
      [selectUnitId, ids.idea, title, digest],
    );
    const selectPrepareAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
      targetType: "AmuxIdeaUnitDecision", targetId: selectDecisionId,
      summary: "synthetic node selection preparation",
    });
    await client.query(
      `INSERT INTO public."AmuxIdeaUnitDecision"
       ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
        "prepareRequestId", "action", "state", "ownerSessionDigest",
        "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
        "confirmationDigest", "confirmationDigestKeyId", "confirmationSnapshot",
        "sourcePreviewId", "sourcePreviewDigest", "sourcePreviewDigestKeyId",
        "baseNodeId", "baseNodeRevision", "baseNodeDigest", "baseNodeDigestKeyId",
        "preparedAt", "expiresAt", "prepareAuditLogId", "updatedAt")
       VALUES ($1, $2, $3, 'synthetic-owner', 0, $4,
               'select_existing_node', 'prepared', $5, 'synthetic', $6,
               'synthetic', $7, 'synthetic', $8::jsonb, $9, $10, 'synthetic',
               $11, 0, $12, 'synthetic', CURRENT_TIMESTAMP,
               CURRENT_TIMESTAMP + INTERVAL '15 minutes', $13, CURRENT_TIMESTAMP)`,
      [selectDecisionId, ids.idea, selectUnitId, randomUUID(),
        "b".repeat(64), digest, "c".repeat(64),
        JSON.stringify({ action: "select_existing_node",
          target: { id: newInitiativeId, revision: 0,
            content: { digest } }, decisionReason: null }), decisionPreviewId,
        digest, newInitiativeId, digest, selectPrepareAudit],
    );
    const selectConsumeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
      targetType: "AmuxIdeaUnitDecision", targetId: selectDecisionId,
      summary: "synthetic node selection consumption",
    });
    const consumeSelection = `UPDATE public."AmuxIdeaUnitDecision"
      SET "state" = 'consumed', "consumeRequestId" = $2,
          "linkedNodeId" = $3, "finalAuditLogId" = $4 WHERE "id" = $1`;
    await client.query("SAVEPOINT incomplete_selection_probe");
    await client.query(consumeSelection,
      [selectDecisionId, randomUUID(), newInitiativeId, selectConsumeAudit]);
    await expectRejected(
      `SET CONSTRAINTS amux_v4_linked_node_decision_complete IMMEDIATE`,
      [], "AmuxV4NodeLink_consistency_check",
    );
    await client.query("ROLLBACK TO SAVEPOINT incomplete_selection_probe");
    await client.query("RELEASE SAVEPOINT incomplete_selection_probe");
    await client.query(consumeSelection,
      [selectDecisionId, randomUUID(), newInitiativeId, selectConsumeAudit]);
    await client.query(`UPDATE public."AmuxIdeaDraftUnit"
      SET "state" = 'approved' WHERE "id" = $1`, [selectUnitId]);
    await client.query(`SET CONSTRAINTS amux_v4_linked_node_decision_complete IMMEDIATE`);
    const linked = await client.query(
      `SELECT "linkedNodeId", "resolvedNodeId" FROM public."AmuxIdeaUnitDecision"
       WHERE "id" = $1`, [selectDecisionId]);
    assert.deepEqual(linked.rows[0], {
      linkedNodeId: newInitiativeId, resolvedNodeId: null,
    });
    await client.query("ROLLBACK TO SAVEPOINT node_registration_probe");
    await client.query("RELEASE SAVEPOINT node_registration_probe");
    const nodeRollback = await client.query(
      `SELECT d."state" AS "decisionState", u."state" AS "unitState",
              n."id" AS "nodeId"
       FROM public."AmuxIdeaUnitDecision" d
       JOIN public."AmuxIdeaDraftUnit" u ON u."id" = d."draftUnitId"
       LEFT JOIN public."AmuxPortfolioNode" n ON n."id" = $2
       WHERE d."id" = $1`, [nodeDecisionId, newInitiativeId],
    );
    assert.deepEqual(nodeRollback.rows[0], {
      decisionState: "prepared", unitState: "proposed", nodeId: null,
    });

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

test("a consumed node decision is durable only with its draft, node, revision and audit", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const approveDraft of [false, true]) {
      const ideaId = randomUUID();
      const previewId = randomUUID();
      const unitId = randomUUID();
      const decisionId = randomUUID();
      const nodeId = randomUUID();
      const bodyDigest = "a".repeat(64);
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await client.query(
        `INSERT INTO public."AmuxIdeaSubmission"
         ("id", "requestId", "actorUserId", "state", "submittedAt",
          "analysisDeadlineAt", "updatedAt")
         VALUES ($1, $2, 'synthetic-owner', 'submitted', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`,
        [ideaId, randomUUID()],
      );
      await client.query(
        `INSERT INTO public."AmuxIdeaAnalysisChunk"
         ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
          "leaseGeneration", "analysisCompletedAt", "updatedAt")
         VALUES ($1, 'synthetic-owner', 0, 'draft_ready', 0, 0,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [ideaId],
      );
      await client.query(
        `INSERT INTO public."AmuxIdeaTransferPreview"
         ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId",
          "templateVersion", "payloadDigest", "payloadDigestKeyId",
          "expiresAt", "confirmedAt", "confirmExpiresAt",
          "confirmedByUserId", "confirmationAuditLogId", "updatedAt")
         VALUES ($1, $2, 0, 1, 'completed', 'synthetic-model',
                 'synthetic-template', $3, 'synthetic',
                 CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP + INTERVAL '15 minutes',
                 'synthetic-owner', $4, CURRENT_TIMESTAMP)`,
        [previewId, ideaId, bodyDigest, randomUUID()],
      );
      await client.query(
        `UPDATE public."AmuxIdeaAnalysisChunk"
         SET "currentPreviewId" = $2 WHERE "ideaId" = $1 AND "chunkIndex" = 0`,
        [ideaId, previewId],
      );
      await client.query(
        `INSERT INTO public."AmuxIdeaDraftUnit"
         ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex",
          "localRef", "unitKind", "state", "bodyCiphertext", "bodyKeyId",
          "bodyKeyVersion", "bodyDigest", "bodyDigestKeyId", "updatedAt")
         VALUES ($1, $2, 'synthetic-owner', 0, 0, 'c0:node-0', 'node',
                 'proposed', $3, 'synthetic', 1, $4, 'synthetic', CURRENT_TIMESTAMP)`,
        [unitId, ideaId, Buffer.from("synthetic"), bodyDigest],
      );
      const prepareAudit = await appendSyntheticAdminAudit(client, {
        actorUserId: "synthetic-owner", action: "amux.v4.unit.prepare",
        targetType: "AmuxIdeaUnitDecision", targetId: decisionId,
        summary: "synthetic node preparation", metadata: null,
      });
      await client.query(
        `INSERT INTO public."AmuxIdeaUnitDecision"
         ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
          "prepareRequestId", "action", "state", "ownerSessionDigest",
          "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
          "confirmationDigest", "confirmationDigestKeyId",
          "confirmationSnapshot", "sourcePreviewId", "sourcePreviewDigest",
          "sourcePreviewDigestKeyId", "preparedAt", "expiresAt",
          "prepareAuditLogId", "updatedAt")
         VALUES ($1, $2, $3, 'synthetic-owner', 0, $4, 'create_node',
                 'prepared', $5, 'synthetic', $6, 'synthetic',
                 $7, 'synthetic', $8::jsonb, $9, $10, 'synthetic',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '15 minutes',
                 $11, CURRENT_TIMESTAMP)`,
        [decisionId, ideaId, unitId, randomUUID(), "1".repeat(64),
          bodyDigest, "2".repeat(64), JSON.stringify({ nodeProposal: {
            id: nodeId, level: "initiative", parentId: null } }),
          previewId, bodyDigest, prepareAudit],
      );
      const consumeAudit = await appendSyntheticAdminAudit(client, {
        actorUserId: "synthetic-owner", action: "amux.v4.unit.consume",
        targetType: "AmuxIdeaUnitDecision", targetId: decisionId,
        summary: "synthetic node consumption", metadata: null,
      });
      await client.query(
        `INSERT INTO public."AmuxPortfolioNode"
         ("id", "level", "state", "revision", "titleCiphertext",
          "descriptionCiphertext", "contentKeyId", "contentKeyVersion",
          "contentDigest", "contentDigestKeyId", "approvedByUserId",
          "authorizationAuditLogId", "updatedAt")
         VALUES ($1, 'initiative', 'active', 0, $2, $2, 'synthetic', 1,
                 $3, 'synthetic', 'synthetic-owner', $4, CURRENT_TIMESTAMP)`,
        [nodeId, Buffer.from("synthetic"), bodyDigest, consumeAudit],
      );
      await client.query(
        `INSERT INTO public."AmuxPortfolioNodeRevision"
         ("id", "nodeId", "revision", "contentDigest",
          "contentDigestKeyId", "decisionId", "authorizationAuditLogId",
          "approvedAt") VALUES ($1, $2, 0, $3, 'synthetic', $4, $5,
                                  CURRENT_TIMESTAMP)`,
        [randomUUID(), nodeId, bodyDigest, decisionId, consumeAudit],
      );
      await client.query(
        `UPDATE public."AmuxIdeaUnitDecision" SET "state" = 'consumed',
         "consumeRequestId" = $2, "resolvedNodeId" = $3,
         "finalAuditLogId" = $4 WHERE "id" = $1`,
        [decisionId, randomUUID(), nodeId, consumeAudit],
      );
      if (approveDraft) {
        await client.query(
          `UPDATE public."AmuxIdeaDraftUnit" SET "state" = 'approved'
           WHERE "id" = $1`, [unitId],
        );
        await client.query("COMMIT");
        const saved = await client.query(
          `SELECT "state", "resolvedNodeId" FROM public."AmuxIdeaUnitDecision"
           WHERE "id" = $1`, [decisionId],
        );
        assert.deepEqual(saved.rows[0], {
          state: "consumed", resolvedNodeId: nodeId,
        });
      } else {
        await assert.rejects(client.query("COMMIT"), (error) =>
          error.constraint === "AmuxV4Registration_consistency_check");
        const absent = await client.query(
          `SELECT "id" FROM public."AmuxIdeaUnitDecision" WHERE "id" = $1`,
          [decisionId],
        );
        assert.equal(absent.rowCount, 0);
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
