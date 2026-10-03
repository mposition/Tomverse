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
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(`${name}_${url.searchParams.get("schema") || ""}`);
})();

test("dark collection request binds owner, scope, Frontier version and bounded encrypted result", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const actor = "synthetic-owner";
  const ideaId = randomUUID();
  const scopeId = randomUUID();
  const frontierId = randomUUID();
  const requestId = randomUUID();
  const modelId = `synthetic-${randomUUID()}`;
  const digest = "a".repeat(64);

  async function rejected(sql, params, expected) {
    await client.query("SAVEPOINT collection_rejection");
    let error;
    try { await client.query(sql, params); } catch (caught) { error = caught; }
    await client.query("ROLLBACK TO SAVEPOINT collection_rejection");
    await client.query("RELEASE SAVEPOINT collection_rejection");
    assert.ok(error, "unsafe collection write unexpectedly succeeded");
    assert.match(`${error.constraint || ""} ${error.message}`, expected);
  }

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query(`INSERT INTO public."AmuxIdeaSubmission"
      ("id", "requestId", "actorUserId", "state", "submittedAt", "analysisDeadlineAt", "updatedAt")
      VALUES ($1, $2, $3, 'submitted', CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)`,
    [ideaId, randomUUID(), actor]);
    const scopeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.source_scope.approved",
      targetType: "AmuxIdeaSourceScopeApproval", targetId: scopeId,
      summary: "synthetic collection scope",
    });
    await client.query(`INSERT INTO public."AmuxIdeaSourceScopeApproval"
      ("id", "ideaId", "status", "scopeDigest", "scopeDigestKeyId", "actorUserId",
       "authorizationAuditLogId", "approvedAt", "expiresAt", "updatedAt")
      VALUES ($1, $2, 'approved', $3, 'synthetic-key', $4, $5,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP)`,
    [scopeId, ideaId, digest, actor, scopeAudit]);
    const frontierAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.idea.frontier_model.approved",
      targetType: "AmuxIdeaFrontierModelApproval", targetId: frontierId,
      summary: "synthetic Frontier approval",
    });
    await client.query(`INSERT INTO public."AmuxIdeaFrontierModelApproval"
      ("id", "provider", "modelId", "allowedEfforts", "version", "status",
       "approvedAt", "approvedByUserId", "approvalAuditLogId", "updatedAt")
      VALUES ($1, 'openai', $2, ARRAY['high']::text[], 1, 'approved',
              CURRENT_TIMESTAMP, $3, $4, CURRENT_TIMESTAMP)`,
    [frontierId, modelId, actor, frontierAudit]);
    const collectionId = randomUUID();
    const creationAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.requested",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic collection request",
    });
    const values = [collectionId, requestId, ideaId, actor, scopeId,
      frontierId, modelId, randomUUID(), digest, creationAudit];
    const insert = `INSERT INTO public."AmuxIdeaCollectionRequest"
      ("id", "requestId", "ideaId", "actorUserId", "sourceScopeApprovalId",
       "frontierApprovalId", "frontierVersion", "provider", "modelId",
       "reasoningEffort", "sourceIndex", "sourceKind", "sourceByteLimit",
       "previewId", "attempt", "requestDigest", "requestDigestKeyId",
       "state", "expiresAt", "creationAuditLogId", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, 1, 'openai', $7,
              'high', 0, 'repository_file', 8192, $8, 1, $9, 'synthetic-key',
              'pending', CURRENT_TIMESTAMP + INTERVAL '10 minutes', $10, CURRENT_TIMESTAMP)`;
    await rejected(insert.replace("'repository_file'", "'pull_request'"), values,
      /AmuxIdeaCollectionRequest_source_kind_check/);
    await rejected(insert.replace("8192", "8193"), values,
      /AmuxIdeaCollectionRequest_source_kind_check/);
    await rejected(insert, [...values.slice(0, 3), "other-owner", ...values.slice(4)],
      /AmuxIdeaCollectionRequest_idea_owner_fkey/);
    await rejected(insert, [...values.slice(0, 5), randomUUID(), ...values.slice(6)],
      /AmuxIdeaCollectionRequest_frontier_binding_fkey/);
    await client.query(insert, values);
    await rejected(insert, [randomUUID(), ...values.slice(1)],
      /AmuxIdeaCollectionRequest_requestId_key/);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "requestDigest" = $2 WHERE "id" = $1`, [collectionId, "b".repeat(64)],
    /amux_collection_identity_immutable/);
    const transitionAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.claimed",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic claim",
    });
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'claimed', "leaseGeneration" = 1, "leaseId" = 'lease-1',
          "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '2 minutes'
      WHERE "id" = $1`, [collectionId], /amux_collection_transition_refused/);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'claimed', "leaseGeneration" = 2, "leaseId" = 'lease-1',
          "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, transitionAudit], /amux_collection_generation_refused/);
    await client.query(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'claimed', "leaseGeneration" = 1, "leaseId" = 'lease-1',
          "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, transitionAudit]);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "leaseGeneration" = 2 WHERE "id" = $1`,
    [collectionId], /amux_collection_same_state_lease_refused/);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "leaseId" = 'lease-2' WHERE "id" = $1`,
    [collectionId], /amux_collection_same_state_lease_refused/);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '3 minutes'
      WHERE "id" = $1`,
    [collectionId], /amux_collection_same_state_lease_refused/);
    const unrelatedAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.unrelated",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic same-state audit mutation",
    });
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, unrelatedAudit], /amux_collection_same_state_audit_refused/);
    const resultAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.preview_ready",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic result",
    });
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'preview_ready', "leaseId" = NULL, "leaseExpiresAt" = NULL,
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, resultAudit], /amux_collection_initial_result_required/);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'preview_ready', "leaseId" = NULL, "leaseExpiresAt" = NULL,
          "resultDigest" = $3, "resultDigestKeyId" = 'synthetic-key',
          "resultPurgeAfter" = "expiresAt" + INTERVAL '1 day',
          "resultPurgedAt" = CURRENT_TIMESTAMP,
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, resultAudit, digest], /amux_collection_initial_result_required/);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'preview_ready', "leaseId" = NULL, "leaseExpiresAt" = NULL,
          "resultCiphertext" = decode(repeat('aa', 32769), 'hex'),
          "resultKeyId" = 'synthetic', "resultKeyVersion" = 1,
          "resultDigest" = $3, "resultDigestKeyId" = 'synthetic-key',
          "resultPurgeAfter" = "expiresAt" + INTERVAL '1 day',
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, resultAudit, digest], /AmuxIdeaCollectionRequest_result_pair_check/);
    await client.query(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'preview_ready', "leaseId" = NULL, "leaseExpiresAt" = NULL,
          "resultCiphertext" = decode('aabb', 'hex'),
          "resultKeyId" = 'synthetic', "resultKeyVersion" = 1,
          "resultDigest" = $3, "resultDigestKeyId" = 'synthetic-key',
          "resultPurgeAfter" = "expiresAt" + INTERVAL '1 day',
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, resultAudit, digest]);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "resultPurgeAfter" = "expiresAt" + INTERVAL '2 days' WHERE "id" = $1`,
    [collectionId], /amux_collection_purge_deadline_immutable/);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "resultDigest" = $2 WHERE "id" = $1`,
    [collectionId, "b".repeat(64)], /amux_collection_result_immutable/);
    const expiryAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.expired",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic request expiry",
    });
    await client.query(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'expired', "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [collectionId, expiryAudit]);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "resultCiphertext" = NULL, "resultKeyId" = NULL,
          "resultKeyVersion" = NULL WHERE "id" = $1`,
    [collectionId], /amux_collection_purge_audit_refused/);
    const purgeSql = `UPDATE public."AmuxIdeaCollectionRequest"
      SET "resultCiphertext" = NULL, "resultKeyId" = NULL,
          "resultKeyVersion" = NULL, "resultPurgedAt" = clock_timestamp(),
          "transitionAuditLogId" = $2 WHERE "id" = $1`;
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "resultCiphertext" = NULL, "resultKeyId" = NULL,
          "resultKeyVersion" = NULL, "resultPurgedAt" = clock_timestamp()
      WHERE "id" = $1`, [collectionId], /amux_collection_purge_audit_refused/);
    await rejected(purgeSql, [collectionId, transitionAudit],
      /amux_collection_purge_audit_refused/);
    const purgeMetadata = {
      systemActor: "amux-v4-intake",
      actorScope: "idea-collection-result-purge-v1",
    };
    const wrongPurgeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: null, action: "amux.v4.collection.result_purged",
      targetType: "AmuxIdeaCollectionRequest", targetId: randomUUID(),
      summary: "synthetic wrong-target purge", metadata: purgeMetadata,
    });
    await rejected(purgeSql, [collectionId, wrongPurgeAudit],
      /amux_collection_purge_audit_refused/);
    const wrongActionAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: null, action: "amux.v4.collection.claimed",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic wrong-action purge", metadata: purgeMetadata,
    });
    await rejected(purgeSql, [collectionId, wrongActionAudit],
      /amux_collection_purge_audit_refused/);
    const wrongActorAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.result_purged",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic wrong-actor purge", metadata: purgeMetadata,
    });
    await rejected(purgeSql, [collectionId, wrongActorAudit],
      /amux_collection_purge_audit_refused/);
    const wrongSystemActorAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: null, action: "amux.v4.collection.result_purged",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic wrong system actor purge",
      metadata: { ...purgeMetadata, systemActor: "tomverse-amux-orchestrator" },
    });
    await rejected(purgeSql, [collectionId, wrongSystemActorAudit],
      /amux_collection_purge_audit_refused/);
    const invalidHashPurgeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: null, action: "amux.v4.collection.result_purged",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic unchained purge", entryHash: "not-a-chain-hash",
      metadata: purgeMetadata,
    });
    await rejected(purgeSql, [collectionId, invalidHashPurgeAudit],
      /amux_collection_purge_audit_refused/);
    const purgeAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: null, action: "amux.v4.collection.result_purged",
      targetType: "AmuxIdeaCollectionRequest", targetId: collectionId,
      summary: "synthetic purge", metadata: purgeMetadata,
    });
    await client.query(purgeSql.replace("clock_timestamp()", "TIMESTAMP '2000-01-01'"),
      [collectionId, purgeAudit]);
    const purgeTime = await client.query(`SELECT
      request."resultPurgedAt" > TIMESTAMP '2020-01-01' AND
      request."resultPurgedAt" >= audit."createdAt" - INTERVAL '1 second' AND
      request."resultPurgedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 second'
        AS "dbClockBound"
      FROM public."AmuxIdeaCollectionRequest" AS request
      JOIN public."AdminAuditLog" AS audit ON audit."id" = request."transitionAuditLogId"
      WHERE request."id" = $1`, [collectionId]);
    assert.equal(purgeTime.rows[0].dbClockBound, true);
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "resultCiphertext" = decode('aabb', 'hex'),
          "resultKeyId" = 'synthetic', "resultKeyVersion" = 1 WHERE "id" = $1`,
    [collectionId], /amux_collection_result_restore_refused/);

    const lateId = randomUUID();
    const lateAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.requested",
      targetType: "AmuxIdeaCollectionRequest", targetId: lateId,
      summary: "synthetic short-lease request",
    });
    const lateValues = [lateId, randomUUID(), ideaId, actor, scopeId, frontierId,
      modelId, randomUUID(), digest, lateAudit];
    await client.query(insert.replace("$8, 1, $9", "$8, 2, $9"), lateValues);
    const lateClaimAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.claimed",
      targetType: "AmuxIdeaCollectionRequest", targetId: lateId,
      summary: "synthetic short lease",
    });
    await client.query(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'claimed', "leaseGeneration" = 1, "leaseId" = 'short-lease',
          "leaseExpiresAt" = clock_timestamp() + INTERVAL '200 milliseconds',
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [lateId, lateClaimAudit]);
    await client.query("SELECT pg_sleep(0.3)");
    const lateResultAudit = await appendSyntheticAdminAudit(client, {
      actorUserId: actor, action: "amux.v4.collection.preview_ready",
      targetType: "AmuxIdeaCollectionRequest", targetId: lateId,
      summary: "synthetic late result",
    });
    await rejected(`UPDATE public."AmuxIdeaCollectionRequest"
      SET "state" = 'preview_ready', "leaseId" = NULL, "leaseExpiresAt" = NULL,
          "resultCiphertext" = decode('aabb', 'hex'),
          "resultKeyId" = 'synthetic', "resultKeyVersion" = 1,
          "resultDigest" = $3, "resultDigestKeyId" = 'synthetic-key',
          "resultPurgeAfter" = "expiresAt" + INTERVAL '1 day',
          "transitionAuditLogId" = $2 WHERE "id" = $1`,
    [lateId, lateResultAudit, digest], /amux_collection_late_result_refused/);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
