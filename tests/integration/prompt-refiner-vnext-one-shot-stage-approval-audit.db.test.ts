import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import pg from "pg";

import { prisma } from "@/lib/prisma";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { writePromptRefinerVnextOneShotStageApprovalAudit } from
  "@/lib/promptRefinerVnextOneShotStageApprovalAudit";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const fixtureKey = "synthetic-chat01-a06-audit-integrity-key";
const stageId = "prompt-refiner-vnext-one-shot-v1";
const binding = {
  id: stageId,
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "e".repeat(40),
  pricePinDigest: "f".repeat(64),
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

      const { auditLogId } = await prisma.$transaction(async (tx) => {
        const approval = await append(tx);
        await insertStage(tx, approval.auditLogId, approval.approvedBy, 80);
        return approval;
      });
      const stage = await prisma.promptRefinerVnextOneShotStage.findUniqueOrThrow({
        where: { id: stageId },
      });
      const audit = await prisma.adminAuditLog.findUniqueOrThrow({
        where: { id: auditLogId },
      });
      assert.equal(stage.stageApprovalAuditLogId, audit.id);
      assert.equal(stage.approvedAt.getTime(), audit.createdAt.getTime());
      assert.match(audit.entryHash ?? "", /^[0-9a-f]{64}$/);
      assert.equal((await prisma.$transaction(readPromptRefinerVnextOneShotStage))
        .approvalAuditsValid, true);
      assert.equal(await prisma.promptRefinerVnextOneShotSlot.count(), 80);
    } finally {
      await prisma.$disconnect();
      await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await setup.end();
      if (oldKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
      else process.env.ADMIN_AUDIT_INTEGRITY_KEY = oldKey;
    }
  });
