// The ops-observer advance against real migrations (docs/policy/sre-ops.md §3
// rules 3, 7, 9 and 10): state, checkpoint, audit entry and ledger row commit
// together; a stale base or an untrusted chain writes nothing; unchanged keys
// write nothing; an open reservation is closed as abandoned and holds the
// heartbeat; and every advanced state still reads as trusted. Runs on a
// throwaway schema, with the store given a Prisma client on it.

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
].map((name) => path.resolve(here, `../../prisma/migrations/${name}/migration.sql`));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_advance_${randomUUID().replaceAll("-", "")}`;
const KEY = "store-advance-test-integrity-key-0123456789abcdef";
const DIGEST = "e".repeat(64);
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

test("the ops-observer advance", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  process.env.DATABASE_URL ||= rawUrl;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
  const { advanceOpsObserverState, readOpsObserverState } = await import("@/lib/opsObserverStore");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const read = () => readOpsObserverState(inSeconds(120), client);
  const genesisId = randomUUID();
  const initial = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
  const withStreak = (n: number) => ({ ...initial, [S2_PAGE_KEYS[0]]: { ...initialKeyState(), streak: n } });
  const advance = (baseGeneration: number, keys: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    advanceOpsObserverState(
      { runDeadline: inSeconds(150), runId: `run-${randomUUID().slice(0, 8)}`, baseGenesisId: genesisId, baseGeneration, keys, reservation: null, ...extra },
      client,
    );
  const counts = async () => {
    const { rows } = await q(`SELECT
        (SELECT generation FROM "OpsObserverState" WHERE "genesisId" = $1) AS generation,
        (SELECT count(*)::int FROM "OpsObserverTransition" WHERE "genesisId" = $1) AS ledger,
        (SELECT count(*)::int FROM "AdminAuditLog" WHERE action = 'ops_observer.state_advanced') AS audits`, [genesisId]);
    return rows[0];
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

    // An approved initial genesis, as the Admin route will write it.
    const createdAt = "2026-10-05T00:00:00.000";
    const entry = {
      previousHash: null, actorUserId: "owner-1", actorEmail: "owner@example.test",
      action: "ops_observer.genesis_created", targetType: "OpsObserverGenesis", targetId: genesisId,
      summary: "Initial genesis.", metadata: { requestDigest: DIGEST, supersedesGenesisId: null, mode: "shadow" },
      ipAddress: null, userAgent: null, createdAt: `${createdAt}Z`,
    };
    await q("BEGIN");
    await q(`INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
             VALUES ($1, 'initial', 'shadow', NULL, $2, 1, clock_timestamp() + interval '60 seconds')`, [genesisId, DIGEST]);
    await q(`INSERT INTO "AdminAuditLog" (id, "actorUserId", "actorEmail", action, "targetType", "targetId", summary, metadata, "entryHash", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [randomUUID(), entry.actorUserId, entry.actorEmail, entry.action, entry.targetType, entry.targetId, entry.summary,
        JSON.stringify(entry.metadata), computeAdminAuditEntryHash(entry, KEY), createdAt]);
    await q(`INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
               "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
             VALUES ($1, 0, $2, 0, 0, '', '', clock_timestamp() + interval '60 seconds')`, [genesisId, JSON.stringify(initial)]);
    await q("COMMIT");
    assert.equal((await read()).trust, "trusted");

    await t.test("an advance writes the state, its audit entry and its ledger row together, and reads as trusted", async () => {
      assert.deepEqual(await advance(0, withStreak(1)), { result: "advanced", sendPermitted: false, deliveryId: null, heartbeatWithheld: false, generation: 1 });
      assert.deepEqual(await counts(), { generation: 1, ledger: 1, audits: 1 });
      const second = await advance(1, withStreak(2));
      assert.equal(second.result, "advanced");
      // The checkpoint moved to the generation before, with that row's audit entry.
      const { rows } = await q(`SELECT s."verifiedThroughGeneration" AS v, s."verifiedThroughAuditId" = t."auditLogId" AS same
                                  FROM "OpsObserverState" s JOIN "OpsObserverTransition" t
                                    ON t."genesisId" = s."genesisId" AND t.generation = 1 WHERE s."genesisId" = $1`, [genesisId]);
      assert.deepEqual(rows[0], { v: 1, same: true });
      const state = await read();
      assert.equal(state.trust, "trusted");
      assert.equal((state as { generation: number }).generation, 2);
      // Ten more: the checkpoint keeps up, so the ledger read stays one or two rows.
      for (let g = 2; g < 12; g += 1) assert.equal((await advance(g, withStreak(g % 2))).result, "advanced");
      assert.equal((await read()).trust, "trusted");
    });

    await t.test("a stale base or an untrusted chain writes nothing", async () => {
      const before = await counts();
      assert.deepEqual(await advance(3, withStreak(1)), { result: "conflict", sendPermitted: false });
      assert.deepEqual(await advanceOpsObserverState(
        { runDeadline: inSeconds(150), runId: "run-x", baseGenesisId: randomUUID(), baseGeneration: before.generation, keys: initial, reservation: null },
        client,
      ), { result: "conflict", sendPermitted: false });
      process.env.ADMIN_AUDIT_INTEGRITY_KEY = "another-integrity-key-0123456789abcdef";
      try {
        assert.deepEqual(await advance(before.generation, initial), { result: "untrusted", trust: "audit_unverified", sendPermitted: false });
      } finally {
        process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
      }
      assert.deepEqual(await counts(), before);
    });

    await t.test("unchanged keys with nothing to close write nothing", async () => {
      const before = await counts();
      const { rows } = await q(`SELECT keys FROM "OpsObserverState" WHERE "genesisId" = $1`, [genesisId]);
      // The same value in another key order is the same state.
      const reordered = Object.fromEntries(Object.entries(rows[0].keys as Record<string, unknown>).reverse());
      assert.deepEqual(await advance(before.generation, reordered), {
        result: "noop", sendPermitted: false, heartbeatWithheld: false, generation: before.generation,
      });
      assert.deepEqual(await counts(), before);
    });

    await t.test("an open reservation is closed as abandoned and holds the heartbeat", async () => {
      const before = await counts();
      const deliveryId = randomUUID();
      await q(`INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "invariantVersion", "stampStatus", "runDeadlineAt")
               VALUES ($1, $2, 'shadow', 'run-left-open', 'reserved', '2026-10-05', 0, 'reserved', clock_timestamp() + interval '60 seconds')`,
        [deliveryId, genesisId]);
      const { rows: keyRows } = await q(`SELECT keys FROM "OpsObserverState" WHERE "genesisId" = $1`, [genesisId]);
      // Same keys: the abandon alone is a change and is recorded.
      const result = await advance(before.generation, keyRows[0].keys);
      assert.deepEqual(result, { result: "advanced", sendPermitted: false, deliveryId: null, heartbeatWithheld: true, generation: before.generation + 1 });
      const { rows } = await q(`SELECT status FROM "OpsObserverDelivery" WHERE id = $1`, [deliveryId]);
      assert.equal(rows[0].status, "abandoned");
      const audit = await q(`SELECT metadata FROM "AdminAuditLog" WHERE action = 'ops_observer.state_advanced'
                              ORDER BY "createdAt" DESC, id DESC LIMIT 1`);
      assert.deepEqual(audit.rows[0].metadata.abandonedDeliveryIds, [deliveryId]);
      // A noop afterwards still reports the hold.
      const again = await advance(before.generation + 1, keyRows[0].keys);
      assert.deepEqual(again, { result: "noop", sendPermitted: false, heartbeatWithheld: true, generation: before.generation + 1 });
      assert.equal((await read()).trust, "trusted");
    });

    // A recovery genesis after the first, the seven-day rule met by moving the
    // first genesis back past its guard (fixture only).
    const recoveryId = randomUUID();
    await t.test("a reservation left by a replaced genesis is closed by the next advance", async () => {
      const leftOpen = randomUUID();
      await q(`INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "invariantVersion", "stampStatus", "runDeadlineAt")
               VALUES ($1, $2, 'shadow', 'run-left-by-old-genesis', 'reserved', '2026-10-05', 0, 'reserved', clock_timestamp() + interval '60 seconds')`,
        [leftOpen, genesisId]);
      await q(`ALTER TABLE "OpsObserverGenesis" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverGenesis" SET "createdAt" = clock_timestamp() - interval '8 days' WHERE id = $1`, [genesisId]);
      } finally {
        await q(`ALTER TABLE "OpsObserverGenesis" ENABLE TRIGGER USER`);
      }
      const at = "2026-10-05T00:00:01.000";
      const entry = {
        previousHash: null, actorUserId: "owner-1", actorEmail: "owner@example.test",
        action: "ops_observer.genesis_created", targetType: "OpsObserverGenesis", targetId: recoveryId,
        summary: "Recovery genesis.", metadata: { requestDigest: DIGEST, supersedesGenesisId: genesisId, mode: "shadow" },
        ipAddress: null, userAgent: null, createdAt: `${at}Z`,
      };
      await q("BEGIN");
      await q(`INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
               VALUES ($1, 'recovery', 'shadow', $2, $3, 1, clock_timestamp() + interval '60 seconds')`, [recoveryId, genesisId, DIGEST]);
      await q(`INSERT INTO "AdminAuditLog" (id, "actorUserId", "actorEmail", action, "targetType", "targetId", summary, metadata, "entryHash", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [randomUUID(), entry.actorUserId, entry.actorEmail, entry.action, entry.targetType, entry.targetId, entry.summary,
          JSON.stringify(entry.metadata), computeAdminAuditEntryHash(entry, KEY), at]);
      await q(`INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
                 "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
               VALUES ($1, 0, $2, 0, 0, '', '', clock_timestamp() + interval '60 seconds')`, [recoveryId, JSON.stringify(initial)]);
      await q("COMMIT");
      assert.equal((await read()).trust, "trusted");

      const result = await advance(0, withStreak(1), { baseGenesisId: recoveryId });
      assert.deepEqual(result, { result: "advanced", sendPermitted: false, deliveryId: null, heartbeatWithheld: true, generation: 1 });
      const { rows } = await q(`SELECT status FROM "OpsObserverDelivery" WHERE id = $1`, [leftOpen]);
      assert.equal(rows[0].status, "abandoned");
    });

    await t.test("an advance that loses the race to another writes nothing at all", async () => {
      const pending = randomUUID();
      await q(`INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "invariantVersion", "stampStatus", "runDeadlineAt")
               VALUES ($1, $2, 'shadow', 'run-open-during-race', 'reserved', '2026-10-05', 0, 'reserved', clock_timestamp() + interval '60 seconds')`,
        [pending, recoveryId]);
      const ledgerBefore = (await q(`SELECT count(*)::int AS n FROM "OpsObserverTransition"`)).rows[0].n;
      const auditBefore = (await q(`SELECT count(*)::int AS n FROM "AdminAuditLog"`)).rows[0].n;

      // Another writer holds the state row and moves the generation while this
      // advance is between reading its facts and taking the base.
      const other = new pg.Client({ connectionString: rawUrl });
      await other.connect();
      try {
        await other.query(`SET search_path TO "${schema}"`);
        await other.query("BEGIN");
        await other.query(`SELECT 1 FROM "OpsObserverState" WHERE "genesisId" = $1 FOR UPDATE`, [recoveryId]);
        const racing = advance(1, withStreak(2), { baseGenesisId: recoveryId });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await other.query(
          `UPDATE "OpsObserverState" SET generation = generation + 1, keys = $2, "runDeadlineAt" = clock_timestamp() + interval '60 seconds'
            WHERE "genesisId" = $1`,
          [recoveryId, JSON.stringify(withStreak(3))],
        );
        await other.query("COMMIT");
        assert.deepEqual(await racing, { result: "conflict", sendPermitted: false });
      } finally {
        await other.query("ROLLBACK").catch(() => undefined);
        await other.end();
      }
      const { rows } = await q(`SELECT status FROM "OpsObserverDelivery" WHERE id = $1`, [pending]);
      assert.equal(rows[0].status, "reserved", "the losing advance must not have closed the reservation");
      assert.equal((await q(`SELECT count(*)::int AS n FROM "OpsObserverTransition"`)).rows[0].n, ledgerBefore);
      assert.equal((await q(`SELECT count(*)::int AS n FROM "AdminAuditLog"`)).rows[0].n, auditBefore);
    });
  } finally {
    await client.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
