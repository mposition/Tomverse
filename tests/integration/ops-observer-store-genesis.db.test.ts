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
  const { createOpsObserverGenesis, readOpsObserverState } = await import("@/lib/opsObserverStore");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const read = () => readOpsObserverState(inSeconds(120), client);
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
  } finally {
    await client.$disconnect();
    await pool.end().catch(() => {});
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
});
