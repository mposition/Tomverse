// What the database enforces on sre-ops reservations
// (docs/policy/sre-ops.md §3 rules 3 and 9, §5, §10): created reserved and
// closed once, the closing status bound to the genesis mode, one open at a
// time, items only in the reservation's own transaction and once per incident
// kind within a mode, nothing changes afterwards, deletion only after the
// retention period, and the same deadline, isolation and superseded rules as
// state. The migrations are applied to a throwaway schema.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

import { confirmStatusForMode } from "../../scripts/ops-observer/delivery-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = [
  "20261003060000_ops_observer_transaction_arm",
  "20261003070000_ops_observer_genesis_state",
  "20261003090000_ops_observer_delivery",
].map((name) => path.resolve(here, `../../prisma/migrations/${name}/migration.sql`));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_delivery_${randomUUID().replaceAll("-", "")}`;
const DIGEST = "b".repeat(64);
const soon = (seconds: number) => `clock_timestamp() + interval '${seconds} seconds'`;

let client: pg.Client;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

async function refused(work: Promise<unknown>, pattern: RegExp) {
  const error = await work.then(() => null, (e: Error) => e);
  assert.ok(error, `expected a refusal matching ${pattern}`);
  assert.match(error!.message, pattern);
}

async function genesis(reason: string, mode: string, supersedes: string | null) {
  const id = randomUUID();
  await q(
    `INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
     VALUES ($1, $2, $3, $4, $5, 1, ${soon(60)})`,
    [id, reason, mode, supersedes, DIGEST],
  );
  return id;
}

async function reserve(genesisId: string, extra: { channelCheckDate?: string; status?: string } = {}) {
  const id = randomUUID();
  await q(
    `INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "channelCheckDate",
       "invariantVersion", "stampStatus", "runDeadlineAt")
     VALUES ($1, $2, 'live', $3, $4, '2026-10-05', $5, 0, $4, ${soon(60)})`,
    [id, genesisId, `run-${id.slice(0, 8)}`, extra.status ?? "reserved", extra.channelCheckDate ?? null],
  );
  return id;
}

const close = (id: string, status: string) =>
  q(`UPDATE "OpsObserverDelivery" SET status = $2, "stampStatus" = $2, "runDeadlineAt" = ${soon(60)} WHERE id = $1`, [id, status]);

const item = (deliveryId: string, kind: string, openedAt = "2026-10-05T01:00:00Z", scope = "database") =>
  q(
    `INSERT INTO "OpsObserverDeliveryItem" (id, "deliveryId", mode, signal, scope, kind, origin, "openedAt", capped)
     VALUES ($1, $2, 'live', 'P1a', $3, $4, 'new', $5, false)`,
    [randomUUID(), deliveryId, scope, kind, openedAt],
  );

test("reservations and their items", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  client = new pg.Client({ connectionString: rawUrl });
  await client.connect();
  try {
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    for (const file of migrations) await q(await readFile(file, "utf8"));

    const shadow = await genesis("initial", "shadow", null);

    await t.test("a reservation is created reserved, takes the genesis mode, and one is open at a time", async () => {
      await refused(reserve(shadow, { status: "confirmed" }), /ops_observer_delivery_not_reserved/);
      const first = await reserve(shadow);
      const { rows } = await q(`SELECT mode, "reservedMarker", "invariantVersion" FROM "OpsObserverDelivery" WHERE id = $1`, [first]);
      assert.deepEqual(rows[0], { mode: "shadow", reservedMarker: 1, invariantVersion: 1 });
      await refused(reserve(shadow), /OpsObserverDelivery_reservedMarker_key/);
      await close(first, "abandoned");
    });

    await t.test("a shadow reservation closes as shadowed, never confirmed, and only once", async () => {
      assert.equal(confirmStatusForMode("shadow"), "shadowed");
      const id = await reserve(shadow);
      await refused(close(id, "confirmed"), /ops_observer_delivery_transition/);
      await close(id, "shadowed");
      await refused(close(id, "abandoned"), /ops_observer_delivery_closed/);
      const { rows } = await q(`SELECT "shadowedAt" IS NOT NULL AS shadowed, "reservedMarker" FROM "OpsObserverDelivery" WHERE id = $1`, [id]);
      assert.deepEqual(rows[0], { shadowed: true, reservedMarker: null });
    });

    await t.test("an item is written only in its reservation's own transaction, and copies its mode", async () => {
      await q("BEGIN");
      const id = await reserve(shadow);
      await item(id, "new_open");
      await q("COMMIT");
      const { rows } = await q(`SELECT mode FROM "OpsObserverDeliveryItem" WHERE "deliveryId" = $1`, [id]);
      assert.equal(rows[0].mode, "shadow");
      // A later transaction cannot add to it, even while it is still reserved.
      await refused(item(id, "worsening"), /ops_observer_delivery_item_not_same_transaction/);
      await close(id, "shadowed");
      await refused(item(id, "recovery"), /ops_observer_delivery_item_not_same_transaction/);
    });

    await t.test("items never change, and are not deleted on their own", async () => {
      const { rows } = await q(`SELECT id FROM "OpsObserverDeliveryItem" LIMIT 1`);
      await refused(q(`UPDATE "OpsObserverDeliveryItem" SET capped = true WHERE id = $1`, [rows[0].id]), /ops_observer_delivery_item_immutable/);
      await refused(q(`DELETE FROM "OpsObserverDeliveryItem" WHERE id = $1`, [rows[0].id]), /ops_observer_delivery_item_not_deletable/);
    });

    await t.test("each kind is reserved once per incident within a mode, and shadow never takes a live slot", async () => {
      await q("BEGIN");
      const shadowAgain = await reserve(shadow);
      await refused(item(shadowAgain, "new_open"), /OpsObserverDeliveryItem_incident_kind_key/);
      await q("ROLLBACK");

      const live = await genesis("activation", "live", shadow);
      await q("BEGIN");
      const liveId = await reserve(live);
      await item(liveId, "new_open"); // same signal, scope, kind and openedAt as the shadow item
      await q("COMMIT");
      assert.equal(confirmStatusForMode("live"), "confirmed");
      await refused(close(liveId, "shadowed"), /ops_observer_delivery_transition/);
      await close(liveId, "confirmed");
    });

    await t.test("a superseded genesis cannot reserve", async () => {
      await refused(reserve(shadow), /ops_observer_delivery_superseded/);
    });

    await t.test("the closing run's fields other than status and deadline cannot change", async () => {
      const { rows: heads } = await q(
        `SELECT id FROM "OpsObserverGenesis" g WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" s WHERE s."supersedesGenesisId" = g.id)`,
      );
      const id = await reserve(heads[0].id, { channelCheckDate: "2026-10-05" });
      await refused(q(`UPDATE "OpsObserverDelivery" SET "ownerDate" = '2026-10-06', "runDeadlineAt" = ${soon(60)} WHERE id = $1`, [id]), /ops_observer_delivery_immutable/);
      await refused(q(`UPDATE "OpsObserverDelivery" SET "channelCheckDate" = NULL, "runDeadlineAt" = ${soon(60)} WHERE id = $1`, [id]), /ops_observer_delivery_immutable/);
      await close(id, "abandoned");
      await refused(reserve(heads[0].id, { channelCheckDate: "2026-10-05" }), /OpsObserverDelivery_channelCheckDate_key/);
    });

    await t.test("isolation, deadline claim and late COMMIT are refused as for state", async () => {
      const { rows: heads } = await q(
        `SELECT id FROM "OpsObserverGenesis" g WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" s WHERE s."supersedesGenesisId" = g.id)`,
      );
      const head = heads[0].id;
      await q("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await refused(reserve(head), /ops_observer_isolation_not_read_committed/);
      await q("ROLLBACK");

      await refused(
        q(`INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "invariantVersion", "stampStatus", "runDeadlineAt")
           VALUES ($1, $2, 'live', 'run-far', 'reserved', '2026-10-05', 1, 'reserved', ${soon(200)})`, [randomUUID(), head]),
        /ops_observer_deadline_too_far/,
      );

      await q("BEGIN");
      await q(
        `INSERT INTO "OpsObserverDelivery" (id, "genesisId", mode, "runId", status, "ownerDate", "invariantVersion", "stampStatus", "runDeadlineAt")
         VALUES ($1, $2, 'live', 'run-late', 'reserved', '2026-10-05', 1, 'reserved', ${soon(1)})`, [randomUUID(), head]);
      await q(`SELECT pg_sleep(1.5)`);
      await refused(q("COMMIT"), /ops_observer_late_commit/);
      const { rows } = await q(`SELECT count(*)::int AS n FROM "OpsObserverDelivery" WHERE "runId" = 'run-late'`);
      assert.equal(rows[0].n, 0);
    });

    await t.test("a reservation is deleted only once closed for the retention period, taking its items", async () => {
      const { rows: heads } = await q(
        `SELECT id FROM "OpsObserverGenesis" g WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" s WHERE s."supersedesGenesisId" = g.id)`,
      );
      await q("BEGIN");
      const id = await reserve(heads[0].id);
      await item(id, "recovery", "2026-10-05T02:00:00Z", "securityEnvironment");
      await q("COMMIT");
      await refused(q(`DELETE FROM "OpsObserverDelivery" WHERE id = $1`, [id]), /ops_observer_delivery_not_deletable/);
      await close(id, "abandoned");
      await refused(q(`DELETE FROM "OpsObserverDelivery" WHERE id = $1`, [id]), /ops_observer_delivery_not_deletable/);

      // Age the close past the retention period, bypassing the guard only for this setup step.
      await q(`ALTER TABLE "OpsObserverDelivery" DISABLE TRIGGER "OpsObserverDelivery_guard"`);
      await q(`UPDATE "OpsObserverDelivery" SET "abandonedAt" = now() - interval '91 days' WHERE id = $1`, [id]);
      await q(`ALTER TABLE "OpsObserverDelivery" ENABLE TRIGGER "OpsObserverDelivery_guard"`);

      await q(`DELETE FROM "OpsObserverDelivery" WHERE id = $1`, [id]);
      const { rows } = await q(`SELECT count(*)::int AS n FROM "OpsObserverDeliveryItem" WHERE "deliveryId" = $1`, [id]);
      assert.equal(rows[0].n, 0);
    });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await client.end();
  }
});
