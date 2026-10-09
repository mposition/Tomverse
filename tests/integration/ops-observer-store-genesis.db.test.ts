// The owner's ops-observer genesis against real migrations
// (docs/policy/sre-ops.md §8, §9 D5b): the approval binds the head the owner
// looked at, the reason must fit the chain, a head younger than seven days
// refuses, and a created genesis -- with its owner audit entry and its
// generation-0 state -- is what the state read then trusts. Throwaway schema,
// as in the other store tests, so the genesis rows never reach a shared one.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Session } from "next-auth";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = [
  "20261003060000_ops_observer_transaction_arm",
  "20261003070000_ops_observer_genesis_state",
  "20261003090000_ops_observer_delivery",
  "20261004030000_ops_observer_transition",
  "20261005030000_ops_observer_retention_deadline",
  "20261008020000_ops_observer_run_guard",
].map((name) => path.resolve(here, `../../prisma/migrations/${name}/migration.sql`));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_genesis_${randomUUID().replaceAll("-", "")}`;
const KEY = "store-genesis-test-integrity-key-0123456789abcdef";
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);
const session = { user: { id: "owner-1", email: "owner@example.test", role: "owner" }, expires: "2099-01-01" } as unknown as Session;

test("the ops-observer genesis", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  process.env.DATABASE_URL ||= rawUrl;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
  const { createOpsObserverGenesis, readOpsObserverAdminView, readOpsObserverState } = await import("@/lib/opsObserverStore");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  type Trusted = { trust: string; genesisId: string; mode: string; generation: number };
  const read = async () => (await readOpsObserverState(inSeconds(120), client)) as Trusted;
  const genesis = (input: Record<string, unknown>) =>
    createOpsObserverGenesis({ session, ...input } as Parameters<typeof createOpsObserverGenesis>[0], client);
  const counts = async () => {
    const { rows } = await q(`SELECT (SELECT count(*) FROM "OpsObserverGenesis")::int AS g,
      (SELECT count(*) FROM "OpsObserverState")::int AS s, (SELECT count(*) FROM "AdminAuditLog")::int AS a`);
    return rows[0];
  };
  // The trigger stamps createdAt from the clock; a test ages the head past the seven days.
  const age = async (genesisId: string, days: number) => {
    await q(`ALTER TABLE "OpsObserverGenesis" DISABLE TRIGGER USER`);
    try {
      await q(`UPDATE "OpsObserverGenesis" SET "createdAt" = "createdAt" - make_interval(days => $2) WHERE id = $1`, [genesisId, days]);
    } finally {
      await q(`ALTER TABLE "OpsObserverGenesis" ENABLE TRIGGER USER`);
    }
  };

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

    const none = { expectedGenesisId: null, expectedGeneration: null, expectedMode: null, trustReason: "state_missing" };
    let first = "";

    await t.test("an initial genesis that is not shadow is refused and writes nothing", async () => {
      assert.deepEqual(await readOpsObserverAdminView(client), { head: null, trustReason: "state_missing", nextGenesisAt: null, genesisAllowedNow: true });
      assert.deepEqual(await genesis({ ...none, reason: "initial", mode: "live" }), { result: "transition_refused" });
      assert.deepEqual(await genesis({ ...none, reason: "recovery", mode: "shadow" }), { result: "transition_refused" });
      assert.deepEqual(await counts(), { g: 0, s: 0, a: 0 });
    });

    await t.test("the initial genesis creates the chain the state read trusts", async () => {
      const created = await genesis({ ...none, reason: "initial", mode: "shadow" });
      assert.equal(created.result, "created");
      first = (created as { genesisId: string }).genesisId;
      const state = await read();
      assert.equal(state.trust, "trusted");
      assert.deepEqual([state.genesisId, state.mode, state.generation], [first, "shadow", 0]);
      const { rows } = await q(`SELECT "actorUserId", action, metadata FROM "AdminAuditLog"`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].actorUserId, "owner-1");
      assert.equal(rows[0].action, "ops_observer.genesis_created");
      assert.equal(rows[0].metadata.requestDigest, (created as { requestDigest: string }).requestDigest);
      const view = await readOpsObserverAdminView(client);
      assert.deepEqual([view.head?.genesisId, view.head?.generation, view.head?.mode, view.trustReason],
        [first, 0, "shadow", "trusted"]);
      assert.equal(Date.parse(view.nextGenesisAt!) - Date.parse(view.head!.createdAt), 7 * 24 * 60 * 60 * 1000);
      assert.equal(view.genesisAllowedNow, false);
    });

    const current = () => ({ expectedGenesisId: first, expectedGeneration: 0, expectedMode: "shadow", trustReason: "trusted" });

    await t.test("an approval of a head that is no longer current is stale", async () => {
      assert.deepEqual(await genesis({ ...none, reason: "initial", mode: "shadow" }), { result: "stale" });
      assert.deepEqual(await genesis({ ...current(), trustReason: "state_missing", reason: "activation", mode: "live" }),
        { result: "stale" });
      assert.deepEqual(await genesis({ ...current(), expectedGeneration: 1, reason: "activation", mode: "live" }),
        { result: "stale" });
      assert.deepEqual(await counts(), { g: 1, s: 1, a: 1 });
    });

    await t.test("a trusted chain is not recovered, and a young head is not replaced", async () => {
      assert.deepEqual(await genesis({ ...current(), reason: "recovery", mode: "shadow" }), { result: "transition_refused" });
      assert.deepEqual(await genesis({ ...current(), reason: "activation", mode: "shadow" }), { result: "transition_refused" });
      assert.deepEqual(await genesis({ ...current(), reason: "activation", mode: "live" }), { result: "genesis_too_soon" });
      assert.deepEqual(await counts(), { g: 1, s: 1, a: 1 });
    });

    await t.test("after seven days the owner activates live, and the new head is trusted", async () => {
      await age(first, 8);
      const created = await genesis({ ...current(), reason: "activation", mode: "live" });
      assert.equal(created.result, "created");
      const state = await read();
      assert.equal(state.trust, "trusted");
      assert.deepEqual([state.genesisId, state.mode, state.generation], [(created as { genesisId: string }).genesisId, "live", 0]);
      const { rows } = await q(`SELECT "supersedesGenesisId" FROM "OpsObserverGenesis" WHERE id = $1`, [state.genesisId]);
      assert.equal(rows[0].supersedesGenesisId, first);
      assert.deepEqual(await counts(), { g: 2, s: 2, a: 2 });
    });

    await t.test("a generation committed while the genesis waited is read, and the older approval is stale", async () => {
      const { genesisId: head, trust } = await read();
      const holder = new pg.Client({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
      await holder.connect();
      try {
        // Stands in for an advance: it holds the head state row, and its write
        // (triggers off for this session only) moves the generation on.
        await holder.query("BEGIN");
        await holder.query("SET LOCAL session_replication_role = replica");
        await holder.query(`SELECT 1 FROM "OpsObserverState" WHERE "genesisId" = $1 FOR UPDATE`, [head]);
        let settled = false;
        const pending = genesis({ expectedGenesisId: head, expectedGeneration: 0, expectedMode: "live", trustReason: trust,
          reason: "recovery", mode: "live" }).finally(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(settled, false, "the genesis must not judge while the state row is held");
        await holder.query(
          `UPDATE "OpsObserverState" SET generation = 1, "stampGeneration" = 1 WHERE "genesisId" = $1`, [head]);
        await holder.query("COMMIT");
        // Released, it reads generation 1: the approval of generation 0 is stale.
        assert.deepEqual(await pending, { result: "stale" });
        assert.deepEqual(await counts(), { g: 2, s: 2, a: 2 });
      } finally {
        await holder.end();
      }
    });

    await t.test("a head whose state row is missing is recovered by naming it", async () => {
      const { rows: heads } = await q(`SELECT id FROM "OpsObserverGenesis" g
        WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" x WHERE x."supersedesGenesisId" = g.id)`);
      const head = heads[0].id as string;
      await age(head, 8);
      await q(`ALTER TABLE "OpsObserverState" DISABLE TRIGGER USER`);
      try {
        await q(`DELETE FROM "OpsObserverState" WHERE "genesisId" = $1`, [head]);
      } finally {
        await q(`ALTER TABLE "OpsObserverState" ENABLE TRIGGER USER`);
      }
      assert.deepEqual(await readOpsObserverState(inSeconds(120), client), { trust: "state_missing" });
      const view = await readOpsObserverAdminView(client);
      assert.deepEqual([view.head?.genesisId, view.head?.generation, view.head?.mode, view.trustReason],
        [head, null, "live", "state_missing"]);
      assert.equal(view.genesisAllowedNow, true);
      const missing = { expectedGenesisId: head, expectedGeneration: null, expectedMode: "live", trustReason: "state_missing" };
      // The head is still named: an approval that says there is none is stale.
      assert.deepEqual(await genesis({ ...none, reason: "initial", mode: "shadow" }), { result: "stale" });
      const created = await genesis({ ...missing, reason: "recovery", mode: "live" });
      assert.equal(created.result, "created");
      const state = await read();
      assert.deepEqual([state.trust, state.genesisId, state.mode, state.generation],
        ["trusted", (created as { genesisId: string }).genesisId, "live", 0]);
    });
  } finally {
    await client.$disconnect();
    await pool.end().catch(() => {});
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
});
