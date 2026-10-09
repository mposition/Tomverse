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
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

test("approved Task price catalog is audited, immutable and fail-closed", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const id = randomUUID();
  const actorUserId = "synthetic-owner";
  const digest = "a".repeat(64);
  const evidenceDigest = "b".repeat(64);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const auditId = await appendSyntheticAdminAudit(client, {
      actorUserId, action: "amux.v4.task_catalog.approve",
      targetType: "AmuxV4TaskCostCatalogApproval", targetId: id,
      summary: "synthetic price approval",
    });
    const insert = `INSERT INTO public."AmuxV4TaskCostCatalogApproval"
      ("id", "version", "status", "catalogVersion", "pricingVersion",
       "catalog", "catalogDigest", "evidenceDigest", "approvedByUserId",
       "approvalAuditLogId", "approvedAt", "updatedAt")
      VALUES ($1, 1, 'approved', 'synthetic-v1', 'prices-v1',
              '{"schemaVersion":1}'::jsonb, $2, $3, $4, $5,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    await client.query(insert, [id, digest, evidenceDigest, actorUserId, auditId]);

    async function rejects(sql, params, constraint) {
      await client.query("SAVEPOINT reject_probe");
      let error = null;
      try { await client.query(sql, params); }
      catch (caught) { error = caught; }
      await client.query("ROLLBACK TO SAVEPOINT reject_probe");
      await client.query("RELEASE SAVEPOINT reject_probe");
      assert.ok(error, "invalid catalog mutation succeeded");
      assert.equal(error.constraint, constraint, error.message);
    }
    await rejects(`UPDATE public."AmuxV4TaskCostCatalogApproval"
      SET "catalogDigest" = $2 WHERE "id" = $1`, [id, "c".repeat(64)],
    "AmuxV4TaskCostCatalogApproval_immutable_check");
    await rejects(`DELETE FROM public."AmuxV4TaskCostCatalogApproval"
      WHERE "id" = $1`, [id],
    "AmuxV4TaskCostCatalogApproval_no_delete_check");
    await rejects(`TRUNCATE public."AmuxV4TaskCostCatalogApproval"`, [],
      "AmuxV4TaskCostCatalogApproval_no_truncate_check");
    await rejects(insert, [randomUUID(), digest, evidenceDigest,
      actorUserId, auditId],
    "AmuxV4TaskCostCatalogApproval_audit_check");

    const revokeAuditId = await appendSyntheticAdminAudit(client, {
      actorUserId, action: "amux.v4.task_catalog.revoke",
      targetType: "AmuxV4TaskCostCatalogApproval", targetId: id,
      summary: "synthetic price revocation",
    });
    await client.query(`UPDATE public."AmuxV4TaskCostCatalogApproval"
      SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP,
          "revocationAuditLogId" = $2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1`, [id, revokeAuditId]);
    await rejects(`UPDATE public."AmuxV4TaskCostCatalogApproval"
      SET "status" = 'approved', "revokedAt" = NULL,
          "revocationAuditLogId" = NULL WHERE "id" = $1`, [id],
    "AmuxV4TaskCostCatalogApproval_immutable_check");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
