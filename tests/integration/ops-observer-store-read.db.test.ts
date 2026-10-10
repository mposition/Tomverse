// The ops-observer state read against real migrations (docs/policy/sre-ops.md
// §3 rule 7): it gathers the trust facts in one bounded transaction and
// answers `trusted` with the state, or only the reason. The ops migrations are
// applied to a throwaway schema beside an AdminAuditLog with the real columns,
// and the store is given a Prisma client on that schema, so the genesis rows a
// run cannot delete never reach a shared one.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { computeAdminAuditEntryHash } from "../../lib/adminAuditIntegrityCore";
import { S2_PAGE_KEYS, initialKeyState } from "../../scripts/ops-observer/classify-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = [
  "20261003060000_ops_observer_transaction_arm",
  "20261003070000_ops_observer_genesis_state",
  "20261003090000_ops_observer_delivery",
  "20261004030000_ops_observer_transition",
  "20261005030000_ops_observer_retention_deadline",
  "20261008020000_ops_observer_run_guard",
  "20261009120000_ops_observer_deferred_item",
].map((name) => path.resolve(here, `../../prisma/migrations/${name}/migration.sql`));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_store_${randomUUID().replaceAll("-", "")}`;
const KEY = "store-read-test-integrity-key-0123456789abcdef";
const DIGEST = "c".repeat(64);
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

test("the ops-observer state read", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  process.env.DATABASE_URL ||= rawUrl;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
  const { readOpsObserverState } = await import("@/lib/opsObserverStore");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const schemaUrl = new URL(rawUrl!);
  schemaUrl.searchParams.set("schema", schema);
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const read = () => readOpsObserverState(inSeconds(120), client);

  try {
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    await q(`CREATE TABLE "AdminAuditLog" (
      id TEXT PRIMARY KEY, "actorUserId" TEXT, "actorEmail" TEXT, action TEXT NOT NULL,
      "targetType" TEXT NOT NULL, "targetId" TEXT, summary TEXT NOT NULL, metadata JSONB,
      "ipAddress" TEXT, "userAgent" TEXT, "previousHash" TEXT, "entryHash" TEXT UNIQUE,
      "createdAt" TIMESTAMP(3) NOT NULL)`);
    await q(`CREATE TABLE "AgentDigestItem" (id UUID PRIMARY KEY)`);
    for (const file of migrations) await q(await readFile(file, "utf8"));

    await t.test("with no genesis the state is missing", async () => {
      assert.deepEqual(await read(), { trust: "state_missing" });
    });

    const genesisId = randomUUID();
    const keys = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
    await t.test("an approved genesis with its state reads as trusted", async () => {
      const createdAt = "2026-10-05T00:00:00.000";
      const entry = {
        previousHash: null,
        actorUserId: "owner-1",
        actorEmail: "owner@example.test",
        action: "ops_observer.genesis_created",
        targetType: "OpsObserverGenesis",
        targetId: genesisId,
        summary: "Initial genesis.",
        metadata: { requestDigest: DIGEST, supersedesGenesisId: null, mode: "shadow" },
        ipAddress: null,
        userAgent: null,
        createdAt: `${createdAt}Z`,
      };
      await q("BEGIN");
      await q(
        `INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
         VALUES ($1, 'initial', 'shadow', NULL, $2, 1, clock_timestamp() + interval '60 seconds')`,
        [genesisId, DIGEST],
      );
      await q(
        `INSERT INTO "AdminAuditLog" (id, "actorUserId", "actorEmail", action, "targetType", "targetId", summary, metadata,
           "previousHash", "entryHash", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10)`,
        [randomUUID(), entry.actorUserId, entry.actorEmail, entry.action, entry.targetType, entry.targetId, entry.summary,
          JSON.stringify(entry.metadata), computeAdminAuditEntryHash(entry, KEY), createdAt],
      );
      await q(
        `INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
           "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
         VALUES ($1, 0, $2, 0, 0, '', '', clock_timestamp() + interval '60 seconds')`,
        [genesisId, JSON.stringify(keys)],
      );
      await q("COMMIT");
      assert.deepEqual(await read(), { trust: "trusted", genesisId, mode: "shadow", generation: 0, keys, reservedOpen: false });
    });

    await t.test("without an integrity key, or with the wrong one, the chain is not trusted", async () => {
      delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
      const nextAuth = process.env.NEXTAUTH_SECRET;
      delete process.env.NEXTAUTH_SECRET;
      try {
        assert.deepEqual(await read(), { trust: "audit_key_missing" });
        process.env.ADMIN_AUDIT_INTEGRITY_KEY = "a-different-integrity-key-0123456789abcdef";
        assert.deepEqual(await read(), { trust: "audit_unverified" });
      } finally {
        process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
        if (nextAuth !== undefined) process.env.NEXTAUTH_SECRET = nextAuth;
      }
      assert.equal((await read()).trust, "trusted");
    });

    await t.test("keys written past the trigger no longer match the stamp", async () => {
      const bent = { ...keys, [S2_PAGE_KEYS[0]]: { ...initialKeyState(), streak: 1 } };
      await q(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverState" SET keys = $2 WHERE "genesisId" = $1`, [genesisId, JSON.stringify(bent)]);
      } finally {
        await q(`ALTER TABLE "OpsObserverState" ENABLE TRIGGER USER`);
      }
      assert.deepEqual(await read(), { trust: "unenforced_write" });
      // Keys outside the closed schema are refused before the stamp is looked at.
      await q(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverState" SET keys = '{"extra":1}' WHERE "genesisId" = $1`, [genesisId]);
      } finally {
        await q(`ALTER TABLE "OpsObserverState" ENABLE TRIGGER USER`);
      }
      assert.deepEqual(await read(), { trust: "schema" });
    });

    await t.test("a checkpoint whose stamp the trigger did not write is not trusted", async () => {
      const restoreKeys = `UPDATE "OpsObserverState" SET keys = $2,
          "stampKeysSha256" = encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex') WHERE "genesisId" = $1`;
      await q(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER USER`);
      try {
        await q(restoreKeys, [genesisId, JSON.stringify(keys)]);
      } finally {
        await q(`ALTER TABLE "OpsObserverState" ENABLE TRIGGER USER`);
      }
      assert.equal((await read()).trust, "trusted");
      // Checkpoint fields written past the trigger leave the stored stamp
      // describing a different checkpoint than the row holds.
      await q(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverState" SET "stampCheckpointSha256" = $2 WHERE "genesisId" = $1`, [genesisId, "f".repeat(64)]);
      } finally {
        await q(`ALTER TABLE "OpsObserverState" ENABLE TRIGGER USER`);
      }
      assert.deepEqual(await read(), { trust: "unenforced_write" });
      await q(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER USER`);
      try {
        await q(
          `UPDATE "OpsObserverState" SET "stampCheckpointSha256" = encode(sha256(convert_to('0::', 'UTF8')), 'hex') WHERE "genesisId" = $1`,
          [genesisId],
        );
      } finally {
        await q(`ALTER TABLE "OpsObserverState" ENABLE TRIGGER USER`);
      }
      assert.equal((await read()).trust, "trusted");
    });

    await t.test("a dropped guard is a missing invariant", async () => {
      await q(`DROP TRIGGER "OpsObserverTransition_no_truncate" ON "OpsObserverTransition"`);
      // The schema check comes first; restore valid keys under their real stamp.
      await q(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER USER`);
      try {
        await q(
          `UPDATE "OpsObserverState" SET keys = $2, "stampKeysSha256" = encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex')
            WHERE "genesisId" = $1`,
          [genesisId, JSON.stringify(keys)],
        );
      } finally {
        await q(`ALTER TABLE "OpsObserverState" ENABLE TRIGGER USER`);
      }
      assert.deepEqual(await read(), { trust: "invariants_missing" });
    });
  } finally {
    await client.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
