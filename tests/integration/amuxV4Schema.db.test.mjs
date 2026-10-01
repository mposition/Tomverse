import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

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
      ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex", "unitKind",
       "state", "bodyCiphertext", "bodyKeyId", "bodyKeyVersion",
       "bodyDigest", "bodyDigestKeyId", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'card', 'proposed', $6, 'synthetic', 1,
              $7, 'synthetic', CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "not-the-owner", 1, 0, title, digest],
      "AmuxIdeaDraftUnit_ideaId_actorUserId_fkey",
    );
    const firstUnitId = randomUUID();
    const secondUnitId = randomUUID();
    await client.query(insertUnit, [firstUnitId, ids.idea, "synthetic-owner", 1, 0, title, digest]);
    await client.query(insertUnit, [secondUnitId, ids.idea, "synthetic-owner", 1, 1, title, digest]);
    await expectRejected(
      insertUnit,
      [randomUUID(), ids.idea, "synthetic-owner", 1, 1, title, digest],
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
      [randomUUID(), ids.idea, "synthetic-owner", 1, 2, title, digest],
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
    await client.query(insertUnit, [currentUnitId, ids.idea, "synthetic-owner", 0, 0, title, digest]);
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
    await client.query(
      `UPDATE public."AmuxPortfolioNode" SET "state" = 'archived'
       WHERE "id" = $1`,
      [ids.archivedInitiative],
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
       "sourceDigest", "sourceSnapshot", "cardType", "parentFeatureNodeId",
       "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion",
       "v4TitleDigest", "v4TitleDigestKeyId", "v4SourceApprovalId", "updatedAt")
      VALUES ($1, 'AMUX Story', 'backlog', 'admin-idea-v4', $2, 'v1', $3,
              $4::jsonb, 'story', $5, $6, 'synthetic', 1, $7, 'synthetic',
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
    const todoError = await expectRejected(
      `UPDATE public."AmuxWorkItem" SET "status" = 'todo' WHERE "id" = $1`,
      [ids.story],
    );
    assert.equal(todoError.code, "23514");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
