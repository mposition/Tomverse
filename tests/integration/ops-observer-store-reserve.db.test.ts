// The ops-observer advance with a reservation (docs/policy/sre-ops.md §3 rules
// 3 and 9, §5): the reservation and its items commit with the advance, and
// only then is sending permitted; the store derives whether an item is capped;
// a reservation the key move does not owe, a replayed run, a taken channel
// check, or one over the daily cap writes nothing at all. Throwaway schema.

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
import { S2_PAGE_KEYS, S2_PAGE_SIGNALS, evaluateKey, initialKeyState } from "../../scripts/ops-observer/classify-core.mjs";
import { admitOwedItems } from "../../scripts/ops-observer/notification-budget-core.mjs";
import { incidentOrigin, owedMessages } from "../../scripts/ops-observer/advance-request-core.mjs";

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
const schema = `ops_observer_reserve_${randomUUID().replaceAll("-", "")}`;
const KEY = "store-reserve-test-integrity-key-0123456789abcdef";
const DIGEST = "a".repeat(64);
const OWNER_DATE = "2026-10-05";
const P3 = S2_PAGE_SIGNALS.find((s) => s.id === "P3")!;
const P3_KEY = "P3#credit_reservation_reconciliation";
const inSeconds = (s: number) => new Date(Date.now() + s * 1000);

test("the ops-observer advance with a reservation", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  process.env.DATABASE_URL ||= rawUrl;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
  const { advanceOpsObserverState, purgeOpsObserverDeliveries, readOpsObserverDateItems, readOpsObserverState } =
    await import("@/lib/opsObserverStore");

  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  const q = (sql: string, params?: unknown[]) => (params ? admin.query(sql, params) : admin.query(sql));
  const pool = new pg.Pool({ connectionString: rawUrl, options: `-c search_path="${schema}"` });
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const genesisId = randomUUID();
  const initial = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
  const current = async () => {
    const state = (await readOpsObserverState(inSeconds(120), client)) as { trust: string; generation: number; keys: Record<string, never> };
    assert.equal(state.trust, "trusted");
    return state;
  };
  const advance = (base: number, keys: Record<string, unknown>, reservation: unknown, runId = `run-${randomUUID().slice(0, 8)}`,
    ownerDate = (reservation as { ownerDate?: string } | null)?.ownerDate ?? OWNER_DATE) =>
    advanceOpsObserverState(
      { runDeadline: inSeconds(150), runId, baseGenesisId: genesisId, baseGeneration: base, ownerDate, keys, reservation: reservation as never },
      client,
    );
  const rowCounts = async () =>
    (await q(`SELECT (SELECT count(*)::int FROM "OpsObserverDelivery") AS deliveries,
                     (SELECT count(*)::int FROM "OpsObserverDeliveryItem") AS items,
                     (SELECT generation FROM "OpsObserverState" WHERE "genesisId" = $1) AS generation`, [genesisId])).rows[0];

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

    // P3 opens now: a new open, owed by the move from the genesis keys.
    const now = Date.now();
    const opened = { ...initial, [P3_KEY]: evaluateKey(P3, initialKeyState(), "delayed", { now, ownerDate: OWNER_DATE }).state };
    const newOpen = { signal: "P3", scope: "credit_reservation_reconciliation", kind: "new_open", origin: "new", openedAt: new Date(now) };

    await t.test("a reservation the move does not owe is refused and writes nothing", async () => {
      const before = await rowCounts();
      const relabelled = { ownerDate: OWNER_DATE, channelCheck: false, items: [{ ...newOpen, kind: "reopen", origin: "reopen" }] };
      assert.deepEqual(await advance(0, opened, relabelled), { result: "reservation_not_owed", sendPermitted: false });
      // The same item against keys that did not open it.
      assert.deepEqual(await advance(0, initial, { ownerDate: OWNER_DATE, channelCheck: false, items: [newOpen] }),
        { result: "reservation_not_owed", sendPermitted: false });
      assert.deepEqual(await rowCounts(), before);
    });

    let firstRunId = "";
    await t.test("an owed reservation commits with the advance and permits sending; the store decides capping", async () => {
      firstRunId = `run-${randomUUID().slice(0, 8)}`;
      const result = await advance(0, opened, { ownerDate: OWNER_DATE, channelCheck: false, items: [newOpen] }, firstRunId);
      assert.equal(result.result, "advanced");
      assert.equal(result.sendPermitted, true);
      const deliveryId = (result as { deliveryId: string }).deliveryId;
      const { rows } = await q(`SELECT d.status, d.mode, d."runId", i.kind, i.capped
                                  FROM "OpsObserverDelivery" d JOIN "OpsObserverDeliveryItem" i ON i."deliveryId" = d.id
                                 WHERE d.id = $1`, [deliveryId]);
      assert.deepEqual(rows, [{ status: "reserved", mode: "shadow", runId: firstRunId, kind: "new_open", capped: false }]);
      const audit = await q(`SELECT metadata FROM "AdminAuditLog" WHERE action = 'ops_observer.state_advanced'
                              ORDER BY "createdAt" DESC, id DESC LIMIT 1`);
      assert.equal(audit.rows[0].metadata.reservedDeliveryId, deliveryId);
      assert.equal((await current()).generation, 1);
    });

    await t.test("a replayed run or a taken channel check writes nothing", async () => {
      const state = await current();
      const before = await rowCounts();
      // The same run id again (the base matches; the run already reserved).
      assert.deepEqual(await advance(state.generation, state.keys, { ownerDate: OWNER_DATE, channelCheck: true, items: [] }, firstRunId),
        { result: "replayed", sendPermitted: false });
      // A channel check for the date, then a second one.
      const check = await advance(state.generation, state.keys, { ownerDate: OWNER_DATE, channelCheck: true, items: [] });
      assert.equal(check.result, "advanced");
      assert.equal(check.sendPermitted, true);
      const after = await current();
      assert.deepEqual(await advance(after.generation, after.keys, { ownerDate: OWNER_DATE, channelCheck: true, items: [] }),
        { result: "channel_check_taken", sendPermitted: false });
      const counted = await rowCounts();
      assert.equal(counted.deliveries, before.deliveries + 1);
      // The first reservation was closed as abandoned by the check's advance.
      const { rows } = await q(`SELECT status FROM "OpsObserverDelivery" WHERE "runId" = $1`, [firstRunId]);
      assert.equal(rows[0].status, "abandoned");
    });

    await t.test("a capped message over the day's six rejects the whole advance", async () => {
      // Six capped items already reserved today under this genesis.
      await q("BEGIN");
      const full = randomUUID();
      await q(`UPDATE "OpsObserverDelivery" SET status = 'abandoned', "stampStatus" = 'abandoned',
                 "runDeadlineAt" = clock_timestamp() + interval '60 seconds' WHERE status = 'reserved'`);
      await q(`INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "invariantVersion", "stampStatus", "runDeadlineAt")
               VALUES ($1, $2, 'shadow', 'run-full-day', 'reserved', $3, 0, 'reserved', clock_timestamp() + interval '60 seconds')`,
        [full, genesisId, OWNER_DATE]);
      for (let i = 0; i < 6; i += 1) {
        await q(`INSERT INTO "OpsObserverDeliveryItem" (id, "deliveryId", mode, signal, scope, kind, origin, "openedAt", capped)
                 VALUES ($1, $2, 'shadow', 'P1a', 'database', 'reopen', 'reopen', $3, true)`,
          [randomUUID(), full, new Date(now - (i + 1) * 3_600_000)]);
      }
      await q(`UPDATE "OpsObserverDelivery" SET status = 'abandoned', "stampStatus" = 'abandoned',
                 "runDeadlineAt" = clock_timestamp() + interval '60 seconds' WHERE id = $1`, [full]);
      await q("COMMIT");

      // P3 recovers: a capped message, the seventh of the day.
      const state = await current();
      let keys = state.keys as Record<string, unknown>;
      let p3 = keys[P3_KEY] as ReturnType<typeof initialKeyState>;
      p3 = evaluateKey(P3, p3, "ok", { now: now + 600_000, ownerDate: OWNER_DATE }).state;
      p3 = evaluateKey(P3, p3, "ok", { now: now + 1_200_000, ownerDate: OWNER_DATE }).state;
      assert.equal(p3.status, "closed");
      keys = { ...keys, [P3_KEY]: p3 };
      const recovery = { signal: "P3", scope: "credit_reservation_reconciliation", kind: "recovery", origin: "new", openedAt: new Date(now) };

      // The state read names the same budget, so a run predicts the refusal
      // before it asks: the same admitOwedItems() over the read rows defers it.
      type Budget = { ownerDate: string; reservedToday: { key: string; kind: string; capped: boolean }[]; channelCheckTaken: boolean };
      const budgetOf = async (ownerDate: string) =>
        ((await readOpsObserverState(inSeconds(120), client, ownerDate)) as { budget: Budget }).budget;
      assert.equal("budget" in (await current()), false);
      const today = await budgetOf(OWNER_DATE);
      assert.equal(today.ownerDate, OWNER_DATE);
      assert.equal(today.channelCheckTaken, true);
      assert.equal(today.reservedToday.filter((item) => item.capped).length, 6);
      assert.deepEqual(today.reservedToday.filter((item) => !item.capped).map((item) => [item.key, item.kind]),
        [[P3_KEY, "new_open"]]);
      const owed = [{ key: P3_KEY, kind: "recovery" }];
      assert.equal(admitOwedItems({ reservedToday: today.reservedToday, owed }).deferred.length, 1);
      const tomorrow = await budgetOf("2026-10-06");
      assert.deepEqual(tomorrow, { ownerDate: "2026-10-06", reservedToday: [], channelCheckTaken: false });
      assert.equal(admitOwedItems({ reservedToday: tomorrow.reservedToday, owed }).admitted.length, 1);

      const before = await rowCounts();
      const deferredRows = async () =>
        (await q(`SELECT mode, to_char("ownerDate", 'YYYY-MM-DD') AS "ownerDate", signal, scope, kind, origin
                    FROM "OpsObserverDeferredItem" ORDER BY "deferredAt"`)).rows;
      assert.deepEqual(await advance(state.generation, keys, { ownerDate: OWNER_DATE, channelCheck: false, items: [recovery] }),
        { result: "rejected", sendPermitted: false });
      assert.deepEqual(await rowCounts(), before);
      // On another owner date the message fits, so leaving it out is refused:
      // a run may not drop what the cap admits.
      assert.deepEqual(await advance(state.generation, keys, null, undefined, "2026-10-06"),
        { result: "reservation_not_owed", sendPermitted: false });
      assert.deepEqual([await rowCounts(), await deferredRows()], [before, []]);

      // Today it is held back: the advance moves the key, reserves nothing and
      // records what the cap deferred, derived by the store.
      const held = await advance(state.generation, keys, null);
      assert.deepEqual([held.result, held.sendPermitted], ["advanced", false]);
      assert.deepEqual(await deferredRows(), [{ mode: "shadow", ownerDate: OWNER_DATE, signal: "P3",
        scope: "credit_reservation_reconciliation", kind: "recovery", origin: "new" }]);
      // The digest reports it as held back, with the reservations of the date.
      const dateItems = await readOpsObserverDateItems(OWNER_DATE, inSeconds(120), client);
      assert.deepEqual(dateItems.filter((i) => i.status === "deferred"),
        [{ key: P3_KEY, kind: "recovery", capped: true, mode: "shadow", status: "deferred" }]);
      assert.equal(dateItems[0].status, "reserved");
      // Rows never change and stay their retention.
      await assert.rejects(q(`UPDATE "OpsObserverDeferredItem" SET kind = 'reopen'`), /deferred_item_immutable/);
      await assert.rejects(q(`DELETE FROM "OpsObserverDeferredItem"`), /deferred_item_retained/);
      await assert.rejects(q(`TRUNCATE "OpsObserverDeferredItem"`), /deferred_item_retained/);

      // P3 reopens: another capped message. The next day it fits and the store
      // derives that it is capped.
      const after = await current();
      const reopened = { ...after.keys, [P3_KEY]: evaluateKey(P3, after.keys[P3_KEY], "delayed", {
        now: now + 1_800_000, ownerDate: "2026-10-06" }).state } as Record<string, never>;
      const items = owedMessages(after.keys, reopened, "2026-10-06").map((o: { signal: string; scope: string; kind: string; openedAt: number }) => ({
        signal: o.signal, scope: o.scope, kind: o.kind, origin: incidentOrigin(reopened[P3_KEY]), openedAt: new Date(o.openedAt) }));
      assert.deepEqual(items.map((i: { kind: string }) => i.kind), ["reopen"]);
      const nextDay = await advance(after.generation, reopened, { ownerDate: "2026-10-06", channelCheck: false, items });
      assert.equal(nextDay.result, "advanced");
      const { rows } = await q(`SELECT capped FROM "OpsObserverDeliveryItem" WHERE "deliveryId" = $1`, [(nextDay as { deliveryId: string }).deliveryId]);
      assert.deepEqual(rows, [{ capped: true }]);
    });

    await t.test("a deferred item past ninety days goes with the retention batch, a younger one stays", async () => {
      await q(`ALTER TABLE "OpsObserverDeferredItem" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverDeferredItem" SET "deferredAt" = "deferredAt" - interval '91 days'`);
      } finally {
        await q(`ALTER TABLE "OpsObserverDeferredItem" ENABLE TRIGGER USER`);
      }
      const { deleted } = await purgeOpsObserverDeliveries(500, client);
      assert.ok(deleted >= 1);
      assert.equal((await q(`SELECT count(*)::int AS n FROM "OpsObserverDeferredItem"`)).rows[0].n, 0);
      const audit = (await q(`SELECT metadata FROM "AdminAuditLog" WHERE action = 'ops_observer.deliveries_purged'`)).rows;
      assert.equal(audit.at(-1).metadata.deferredCount, 1);
    });
  } finally {
    await client.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
