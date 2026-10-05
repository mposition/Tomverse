import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import pg from "pg";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES,
  promptRefinerVnextOneShotApprovalAuditMetadata } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import { lockAndReadPromptRefinerVnextOneShotStage,
  readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { approvePromptRefinerVnextOneShotRun } from
  "@/lib/promptRefinerVnextOneShotRunApproval";
import { consumePromptRefinerVnextOneShotSlot } from
  "@/lib/promptRefinerVnextOneShotSlotConsumption";
import { readPromptRefinerVnextOneShotOperationalShadow,
  recordPromptRefinerVnextOneShotOperationalShadow } from
  "@/lib/promptRefinerVnextOneShotOperationalShadow";
import { createPromptRefinerVnextOneShotAdapter } from
  "@/lib/promptRefinerVnextOneShotAdapter";
import { readPromptRefinerVnextOneShotUnknownStop,
  stopPromptRefinerVnextOneShotUnknown } from
  "@/lib/promptRefinerVnextOneShotOutcomeRecovery";
import { writePromptRefinerVnextOneShotStageApprovalAudit } from
  "@/lib/promptRefinerVnextOneShotStageApprovalAudit";
import { createPromptRefinerVnextOneShotStageWithSlots } from
  "@/lib/promptRefinerVnextOneShotStageWriter";
import { recordPromptRefinerVnextOneShotPreregistration } from
  "@/lib/promptRefinerVnextOneShotPreregistration";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const fixtureKey = "synthetic-chat01-a06-audit-integrity-key";
const stageId = "prompt-refiner-vnext-one-shot-v2";
const legacyStageId = "prompt-refiner-vnext-one-shot-v1";
const countOperationalAudits = () => prisma.adminAuditLog.count({
  where: { targetId: { not: legacyStageId },
    action: { not: "prompt_refiner.vnext_one_shot.preregistered" } },
});
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binding = {
  id: stageId,
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: createHash("sha256").update(readFileSync(path.join(
    projectRoot, "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-candidate-source.json"
  ))).digest("hex"),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "a".repeat(40),
  pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
  perRequestCostMicroUsd: BigInt(29_918),
  slotCount: 80,
  costCeilingMicroUsd: BigInt(2_393_440),
};
const session = {
  user: { id: "synthetic-owner", email: "owner@example.test" },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;
const request = new Request("https://example.test/api/admin/prompt-refiner/stage", {
  headers: { "user-agent": "a06-synthetic-integration" },
});
const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations");

test("stage audit and 80 slots commit or roll back in the same PG17 transaction",
  { skip: !testUrl, timeout: 40_000 }, async () => {
    assert.equal(process.env.DATABASE_URL, testUrl,
      "only DATABASE_URL=TEST_DATABASE_URL is accepted");
    const url = new URL(testUrl!);
    const schema = url.searchParams.get("schema");
    assert.match(decodeURIComponent(url.pathname), /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i);
    assert.match(schema ?? "", /^chat01_a06_test_[a-z0-9]+$/);
    url.searchParams.delete("schema");
    const setup = new pg.Client({ connectionString: url.toString() });
    const oldKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    process.env.ADMIN_AUDIT_INTEGRITY_KEY = fixtureKey;
    await setup.connect();
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}"`);
      await setup.query(`CREATE TABLE "AdminAuditLog" (
        "id" TEXT PRIMARY KEY, "actorUserId" TEXT, "actorEmail" TEXT,
        "action" TEXT NOT NULL, "targetType" TEXT NOT NULL, "targetId" TEXT,
        "summary" TEXT NOT NULL, "metadata" JSONB, "ipAddress" TEXT,
        "userAgent" TEXT, "previousHash" TEXT, "entryHash" TEXT UNIQUE,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await setup.query(await readFile(path.join(migrationPath,
        "20260918090000_admin_audit_log_append_only/migration.sql"), "utf8"));
      await setup.query(await readFile(path.join(migrationPath,
        "20261002093000_prompt_refiner_vnext_one_shot_slots/migration.sql"), "utf8"));
      await setup.query(await readFile(path.join(migrationPath,
        "20261005140000_prompt_refiner_one_shot_unrun_replacement/migration.sql"), "utf8"));
      await setup.query(`CREATE TABLE "StageAuditProbe" ("id" TEXT PRIMARY KEY)`);
      await setup.query(`CREATE TABLE "ModelRegistryEntry" (
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
        "supportsNativePdf" BOOLEAN NOT NULL DEFAULT false, "webSearchOverride" TEXT,
        "maxImages" INTEGER, "maxBase64ImagePayloadBytes" INTEGER,
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

      const append = (tx: Prisma.TransactionClient) =>
        writePromptRefinerVnextOneShotStageApprovalAudit({ tx, session, request, binding });

      await assert.rejects(
        writePromptRefinerVnextOneShotStageApprovalAudit({
          tx: null as unknown as Prisma.TransactionClient, session, request, binding,
        }),
        /stage_audit_context_invalid/,
      );
      await assert.rejects(prisma.$transaction((tx) =>
        writePromptRefinerVnextOneShotStageApprovalAudit({
          tx, session, request,
          binding: { ...binding, perRequestCostMicroUsd: BigInt(29_919) },
        })), /stage_audit_binding_invalid/);
      assert.equal(await countOperationalAudits(), 0);

      const oldFallback = process.env.NEXTAUTH_SECRET;
      delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
      delete process.env.NEXTAUTH_SECRET;
      try {
        await assert.rejects(prisma.$transaction(append), /stage_audit_key_unavailable/);
      } finally {
        process.env.ADMIN_AUDIT_INTEGRITY_KEY = fixtureKey;
        if (oldFallback === undefined) delete process.env.NEXTAUTH_SECRET;
        else process.env.NEXTAUTH_SECRET = oldFallback;
      }
      assert.equal(await countOperationalAudits(), 0);

      // A real failure in the shared audit writer rolls back an earlier write.
      await setup.query(`CREATE FUNCTION reject_stage_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW."action" = 'prompt_refiner.vnext_one_shot.stage_approved' THEN
            RAISE EXCEPTION 'synthetic audit failure';
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await setup.query(`CREATE TRIGGER reject_stage_audit_trigger BEFORE INSERT
        ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION reject_stage_audit()`);
      await assert.rejects(prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "StageAuditProbe" ("id") VALUES ('prior-write')`;
        await append(tx);
      }), /synthetic audit failure/);
      assert.equal((await setup.query(`SELECT count(*)::int AS count FROM "StageAuditProbe"`))
        .rows[0].count, 0);
      assert.equal(await countOperationalAudits(), 0);
      await setup.query(`DROP TRIGGER reject_stage_audit_trigger ON "AdminAuditLog"`);
      await setup.query(`DROP FUNCTION reject_stage_audit()`);

      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request,
        binding: { ...binding, costCeilingMicroUsd: BigInt(2_393_441) },
      }), /stage_audit_binding_invalid/);
      assert.equal(await countOperationalAudits(), 0);
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request,
        binding: { ...binding, pricePinDigest: "f".repeat(64) },
      }), /stage_price_mismatch/);
      assert.equal(await countOperationalAudits(), 0);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: 0.01 } });
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding,
      }), /stage_price_mismatch/);
      assert.equal(await countOperationalAudits(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 0);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: null } });

      // The real writer must not create any stage, slot, or audit without B01.
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding,
      }), /preregistration_unavailable/);
      assert.equal(await countOperationalAudits(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 0);

      // B01 is committed first, without a root or any holdout material.
      const priorPreregCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
      const priorPreregRunner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
      process.env.RAILWAY_GIT_COMMIT_SHA = binding.sourceCommitSha;
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = binding.runnerDigest;
      let preregistration;
      try {
        preregistration = await recordPromptRefinerVnextOneShotPreregistration({
          session, request, pins: binding,
        });
      } finally {
        if (priorPreregCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
        else process.env.RAILWAY_GIT_COMMIT_SHA = priorPreregCommit;
        if (priorPreregRunner === undefined) {
          delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
        } else {
          process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = priorPreregRunner;
        }
      }
      assert.equal(preregistration.dispatchAuthorized, false);
      assert.equal(await prisma.adminAuditLog.count({ where: {
        action: "prompt_refiner.vnext_one_shot.preregistered",
      } }), 1);

      const legacyBinding = { ...binding, id: legacyStageId,
        runtimeDeploymentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
      await prisma.$transaction(async (tx) => {
        const legacyAuditLogId = await writeAdminAuditLog({
          tx, session, request,
          action: "prompt_refiner.vnext_one_shot.stage_approved",
          targetType: "PromptRefinerVnextOneShotStage",
          targetId: legacyStageId,
          summary: PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES.stage,
          metadata: promptRefinerVnextOneShotApprovalAuditMetadata(
            legacyBinding, "stage"),
        });
        await tx.promptRefinerVnextOneShotStage.create({ data: {
          ...legacyBinding, approvedBy: session.user!.id!,
          approvedAt: new Date(0), stageApprovalAuditLogId: legacyAuditLogId,
        } });
        await tx.promptRefinerVnextOneShotSlot.createMany({ data:
          Array.from({ length: 80 }, (_, slotIndex) => ({
            id: `legacy-slot-${slotIndex}`, stageId: legacyStageId, slotIndex,
            reservedCostMicroUsd: BigInt(29_918),
          })),
        });
      });
      assert.equal((await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, legacyStageId)))
        .approvalAuditsValid, true);
      const legacyStage = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: legacyStageId },
      });
      await assert.rejects(prisma.promptRefinerVnextOneShotStage.update({
        where: { id: legacyStageId }, data: { status: "closed" },
      }), /first-stage close requires a supersession audit/);
      await assert.rejects(prisma.promptRefinerVnextOneShotStage.update({
        where: { id: legacyStageId },
        data: { status: "closed",
          supersededAuditLogId: legacyStage.stageApprovalAuditLogId },
      }), /supersession audit binding is invalid/);
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding: legacyBinding,
      }), /stage_audit_binding_invalid/);
      assert.equal(await countOperationalAudits(), 0);

      // A second stage cannot be inserted before the first closes with its
      // own linked audit; a failed attempt leaves the old stage untouched.
      await assert.rejects(prisma.$transaction(async (tx) => {
        const { auditLogId, approvedBy } = await append(tx);
        await tx.promptRefinerVnextOneShotStage.create({ data: {
          ...binding, approvedBy, approvedAt: new Date(0),
          stageApprovalAuditLogId: auditLogId,
        } });
      }), /one-shot replacement requires a closed/i);
      assert.equal(await countOperationalAudits(), 0);
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: legacyStageId },
      })).status, "staged");
      const insertReplacementFixture = (slotCount: number, failAfter = false,
        omitReplacement = false) =>
        prisma.$transaction(async (tx) => {
          const legacy = await tx.promptRefinerVnextOneShotStage.findUniqueOrThrow({
            where: { id: legacyStageId },
          });
          const { auditLogId, approvedBy } = await append(tx);
          const closeAuditLogId = await writeAdminAuditLog({
            tx, session, request,
            action: "prompt_refiner.vnext_one_shot.stage_superseded",
            targetType: "PromptRefinerVnextOneShotStage",
            targetId: legacyStageId,
            summary: "Closed an unrun one-shot stage for exact-deployment replacement.",
            metadata: {
              replacementStageId: stageId,
              previousStageApprovalAuditLogId: legacy.stageApprovalAuditLogId,
              replacementStageApprovalAuditLogId: auditLogId,
            },
          });
          await tx.promptRefinerVnextOneShotStage.update({
            where: { id: legacyStageId },
            data: { status: "closed", supersededAuditLogId: closeAuditLogId },
          });
          if (!omitReplacement) {
            await tx.promptRefinerVnextOneShotStage.create({ data: {
              ...binding, approvedBy, approvedAt: new Date(0),
              stageApprovalAuditLogId: auditLogId,
            } });
            await tx.promptRefinerVnextOneShotSlot.createMany({ data:
              Array.from({ length: slotCount }, (_, slotIndex) => ({
                id: `replacement-fixture-${slotIndex}`, stageId, slotIndex,
                reservedCostMicroUsd: BigInt(29_918),
              })),
            });
          }
          if (failAfter) throw new Error("synthetic post-stage failure");
        });
      await assert.rejects(insertReplacementFixture(0, false, true),
        /one-shot supersession requires replacement stage in the same transaction/);
      await assert.rejects(insertReplacementFixture(79),
        /exactly 80 reserved slots/);
      await assert.rejects(insertReplacementFixture(81),
        /PromptRefinerVnextOneShotSlot_index_check/);
      await assert.rejects(insertReplacementFixture(80, true),
        /synthetic post-stage failure/);
      assert.equal(await countOperationalAudits(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 1);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 80);
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: legacyStageId },
      })).status, "staged");
      for (const drifted of [
        { ...binding, manifestRoot: "f".repeat(64) },
        { ...binding, runtimeDeploymentId: legacyBinding.runtimeDeploymentId },
      ]) {
        await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
          session, request, binding: drifted,
        }), /legacy_stage_not_replaceable/);
        assert.equal(await countOperationalAudits(), 0);
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: legacyStageId },
        })).status, "staged");
      }

      // Exercise the actual A07 writer, not only a hand-built transaction.
      await setup.query(`CREATE FUNCTION reject_slot_forty() RETURNS trigger AS $$
        BEGIN
          IF NEW."slotIndex" = 40 THEN RAISE EXCEPTION 'synthetic slot failure'; END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await setup.query(`CREATE TRIGGER reject_slot_forty_trigger BEFORE INSERT
        ON "PromptRefinerVnextOneShotSlot" FOR EACH ROW
        EXECUTE FUNCTION reject_slot_forty()`);
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding,
      }), /synthetic slot failure/);
      assert.equal(await countOperationalAudits(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 1);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 80);
      assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: legacyStageId },
      })).status, "staged", "slot failure must roll back the old-stage close");
      await setup.query(`DROP TRIGGER reject_slot_forty_trigger
        ON "PromptRefinerVnextOneShotSlot"`);
      await setup.query(`DROP FUNCTION reject_slot_forty()`);

      const extraFields = { ...binding, status: "run_approved",
        runApprovalAuditLogId: "forged-audit-id" };
      const competing = await Promise.allSettled(Array.from({ length: 2 }, () =>
        createPromptRefinerVnextOneShotStageWithSlots({
          session, request, binding: extraFields,
        })
      ));
      const committed = competing.filter((result) => result.status === "fulfilled");
      const refused = competing.filter((result) => result.status === "rejected");
      assert.equal(committed.length, 1, "only one concurrent stage may commit");
      assert.equal(refused.length, 1, "the duplicate stage must be refused");
      assert.match(String((refused[0] as PromiseRejectedResult).reason),
        /legacy_stage_not_replaceable|unique|P2002|duplicate/i);
      const { stageApprovalAuditLogId: auditLogId, slotCount } =
        (committed[0] as PromiseFulfilledResult<Awaited<ReturnType<
          typeof createPromptRefinerVnextOneShotStageWithSlots>>>).value;
      assert.equal(slotCount, 80);
      const stage = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: stageId },
      });
      assert.equal(stage.status, "staged");
      assert.equal(stage.runApprovalAuditLogId, null);
      const audit = await prisma.adminAuditLog.findUniqueOrThrow({
        where: { id: auditLogId },
      });
      assert.equal(stage.stageApprovalAuditLogId, audit.id);
      assert.equal(stage.approvedAt.getTime(), audit.createdAt.getTime());
      assert.match(audit.entryHash ?? "", /^[0-9a-f]{64}$/);
      const readback = await prisma.$transaction(readPromptRefinerVnextOneShotStage);
      assert.equal(readback.approvalAuditsValid, true);
      assert.equal(readback.stageId, stageId);
      assert.equal(readback.runtimeDeploymentId, binding.runtimeDeploymentId);
      assert.equal(readback.runtimeCommitSha, binding.runtimeCommitSha);
      assert.equal(readback.stageApprovalAuditLogId, auditLogId);
      assert.equal(readback.runApprovalAuditLogId, null);
      assert.equal(readback.reservationShapeValid, true);
      assert.equal(readback.reservedSlots, 80);
      assert.equal(readback.dispatchAuthorized, false);
      const lockContender = new pg.Client({ connectionString: url.toString() });
      await lockContender.connect();
      try {
        await lockContender.query(`SET search_path TO "${schema}"`);
        await setup.query("BEGIN");
        await setup.query(`SELECT "id" FROM "PromptRefinerVnextOneShotStage"
          WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT`, [stageId]);
        let unlockedReadCount = 0;
        const blockedReadbackTx = {
          async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
            const sql = strings.reduce((query, part, index) =>
              query + part + (index < values.length ? `$${index + 1}` : ""), "");
            return (await lockContender.query(sql, values)).rows;
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
        await assert.rejects(lockAndReadPromptRefinerVnextOneShotStage(blockedReadbackTx),
          (error: unknown) => (error as { code?: string }).code === "55P03" &&
            /could not obtain lock on row/.test((error as Error).message));
        assert.equal(unlockedReadCount, 0);
      } finally {
        await setup.query("ROLLBACK");
        await lockContender.end();
      }
      const previousReadback = await prisma.$transaction((tx) =>
        readPromptRefinerVnextOneShotStage(tx, legacyStageId));
      assert.equal(previousReadback.stageId, legacyStageId);
      assert.equal(previousReadback.runtimeDeploymentId,
        legacyBinding.runtimeDeploymentId);
      assert.equal(previousReadback.stageApprovalAuditLogId,
        legacyStage.stageApprovalAuditLogId);
      assert.equal(previousReadback.runApprovalAuditLogId, null);
      assert.equal(previousReadback.reservedSlots, 80);
      await assert.rejects(prisma.promptRefinerVnextOneShotSlot.update({
        where: { stageId_slotIndex: { stageId: legacyStageId, slotIndex: 0 } },
        data: { status: "consumed", requestId: "synthetic-legacy-forbidden" },
      }), /one-shot run approval is required before consumption/);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 160);
      assert.equal(await countOperationalAudits(), 1,
        "the refused concurrent approval must not leave an audit row");
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding,
      }));
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 2);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 160);
      assert.equal(await countOperationalAudits(), 1);

      // A09 reobserves the same source/deployment/price under the stage lock;
      // neither a bad pin nor a failed audit may advance the run state.
      const envPins = {
        APP_ENV: "staging",
        RAILWAY_ENVIRONMENT_NAME: "staging",
        RAILWAY_DEPLOYMENT_ID: binding.runtimeDeploymentId,
        RAILWAY_GIT_COMMIT_SHA: binding.runtimeCommitSha,
        RAILWAY_PROJECT_ID: "12345678-1234-1234-1234-123456789abd",
        RAILWAY_SERVICE_ID: "12345678-1234-1234-1234-123456789abe",
        RAILWAY_ENVIRONMENT_ID: "12345678-1234-1234-1234-123456789abf",
        RAILWAY_API_TOKEN: "synthetic-read-only-token",
        PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT: binding.manifestRoot,
        PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST: binding.runnerDigest,
      };
      const priorEnv = Object.fromEntries(Object.keys(envPins).map((key) =>
        [key, process.env[key]]));
      Object.assign(process.env, envPins);
      let activeDeploymentId = binding.runtimeDeploymentId;
      const fetchStub = mock.method(globalThis, "fetch", async () => Response.json({
        data: {
          deployment: { id: binding.runtimeDeploymentId, status: "SUCCESS",
            meta: { commitHash: binding.runtimeCommitSha } },
          deployments: { edges: [{ node: {
            id: activeDeploymentId, status: "SUCCESS",
          } }] },
        },
      }));
      const expected = {
        stageApprovalAuditLogId: auditLogId,
        sourceCommitSha: binding.sourceCommitSha,
        sourceManifestDigest: binding.sourceManifestDigest,
        runnerDigest: binding.runnerDigest,
        manifestRoot: binding.manifestRoot,
        runtimeDeploymentId: binding.runtimeDeploymentId,
        runtimeCommitSha: binding.runtimeCommitSha,
        pricePinDigest: binding.pricePinDigest,
      };
      try {
        await assert.rejects(prisma.promptRefinerVnextOneShotStage.update({
          where: { id: stageId },
          data: { status: "run_approved", runApprovalAuditLogId: "forged-run-audit" },
        }), /one-shot run approval audit is missing/);
        assert.equal(await countOperationalAudits(), 1);
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session: { ...session, user: { id: "other-owner", email: "other@example.test" } },
          request, expected,
        }), /run_binding_mismatch/);
        assert.equal(await countOperationalAudits(), 1);
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected: { ...expected, manifestRoot: "f".repeat(64) },
        }), /run_binding_mismatch/);
        assert.equal(await countOperationalAudits(), 1);
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: stageId },
        })).status, "staged");

        activeDeploymentId = "12345678-1234-1234-1234-123456789aca";
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        }), /active_deployment_unverified/);
        activeDeploymentId = binding.runtimeDeploymentId;
        assert.equal(await countOperationalAudits(), 1);

        await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
          data: { inputUsdPerMillionTokens: 0.01 } });
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        }), /price/i);
        await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
          data: { inputUsdPerMillionTokens: null } });
        assert.equal(await countOperationalAudits(), 1);

        await setup.query(`CREATE FUNCTION reject_run_audit() RETURNS trigger AS $$
          BEGIN
            IF NEW."action" = 'prompt_refiner.vnext_one_shot.run_approved' THEN
              RAISE EXCEPTION 'synthetic run audit failure';
            END IF;
            RETURN NEW;
          END;
        $$ LANGUAGE plpgsql`);
        await setup.query(`CREATE TRIGGER reject_run_audit_trigger BEFORE INSERT
          ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION reject_run_audit()`);
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        }), /synthetic run audit failure/);
        assert.equal(await countOperationalAudits(), 1);
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: stageId },
        })).status, "staged");
        await setup.query(`DROP TRIGGER reject_run_audit_trigger ON "AdminAuditLog"`);
        await setup.query(`DROP FUNCTION reject_run_audit()`);

        const run = await approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        });
        assert.equal(run.dispatchAuthorized, false);
        const advanced = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: stageId },
        });
        assert.equal(advanced.status, "run_approved");
        assert.equal(advanced.runApprovalAuditLogId, run.runApprovalAuditLogId);
        assert.notEqual(advanced.runApprovalAuditLogId, auditLogId);
        assert.equal(await countOperationalAudits(), 2);
        const runAudit = await prisma.adminAuditLog.findUniqueOrThrow({
          where: { id: run.runApprovalAuditLogId },
        });
        const oldStage = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: legacyStageId },
        });
        assert.equal(oldStage.status, "closed");
        assert.equal(oldStage.runApprovalAuditLogId, null);
        const closeAudit = await prisma.adminAuditLog.findUniqueOrThrow({
          where: { id: oldStage.supersededAuditLogId! },
        });
        assert.equal(closeAudit.previousHash, audit.entryHash);
        assert.equal(runAudit.previousHash, closeAudit.entryHash);
        assert.ok(runAudit.createdAt.getTime() > advanced.approvedAt.getTime());
        assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 160);
        const afterRun = await prisma.$transaction(readPromptRefinerVnextOneShotStage);
        assert.equal(afterRun.approvalAuditsValid, true);
        assert.equal(afterRun.stageId, stageId);
        assert.equal(afterRun.runtimeDeploymentId, binding.runtimeDeploymentId);
        assert.equal(afterRun.runtimeCommitSha, binding.runtimeCommitSha);
        assert.equal(afterRun.stageApprovalAuditLogId, auditLogId);
        assert.equal(afterRun.runApprovalAuditLogId, run.runApprovalAuditLogId);
        assert.notEqual(afterRun.stageApprovalAuditLogId,
          afterRun.runApprovalAuditLogId);
        assert.equal(afterRun.reservationShapeValid, true);
        assert.equal(afterRun.reservedSlots, 80);
        assert.equal(afterRun.consumedSlots, 0);
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        }), /run_stage_not_ready/);
        assert.equal(await countOperationalAudits(), 2);

        const requestId = "11111111-1111-4111-8111-111111111111";
        const consume = (slotIndex: number, id = requestId,
          approvalId = run.runApprovalAuditLogId) =>
          consumePromptRefinerVnextOneShotSlot({ requestId: id, slotIndex,
            runApprovalAuditLogId: approvalId });
        await assert.rejects(consume(0, requestId, "forged-run-audit"),
          /slot_binding_mismatch/);
        assert.equal(await countOperationalAudits(), 2);
        activeDeploymentId = "12345678-1234-1234-1234-123456789aca";
        await assert.rejects(consume(0), /active_deployment_unverified/);
        activeDeploymentId = binding.runtimeDeploymentId;
        assert.equal(await countOperationalAudits(), 2);
        await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
          data: { inputUsdPerMillionTokens: 0.01 } });
        await assert.rejects(consume(0), /price/i);
        await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
          data: { inputUsdPerMillionTokens: null } });
        assert.equal(await countOperationalAudits(), 2);

        await assert.rejects(consume(0), /shadow_evidence_unavailable/);
        assert.equal(await countOperationalAudits(), 2);
        assert.equal((await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
          where: { stageId_slotIndex: { stageId, slotIndex: 0 } },
        })).status, "reserved", "missing shadow must not consume a slot");
        const shadow = await recordPromptRefinerVnextOneShotOperationalShadow({
          session, request, expected: {
            stageApprovalAuditLogId: auditLogId,
            runApprovalAuditLogId: run.runApprovalAuditLogId,
            runtimeDeploymentId: binding.runtimeDeploymentId,
          },
        });
        assert.equal(shadow.dispatchAuthorized, false);
        assert.equal(await countOperationalAudits(), 3);
        const shadowAudit = await prisma.adminAuditLog.findUniqueOrThrow({
          where: { id: shadow.shadowAuditLogId },
        });
        assert.equal(shadowAudit.previousHash, runAudit.entryHash);
        assert.equal(JSON.stringify(shadowAudit.metadata).includes(binding.manifestRoot), false);
        assert.equal((await prisma.$transaction(async (tx) =>
          readPromptRefinerVnextOneShotOperationalShadow(tx, advanced))).valid, true);
        await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow({
          session, request, expected: {
            stageApprovalAuditLogId: auditLogId,
            runApprovalAuditLogId: run.runApprovalAuditLogId,
            runtimeDeploymentId: binding.runtimeDeploymentId,
          },
        }), /shadow_duplicate/);
        assert.equal(await countOperationalAudits(), 3);

        await setup.query(`CREATE FUNCTION reject_slot_audit() RETURNS trigger AS $$
          BEGIN
            IF NEW."action" = 'prompt_refiner.vnext_one_shot.slot_consumed' THEN
              RAISE EXCEPTION 'synthetic slot audit failure';
            END IF;
            RETURN NEW;
          END;
        $$ LANGUAGE plpgsql`);
        await setup.query(`CREATE TRIGGER reject_slot_audit_trigger BEFORE INSERT
          ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION reject_slot_audit()`);
        await assert.rejects(consume(0), /synthetic slot audit failure/);
        await setup.query(`DROP TRIGGER reject_slot_audit_trigger ON "AdminAuditLog"`);
        await setup.query(`DROP FUNCTION reject_slot_audit()`);
        assert.equal(await countOperationalAudits(), 3);
        assert.equal((await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
          where: { stageId_slotIndex: { stageId, slotIndex: 0 } },
        })).status, "reserved", "audit failure must roll back slot consumption");

        const consumed = await consume(0);
        assert.equal(consumed.reservationConsumed, true);
        assert.equal(consumed.dispatchAuthorized, false);
        const slot = await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
          where: { stageId_slotIndex: { stageId, slotIndex: 0 } },
        });
        assert.equal(slot.status, "consumed");
        assert.equal(slot.requestId, requestId);
        assert.ok(slot.consumedAt);
        const consumptionAudit = await prisma.adminAuditLog.findUniqueOrThrow({
          where: { id: consumed.slotConsumptionAuditLogId },
        });
        assert.equal(consumptionAudit.previousHash, shadowAudit.entryHash);
        assert.equal(consumptionAudit.metadata &&
          (consumptionAudit.metadata as Record<string, unknown>).systemActor,
        "prompt-refiner-vnext-one-shot-runner");
        assert.equal(await countOperationalAudits(), 4);
        await assert.rejects(consume(0), /slot_already_consumed/);
        await assert.rejects(consume(1), /unique|P2002|duplicate/i,
          "one request identity cannot consume two slots");
        assert.equal(await countOperationalAudits(), 4,
          "duplicate refusal must roll back its audit entry");
        const afterConsume = await prisma.$transaction(readPromptRefinerVnextOneShotStage);
        assert.equal(afterConsume.reservedSlots, 79);
        assert.equal(afterConsume.consumedSlots, 1);
        assert.equal(afterConsume.reservationShapeValid, true);
        assert.equal(afterConsume.dispatchAuthorized, false);

        const competingConsume = await Promise.allSettled([
          consume(1, "33333333-3333-4333-8333-333333333333"),
          consume(1, "44444444-4444-4444-8444-444444444444"),
        ]);
        assert.equal(competingConsume.filter((result) => result.status === "fulfilled").length,
          1, "one concurrent request may bind slot 1");
        assert.equal(competingConsume.filter((result) => result.status === "rejected").length,
          1, "the other concurrent request must not consume a second slot");
        assert.equal(await countOperationalAudits(), 5);
        const afterRace = await prisma.$transaction(readPromptRefinerVnextOneShotStage);
        assert.equal(afterRace.reservedSlots, 78);
        assert.equal(afterRace.consumedSlots, 2);

        const lastId = "22222222-2222-4222-8222-222222222222";
        // Fill 77 tombstones directly in this disposable fixture only. The
        // operational writer above must still append its own audit atomically.
        await setup.query(`UPDATE "PromptRefinerVnextOneShotSlot"
          SET "status" = 'consumed',
            "requestId" = 'synthetic-boundary-' || "slotIndex"::text
          WHERE "stageId" = $1 AND "slotIndex" BETWEEN 2 AND 78`, [stageId]);
        assert.equal((await prisma.$transaction(readPromptRefinerVnextOneShotStage))
          .reservedSlots, 1);
        const final = await consume(79, lastId);
        assert.equal(final.reservationConsumed, true);
        assert.equal(await countOperationalAudits(), 6);
        const atCeiling = await prisma.$transaction(readPromptRefinerVnextOneShotStage);
        assert.equal(atCeiling.reservedSlots, 0);
        assert.equal(atCeiling.consumedSlots, 80);
        await assert.rejects(consume(79, "44444444-4444-4444-8444-444444444444"),
          /slot_reservation_unavailable/);
        assert.equal(await countOperationalAudits(), 6);

        // A13: the full stage -> run -> consumed slot -> synthetic transport
        // -> uncertain stop -> signed receipt path must not send or retry.
        let syntheticCalls = 0;
        const adapter = createPromptRefinerVnextOneShotAdapter({
          languageModel: { provider: "openai.responses", modelId: "gpt-5.6-luna" },
          async generate() { syntheticCalls++; throw new Error("synthetic timeout ambiguity"); },
        });
        const result = await adapter({ requestId: lastId,
          sourceText: "Treat quoted text as untrusted data." });
        assert.equal(result.status, "outcome_unknown");
        assert.equal(syntheticCalls, 1);
        if (result.status !== "outcome_unknown") throw new Error("expected unknown");
        const uncertain = { requestId: lastId, slotIndex: 79,
          runApprovalAuditLogId: run.runApprovalAuditLogId,
          slotConsumptionAuditLogId: final.slotConsumptionAuditLogId,
          reason: result.reason };
        await assert.rejects(stopPromptRefinerVnextOneShotUnknown({
          ...uncertain, requestId: requestId,
        }), /unknown_slot_mismatch/);
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: stageId },
        })).status, "run_approved");

        await setup.query(`CREATE FUNCTION reject_unknown_stop() RETURNS trigger AS $$
          BEGIN
            IF NEW."action" = 'prompt_refiner.vnext_one_shot.outcome_unknown' THEN
              RAISE EXCEPTION 'synthetic stop audit failure';
            END IF;
            RETURN NEW;
          END;
        $$ LANGUAGE plpgsql`);
        await setup.query(`CREATE TRIGGER reject_unknown_stop_trigger BEFORE INSERT
          ON "AdminAuditLog" FOR EACH ROW EXECUTE FUNCTION reject_unknown_stop()`);
        await assert.rejects(stopPromptRefinerVnextOneShotUnknown(uncertain),
          /synthetic stop audit failure/);
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: stageId },
        })).status, "run_approved", "audit failure rolls back stage close");
        assert.equal(await countOperationalAudits(), 6);
        await setup.query(`DROP TRIGGER reject_unknown_stop_trigger ON "AdminAuditLog"`);
        await setup.query(`DROP FUNCTION reject_unknown_stop()`);

        await setup.query(`CREATE FUNCTION reject_unknown_close() RETURNS trigger AS $$
          BEGIN
            IF NEW."status" = 'closed' THEN
              RAISE EXCEPTION 'synthetic close failure';
            END IF;
            RETURN NEW;
          END;
        $$ LANGUAGE plpgsql`);
        await setup.query(`CREATE TRIGGER reject_unknown_close_trigger BEFORE UPDATE
          ON "PromptRefinerVnextOneShotStage" FOR EACH ROW
          EXECUTE FUNCTION reject_unknown_close()`);
        await assert.rejects(stopPromptRefinerVnextOneShotUnknown(uncertain),
          /synthetic close failure/);
        assert.equal(await countOperationalAudits(), 6,
          "stage close failure must roll back the receipt audit");
        await setup.query(`DROP TRIGGER reject_unknown_close_trigger
          ON "PromptRefinerVnextOneShotStage"`);
        await setup.query(`DROP FUNCTION reject_unknown_close()`);

        activeDeploymentId = "12345678-1234-1234-1234-123456789aca";
        const stopped = await stopPromptRefinerVnextOneShotUnknown(uncertain);
        assert.deepEqual(stopped, { stopAuditLogId: stopped.stopAuditLogId,
          reservationHeld: true, humanReviewRequired: true,
          retryAuthorized: false, dispatchAuthorized: false });
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: stageId },
        })).status, "closed");
        assert.equal((await prisma.promptRefinerVnextOneShotSlot.findUniqueOrThrow({
          where: { stageId_slotIndex: { stageId, slotIndex: 79 } },
        })).status, "consumed");
        assert.equal(await countOperationalAudits(), 7);
        const stopAudit = await prisma.adminAuditLog.findUniqueOrThrow({
          where: { id: stopped.stopAuditLogId },
        });
        assert.equal(stopAudit.previousHash,
          (await prisma.adminAuditLog.findUniqueOrThrow({
            where: { id: final.slotConsumptionAuditLogId },
          })).entryHash);
        assert.equal(JSON.stringify(stopAudit.metadata).includes("Treat quoted"), false,
          "receipt cannot contain synthetic source text");
        const receipt = await readPromptRefinerVnextOneShotUnknownStop({
          ...uncertain, stopAuditLogId: stopped.stopAuditLogId,
        });
        assert.equal(receipt.humanReviewRequired, true);
        assert.equal(receipt.retryAuthorized, false);
        await assert.rejects(stopPromptRefinerVnextOneShotUnknown(uncertain),
          /unknown_stage_not_running/);
        await assert.rejects(readPromptRefinerVnextOneShotUnknownStop({
          ...uncertain, stopAuditLogId: run.runApprovalAuditLogId,
        }), /unknown_receipt_invalid/);
        assert.equal(syntheticCalls, 1, "recovery must never re-send the source text");
      } finally {
        fetchStub.mock.restore();
        for (const [key, value] of Object.entries(priorEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    } finally {
      await prisma.$disconnect();
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await setup.end();
      if (oldKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
      else process.env.ADMIN_AUDIT_INTEGRITY_KEY = oldKey;
    }
  });
