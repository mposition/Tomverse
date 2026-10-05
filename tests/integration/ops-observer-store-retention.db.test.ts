// The ops-observer retention batch (docs/policy/sre-ops.md §10): closed
// reservations past ninety days are deleted with their items, oldest first and
// up to the limit, with one system audit entry per batch that deleted
// anything; a reserved row and one closed more recently stay, and an empty
// batch writes nothing.

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
].map((name) => path.resolve(here, `../../prisma/migrations/${name}/migration.sql`));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_retention_${randomUUID().replaceAll("-", "")}`;
const KEY = "store-retention-test-integrity-key-0123456789abcdef";
const DIGEST = "b".repeat(64);
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

test("the ops-observer retention batch", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  process.env.DATABASE_URL ||= rawUrl;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
  const { advanceOpsObserverState, confirmOpsObserverDelivery, purgeOpsObserverDeliveries, readOpsObserverState } = await import("@/lib/opsObserverStore");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const initial = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
  let auditSeconds = 0;

  /** An approved genesis with its state, as the Admin route will write it. */
  async function approvedGenesis(reason: string, mode: string, supersedes: string | null) {
    const id = randomUUID();
    auditSeconds += 1;
    const at = `2026-10-05T00:00:${String(auditSeconds).padStart(2, "0")}.000`;
    const entry = {
      previousHash: null, actorUserId: "owner-1", actorEmail: "owner@example.test",
      action: "ops_observer.genesis_created", targetType: "OpsObserverGenesis", targetId: id,
      summary: "Genesis.", metadata: { requestDigest: DIGEST, supersedesGenesisId: supersedes, mode },
      ipAddress: null, userAgent: null, createdAt: `${at}Z`,
    };
    await q("BEGIN");
    await q(`INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
             VALUES ($1, $2, $3, $4, $5, 1, clock_timestamp() + interval '60 seconds')`, [id, reason, mode, supersedes, DIGEST]);
    await q(`INSERT INTO "AdminAuditLog" (id, "actorUserId", "actorEmail", action, "targetType", "targetId", summary, metadata, "entryHash", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [randomUUID(), entry.actorUserId, entry.actorEmail, entry.action, entry.targetType, entry.targetId, entry.summary,
        JSON.stringify(entry.metadata), computeAdminAuditEntryHash(entry, KEY), at]);
    await q(`INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
               "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
             VALUES ($1, 0, $2, 0, 0, '', '', clock_timestamp() + interval '60 seconds')`, [id, JSON.stringify(initial)]);
    await q("COMMIT");
    return id;
  }

  /** A channel-check reservation through the advance; returns its id and run. */
  async function reserve(genesisId: string, ownerDate: string) {
    const state = (await readOpsObserverState(inSeconds(120), client)) as { trust: string; generation: number; keys: Record<string, unknown> };
    assert.equal(state.trust, "trusted");
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const result = await advanceOpsObserverState(
      { runDeadline: inSeconds(150), runId, baseGenesisId: genesisId, baseGeneration: state.generation, keys: state.keys,
        reservation: { ownerDate, channelCheck: true, items: [] } },
      client,
    );
    assert.equal(result.result, "advanced");
    return { deliveryId: (result as { deliveryId: string }).deliveryId, runId, state };
  }
  const confirm = (deliveryId: string, runId: string) =>
    confirmOpsObserverDelivery({ runDeadline: inSeconds(150), deliveryId, runId }, client);

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
    const shadowGenesis = await approvedGenesis("initial", "shadow", null);

    /** Moves a closed reservation's close back by `days` (fixture only: the trigger owns that column). */
    const age = async (id: string, days: number) => {
      await q(`ALTER TABLE "OpsObserverDelivery" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverDelivery" SET "shadowedAt" = "shadowedAt" - make_interval(days => $2),
                   "abandonedAt" = "abandonedAt" - make_interval(days => $2) WHERE id = $1`, [id, days]);
      } finally {
        await q(`ALTER TABLE "OpsObserverDelivery" ENABLE TRIGGER USER`);
      }
    };
    const exists = async (id: string) => (await q(`SELECT 1 FROM "OpsObserverDelivery" WHERE id = $1`, [id])).rowCount === 1;
    const purgeAudits = async () =>
      (await q(`SELECT metadata FROM "AdminAuditLog" WHERE action = 'ops_observer.deliveries_purged' ORDER BY "createdAt"`)).rows
        .map((r) => r.metadata);

    // Three closed reservations and one still reserved.
    const old1 = await reserve(shadowGenesis, "2026-10-01");
    await confirm(old1.deliveryId, old1.runId);
    const old2 = await reserve(shadowGenesis, "2026-10-02");
    await confirm(old2.deliveryId, old2.runId);
    const recent = await reserve(shadowGenesis, "2026-10-03");
    await confirm(recent.deliveryId, recent.runId);
    const open = await reserve(shadowGenesis, "2026-10-04");

    await t.test("nothing past retention: nothing deleted and nothing audited", async () => {
      assert.deepEqual(await purgeOpsObserverDeliveries(500, client), { deleted: 0 });
      assert.deepEqual(await purgeAudits(), []);
    });

    await t.test("closed past ninety days are deleted oldest first, up to the limit, with their items", async () => {
      await age(old1.deliveryId, 120);
      await age(old2.deliveryId, 100);
      await age(recent.deliveryId, 89);
      const itemsBefore = (await q(`SELECT count(*)::int AS n FROM "OpsObserverDeliveryItem"`)).rows[0].n;
      assert.deepEqual(await purgeOpsObserverDeliveries(1, client), { deleted: 1 });
      assert.deepEqual([await exists(old1.deliveryId), await exists(old2.deliveryId)], [false, true]);
      assert.deepEqual(await purgeOpsObserverDeliveries(500, client), { deleted: 1 });
      assert.deepEqual([await exists(old2.deliveryId), await exists(recent.deliveryId), await exists(open.deliveryId)],
        [false, true, true]);
      assert.equal((await q(`SELECT count(*)::int AS n FROM "OpsObserverDeliveryItem"`)).rows[0].n, itemsBefore);
      assert.deepEqual(await purgeAudits(), [1, 2].map(() => ({ count: 1, retentionDays: 90, systemActor: "ops-observer" })));
    });

    await t.test("a reserved row is never deleted, however old", async () => {
      await q(`ALTER TABLE "OpsObserverDelivery" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverDelivery" SET "reservedAt" = "reservedAt" - interval '400 days' WHERE id = $1`, [open.deliveryId]);
      } finally {
        await q(`ALTER TABLE "OpsObserverDelivery" ENABLE TRIGGER USER`);
      }
      assert.deepEqual(await purgeOpsObserverDeliveries(500, client), { deleted: 0 });
      assert.equal(await exists(open.deliveryId), true);
    });

    await t.test("an out-of-range limit is refused before any transaction", async () => {
      for (const limit of [0, 501, 1.5]) {
        await assert.rejects(purgeOpsObserverDeliveries(limit, client), /ops_observer_retention_limit_invalid/);
      }
    });
  } finally {
    await client.$disconnect();
    await pool.end().catch(() => {});
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
});
