import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";

import { lockAndReadPromptRefinerVnextOneShotStage } from
  "../../lib/promptRefinerVnextOneShotStageReadback";

const migration = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations/20261002093000_prompt_refiner_vnext_one_shot_slots/migration.sql",
);
const rawUrl = process.env.TEST_DATABASE_URL?.trim();

test("vNext one-shot slots are exactly 80, priced and irreversible", { skip: !rawUrl }, async () => {
  if (!rawUrl) return;
  const url = new URL(rawUrl);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const schemaName = url.searchParams.get("schema") || "";
  assert.match(`${databaseName}_${schemaName}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  const schema = `chat01_vnext_slots_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: rawUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    // Isolated audit witness, not the product audit log or its writer.
    await client.query(`CREATE TABLE "AdminAuditLog" (
      "id" TEXT PRIMARY KEY, "actorUserId" TEXT, "action" TEXT NOT NULL,
      "summary" TEXT NOT NULL,
      "targetType" TEXT NOT NULL, "targetId" TEXT, "metadata" JSONB,
      "entryHash" TEXT, "createdAt" TIMESTAMP(3) NOT NULL
        DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')
    )`);
    await client.query(await readFile(migration, "utf8"));
    const stage = "prompt-refiner-vnext-one-shot-v1";
    const pins = {
      sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
      runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
      runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
      runtimeCommitSha: "e".repeat(40), pricePinDigest: "f".repeat(64),
      perRequestCostMicroUsd: 29918, slotCount: 80,
      costCeilingMicroUsd: 2393440,
    };
    const insertAudit = async (id: string, kind: "stage" | "run", options: {
      createdAt?: string; targetId?: string; actor?: string;
      action?: string; summary?: string; cost?: number;
      metadata?: Record<string, unknown>;
    } = {}) => client.query(`
      INSERT INTO "AdminAuditLog" (
        "id", "actorUserId", "action", "summary", "targetType", "targetId",
        "metadata", "entryHash", "createdAt"
      ) VALUES ($1, $2, $3, $4, 'PromptRefinerVnextOneShotStage', $5,
        $6::jsonb, $7, COALESCE($8::timestamp, clock_timestamp() AT TIME ZONE 'UTC'))
    `, [id, options.actor ?? "synthetic-owner",
      options.action ?? `prompt_refiner.vnext_one_shot.${kind}_approved`,
      options.summary ?? `Approved the bounded Prompt Refiner vNext one-shot ${kind}.`,
      options.targetId ?? stage,
      JSON.stringify(options.metadata ?? {
        approvalKind: kind, ...pins,
        perRequestCostMicroUsd: options.cost ?? pins.perRequestCostMicroUsd,
      }), "1".repeat(64), options.createdAt ?? null]);
    const createStage = (auditId = "stage-audit") => client.query(`
      INSERT INTO "PromptRefinerVnextOneShotStage" (
        "id", "sourceCommitSha", "sourceManifestDigest", "runnerDigest",
        "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", "perRequestCostMicroUsd", "slotCount",
        "costCeilingMicroUsd", "approvedBy", "approvedAt",
        "stageApprovalAuditLogId", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 29918, 80,
                2393440, 'synthetic-owner', '2099-01-01', $9, now())
    `, [stage, pins.sourceCommitSha, pins.sourceManifestDigest,
      pins.runnerDigest, pins.manifestRoot, pins.runtimeDeploymentId,
      pins.runtimeCommitSha, pins.pricePinDigest, auditId]);
    const createSlots = (lastIndex: number) => client.query(`
      INSERT INTO "PromptRefinerVnextOneShotSlot" (
        "id", "stageId", "slotIndex", "reservedCostMicroUsd"
      ) SELECT $1 || ':' || i::text, $1, i, 29918
        FROM generate_series(0, $2::integer) AS i
    `, [stage, lastIndex]);

    await insertAudit("wrong-cost-audit", "stage", { cost: 29919 });
    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotStage" (
        "id", "sourceCommitSha", "sourceManifestDigest", "runnerDigest",
        "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", "perRequestCostMicroUsd", "slotCount",
        "costCeilingMicroUsd", "approvedBy", "approvedAt",
        "stageApprovalAuditLogId", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 29919, 80,
                2393440, 'synthetic-owner', now(), 'wrong-cost-audit', now())
    `, [stage, "a".repeat(40), "b".repeat(64), "c".repeat(64),
      "d".repeat(64), "12345678-1234-1234-1234-123456789abc",
      "e".repeat(40), "f".repeat(64)]), /Stage_cost_check/);

    await insertAudit("partial-stage-audit", "stage");
    await insertAudit("wrong-summary-stage-audit", "stage", { summary: "Different stage approval." });
    await assert.rejects(createStage("wrong-summary-stage-audit"),
      /stage approval audit binding is invalid/);
    await client.query("BEGIN");
    try {
      await createStage("partial-stage-audit");
      await createSlots(78);
      await assert.rejects(client.query("COMMIT"), /exactly 80 reserved slots/);
    } finally {
      await client.query("ROLLBACK");
    }

    await insertAudit("stage-audit", "stage");
    await client.query("BEGIN");
    try {
      await createStage();
      await createSlots(79);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
    }
    const totals = await client.query(`
      SELECT count(*)::integer AS count,
             sum("reservedCostMicroUsd")::bigint AS micro_usd
        FROM "PromptRefinerVnextOneShotSlot" WHERE "stageId" = $1
    `, [stage]);
    assert.equal(totals.rows[0].count, 80);
    assert.equal(totals.rows[0].micro_usd, "2393440");
    const approvalClock = await client.query(`
      SELECT stage."approvedAt" = audit."createdAt" AS audit_owned
        FROM "PromptRefinerVnextOneShotStage" stage
        JOIN "AdminAuditLog" audit ON audit."id" = stage."stageApprovalAuditLogId"
       WHERE stage."id" = $1
    `, [stage]);
    assert.equal(approvalClock.rows[0].audit_owned, true);
    const contender = new pg.Client({ connectionString: rawUrl });
    await contender.connect();
    try {
      await contender.query(`SET search_path TO "${schema}"`);
      await client.query("BEGIN");
      await client.query(`
        SELECT "id" FROM "PromptRefinerVnextOneShotStage"
         WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT
      `, [stage]);
      await contender.query("BEGIN");
      // The v1 stage remains historical even while its row is locked.
      await contender.query("SET LOCAL lock_timeout = '500ms'");
      let unlockedReadCount = 0;
      const blockedReadbackTx = {
        async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          const sql = strings.reduce((query, part, index) =>
            query + part + (index < values.length ? `$${index + 1}` : ""), "");
          return (await contender.query(sql, values)).rows;
        },
        promptRefinerVnextOneShotStage: { async findUnique() {
          unlockedReadCount++;
          throw new Error("stage_read_without_lock");
        } },
        promptRefinerVnextOneShotSlot: { async findMany() {
          unlockedReadCount++;
          throw new Error("slots_read_without_lock");
        } },
      } as unknown as Parameters<typeof lockAndReadPromptRefinerVnextOneShotStage>[0];
      const activeReadback = await lockAndReadPromptRefinerVnextOneShotStage(
        blockedReadbackTx);
      assert.equal(activeReadback.stagePresent, false,
        "the historical v1 row cannot be selected as the active run stage");
      assert.equal(unlockedReadCount, 0);
      await contender.query("ROLLBACK");
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout = '200ms'");
      await assert.rejects(contender.query(`
        UPDATE "PromptRefinerVnextOneShotSlot"
           SET "status" = 'consumed', "requestId" = 'lock-test-request',
               "consumedAt" = NULL WHERE "stageId" = $1 AND "slotIndex" = 0
      `, [stage]), /lock timeout/);
      await contender.query("ROLLBACK");
      await client.query("ROLLBACK");
      await assert.rejects(contender.query(`
        UPDATE "PromptRefinerVnextOneShotSlot"
           SET "status" = 'consumed', "requestId" = 'lock-test-request',
               "consumedAt" = NULL WHERE "stageId" = $1 AND "slotIndex" = 0
      `, [stage]), /run approval is required/);
    } finally {
      await contender.query("ROLLBACK");
      await client.query("ROLLBACK");
      await contender.end();
    }
    await insertAudit("past-stage-audit", "stage", { createdAt: "2020-01-01" });
    await assert.rejects(createStage("past-stage-audit"),
      /stage approval audit is stale/);
    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotSlot"
        ("id", "stageId", "slotIndex", "reservedCostMicroUsd")
      VALUES ('duplicate-index', $1, 1, 29918)
    `, [stage]), /PromptRefinerVnextOneShotSlot_stageId_slotIndex_key/);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'closed', "runApprovalAuditLogId" = 'stage-audit'
       WHERE "id" = $1
    `, [stage]), /stage transition is not permitted/);
    await client.query("BEGIN");
    try {
      await client.query(`
        UPDATE "PromptRefinerVnextOneShotStage"
           SET "status" = 'closed' WHERE "id" = $1
      `, [stage]);
      const stagedClose = await client.query(`
        SELECT "status" FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
      `, [stage]);
      assert.equal(stagedClose.rows[0].status, "closed");
      await assert.rejects(client.query(`
        INSERT INTO "PromptRefinerVnextOneShotSlot"
          ("id", "stageId", "slotIndex", "reservedCostMicroUsd")
        VALUES ('closed-stage-slot', $1, 1, 29918)
      `, [stage]), /stage must be staged for slot allocation/);
    } finally {
      await client.query("ROLLBACK");
    }
    await insertAudit("future-audit", "stage", { createdAt: "2099-01-01" });
    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotStage" (
        "id", "sourceCommitSha", "sourceManifestDigest", "runnerDigest",
        "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", "perRequestCostMicroUsd", "slotCount",
        "costCeilingMicroUsd", "approvedBy", "approvedAt",
        "stageApprovalAuditLogId", "updatedAt"
      ) SELECT $1, "sourceCommitSha", "sourceManifestDigest",
        "runnerDigest", "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", 29918, 80, 2393440, "approvedBy", now(),
        'future-audit', now()
        FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
    `, [stage]), /stage approval audit is stale/);
    await insertAudit("unrelated-stage-audit", "stage", {
      action: "unrelated.action",
    });
    await assert.rejects(createStage("unrelated-stage-audit"),
      /stage approval audit binding is invalid/);
    await insertAudit("second-audit", "stage", { targetId: "second-stage" });
    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotStage" (
        "id", "sourceCommitSha", "sourceManifestDigest", "runnerDigest",
        "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", "perRequestCostMicroUsd", "slotCount",
        "costCeilingMicroUsd", "approvedBy", "approvedAt",
        "stageApprovalAuditLogId", "updatedAt"
      ) SELECT 'second-stage', "sourceCommitSha", "sourceManifestDigest",
        "runnerDigest", "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", 29918, 80, 2393440, "approvedBy", now(),
        'second-audit', now()
        FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
    `, [stage]), /Stage_id_check/);
    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotSlot"
        ("id", "stageId", "slotIndex", "reservedCostMicroUsd")
      VALUES ($1, $2, 80, 29918)
    `, [`${stage}:80`, stage]), /Slot_index_check/);

    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotStage" (
        "id", "status", "sourceCommitSha", "sourceManifestDigest",
        "runnerDigest", "manifestRoot", "runtimeDeploymentId",
        "runtimeCommitSha", "pricePinDigest", "perRequestCostMicroUsd",
        "slotCount", "costCeilingMicroUsd", "approvedBy", "approvedAt",
        "stageApprovalAuditLogId", "runApprovalAuditLogId", "updatedAt"
      ) SELECT $1, 'run_approved', "sourceCommitSha",
        "sourceManifestDigest", "runnerDigest", "manifestRoot",
        "runtimeDeploymentId", "runtimeCommitSha", "pricePinDigest",
        29918, 80, 2393440, "approvedBy", now(),
        'premature-stage-audit', 'premature-run-audit', now()
        FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
    `, [stage]), /stage must start staged/);
    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotStage" (
        "id", "sourceCommitSha", "sourceManifestDigest", "runnerDigest",
        "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", "perRequestCostMicroUsd", "slotCount",
        "costCeilingMicroUsd", "approvedBy", "approvedAt",
        "stageApprovalAuditLogId", "updatedAt"
      ) SELECT $1, "sourceCommitSha", "sourceManifestDigest",
        "runnerDigest", "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha",
        "pricePinDigest", 29918, 80, 2393440, "approvedBy", now(),
        'missing-audit', now()
        FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
    `, [stage]), /stage approval audit is missing/);
    await assert.rejects(client.query(`
      INSERT INTO "PromptRefinerVnextOneShotSlot"
        ("id", "stageId", "slotIndex", "status", "reservedCostMicroUsd", "requestId", "consumedAt")
      VALUES ('forged-consumed', $1, 0, 'consumed', 29918, 'forged-request', now())
    `, [stage]), /slot must start reserved/);

    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "sourceCommitSha" = $1 WHERE "id" = $2
    `, ["0".repeat(40), stage]), /stage transition is not permitted/);
    await assert.rejects(client.query(`
      DELETE FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
    `, [stage]), /stage cannot be deleted/);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotSlot"
         SET "status" = 'consumed', "requestId" = 'request-0',
             "consumedAt" = NULL WHERE "stageId" = $1 AND "slotIndex" = 0
    `, [stage]), /run approval is required/);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved', "runApprovalAuditLogId" = 'missing-audit',
             "updatedAt" = now() WHERE "id" = $1
    `, [stage]), /run approval audit is missing/);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved', "runApprovalAuditLogId" = 'stage-audit',
             "updatedAt" = now() WHERE "id" = $1
    `, [stage]), /requires a distinct audit/);
    await insertAudit("ancient-run-audit", "run", { createdAt: "2020-01-01" });
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'ancient-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval audit is stale/);
    await insertAudit("future-run-audit", "run", { createdAt: "2099-01-01" });
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'future-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval audit is stale/);
    await insertAudit("unrelated-run-audit", "run", {
      action: "unrelated.action",
    });
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'unrelated-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval audit binding is invalid/);
    await insertAudit("wrong-root-run-audit", "run", {
      metadata: { approvalKind: "run", ...pins, manifestRoot: "0".repeat(64) },
    });
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'wrong-root-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval audit binding is invalid/);
    await insertAudit("wrong-actor-run-audit", "run", { actor: "other-owner" });
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'wrong-actor-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval audit binding is invalid/);
    await insertAudit("wrong-summary-run-audit", "run", { summary: "Different run approval." });
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'wrong-summary-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval audit binding is invalid/);
    await insertAudit("early-run-audit", "run");
    await client.query(`
      UPDATE "AdminAuditLog"
         SET "createdAt" = (
           SELECT "approvedAt" - INTERVAL '1 millisecond'
             FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
         ) WHERE "id" = 'early-run-audit'
    `, [stage]);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'early-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval must follow stage approval/);
    await insertAudit("same-millisecond-run-audit", "run");
    await client.query(`
      UPDATE "AdminAuditLog"
         SET "createdAt" = (
           SELECT "approvedAt" FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
         ) WHERE "id" = 'same-millisecond-run-audit'
    `, [stage]);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'same-millisecond-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval must follow stage approval/);
    // A caller-owned temporary audit table must not authorize this stage.
    await client.query(`CREATE TEMP TABLE "AdminAuditLog"
      (LIKE "${schema}"."AdminAuditLog" INCLUDING DEFAULTS)`);
    await insertAudit("forged-run-audit", "run");
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved',
             "runApprovalAuditLogId" = 'forged-run-audit'
       WHERE "id" = $1
    `, [stage]), /run approval audit is missing/);
    await client.query(`DROP TABLE pg_temp."AdminAuditLog"`);
    await insertAudit("run-audit", "run");
    await client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved', "runApprovalAuditLogId" = 'run-audit',
             "updatedAt" = '2099-01-01' WHERE "id" = $1
    `, [stage]);
    const stageClock = await client.query(`
      SELECT "updatedAt" < '2099-01-01'::timestamp AS database_owned
        FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
    `, [stage]);
    assert.equal(stageClock.rows[0].database_owned, true);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotSlot"
         SET "status" = 'consumed', "requestId" = 'spoofed-time',
             "consumedAt" = '2099-01-01' WHERE "stageId" = $1 AND "slotIndex" = 2
    `, [stage]), /consumption timestamp is database-owned/);
    const closer = new pg.Client({ connectionString: rawUrl });
    await closer.connect();
    try {
      await closer.query(`SET search_path TO "${schema}"`);
      await client.query("BEGIN");
      await client.query(`
        UPDATE "PromptRefinerVnextOneShotSlot"
           SET "status" = 'consumed', "requestId" = 'request-0',
               "consumedAt" = NULL WHERE "stageId" = $1 AND "slotIndex" = 0
      `, [stage]);
      await closer.query("BEGIN");
      await closer.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(closer.query(`
        UPDATE "PromptRefinerVnextOneShotStage"
           SET "status" = 'closed', "updatedAt" = now() WHERE "id" = $1
      `, [stage]), /canceling statement due to lock timeout/);
      await closer.query("ROLLBACK");
      await client.query("COMMIT");
    } finally {
      await closer.query("ROLLBACK");
      await client.query("ROLLBACK");
      await closer.end();
    }
    const slotClock = await client.query(`
      SELECT "consumedAt" IS NOT NULL AND
             "consumedAt" <= clock_timestamp() AT TIME ZONE 'UTC' AS database_owned
        FROM "PromptRefinerVnextOneShotSlot"
       WHERE "stageId" = $1 AND "slotIndex" = 0
    `, [stage]);
    assert.equal(slotClock.rows[0].database_owned, true);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotSlot"
         SET "status" = 'consumed', "requestId" = 'request-0',
             "consumedAt" = NULL WHERE "stageId" = $1 AND "slotIndex" = 1
    `, [stage]), /Slot_requestId_key/);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotSlot"
         SET "status" = 'reserved', "requestId" = NULL,
             "consumedAt" = NULL WHERE "stageId" = $1 AND "slotIndex" = 0
    `, [stage]), /slot transition is not permitted/);
    await assert.rejects(client.query(`
      DELETE FROM "PromptRefinerVnextOneShotSlot"
       WHERE "stageId" = $1 AND "slotIndex" = 0
    `, [stage]), /slots cannot be deleted/);
    await client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'closed' WHERE "id" = $1
    `, [stage]);
    const runApprovedClose = await client.query(`
      SELECT "status" FROM "PromptRefinerVnextOneShotStage" WHERE "id" = $1
    `, [stage]);
    assert.equal(runApprovedClose.rows[0].status, "closed");
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotStage"
         SET "status" = 'run_approved' WHERE "id" = $1
    `, [stage]), /stage transition is not permitted/);
    await assert.rejects(client.query(`
      UPDATE "PromptRefinerVnextOneShotSlot"
         SET "status" = 'consumed', "requestId" = 'after-close',
             "consumedAt" = NULL WHERE "stageId" = $1 AND "slotIndex" = 1
    `, [stage]), /run approval is required/);
    await assert.rejects(client.query(`
      TRUNCATE TABLE "PromptRefinerVnextOneShotSlot"
    `), /stage and slots cannot be truncated/);
    await assert.rejects(client.query(`
      TRUNCATE TABLE "PromptRefinerVnextOneShotStage" CASCADE
    `), /stage and slots cannot be truncated/);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
