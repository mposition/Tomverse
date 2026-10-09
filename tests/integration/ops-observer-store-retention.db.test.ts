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
import { owedMessages } from "../../scripts/ops-observer/advance-request-core.mjs";
import { S2_PAGE_KEYS, S2_PAGE_SIGNALS, evaluateKey, initialKeyState } from "../../scripts/ops-observer/classify-core.mjs";

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
  const {
    advanceOpsObserverState,
    confirmOpsObserverDelivery,
    purgeOpsObserverDeliveries,
    readOpsObserverDateReservations,
    readOpsObserverDelivery,
    readOpsObserverState,
  } = await import("@/lib/opsObserverStore");

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
  const P3 = S2_PAGE_SIGNALS.find((signal) => signal.id === "P3")!;
  const P3_KEY = "P3#credit_reservation_reconciliation";
  let clock = Date.parse("2026-10-01T00:00:00.000Z");

  /**
   * One advance through the store. With an observation the P3 key moves by
   * evaluateKey(); the reservation carries exactly what that move owes, or the
   * channel check when it owes nothing (`reserve: false` advances without one).
   */
  async function advance(genesisId: string, ownerDate: string, observation: string | null, reserve = true) {
    const state = (await readOpsObserverState(inSeconds(120), client)) as {
      trust: string; generation: number; keys: Record<string, ReturnType<typeof initialKeyState>>;
    };
    assert.equal(state.trust, "trusted");
    clock += 600_000;
    const keys = observation
      ? { ...state.keys, [P3_KEY]: evaluateKey(P3, state.keys[P3_KEY], observation, { now: clock, ownerDate }).state }
      : state.keys;
    const items = owedMessages(state.keys, keys, ownerDate).map((o: { signal: string; scope: string; kind: string; openedAt: number }) => ({
      signal: o.signal, scope: o.scope, kind: o.kind, origin: o.kind === "reopen" ? "reopen" : "new", openedAt: new Date(o.openedAt),
    }));
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const result = await advanceOpsObserverState(
      { runDeadline: inSeconds(150), runId, baseGenesisId: genesisId, baseGeneration: state.generation, keys,
        reservation: reserve ? { ownerDate, channelCheck: items.length === 0, items } : null },
      client,
    );
    assert.equal(result.result, "advanced");
    return { deliveryId: (result as { deliveryId: string }).deliveryId, runId, items: items.length };
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

    // Three closed reservations and one still reserved; two carry an item.
    const old1 = await advance(shadowGenesis, "2026-10-01", "delayed"); // new_open
    assert.equal(old1.items, 1);
    await confirm(old1.deliveryId, old1.runId);
    const old2 = await advance(shadowGenesis, "2026-10-02", null); // channel check
    await confirm(old2.deliveryId, old2.runId);
    await advance(shadowGenesis, "2026-10-03", "ok", false); // one good evaluation, nothing owed
    const recent = await advance(shadowGenesis, "2026-10-03", "ok"); // recovery
    assert.equal(recent.items, 1);
    await confirm(recent.deliveryId, recent.runId);
    // A recovery later the same date: the new head starts from initial keys, so
    // the same delay owes a new_open again, now under the second genesis.
    // Fixture only: the first genesis is dated eight days back, so the
    // seven-day rule (T5) does not hold the recovery silent.
    await q(`ALTER TABLE "OpsObserverGenesis" DISABLE TRIGGER USER`);
    try {
      await q(`UPDATE "OpsObserverGenesis" SET "createdAt" = "createdAt" - interval '8 days' WHERE id = $1`, [shadowGenesis]);
    } finally {
      await q(`ALTER TABLE "OpsObserverGenesis" ENABLE TRIGGER USER`);
    }
    const recovery = await approvedGenesis("recovery", "shadow", shadowGenesis);
    const later = await advance(recovery, "2026-10-03", "delayed");
    assert.equal(later.items, 1);
    await confirm(later.deliveryId, later.runId);
    const open = await advance(recovery, "2026-10-04", null);
    const itemsOf = async (id: string) =>
      (await q(`SELECT count(*)::int AS n FROM "OpsObserverDeliveryItem" WHERE "deliveryId" = $1`, [id])).rows[0].n;

    await t.test("the item screen reads a reservation by its id, and nothing else", async () => {
      const view = await readOpsObserverDelivery(old1.deliveryId, client);
      assert.equal(view?.id, old1.deliveryId);
      assert.deepEqual([view?.status, view?.mode, view?.ownerDate, view?.channelCheck], ["shadowed", "shadow", "2026-10-01", false]);
      assert.ok(view?.closedAt && Date.parse(view.closedAt) >= Date.parse(view.reservedAt));
      assert.equal(view?.items.length, 1);
      assert.deepEqual([view?.items[0].signal, view?.items[0].scope, view?.items[0].kind, view?.items[0].capped],
        ["P3", "credit_reservation_reconciliation", "new_open", false]);
      // The first advance opened P3 at the fixture clock's first tick, printed in UTC.
      assert.equal(view!.items[0].openedAt, "2026-10-01T00:10:00.000Z");
      const check = await readOpsObserverDelivery(old2.deliveryId, client);
      assert.deepEqual([check?.channelCheck, check?.items], [true, []]);
      const reserved = await readOpsObserverDelivery(open.deliveryId, client);
      assert.deepEqual([reserved?.status, reserved?.closedAt], ["reserved", null]);
      // An unknown id, or anything that is not a UUID, is no reservation.
      assert.equal(await readOpsObserverDelivery("00000000-0000-4000-8000-000000000000", client), null);
      assert.equal(await readOpsObserverDelivery("../etc", client), null);
      // A read without the time left to finish returns nothing at all.
      await assert.rejects(readOpsObserverDelivery(old1.deliveryId, client, inSeconds(5)));
      // A read that succeeded still answers only after its own deadline check
      // (policy §6 item 5): the separate short transaction runs, and when that
      // check refuses, the read returns nothing. Counted on the client, since a
      // read that finishes well inside its deadline cannot be made late here.
      const kinds: string[] = [];
      let refuseCheck = false;
      const spied = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return (...args: unknown[]) => {
            kinds.push(kinds.length === 0 ? "read" : "check");
            if (kinds.length > 1 && refuseCheck) return Promise.reject(new Error("ops_observer_late_commit"));
            return (target.$transaction as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      assert.equal((await readOpsObserverDelivery(old1.deliveryId, spied))?.id, old1.deliveryId);
      assert.deepEqual(kinds, ["read", "check"]);
      kinds.length = 0;
      refuseCheck = true;
      await assert.rejects(readOpsObserverDelivery(old1.deliveryId, spied), /ops_observer_late_commit/);
      assert.deepEqual(kinds, ["read", "check"]);
    });

    await t.test("the digest's date read spans every genesis of the mode; the run budget stays the head's", async () => {
      const date = await readOpsObserverDateReservations("2026-10-03", "shadow", inSeconds(120), client);
      assert.deepEqual(date.map((i) => `${i.key}:${i.kind}`).sort(), [`${P3_KEY}:new_open`, `${P3_KEY}:recovery`].sort());
      const head = (await readOpsObserverState(inSeconds(120), client, "2026-10-03")) as {
        budget: { reservedToday: { kind: string }[] };
      };
      assert.deepEqual(head.budget.reservedToday.map((i) => i.kind), ["new_open"]);
      // Another mode's reservations, or another date's, are not this digest's.
      assert.deepEqual(await readOpsObserverDateReservations("2026-10-03", "live", inSeconds(120), client), []);
      assert.deepEqual(await readOpsObserverDateReservations("2026-09-30", "shadow", inSeconds(120), client), []);
      await assert.rejects(readOpsObserverDateReservations("2026-10-03", "shadow", inSeconds(5), client));
    });

    await t.test("nothing past retention: nothing deleted and nothing audited", async () => {
      assert.deepEqual(await purgeOpsObserverDeliveries(500, client), { deleted: 0 });
      assert.deepEqual(await purgeAudits(), []);
    });

    await t.test("closed past ninety days are deleted oldest first, up to the limit, with their items", async () => {
      await age(old1.deliveryId, 120);
      await age(old2.deliveryId, 100);
      await age(recent.deliveryId, 89);
      assert.deepEqual([await itemsOf(old1.deliveryId), await itemsOf(recent.deliveryId)], [1, 1]);
      // Past retention the item screen shows nothing, before any batch has run;
      // a close inside it, and a reservation still open, are shown.
      assert.equal(await readOpsObserverDelivery(old1.deliveryId, client), null);
      assert.equal(await readOpsObserverDelivery(old2.deliveryId, client), null);
      assert.equal((await readOpsObserverDelivery(recent.deliveryId, client))?.id, recent.deliveryId);
      assert.equal((await readOpsObserverDelivery(open.deliveryId, client))?.id, open.deliveryId);
      assert.deepEqual(await purgeOpsObserverDeliveries(1, client), { deleted: 1 });
      assert.deepEqual([await exists(old1.deliveryId), await exists(old2.deliveryId)], [false, true]);
      assert.deepEqual(await purgeOpsObserverDeliveries(500, client), { deleted: 1 });
      assert.deepEqual([await exists(old2.deliveryId), await exists(recent.deliveryId), await exists(open.deliveryId)],
        [false, true, true]);
      // The deleted reservation took its item; the recent one keeps its own.
      assert.deepEqual([await itemsOf(old1.deliveryId), await itemsOf(recent.deliveryId)], [0, 1]);
      assert.deepEqual(await purgeAudits(), [1, 2].map(() => ({ count: 1, retentionDays: 90, systemActor: "ops-observer" })));
    });

    await t.test("a delete that names no deadline, or commits past it, does not commit", async () => {
      await age(recent.deliveryId, 10); // 99 days: the delete guard allows it
      const code = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return null;
        } catch (error) {
          return (error as { code?: string }).code ?? "thrown";
        }
      };
      await q("BEGIN");
      await q(`DELETE FROM "OpsObserverDelivery" WHERE id = $1`, [recent.deliveryId]);
      assert.equal(await code(() => q("COMMIT")), "OB013");
      await q("BEGIN");
      await q(`SELECT set_config('ops_observer.retention_deadline', (clock_timestamp() + interval '300 milliseconds')::text, true)`);
      await q(`DELETE FROM "OpsObserverDelivery" WHERE id = $1`, [recent.deliveryId]);
      await q("SELECT pg_sleep(0.5)");
      assert.equal(await code(() => q("COMMIT")), "OB012");
      await q("BEGIN");
      await q(`SELECT set_config('ops_observer.retention_deadline', (clock_timestamp() + interval '600 seconds')::text, true)`);
      await q(`DELETE FROM "OpsObserverDelivery" WHERE id = $1`, [recent.deliveryId]);
      assert.equal(await code(() => q("COMMIT")), "OB011");
      // Each refusal rolled back the delete and its item.
      assert.deepEqual([await exists(recent.deliveryId), await itemsOf(recent.deliveryId)], [true, 1]);
    });

    await t.test("a reserved row is never deleted, however old", async () => {
      await q(`ALTER TABLE "OpsObserverDelivery" DISABLE TRIGGER USER`);
      try {
        await q(`UPDATE "OpsObserverDelivery" SET "reservedAt" = "reservedAt" - interval '400 days' WHERE id = $1`, [open.deliveryId]);
      } finally {
        await q(`ALTER TABLE "OpsObserverDelivery" ENABLE TRIGGER USER`);
      }
      // The 99-day close goes (through the store, deadline named); the reserved row stays.
      assert.deepEqual(await purgeOpsObserverDeliveries(500, client), { deleted: 1 });
      assert.equal(await exists(recent.deliveryId), false);
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
