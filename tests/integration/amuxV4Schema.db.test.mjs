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
    if (expectedConstraint) assert.equal(error.constraint, expectedConstraint);
    return error;
  }

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");

    const insertIdea = `INSERT INTO public."AmuxIdeaSubmission"
      ("id", "actorUserId", "state", "rawCiphertext", "rawKeyId", "rawKeyVersion",
       "rawDigest", "rawDigestKeyId", "submittedAt", "analysisDeadlineAt", "updatedAt")
      VALUES ($1, 'synthetic-owner', 'submitted', $2, $3, $4, $5, $6,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`;
    await expectRejected(
      insertIdea,
      [randomUUID(), title, "", 1, null, null],
      "AmuxIdeaSubmission_raw_key_pair_check",
    );
    await expectRejected(
      insertIdea,
      [randomUUID(), null, null, null, digest, null],
      "AmuxIdeaSubmission_raw_digest_check",
    );
    await client.query(insertIdea, [ids.idea, null, null, null, null, null]);

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
