import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const migrationRoot = resolve(fileURLToPath(new URL("../../prisma/migrations/", import.meta.url)));
const V1 = "prompt-refiner-vnext-one-shot-v1";
const V2 = "prompt-refiner-vnext-one-shot-v2";
const V3 = "prompt-refiner-vnext-one-shot-v3";
const owner = "synthetic-owner";
const base = {
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  pricePinDigest: "e".repeat(64), perRequestCostMicroUsd: 29918,
  slotCount: 80, costCeilingMicroUsd: 2393440,
};
const runtime = [
  { id: V1, runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
    runtimeCommitSha: "1".repeat(40) },
  { id: V2, runtimeDeploymentId: "3565f671-c168-4d3d-8573-8e79126e1c63",
    runtimeCommitSha: "291e6d07f284e6333c34a3061dd94da77752aad9" },
  { id: V3, runtimeDeploymentId: "33333333-3333-4333-8333-333333333333",
    runtimeCommitSha: "3".repeat(40) },
];
type Client = pg.Client;
let auditCounter = 0;

async function audit(client: Client, action: string, targetId: string,
  summary: string, metadata: unknown, fixedId?: string) {
  const head = await client.query<{ entryHash: string }>(
    `SELECT "entryHash" FROM "AdminAuditLog"
     WHERE "entryHash" IS NOT NULL ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`);
  const prior = head.rows[0];
  const createdAt = new Date(Date.now() + ++auditCounter * 2);
  const id = fixedId ?? randomUUID();
  const hash = randomUUID().replaceAll("-", "").padEnd(64, "0");
  await client.query(`INSERT INTO "AdminAuditLog"
    ("id", "actorUserId", "action", "targetType", "targetId", "summary",
     "metadata", "previousHash", "entryHash", "createdAt")
    VALUES ($1,$2,$3,'PromptRefinerVnextOneShotStage',$4,$5,$6,$7,$8,
      $9::timestamptz AT TIME ZONE 'UTC')`,
  [id, owner, action, targetId, summary, JSON.stringify(metadata),
    prior?.entryHash ?? null, hash, createdAt]);
  return id;
}

const metadata = (row: typeof runtime[number], kind: "stage" | "run") => ({
  approvalKind: kind, ...base, runtimeDeploymentId: row.runtimeDeploymentId,
  runtimeCommitSha: row.runtimeCommitSha,
});
async function insertStage(client: Client, row: typeof runtime[number], auditId: string,
  slotCount = 80) {
  await client.query(`INSERT INTO "PromptRefinerVnextOneShotStage"
    ("id", "sourceCommitSha", "sourceManifestDigest", "runnerDigest",
     "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha", "pricePinDigest",
     "perRequestCostMicroUsd", "slotCount", "costCeilingMicroUsd", "approvedBy",
     "approvedAt", "stageApprovalAuditLogId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP,$13)`,
  [row.id, base.sourceCommitSha, base.sourceManifestDigest, base.runnerDigest,
    base.manifestRoot, row.runtimeDeploymentId, row.runtimeCommitSha,
    base.pricePinDigest, base.perRequestCostMicroUsd, base.slotCount,
    base.costCeilingMicroUsd, owner, auditId]);
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
    await client.query(`INSERT INTO "PromptRefinerVnextOneShotSlot"
      ("id", "stageId", "slotIndex", "reservedCostMicroUsd")
      VALUES ($1,$2,$3,29918)`,
    [row.id === V2 ? `one-shot-v2-${slotIndex}` :
      `synthetic-${row.id}-${slotIndex}`, row.id, slotIndex]);
  }
}
async function writeStageAudit(client: Client, row: typeof runtime[number], fixedId?: string) {
  return audit(client, "prompt_refiner.vnext_one_shot.stage_approved", row.id,
    "Approved the bounded Prompt Refiner vNext one-shot stage.",
    metadata(row, "stage"), fixedId);
}
async function supersede(client: Client, previous: typeof runtime[number],
  next: typeof runtime[number], stageAudit: string, runAudit?: string) {
  const previousStage = await client.query<{ stageApprovalAuditLogId: string }>(
    `SELECT "stageApprovalAuditLogId" FROM "PromptRefinerVnextOneShotStage"
     WHERE "id" = $1`, [previous.id]);
  const auditId = await audit(client, "prompt_refiner.vnext_one_shot.stage_superseded",
    previous.id, "Synthetic one-shot recovery close.", {
      replacementStageId: next.id,
      previousStageApprovalAuditLogId: previousStage.rows[0].stageApprovalAuditLogId,
      ...(runAudit ? { previousRunApprovalAuditLogId: runAudit } : {}),
      replacementStageApprovalAuditLogId: stageAudit,
    });
  await client.query(`UPDATE "PromptRefinerVnextOneShotStage"
    SET "status" = 'closed', "supersededAuditLogId" = $2 WHERE "id" = $1`,
  [previous.id, auditId]);
}

test("PG17 permits only atomic zero-consumption v2 to v3 recovery",
  { skip: !testUrl, timeout: 60_000 }, async () => {
    const url = new URL(testUrl!);
    const schema = url.searchParams.get("schema");
    assert.match(decodeURIComponent(url.pathname),
      /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i);
    assert.match(schema ?? "", /^chat01_b06_test_[a-z0-9]+$/);
    url.searchParams.delete("schema");
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE "AdminAuditLog" (
        "id" TEXT PRIMARY KEY, "actorUserId" TEXT, "actorEmail" TEXT,
        "action" TEXT NOT NULL, "targetType" TEXT NOT NULL, "targetId" TEXT,
        "summary" TEXT NOT NULL, "metadata" JSONB, "ipAddress" TEXT,
        "userAgent" TEXT, "previousHash" TEXT, "entryHash" TEXT UNIQUE,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      for (const folder of [
        "20260918090000_admin_audit_log_append_only",
        "20261002093000_prompt_refiner_vnext_one_shot_slots",
        "20261005140000_prompt_refiner_one_shot_unrun_replacement",
        "20261005210000_prompt_refiner_one_shot_run_approved_recovery",
      ]) {
        await client.query(await readFile(resolve(migrationRoot, folder, "migration.sql"), "utf8"));
      }
      await client.query("BEGIN");
      const v1Audit = await writeStageAudit(client, runtime[0]);
      await insertStage(client, runtime[0], v1Audit);
      await client.query("COMMIT");
      await client.query("BEGIN");
      const v2Audit = await writeStageAudit(client, runtime[1],
        "cmuuyx04a001d02qt3ald6khq");
      await supersede(client, runtime[0], runtime[1], v2Audit);
      await insertStage(client, runtime[1], v2Audit);
      await client.query("COMMIT");
      const runAudit = await audit(client, "prompt_refiner.vnext_one_shot.run_approved",
        V2, "Approved the bounded Prompt Refiner vNext one-shot run.",
        metadata(runtime[1], "run"), "cmuuz1ltu002002qtnct9lojp");
      await client.query(`UPDATE "PromptRefinerVnextOneShotStage"
        SET "status" = 'run_approved', "runApprovalAuditLogId" = $1
        WHERE "id" = $2`, [runAudit, V2]);

      await assert.rejects(client.query(`UPDATE "PromptRefinerVnextOneShotStage"
        SET "status" = 'closed' WHERE "id" = $1`, [V2]),
      /supersession audit/);
      await client.query("BEGIN");
      const badV3Audit = await writeStageAudit(client, runtime[2]);
      await supersede(client, runtime[1], runtime[2], badV3Audit, runAudit);
      await insertStage(client, runtime[2], badV3Audit, 79);
      await assert.rejects(client.query("COMMIT"), /80|reservation|complete/i);
      await client.query("ROLLBACK");
      const afterRollback = await client.query<{ status: string }>(
        `SELECT "status" FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1`, [V2]);
      assert.equal(afterRollback.rows[0].status, "run_approved");
      assert.equal((await client.query(`SELECT count(*)::int AS n
        FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1`, [V3])).rows[0].n, 0);

      await client.query("BEGIN");
      const v3Audit = await writeStageAudit(client, runtime[2]);
      await supersede(client, runtime[1], runtime[2], v3Audit, runAudit);
      await insertStage(client, runtime[2], v3Audit);
      await client.query("COMMIT");
      const stages = await client.query<{ id: string; status: string;
        runApprovalAuditLogId: string | null; n: number }>(
        `SELECT s."id", s."status", s."runApprovalAuditLogId",
          count(sl."id")::int AS n FROM "PromptRefinerVnextOneShotStage" s
          JOIN "PromptRefinerVnextOneShotSlot" sl ON sl."stageId" = s."id"
          GROUP BY s."id" ORDER BY s."id"`);
      assert.deepEqual(stages.rows.map((row) => [row.id, row.status, row.n]),
        [[V1, "closed", 80], [V2, "closed", 80], [V3, "staged", 80]]);
      assert.equal(stages.rows[1].runApprovalAuditLogId, runAudit);
      assert.equal((await client.query(`SELECT count(*)::int AS n
        FROM "PromptRefinerVnextOneShotSlot" WHERE "status" = 'consumed'`)).rows[0].n, 0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
