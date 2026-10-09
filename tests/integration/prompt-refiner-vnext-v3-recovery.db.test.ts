import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Session } from "next-auth";
import { computeAdminAuditEntryHash } from "@/lib/adminAuditIntegrityCore";
import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";
import { prisma } from "@/lib/prisma";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import { createPromptRefinerVnextOneShotStageWithSlots } from
  "@/lib/promptRefinerVnextOneShotStageWriter";
import { createPromptRefinerVnextOneShotV4Stage } from
  "@/lib/promptRefinerVnextOneShotV4StageWriter";
import { createPromptRefinerVnextOneShotV5Stage } from
  "@/lib/promptRefinerVnextOneShotV5StageWriter";
import { recordPromptRefinerVnextOneShotPreregistration } from
  "@/lib/promptRefinerVnextOneShotPreregistration";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { approvePromptRefinerVnextOneShotPaidDispatch,
  readPromptRefinerVnextOneShotPaidAuthorization } from
  "@/lib/promptRefinerVnextOneShotPaidAuthorization";
import { consumePromptRefinerVnextOneShotSlot } from
  "@/lib/promptRefinerVnextOneShotSlotConsumption";
import { readPromptRefinerVnextOneShotUnknownStop,
  stopPromptRefinerVnextOneShotUnknown } from
  "@/lib/promptRefinerVnextOneShotOutcomeRecovery";
import { approvePromptRefinerVnextOneShotRun } from
  "@/lib/promptRefinerVnextOneShotRunApproval";
import { readPromptRefinerVnextOneShotOperationalShadow,
  recordPromptRefinerVnextOneShotOperationalShadow,
  promptRefinerVnextOneShotShadowTarget } from
  "@/lib/promptRefinerVnextOneShotOperationalShadow";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  promptRefinerVnextOneShotShadowPublicKeyDigest,
  signPromptRefinerVnextOneShotShadowProof } from
  "@/lib/promptRefinerVnextOneShotShadowProof";
import { POST as consumeSlotRoute } from
  "@/app/api/internal/prompt-refiner/vnext-one-shot-slot/route";
import { POST as recordTerminalRoute } from
  "@/app/api/internal/prompt-refiner/vnext-one-shot-terminal/route";
import { guardPromptRefinerVnextBilledUsage,
  PROMPT_REFINER_VNEXT_PRICE_PIN } from
  "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { assertPromptRefinerVnextOneShotTerminalsComplete,
  readPromptRefinerVnextOneShotTerminalReceipts } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const migrationRoot = resolve(fileURLToPath(new URL("../../prisma/migrations/", import.meta.url)));
const V1 = "prompt-refiner-vnext-one-shot-v1";
const V2 = "prompt-refiner-vnext-one-shot-v2";
const V3 = "prompt-refiner-vnext-one-shot-v3";
const V4 = "prompt-refiner-vnext-one-shot-v4";
const V5 = "prompt-refiner-vnext-one-shot-v5";
const owner = "synthetic-owner";
const auditKey = "synthetic-chat01-b06-audit-integrity-key";
const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const manifestDigest = createHash("sha256").update(readFileSync(resolve(projectRoot,
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-candidate-source.json")))
  .digest("hex");
const base = {
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: manifestDigest,
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
  perRequestCostMicroUsd: 29918,
  slotCount: 80, costCeilingMicroUsd: 2393440,
};
const runtime = [
  { id: V1, runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
    runtimeCommitSha: "1".repeat(40) },
  { id: V2, runtimeDeploymentId: "3565f671-c168-4d3d-8573-8e79126e1c63",
    runtimeCommitSha: "291e6d07f284e6333c34a3061dd94da77752aad9" },
  { id: V3, runtimeDeploymentId: "5e2245d9-17a8-46fe-b967-1ebd86806649",
    runtimeCommitSha: "73e60ebd79869f16d82d914103122a0c3eaf0ad7" },
  { id: V4, runtimeDeploymentId: "35787baf-2329-4002-b837-182ae9f51d13",
    runtimeCommitSha: "e3ecfcdc5eee9cbce8f79fda39eb76a87c445819" },
];
type Client = pg.Client;
async function audit(client: Client, action: string, targetId: string,
  summary: string, metadata: unknown, fixedId?: string) {
  const head = await client.query<{ entryHash: string; createdAtEpochMs: string }>(
    `SELECT "entryHash",
       (EXTRACT(EPOCH FROM "createdAt" AT TIME ZONE 'UTC') * 1000)::text
         AS "createdAtEpochMs" FROM "AdminAuditLog"
     WHERE "entryHash" IS NOT NULL ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`);
  const prior = head.rows[0];
  const createdAt = new Date(Math.max(Date.now(),
    Math.ceil(Number(prior?.createdAtEpochMs ?? 0) + 2)));
  const id = fixedId ?? randomUUID();
  const hash = computeAdminAuditEntryHash({
    previousHash: prior?.entryHash ?? null, actorUserId: owner,
    actorEmail: null, action, targetType: "PromptRefinerVnextOneShotStage",
    targetId, summary, metadata, ipAddress: null, userAgent: null,
    createdAt: createdAt.toISOString(),
  }, auditKey);
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

test("PG17 permits atomic zero-consumption v2 to v4 recovery and terminal receipts",
  { skip: !testUrl, timeout: 120_000 }, async () => {
    assert.equal(process.env.DATABASE_URL, testUrl);
    const url = new URL(testUrl!);
    const schema = url.searchParams.get("schema");
    assert.match(decodeURIComponent(url.pathname),
      /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i);
    assert.match(schema ?? "", /^chat01_b06_test_[a-z0-9]+$/);
    url.searchParams.delete("schema");
    const client = new pg.Client({ connectionString: url.toString() });
    const priorKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    const environmentNames = ["APP_ENV", "RAILWAY_ENVIRONMENT_NAME",
      "RAILWAY_DEPLOYMENT_ID", "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_PROJECT_ID",
      "RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_API_TOKEN",
      "PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT",
      "PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST",
      "PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_B64",
      "PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST",
      "PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED",
      "PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED",
      "PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN"] as const;
    const priorEnvironment = Object.fromEntries(environmentNames.map((name) =>
      [name, process.env[name]]));
    const priorFetch = globalThis.fetch;
    process.env.ADMIN_AUDIT_INTEGRITY_KEY = auditKey;
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
        "20261006151000_prompt_refiner_one_shot_terminal_recovery",
        "20261006160000_prompt_refiner_one_shot_post_unknown_v5",
      ]) {
        await client.query(await readFileAsync(resolve(migrationRoot, folder, "migration.sql"), "utf8"));
      }
      await client.query(`CREATE TABLE "ModelRegistryEntry" (
        "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "apiModel" TEXT NOT NULL,
        "provider" TEXT NOT NULL, "apiBaseUrl" TEXT NOT NULL,
        "apiKeyEnvName" TEXT NOT NULL, "icon" TEXT NOT NULL DEFAULT '',
        "bestFor" TEXT NOT NULL DEFAULT '', "minimumPlan" TEXT NOT NULL,
        "usageClass" TEXT NOT NULL, "creditWeight" INTEGER NOT NULL,
        "publiclyListed" BOOLEAN NOT NULL DEFAULT true,
        "enabled" BOOLEAN NOT NULL DEFAULT true, "status" TEXT NOT NULL DEFAULT 'enabled',
        "operationalReason" TEXT, "userVisibleNote" TEXT, "replacementModelId" TEXT,
        "catalogDeleted" BOOLEAN NOT NULL DEFAULT false, "reasoning" TEXT,
        "contextWindowTokens" INTEGER, "supportsImage" BOOLEAN NOT NULL DEFAULT false,
        "supportsNativePdf" BOOLEAN NOT NULL DEFAULT false,
        "webSearchOverride" TEXT, "maxImages" INTEGER,
        "maxBase64ImagePayloadBytes" INTEGER,
        "maxOutputTokens" INTEGER, "reservationOutputTokens" INTEGER,
        "inputUsdPerMillionTokens" DOUBLE PRECISION,
        "outputUsdPerMillionTokens" DOUBLE PRECISION,
        "cachedInputPriceMultiplier" DOUBLE PRECISION,
        "sortOrder" INTEGER NOT NULL DEFAULT 0, "updatedById" TEXT,
        "updatedByEmail" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      const pinnedModel = staticModelRegistrySeedRows().find((row) =>
        row.id === "gpt-5-6-luna");
      assert.ok(pinnedModel);
      await prisma.modelRegistryEntry.create({ data: pinnedModel });
      const session = { user: { id: owner, email: "owner@example.test" },
        expires: "2099-01-01T00:00:00.000Z" } as Session;
      const request = new Request("https://example.test/stage", {
        method: "POST", headers: { "user-agent": "b06-synthetic-integration" },
      });
      process.env.RAILWAY_GIT_COMMIT_SHA = base.sourceCommitSha;
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = base.runnerDigest;
      await recordPromptRefinerVnextOneShotPreregistration({
        session, request, pins: base,
      });
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
      for (const action of [
        "prompt_refiner.vnext_one_shot.operational_shadow_completed",
        "prompt_refiner.vnext_one_shot.outcome_unknown",
        "prompt_refiner.vnext_one_shot.gate_evaluated",
        "prompt_refiner.vnext_one_shot.disposition_recorded",
        "prompt_refiner.vnext_one_shot.paid_dispatch_authorized",
      ]) {
        await client.query("BEGIN");
        const replacementAudit = await writeStageAudit(client, runtime[2]);
        await supersede(client, runtime[1], runtime[2], replacementAudit, runAudit);
        await audit(client, action, V2, "Synthetic forbidden historical evidence.", {});
        await assert.rejects(insertStage(client, runtime[2], replacementAudit),
          /forbidden historical evidence/,
          `${action} must prevent the v3 recovery in PostgreSQL`);
        await client.query("ROLLBACK");
      }
      await client.query("BEGIN");
      let replacementAudit = await writeStageAudit(client, runtime[2]);
      await supersede(client, runtime[1], runtime[2], replacementAudit, runAudit);
      await client.query(`INSERT INTO "AdminAuditLog"
        ("id", "actorUserId", "action", "targetType", "targetId", "summary")
        VALUES ($1,$2,'prompt_refiner.vnext_one_shot.slot_consumed',
          'PromptRefinerVnextOneShotSlot','one-shot-v2-0',
          'Synthetic forbidden historical slot audit.')`, [randomUUID(), owner]);
      await assert.rejects(insertStage(client, runtime[2], replacementAudit),
        /forbidden historical evidence/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query(`UPDATE "PromptRefinerVnextOneShotSlot"
        SET "status" = 'consumed', "requestId" = $1
        WHERE "stageId" = $2 AND "slotIndex" = 0`, [randomUUID(), V2]);
      replacementAudit = await writeStageAudit(client, runtime[2]);
      await supersede(client, runtime[1], runtime[2], replacementAudit, runAudit);
      await assert.rejects(insertStage(client, runtime[2], replacementAudit),
        /untouched historical slots/);
      await client.query("ROLLBACK");
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

      const legacyReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, V2));
      assert.equal(legacyReadback.approvalAuditsValid, true);
      const binding = { id: V3, ...base,
        perRequestCostMicroUsd: BigInt(base.perRequestCostMicroUsd),
        costCeilingMicroUsd: BigInt(base.costCeilingMicroUsd),
        runtimeDeploymentId: runtime[2].runtimeDeploymentId,
        runtimeCommitSha: runtime[2].runtimeCommitSha,
      };
      const competing = await Promise.allSettled([
        createPromptRefinerVnextOneShotStageWithSlots({ session, request, binding }),
        createPromptRefinerVnextOneShotStageWithSlots({ session, request, binding }),
      ]);
      assert.equal(competing.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(competing.filter((outcome) => outcome.status === "rejected").length, 1);
      const winner = competing.find((outcome) => outcome.status === "fulfilled");
      assert.ok(winner && winner.status === "fulfilled");
      assert.equal(winner.value.stageId, V3);
      assert.equal(winner.value.slotCount, 80);
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding,
      }));
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, V3))).approvalAuditsValid, true);

      // Historical B06 evidence is synthetic but hash chained. The recovery
      // code must validate it before a different deployment can stage v4.
      const v3RunAudit = await audit(client, "prompt_refiner.vnext_one_shot.run_approved",
        V3, "Approved the bounded Prompt Refiner vNext one-shot run.",
        metadata(runtime[2], "run"));
      await client.query(`UPDATE "PromptRefinerVnextOneShotStage"
        SET "status" = 'run_approved', "runApprovalAuditLogId" = $1
        WHERE "id" = $2`, [v3RunAudit, V3]);
      const v4Binding = { ...binding, id: V4, runnerDigest: "e".repeat(64),
        runtimeDeploymentId: runtime[3].runtimeDeploymentId,
        runtimeCommitSha: runtime[3].runtimeCommitSha };
      const auditCountBeforeShadow = await prisma.adminAuditLog.count();
      await assert.rejects(createPromptRefinerVnextOneShotV4Stage({
        session, request, binding: v4Binding,
      }), /shadow_unavailable/);
      assert.equal(await prisma.adminAuditLog.count(), auditCountBeforeShadow,
        "a refused v4 stage must roll back its approval audit");
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V3 },
      })).status, "run_approved");
      const historicalSigner = generateKeyPairSync("ed25519").publicKey.export({
        format: "der", type: "spki",
      }).toString("base64");
      const historicalStage = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V3 },
      });
      const historicalShadowAudit = await audit(client,
        "prompt_refiner.vnext_one_shot.operational_shadow_completed", V3,
        "Verified the one-shot stage, run, audit and 80 reserved slots without dispatch.", {
          version: "prompt-refiner-vnext-one-shot-operational-shadow-v2",
          stageApprovalAuditLogId: historicalStage.stageApprovalAuditLogId,
          runApprovalAuditLogId: v3RunAudit,
          sourceCommitSha: base.sourceCommitSha,
          sourceManifestDigest: base.sourceManifestDigest,
          runnerDigest: base.runnerDigest,
          runtimeDeploymentId: runtime[2].runtimeDeploymentId,
          runtimeCommitSha: runtime[2].runtimeCommitSha,
          pricePinDigest: base.pricePinDigest,
          perRequestCostMicroUsd: base.perRequestCostMicroUsd,
          slotCount: 80, reservedSlots: 80, consumedSlots: 0,
          costCeilingMicroUsd: base.costCeilingMicroUsd,
          runnerPreflightDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
          cacheWriteInputTokens: 0, providerCalls: 0, slotConsumeCalls: 0,
          signedAt: new Date().toISOString(),
          signerPublicKeyDigest:
            promptRefinerVnextOneShotShadowPublicKeyDigest(historicalSigner),
        });
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotOperationalShadow(tx, historicalStage)))
        .shadowAuditLogId, historicalShadowAudit);
      const v4AuditCount = await prisma.adminAuditLog.count();
      for (const drift of [
        { runnerDigest: binding.runnerDigest },
        { runtimeDeploymentId: runtime[2].runtimeDeploymentId },
        { runtimeCommitSha: runtime[2].runtimeCommitSha },
      ]) {
        await assert.rejects(createPromptRefinerVnextOneShotV4Stage({
          session, request, binding: { ...v4Binding, ...drift },
        }), /source_not_replaceable/);
        assert.equal(await prisma.adminAuditLog.count(), v4AuditCount,
          "a rejected v4 binding must not leave an approval audit");
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: V3 },
        })).status, "run_approved");
      }
      const v4Competing = await Promise.allSettled([1, 2].map(() =>
        createPromptRefinerVnextOneShotV4Stage({
          session, request, binding: v4Binding,
        })));
      assert.equal(v4Competing.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(v4Competing.filter((outcome) => outcome.status === "rejected").length, 1);
      const v4Success = v4Competing.find((outcome) => outcome.status === "fulfilled");
      assert.ok(v4Success && v4Success.status === "fulfilled");
      const v4Winner = v4Success.value;
      assert.equal(v4Winner.stageId, V4);
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.stage_approved", targetId: V4,
      } }), 1);
      const closedHistoricalStage = await prisma.promptRefinerVnextOneShotStage
        .findUniqueOrThrow({ where: { id: V3 } });
      assert.ok(closedHistoricalStage.supersededAuditLogId);
      assert.deepEqual({ ...closedHistoricalStage, status: "run_approved",
        supersededAuditLogId: null, updatedAt: historicalStage.updatedAt },
      historicalStage, "v4 may only close and link the historical stage");
      const historicalSlots = await prisma.promptRefinerVnextOneShotSlot.findMany({
        where: { stageId: V3 }, orderBy: { slotIndex: "asc" },
      });
      assert.equal(historicalSlots.length, 80);
      assert.ok(historicalSlots.every((slot, index) =>
        slot.id === `one-shot-v3-${index}` && slot.slotIndex === index &&
        slot.status === "reserved" && slot.requestId === null &&
        slot.consumedAt === null && slot.reservedCostMicroUsd === BigInt(29918)));
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotOperationalShadow(tx, closedHistoricalStage)))
        .shadowAuditLogId, historicalShadowAudit);
      await assert.rejects(createPromptRefinerVnextOneShotV4Stage({
        session, request, binding: v4Binding,
      }), /source_not_replaceable|source_unavailable/);
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, V4))).approvalAuditsValid, true);

      // Exercise the real app run, signed shadow and slot route against the
      // migrated database. Fetch observes only a synthetic Railway response.
      process.env.APP_ENV = "staging";
      process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
      process.env.RAILWAY_DEPLOYMENT_ID = runtime[3].runtimeDeploymentId;
      process.env.RAILWAY_GIT_COMMIT_SHA = runtime[3].runtimeCommitSha;
      process.env.RAILWAY_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
      process.env.RAILWAY_SERVICE_ID = "55555555-5555-4555-8555-555555555555";
      process.env.RAILWAY_ENVIRONMENT_ID = "66666666-6666-4666-8666-666666666666";
      process.env.RAILWAY_API_TOKEN = "synthetic-railway-read-token";
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = base.manifestRoot;
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = v4Binding.runnerDigest;
      let activeDeploymentId = runtime[3].runtimeDeploymentId;
      globalThis.fetch = async () => Response.json({ data: {
        deployment: { id: runtime[3].runtimeDeploymentId, status: "SUCCESS",
          meta: { commitHash: runtime[3].runtimeCommitSha } },
        deployments: { edges: [{ node: {
          id: activeDeploymentId, status: "SUCCESS",
        } }] },
      } });
      const expectedRun = { ...v4Binding,
        stageApprovalAuditLogId: v4Winner.stageApprovalAuditLogId };
      await assert.rejects(approvePromptRefinerVnextOneShotRun({
        session, request, expected: { ...expectedRun,
          manifestRoot: "f".repeat(64) },
      }), /run_binding_mismatch/);
      activeDeploymentId = "77777777-7777-4777-8777-777777777777";
      await assert.rejects(approvePromptRefinerVnextOneShotRun({
        session, request, expected: expectedRun,
      }), /active_deployment_unverified/);
      activeDeploymentId = runtime[3].runtimeDeploymentId;
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: 0.01 } });
      await assert.rejects(approvePromptRefinerVnextOneShotRun({
        session, request, expected: expectedRun,
      }), /price_mismatch/);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: null } });
      await client.query(`CREATE FUNCTION reject_b06_run_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW."action" = 'prompt_refiner.vnext_one_shot.run_approved' THEN
            RAISE EXCEPTION 'synthetic run audit failure';
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER reject_b06_run_audit_trigger BEFORE INSERT
        ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION reject_b06_run_audit()`);
      await assert.rejects(approvePromptRefinerVnextOneShotRun({
        session, request, expected: expectedRun,
      }), /synthetic run audit failure/);
      await client.query(`DROP TRIGGER reject_b06_run_audit_trigger ON "AdminAuditLog"`);
      await client.query(`DROP FUNCTION reject_b06_run_audit()`);
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V4 },
      })).status, "staged", "failed run audit must roll back run approval");
      const run = await approvePromptRefinerVnextOneShotRun({
        session, request, expected: expectedRun,
      });
      assert.equal(run.dispatchAuthorized, false);
      const runnerToken = "synthetic-b06-runner-token-12345678901234567890";
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = runnerToken;
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = "1";
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED = "1";
      const slotRequest = (slotIndex = 0) => new Request(
        "https://example.test/api/internal/prompt-refiner/vnext-one-shot-slot", {
          method: "POST", headers: { authorization: `Bearer ${runnerToken}`,
            "content-type": "application/json" },
          body: JSON.stringify({ requestId: randomUUID(), slotIndex,
            runApprovalAuditLogId: run.runApprovalAuditLogId,
            manifestRoot: base.manifestRoot, runnerDigest: v4Binding.runnerDigest }),
        });
      assert.equal((await consumeSlotRoute(slotRequest())).status, 409,
        "the real route must refuse when no shadow audit exists");
      const keys = generateKeyPairSync("ed25519");
      const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" })
        .toString("base64");
      const publicKey = keys.publicKey.export({ format: "der", type: "spki" })
        .toString("base64");
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_B64 = publicKey;
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST =
        promptRefinerVnextOneShotShadowPublicKeyDigest(publicKey);
      const stage = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V4 },
      });
      const target = promptRefinerVnextOneShotShadowTarget(stage);
      assert.ok(target);
      const proof = signPromptRefinerVnextOneShotShadowProof({
        version: "prompt-refiner-vnext-one-shot-shadow-proof-v1",
        ...target, manifestRoot: base.manifestRoot,
        runnerPreflightDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
        cacheWriteInputTokens: 0, providerCalls: 0, slotConsumeCalls: 0,
        signedAt: new Date().toISOString(),
      }, privateKey);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: 0.01 } });
      await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow({
        session, request, proof,
      }), /price_mismatch/);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: null } });
      const shadow = await recordPromptRefinerVnextOneShotOperationalShadow({
        session, request, proof,
      });
      assert.equal(shadow.dispatchAuthorized, false);
      const evidence = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotOperationalShadow(tx, stage));
      assert.equal(evidence.valid, true);
      assert.equal(evidence.cacheWriteInputTokens, 0);
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 0,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /vnext_one_shot_paid_authorization_unavailable/);
      assert.equal((await consumeSlotRoute(slotRequest())).status, 409,
        "a valid signed shadow still cannot replace the missing paid audit");
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.slot_consumed",
      } }), 0);
      const stages = await client.query<{ id: string; status: string;
        runApprovalAuditLogId: string | null; n: number }>(
        `SELECT s."id", s."status", s."runApprovalAuditLogId",
          count(sl."id")::int AS n FROM "PromptRefinerVnextOneShotStage" s
          JOIN "PromptRefinerVnextOneShotSlot" sl ON sl."stageId" = s."id"
          GROUP BY s."id" ORDER BY s."id"`);
      assert.deepEqual(stages.rows.map((row) => [row.id, row.status, row.n]),
        [[V1, "closed", 80], [V2, "closed", 80], [V3, "closed", 80], [V4, "run_approved", 80]]);
      assert.equal(stages.rows[1].runApprovalAuditLogId, runAudit);
      assert.equal((await client.query(`SELECT count(*)::int AS n
        FROM "PromptRefinerVnextOneShotSlot" WHERE "status" = 'consumed'`)).rows[0].n, 0);
      await assert.rejects(client.query(`UPDATE "PromptRefinerVnextOneShotSlot"
        SET "status" = 'consumed', "requestId" = $1
        WHERE "stageId" = $2 AND "slotIndex" = 0`, [randomUUID(), V2]),
      /one-shot run approval is required before consumption/);
      assert.equal((await client.query(`SELECT count(*)::int AS n
        FROM "PromptRefinerVnextOneShotSlot"
        WHERE "stageId" = $1 AND "status" = 'consumed'`, [V2])).rows[0].n, 0);

      // A separate, synthetic future paid authorization proves the guarded
      // route is capable of consuming only after a distinct audited approval.
      // No provider transport is configured or called in this fixture.
      const expectedPaid = {
        stageApprovalAuditLogId: v4Winner.stageApprovalAuditLogId,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
        shadowAuditLogId: shadow.shadowAuditLogId,
        sourceCommitSha: v4Binding.sourceCommitSha,
        sourceManifestDigest: v4Binding.sourceManifestDigest,
        runnerDigest: v4Binding.runnerDigest,
        manifestRoot: v4Binding.manifestRoot,
        runtimeDeploymentId: v4Binding.runtimeDeploymentId,
        runtimeCommitSha: v4Binding.runtimeCommitSha,
        pricePinDigest: v4Binding.pricePinDigest,
      };
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: 0.01 } });
      await assert.rejects(approvePromptRefinerVnextOneShotPaidDispatch({
        session, request, expected: expectedPaid,
      }), /price_mismatch/);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: null } });
      await assert.rejects(approvePromptRefinerVnextOneShotPaidDispatch({
        session, request, expected: { ...expectedPaid,
          shadowAuditLogId: "wrong-shadow-audit" },
      }), /paid_approval_shadow_unavailable/);
      await assert.rejects(approvePromptRefinerVnextOneShotPaidDispatch({
        session, request, expected: { ...expectedPaid,
          manifestRoot: "f".repeat(64) },
      }), /paid_approval_binding_mismatch/);
      activeDeploymentId = "77777777-7777-4777-8777-777777777777";
      await assert.rejects(approvePromptRefinerVnextOneShotPaidDispatch({
        session, request, expected: expectedPaid,
      }), /active_deployment_unverified/);
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 0,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /active_deployment_unverified/);
      activeDeploymentId = runtime[3].runtimeDeploymentId;
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.paid_dispatch_authorized",
      } }), 0);
      const paid = await approvePromptRefinerVnextOneShotPaidDispatch({
        session, request, expected: expectedPaid,
      });
      assert.equal(paid.dispatchAuthorized, false);
      assert.deepEqual(await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotPaidAuthorization(
          tx, stage, shadow.shadowAuditLogId)), {
        present: true, valid: true,
        auditLogId: paid.paidAuthorizationAuditLogId,
      });
      await assert.rejects(approvePromptRefinerVnextOneShotPaidDispatch({
        session, request, expected: expectedPaid,
      }), /paid_approval_duplicate/);
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.paid_dispatch_authorized",
      } }), 1);

      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: 0.01 } });
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 0,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /price_mismatch/);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: null } });
      const firstRequestId = randomUUID();
      const first = await consumePromptRefinerVnextOneShotSlot({
        requestId: firstRequestId, slotIndex: 0,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      });
      assert.equal(first.reservationConsumed, true);
      assert.equal(first.dispatchAuthorized, false);
      assert.equal((await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
        where: { stageId_slotIndex: { stageId: V4, slotIndex: 0 } },
      })).requestId, firstRequestId);
      const unreported = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx));
      assert.equal(unreported.valid, false);
      assert.equal(unreported.consumedWithoutReceipt, 1);
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 1,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /prior_terminal_unverified/);
      const prematureNextSlot = await consumeSlotRoute(slotRequest(1));
      assert.equal(prematureNextSlot.status, 409);
      assert.deepEqual(await prematureNextSlot.json(), {
        code: "SLOT_CONSUMPTION_REFUSED", retryAuthorized: false,
      });
      const usage = { inputTokens: 1, outputTokens: 1,
        cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 };
      const cost = guardPromptRefinerVnextBilledUsage({ usage,
        effectivePricePin: PROMPT_REFINER_VNEXT_PRICE_PIN }).costUpperBoundMicroUsd;
      assert.ok(cost !== null);
      const terminalInput = { requestId: firstRequestId, slotIndex: 0,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
        slotConsumptionAuditLogId: first.slotConsumptionAuditLogId,
        resultKind: "abstained", usage, observedCostMicroUsd: cost,
        intentToTerminalLatencyMs: 10 };
      const terminalRequest = (body: unknown) => new Request(
        "https://example.test/api/internal/prompt-refiner/vnext-one-shot-terminal", {
          method: "POST", headers: { authorization: `Bearer ${runnerToken}`,
            "content-type": "application/json" }, body: JSON.stringify(body),
        });
      assert.equal((await recordTerminalRoute(terminalRequest({
        ...terminalInput, observedCostMicroUsd: cost + 1,
      }))).status, 409);
      assert.equal((await recordTerminalRoute(terminalRequest({
        ...terminalInput, output: "restricted-content-must-not-enter-audit",
      }))).status, 400);
      const recorded = await recordTerminalRoute(terminalRequest(terminalInput));
      assert.equal(recorded.status, 201);
      assert.equal((await recorded.json()).observedCostMicroUsd, cost);
      const terminalAudit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "prompt_refiner.vnext_one_shot.terminal_recorded" },
      });
      const auditBody = JSON.stringify(terminalAudit.metadata);
      for (const forbidden of ["manifestRoot", "sourceText", "refinedPrompt",
        "abstentionReason", "answer", "rubric", "counterexample",
        "restricted-content-must-not-enter-audit"]) {
        assert.equal(auditBody.includes(forbidden), false);
      }
      assert.equal((terminalAudit.metadata as Record<string, unknown>).resultKind,
        "abstained");
      assert.equal((await recordTerminalRoute(terminalRequest(terminalInput))).status, 409);
      const terminalReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx));
      assert.equal(terminalReadback.valid, true);
      assert.equal(terminalReadback.terminalReceipts, 1);
      assert.equal(terminalReadback.observedCostMicroUsd, cost);
      assert.equal(terminalReadback.slots[0].state, "terminal");
      assert.equal(terminalReadback.slots[1].state, "not_attempted");
      for (const corruption of ["metadata", "hash"] as const) {
        const tampered = await prisma.$transaction(async (tx) => {
          const auditLog = new Proxy(tx.adminAuditLog, {
            get(delegate, key) {
              if (key !== "findMany") return Reflect.get(delegate, key);
              return async (args: Parameters<typeof delegate.findMany>[0]) => {
                const rows = await delegate.findMany(args);
                if (args?.where?.action !==
                    "prompt_refiner.vnext_one_shot.terminal_recorded") return rows;
                return rows.map((row) => corruption === "metadata" ? {
                  ...row, metadata: { ...(row.metadata as Record<string, unknown>),
                    observedCostMicroUsd: cost + 1 },
                } : { ...row, entryHash: "0".repeat(64) });
              };
            },
          });
          const view = new Proxy(tx, {
            get(target, key) {
              return key === "adminAuditLog" ? auditLog : Reflect.get(target, key);
            },
          });
          const readback = await readPromptRefinerVnextOneShotTerminalReceipts(view);
          await assert.rejects(assertPromptRefinerVnextOneShotTerminalsComplete(view),
            /prior_terminal_unverified/);
          return readback;
        });
        assert.equal(tampered.valid, false);
        assert.equal(tampered.slots[0].state, "receipt_missing_or_invalid");
        assert.equal(tampered.consumedWithoutReceipt, 1);
      }
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: firstRequestId, slotIndex: 1,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /unique|P2002|duplicate/i);
      await client.query(`CREATE FUNCTION reject_b06_slot_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW."action" = 'prompt_refiner.vnext_one_shot.slot_consumed' THEN
            RAISE EXCEPTION 'synthetic slot audit failure';
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER reject_b06_slot_audit_trigger BEFORE INSERT
        ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION reject_b06_slot_audit()`);
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 1,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /synthetic slot audit failure/);
      await client.query(`DROP TRIGGER reject_b06_slot_audit_trigger ON "AdminAuditLog"`);
      await client.query(`DROP FUNCTION reject_b06_slot_audit()`);
      assert.equal((await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
        where: { stageId_slotIndex: { stageId: V4, slotIndex: 1 } },
      })).status, "reserved");
      const raced = await Promise.allSettled([1, 2].map(() =>
        consumePromptRefinerVnextOneShotSlot({
          requestId: randomUUID(), slotIndex: 1,
          runApprovalAuditLogId: run.runApprovalAuditLogId,
        })));
      assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.slot_consumed",
      } }), 2);
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, V4))).consumedSlots, 2);
      const second = raced.find((result) => result.status === "fulfilled");
      assert.ok(second && second.status === "fulfilled");
      const secondRequestId = (await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
        where: { stageId_slotIndex: { stageId: V4, slotIndex: 1 } },
      })).requestId!;
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx))).consumedWithoutReceipt, 1);

      assert.equal((await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
        where: { stageId_slotIndex: { stageId: V4, slotIndex: 2 } },
      })).status, "reserved");
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.slot_consumed",
      } }), 2);

      // An unresolved second invocation prevents even a different reserved
      // slot from being consumed. Its stop receipt preserves the held ceiling.
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 2,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /prior_terminal_unverified/);

      const failedInput = { ...terminalInput, requestId: secondRequestId,
        slotIndex: 1, slotConsumptionAuditLogId: second.value.slotConsumptionAuditLogId,
        resultKind: "failed", failureCode: "vnext_strict_parse_failure" };
      assert.equal((await recordTerminalRoute(terminalRequest({
        ...failedInput, failureCode: undefined,
      }))).status, 409);
      assert.equal((await recordTerminalRoute(terminalRequest(failedInput))).status, 201);
      const failedReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx));
      assert.equal(failedReadback.valid, true);
      assert.equal(failedReadback.terminalReceipts, 2);
      const oldTerminal = failedReadback.slots[0];
      const failedTerminal = failedReadback.slots[1];
      assert.ok("resultKind" in oldTerminal);
      assert.ok("resultKind" in failedTerminal);
      assert.ok("failureCode" in failedTerminal);
      assert.equal(oldTerminal.resultKind, "abstained");
      assert.equal(failedTerminal.resultKind, "failed");
      assert.equal(failedTerminal.failureCode,
        "vnext_strict_parse_failure");
      const failedAudit = (await prisma.adminAuditLog.findMany({ where: {
        action: "prompt_refiner.vnext_one_shot.terminal_recorded",
      } })).find((entry) => (entry.metadata as Record<string, unknown>)
        ?.resultKind === "failed");
      assert.ok(failedAudit);
      assert.equal((failedAudit.metadata as Record<string, unknown>).version,
        "prompt-refiner-vnext-one-shot-terminal-v2");
      assert.equal(JSON.stringify(failedAudit.metadata).includes("not JSON"), false);

      const highUsage = { ...usage, inputTokens: 13_060, outputTokens: 4_096 };
      const highCost = guardPromptRefinerVnextBilledUsage({ usage: highUsage,
        effectivePricePin: PROMPT_REFINER_VNEXT_PRICE_PIN }).costUpperBoundMicroUsd;
      assert.equal(highCost, 7_528);
      for (let slotIndex = 2; slotIndex <= 32; slotIndex++) {
        const requestId = randomUUID();
        const consumed = await consumePromptRefinerVnextOneShotSlot({
          requestId, slotIndex, runApprovalAuditLogId: run.runApprovalAuditLogId,
        });
        const isLast = slotIndex === 32;
        assert.equal((await recordTerminalRoute(terminalRequest({
          ...terminalInput, requestId, slotIndex,
          slotConsumptionAuditLogId: consumed.slotConsumptionAuditLogId,
          usage: isLast ? highUsage : usage,
          observedCostMicroUsd: isLast ? highCost : cost,
        }))).status, 201);
      }
      const third = await consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 33,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      });
      const thirdRequestId = (await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
        where: { stageId_slotIndex: { stageId: V4, slotIndex: 33 } },
      })).requestId!;

      const uncertain = { requestId: thirdRequestId, slotIndex: 33,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
        slotConsumptionAuditLogId: third.slotConsumptionAuditLogId,
        reason: "timeout" as const };
      await assert.rejects(stopPromptRefinerVnextOneShotUnknown({
        ...uncertain, requestId: firstRequestId, slotIndex: 0,
        slotConsumptionAuditLogId: first.slotConsumptionAuditLogId,
      }), /terminal_already_recorded/);
      await assert.rejects(stopPromptRefinerVnextOneShotUnknown({
        ...uncertain, requestId: randomUUID(),
      }), /unknown_slot_mismatch/);
      await client.query(`CREATE FUNCTION reject_b06_unknown_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW."action" = 'prompt_refiner.vnext_one_shot.outcome_unknown' THEN
            RAISE EXCEPTION 'synthetic unknown audit failure';
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER reject_b06_unknown_audit_trigger BEFORE INSERT
        ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION reject_b06_unknown_audit()`);
      await assert.rejects(stopPromptRefinerVnextOneShotUnknown(uncertain),
        /synthetic unknown audit failure/);
      await client.query(`DROP TRIGGER reject_b06_unknown_audit_trigger
        ON "AdminAuditLog"`);
      await client.query(`DROP FUNCTION reject_b06_unknown_audit()`);
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V4 },
      })).status, "run_approved");
      await client.query(`CREATE FUNCTION reject_b06_unknown_close() RETURNS trigger AS $$
        BEGIN
          IF NEW."status" = 'closed' THEN
            RAISE EXCEPTION 'synthetic unknown close failure';
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER reject_b06_unknown_close_trigger BEFORE UPDATE
        ON "PromptRefinerVnextOneShotStage" FOR EACH ROW
        EXECUTE FUNCTION reject_b06_unknown_close()`);
      await assert.rejects(stopPromptRefinerVnextOneShotUnknown(uncertain),
        /synthetic unknown close failure/);
      await client.query(`DROP TRIGGER reject_b06_unknown_close_trigger
        ON "PromptRefinerVnextOneShotStage"`);
      await client.query(`DROP FUNCTION reject_b06_unknown_close()`);
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.outcome_unknown",
      } }), 0);
      const stopped = await stopPromptRefinerVnextOneShotUnknown(uncertain);
      assert.equal(stopped.retryAuthorized, false);
      assert.equal(stopped.reservationHeld, true);
      const stopReadback = await readPromptRefinerVnextOneShotUnknownStop({
        ...uncertain, stopAuditLogId: stopped.stopAuditLogId,
      });
      assert.equal(stopReadback.retryAuthorized, false);
      const stoppedReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx));
      assert.equal(stoppedReadback.valid, true);
      assert.equal(stoppedReadback.terminalReceipts, 33);
      assert.equal(stoppedReadback.unknownReceipts, 1);
      assert.equal(stoppedReadback.consumedWithoutReceipt, 0);
      assert.equal(stoppedReadback.observedCostMicroUsd, 7_624);
      assert.equal(stoppedReadback.unresolvedCostUpperBoundMicroUsd, 29_918);
      assert.equal(stoppedReadback.slots[33].state, "outcome_unknown");
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V4 },
      })).status, "closed");
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        requestId: randomUUID(), slotIndex: 34,
        runApprovalAuditLogId: run.runApprovalAuditLogId,
      }), /approved_stage_inactive/);
      const v4Before = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V4 },
      });
      const v4SlotsBefore = await prisma.promptRefinerVnextOneShotSlot.findMany({
        where: { stageId: V4 }, orderBy: { slotIndex: "asc" },
      });
      const v5Binding = { ...v4Binding, id: V5,
        runnerDigest: "b".repeat(64), manifestRoot: "f".repeat(64),
        runtimeDeploymentId: "55555555-5555-4555-8555-555555555555",
        runtimeCommitSha: "5".repeat(40) };
      const priorAuditCount = await prisma.adminAuditLog.count();
      for (const drift of [
        { runnerDigest: v4Binding.runnerDigest },
        { manifestRoot: v4Binding.manifestRoot },
        { runtimeDeploymentId: v4Binding.runtimeDeploymentId },
        { runtimeCommitSha: v4Binding.runtimeCommitSha },
      ]) {
        await assert.rejects(createPromptRefinerVnextOneShotV5Stage({
          session, request, binding: { ...v5Binding, ...drift },
        }), /predecessor_invalid/);
        assert.equal(await prisma.adminAuditLog.count(), priorAuditCount);
      }
      await assert.rejects(createPromptRefinerVnextOneShotV5Stage({
        session, request, binding: { ...v5Binding,
          pricePinDigest: "1".repeat(64) },
      }), /v5_price_mismatch/);
      assert.equal(await prisma.adminAuditLog.count(), priorAuditCount);
      const v5Competing = await Promise.allSettled([1, 2].map(() =>
        createPromptRefinerVnextOneShotV5Stage({
          session, request, binding: v5Binding,
        })));
      assert.equal(v5Competing.filter((outcome) => outcome.status === "fulfilled").length, 1,
        v5Competing.map((outcome) => outcome.status === "rejected" ?
          String((outcome.reason as Error).message).slice(0, 240) : "fulfilled").join(" | "));
      assert.equal(v5Competing.filter((outcome) => outcome.status === "rejected").length, 1);
      const v5Success = v5Competing.find((outcome) => outcome.status === "fulfilled");
      assert.ok(v5Success && v5Success.status === "fulfilled");
      assert.deepEqual(await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V4 },
      }), v4Before, "v5 must not modify the closed v4 stage");
      const v5Readback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, V5));
      assert.equal(v5Readback.stageStatus, "staged");
      assert.equal(v5Readback.reservedSlots, 80);
      assert.equal(v5Readback.consumedSlots, 0);
      assert.equal(v5Readback.approvalAuditsValid, true);
      assert.equal(v5Readback.dispatchAuthorized, false);
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.post_unknown_new_run_approved",
      } }), 1);
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx))).valid, true,
      "v4 terminal readback remains valid after v5 stage");
      process.env.RAILWAY_DEPLOYMENT_ID = v5Binding.runtimeDeploymentId;
      process.env.RAILWAY_GIT_COMMIT_SHA = v5Binding.runtimeCommitSha;
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT =
        v5Binding.manifestRoot;
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST =
        v5Binding.runnerDigest;
      globalThis.fetch = async () => Response.json({ data: {
        deployment: { id: v5Binding.runtimeDeploymentId, status: "SUCCESS",
          meta: { commitHash: v5Binding.runtimeCommitSha } },
        deployments: { edges: [{ node: {
          id: v5Binding.runtimeDeploymentId, status: "SUCCESS",
        } }] },
      } });
      const v5Run = await approvePromptRefinerVnextOneShotRun({
        session, request, stageId: V5,
        expected: { ...v5Binding,
          stageApprovalAuditLogId: v5Success.value.stageApprovalAuditLogId },
      });
      assert.equal(v5Run.stageId, V5);
      assert.equal(v5Run.dispatchAuthorized, false);
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, V5))).stageStatus,
      "run_approved");
      const v5Stage = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V5 },
      });
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        stageId: V5, requestId: randomUUID(), slotIndex: 0,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
      }), /shadow_evidence_unavailable/);
      const v5Target = promptRefinerVnextOneShotShadowTarget(v5Stage);
      assert.ok(v5Target);
      const v5Proof = signPromptRefinerVnextOneShotShadowProof({
        version: "prompt-refiner-vnext-one-shot-shadow-proof-v1",
        ...v5Target, manifestRoot: v5Binding.manifestRoot,
        runnerPreflightDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
        cacheWriteInputTokens: 0, providerCalls: 0, slotConsumeCalls: 0,
        signedAt: new Date().toISOString(),
      }, privateKey);
      const v5Shadow = await recordPromptRefinerVnextOneShotOperationalShadow({
        session, request, proof: v5Proof, stageId: V5,
      });
      assert.equal(v5Shadow.stageId, V5);
      assert.equal(v5Shadow.dispatchAuthorized, false);
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotOperationalShadow(tx, v5Stage))).valid, true);
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        stageId: V5, requestId: randomUUID(), slotIndex: 0,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
      }), /paid_authorization_unavailable/);
      const v5Paid = await approvePromptRefinerVnextOneShotPaidDispatch({
        session, request, stageId: V5,
        expected: { ...v5Binding,
          stageApprovalAuditLogId: v5Success.value.stageApprovalAuditLogId,
          runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
          shadowAuditLogId: v5Shadow.shadowAuditLogId },
      });
      assert.equal(v5Paid.stageId, V5);
      assert.equal(v5Paid.dispatchAuthorized, false);
      const v5PaidReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotPaidAuthorization(tx, v5Stage,
          v5Shadow.shadowAuditLogId));
      assert.equal(v5PaidReadback.valid, true);
      const v5PaidAudit = await prisma.adminAuditLog.findUniqueOrThrow({
        where: { id: v5Paid.paidAuthorizationAuditLogId },
      });
      assert.equal((v5PaidAudit.metadata as Record<string, unknown>)
        .crossRunWorstCaseMicroUsd, 2_430_982);
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        stageId: V5, requestId: randomUUID(), slotIndex: 1,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
      }), /reservation_unavailable/);
      const v5RequestId = randomUUID();
      const v5First = await consumePromptRefinerVnextOneShotSlot({
        stageId: V5, requestId: v5RequestId, slotIndex: 0,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
      });
      assert.equal(v5First.reservationConsumed, true);
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        stageId: V5, requestId: randomUUID(), slotIndex: 1,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
      }), /prior_terminal_unverified/);
      assert.equal((await recordTerminalRoute(terminalRequest({
        stageId: V5, requestId: v5RequestId, slotIndex: 0,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
        slotConsumptionAuditLogId: v5First.slotConsumptionAuditLogId,
        resultKind: "failed", failureCode: "vnext_strict_parse_failure",
        usage, observedCostMicroUsd: cost,
        intentToTerminalLatencyMs: 10,
      }))).status, 201);
      const v5FirstReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx, V5));
      assert.equal(v5FirstReadback.valid, true);
      assert.equal(v5FirstReadback.terminalReceipts, 1);
      assert.equal(v5FirstReadback.observedCostMicroUsd, cost);
      assert.equal(v5FirstReadback.slots[0].state, "terminal");
      const v5SecondRequestId = randomUUID();
      const v5Second = await consumePromptRefinerVnextOneShotSlot({
        stageId: V5, requestId: v5SecondRequestId, slotIndex: 1,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
      });
      const v5Stopped = await stopPromptRefinerVnextOneShotUnknown({
        stageId: V5, requestId: v5SecondRequestId, slotIndex: 1,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
        slotConsumptionAuditLogId: v5Second.slotConsumptionAuditLogId,
        reason: "response_unverified",
      });
      assert.equal(v5Stopped.retryAuthorized, false);
      const v5StoppedReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotTerminalReceipts(tx, V5));
      assert.equal(v5StoppedReadback.valid, true);
      assert.equal(v5StoppedReadback.terminalReceipts, 1);
      assert.equal(v5StoppedReadback.unknownReceipts, 1);
      assert.equal(v5StoppedReadback.slots[1].state, "outcome_unknown");
      await assert.rejects(consumePromptRefinerVnextOneShotSlot({
        stageId: V5, requestId: randomUUID(), slotIndex: 2,
        runApprovalAuditLogId: v5Run.runApprovalAuditLogId,
      }), /approved_stage_inactive/);
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: V4 },
      })).status, "closed");
      assert.deepEqual(await prisma.promptRefinerVnextOneShotSlot.findMany({
        where: { stageId: V4 }, orderBy: { slotIndex: "asc" },
      }), v4SlotsBefore, "v5 run and safe stop must not rewrite v4 slots");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await prisma.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
      globalThis.fetch = priorFetch;
      for (const name of environmentNames) {
        const previous = priorEnvironment[name];
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      if (priorKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
      else process.env.ADMIN_AUDIT_INTEGRITY_KEY = priorKey;
    }
  });
