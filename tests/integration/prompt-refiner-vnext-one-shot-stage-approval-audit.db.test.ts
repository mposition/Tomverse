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

import { prisma } from "@/lib/prisma";
import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { approvePromptRefinerVnextOneShotRun } from
  "@/lib/promptRefinerVnextOneShotRunApproval";
import { writePromptRefinerVnextOneShotStageApprovalAudit } from
  "@/lib/promptRefinerVnextOneShotStageApprovalAudit";
import { createPromptRefinerVnextOneShotStageWithSlots } from
  "@/lib/promptRefinerVnextOneShotStageWriter";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const fixtureKey = "synthetic-chat01-a06-audit-integrity-key";
const stageId = "prompt-refiner-vnext-one-shot-v1";
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
      const insertStage = async (tx: Prisma.TransactionClient, auditLogId: string,
        approvedBy: string, count: number) => {
        await tx.promptRefinerVnextOneShotStage.create({ data: {
          ...binding, approvedBy, approvedAt: new Date(0), stageApprovalAuditLogId: auditLogId,
        } });
        await tx.promptRefinerVnextOneShotSlot.createMany({ data:
          Array.from({ length: count }, (_, slotIndex) => ({
            id: `synthetic-slot-${slotIndex}`, stageId, slotIndex,
            reservedCostMicroUsd: BigInt(29_918),
          })),
        });
      };

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
      assert.equal(await prisma.adminAuditLog.count(), 0);

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
      assert.equal(await prisma.adminAuditLog.count(), 0);

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
      assert.equal(await prisma.adminAuditLog.count(), 0);
      await setup.query(`DROP TRIGGER reject_stage_audit_trigger ON "AdminAuditLog"`);
      await setup.query(`DROP FUNCTION reject_stage_audit()`);

      // A failure after audit and stage inserts discards both, not an orphan approval.
      await assert.rejects(prisma.$transaction(async (tx) => {
        const { auditLogId, approvedBy } = await append(tx);
        await insertStage(tx, auditLogId, approvedBy, 80);
        throw new Error("synthetic post-stage failure");
      }), /synthetic post-stage failure/);
      assert.equal(await prisma.adminAuditLog.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 0);

      // The deferred 80-slot constraint fails at commit and rolls the audit back.
      await assert.rejects(prisma.$transaction(async (tx) => {
        const { auditLogId, approvedBy } = await append(tx);
        await insertStage(tx, auditLogId, approvedBy, 79);
      }), /exactly 80 reserved slots/);
      assert.equal(await prisma.adminAuditLog.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 0);

      await assert.rejects(prisma.$transaction(async (tx) => {
        const { auditLogId, approvedBy } = await append(tx);
        await insertStage(tx, auditLogId, approvedBy, 81);
      }), /slot|index|constraint/i);
      assert.equal(await prisma.adminAuditLog.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 0);

      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request,
        binding: { ...binding, costCeilingMicroUsd: BigInt(2_393_441) },
      }), /stage_audit_binding_invalid/);
      assert.equal(await prisma.adminAuditLog.count(), 0);
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request,
        binding: { ...binding, pricePinDigest: "f".repeat(64) },
      }), /stage_price_mismatch/);
      assert.equal(await prisma.adminAuditLog.count(), 0);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: 0.01 } });
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding,
      }), /stage_price_mismatch/);
      assert.equal(await prisma.adminAuditLog.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 0);
      await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
        data: { inputUsdPerMillionTokens: null } });

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
      assert.equal(await prisma.adminAuditLog.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 0);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 0);
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
        /unique|P2002|duplicate/i);
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
      assert.equal(readback.reservationShapeValid, true);
      assert.equal(readback.reservedSlots, 80);
      assert.equal(readback.dispatchAuthorized, false);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 80);
      assert.equal(await prisma.adminAuditLog.count(), 1,
        "the refused concurrent approval must not leave an audit row");
      await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots({
        session, request, binding,
      }));
      assert.equal(await prisma.promptRefinerVnextOneShotStage.count(), 1);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 80);
      assert.equal(await prisma.adminAuditLog.count(), 1);

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
        assert.equal(await prisma.adminAuditLog.count(), 1);
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session: { ...session, user: { id: "other-owner", email: "other@example.test" } },
          request, expected,
        }), /run_binding_mismatch/);
        assert.equal(await prisma.adminAuditLog.count(), 1);
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected: { ...expected, manifestRoot: "f".repeat(64) },
        }), /run_binding_mismatch/);
        assert.equal(await prisma.adminAuditLog.count(), 1);
        assert.equal((await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
          where: { id: stageId },
        })).status, "staged");

        activeDeploymentId = "12345678-1234-1234-1234-123456789aca";
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        }), /active_deployment_unverified/);
        activeDeploymentId = binding.runtimeDeploymentId;
        assert.equal(await prisma.adminAuditLog.count(), 1);

        await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
          data: { inputUsdPerMillionTokens: 0.01 } });
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        }), /price/i);
        await prisma.modelRegistryEntry.update({ where: { id: "gpt-5-6-luna" },
          data: { inputUsdPerMillionTokens: null } });
        assert.equal(await prisma.adminAuditLog.count(), 1);

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
        assert.equal(await prisma.adminAuditLog.count(), 1);
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
        assert.equal(await prisma.adminAuditLog.count(), 2);
        const runAudit = await prisma.adminAuditLog.findUniqueOrThrow({
          where: { id: run.runApprovalAuditLogId },
        });
        assert.equal(runAudit.previousHash, audit.entryHash);
        assert.ok(runAudit.createdAt.getTime() > advanced.approvedAt.getTime());
        assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 80);
        const afterRun = await prisma.$transaction(readPromptRefinerVnextOneShotStage);
        assert.equal(afterRun.approvalAuditsValid, true);
        assert.equal(afterRun.reservationShapeValid, true);
        assert.equal(afterRun.reservedSlots, 80);
        assert.equal(afterRun.consumedSlots, 0);
        await assert.rejects(approvePromptRefinerVnextOneShotRun({
          session, request, expected,
        }), /run_stage_not_ready/);
        assert.equal(await prisma.adminAuditLog.count(), 2);
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
