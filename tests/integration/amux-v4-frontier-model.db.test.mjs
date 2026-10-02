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
  const marker = `${databaseName}_${url.searchParams.get("schema") || ""}`;
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(marker);
})();

test("Frontier catalog requires human audit and enforces one-way versioned approval", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const actor = "synthetic-owner";
  const modelId = `synthetic-${randomUUID()}`;
  const firstId = randomUUID();
  const secondId = randomUUID();

  async function audit(id, action, actorUserId = actor, targetType = "AmuxIdeaFrontierModelApproval", entryHash = null) {
    return appendSyntheticAdminAudit(client, {
      actorUserId, action, targetType, targetId: id,
      summary: "synthetic Frontier eligibility probe",
      ...(entryHash === null ? {} : { entryHash }),
    });
  }

  async function rejected(query, params, expected) {
    await client.query("SAVEPOINT rejected_probe");
    let error;
    try {
      await client.query(query, params);
    } catch (caught) {
      error = caught;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT rejected_probe");
      await client.query("RELEASE SAVEPOINT rejected_probe");
    }
    assert.ok(error, "unsafe catalog write unexpectedly succeeded");
    assert.match(error.message, expected);
  }

  const insert = `INSERT INTO public."AmuxIdeaFrontierModelApproval"
    ("id", "provider", "modelId", "allowedEfforts", "version", "status",
     "approvedAt", "approvedByUserId", "approvalAuditLogId", "updatedAt")
    VALUES ($1, 'openai', $2, $3::text[], $4, 'approved', CURRENT_TIMESTAMP,
            $5, $6, CURRENT_TIMESTAMP)`;

  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await rejected(
      `TRUNCATE public."AmuxIdeaFrontierModelApproval"`, [],
      /amux_v4_frontier_truncate_refused/,
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    // Other suites may leave committed rows (including through finance
    // fixtures), so this READ COMMITTED probe cannot assume an empty catalog.
    // Its model ID is random and its writes roll back. Stronger-isolation and
    // populated-catalog TRUNCATE refusals are tested above and below; the
    // empty-catalog allowance needs an isolated DB and is not tested here.
    const wrongActorAudit = await audit(firstId, "amux.idea.frontier_model.approved", "another-owner");
    await rejected(insert, [firstId, modelId, ["high"], 1, actor, wrongActorAudit],
      /amux_v4_frontier_approval_audit_refused/);
    const wrongTargetAudit = await audit(firstId, "amux.idea.frontier_model.approved", actor, "OtherTarget");
    await rejected(insert, [firstId, modelId, ["high"], 1, actor, wrongTargetAudit],
      /amux_v4_frontier_approval_audit_refused/);
    const invalidHashAudit = await audit(firstId, "amux.idea.frontier_model.approved", actor,
      "AmuxIdeaFrontierModelApproval", "not-a-chain-hash");
    await rejected(insert, [firstId, modelId, ["high"], 1, actor, invalidHashAudit],
      /amux_v4_frontier_approval_audit_refused/);

    const firstAudit = await audit(firstId, "amux.idea.frontier_model.approved");
    await rejected(insert, [firstId, modelId, ["high", "high"], 1, actor, firstAudit],
      /amux_v4_frontier_duplicate_effort_refused/);
    await rejected(insert, [firstId, modelId, ["high"], 2, actor, firstAudit],
      /amux_v4_frontier_version_refused/);
    await client.query(insert, [firstId, modelId, ["high"], 1, actor, firstAudit]);
    await rejected(
      `UPDATE public."AmuxIdeaFrontierModelApproval"
       SET "allowedEfforts" = ARRAY['xhigh']::text[] WHERE "id" = $1`,
      [firstId], /amux_v4_frontier_update_refused/,
    );

    const secondAudit = await audit(secondId, "amux.idea.frontier_model.approved");
    await rejected(insert, [secondId, modelId, ["high"], 2, actor, secondAudit],
      /AmuxIdeaFrontierModelApproval_one_active_model/);
    const wrongRevocation = await audit(firstId, "amux.idea.frontier_model.approved");
    await rejected(
      `UPDATE public."AmuxIdeaFrontierModelApproval"
       SET "status" = 'revoked', "revokedByUserId" = $2,
           "revocationAuditLogId" = $3 WHERE "id" = $1`,
      [firstId, actor, wrongRevocation], /amux_v4_frontier_revocation_audit_refused/,
    );

    const revocationAudit = await audit(firstId, "amux.idea.frontier_model.revoked");
    await client.query(
      `UPDATE public."AmuxIdeaFrontierModelApproval"
       SET "status" = 'revoked', "revokedByUserId" = $2,
           "revocationAuditLogId" = $3 WHERE "id" = $1`,
      [firstId, actor, revocationAudit],
    );
    await rejected(
      `UPDATE public."AmuxIdeaFrontierModelApproval" SET "status" = 'approved' WHERE "id" = $1`,
      [firstId], /amux_v4_frontier_update_refused/,
    );
    await client.query(insert, [secondId, modelId, ["xhigh"], 2, actor, secondAudit]);
    await rejected(
      `DELETE FROM public."AmuxIdeaFrontierModelApproval" WHERE "id" = $1`,
      [secondId], /amux_v4_frontier_delete_refused/,
    );
    await rejected(
      `TRUNCATE public."AmuxIdeaFrontierModelApproval"`, [],
      /amux_v4_frontier_truncate_refused/,
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
