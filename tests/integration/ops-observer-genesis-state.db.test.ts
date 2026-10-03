// What the database itself enforces on the sre-ops genesis chain and state
// (docs/policy/sre-ops.md §3 rules 3, 8 and 9, §6, §8): the chain shape, the
// compare-and-set generation, the checkpoint order, the stamps the triggers
// write, immutability, and that a state write evaluated past its run deadline
// does not commit. The migrations are applied to a throwaway schema.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

import { genesisRefusal } from "../../scripts/ops-observer/genesis-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = [
  "20261003060000_ops_observer_transaction_arm",
  "20261003070000_ops_observer_genesis_state",
].map((name) => path.resolve(here, `../../prisma/migrations/${name}/migration.sql`));
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_state_${randomUUID().replaceAll("-", "")}`;
const DIGEST = "a".repeat(64);

let client: pg.Client;

async function q(sql: string, params: unknown[] = []) {
  return client.query(sql, params);
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  const error = await work.then(() => null, (e: Error) => e);
  assert.ok(error, `expected a refusal matching ${pattern}`);
  assert.match(error!.message, pattern);
}

function genesisSql(deadlineSeconds = 60) {
  return `INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "createdAt", "runDeadlineAt")
     VALUES ($1, $2, $3, $4, $5, 99, '2000-01-01T00:00:00Z', clock_timestamp() + interval '${deadlineSeconds} seconds')`;
}

async function genesis(reason: string, mode: string, supersedes: string | null, on: pg.Client = client) {
  const id = randomUUID();
  await on.query(genesisSql(), [id, reason, mode, supersedes, DIGEST]);
  return id;
}

const soon = (seconds: number) => `clock_timestamp() + interval '${seconds} seconds'`;

async function insertState(genesisId: string, extra = "") {
  await q(
    `INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
       "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt" ${extra ? ", " + extra.split("=")[0] : ""})
     VALUES ($1, 0, '{}'::jsonb, 0, 0, 'x', 'x', ${soon(60)} ${extra ? ", " + extra.split("=")[1] : ""})`,
    [genesisId],
  );
}

test("genesis chain, state compare-and-set and late-commit refusal", { skip: !rawUrl }, async (t) => {
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

    await t.test("the first genesis is shadow, and the trigger owns its clock, version and root marker", async () => {
      await refused(genesis("initial", "live", null), /ops_observer_genesis_transition/);
      await refused(genesis("recovery", "shadow", null), /ops_observer_genesis_not_head/);
      const first = await genesis("initial", "shadow", null);
      const { rows } = await q(`SELECT "createdAt" > now() - interval '1 minute' AS fresh, "invariantVersion", "rootMarker" FROM "OpsObserverGenesis" WHERE id = $1`, [first]);
      assert.deepEqual(rows[0], { fresh: true, invariantVersion: 1, rootMarker: 1 });
      await refused(genesis("initial", "shadow", null), /ops_observer_genesis_transition/);
    });

    const head = async () =>
      (await q(`SELECT id, mode FROM "OpsObserverGenesis" g WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" s WHERE s."supersedesGenesisId" = g.id)`)).rows[0];

    await t.test("later genesis rows replace the head: recovery keeps the mode, activation is shadow to live once", async () => {
      const first = await head();
      await refused(genesis("recovery", "shadow", randomUUID()), /ops_observer_genesis_not_head/);
      await refused(genesis("recovery", "live", first.id), /ops_observer_genesis_transition/);
      const recovered = await genesis("recovery", "shadow", first.id);
      await refused(genesis("recovery", "shadow", first.id), /ops_observer_genesis_not_head|duplicate key/);
      const live = await genesis("activation", "live", recovered);
      await refused(genesis("activation", "live", live), /ops_observer_genesis_transition/);
      await refused(genesis("recovery", "shadow", live), /ops_observer_genesis_transition/);
      const liveRecovery = await genesis("recovery", "live", live);
      assert.equal((await head()).id, liveRecovery);
    });

    await t.test("the code table agrees with the trigger on every reason and mode against every head", async () => {
      // Pure: the same cases the trigger refused above, judged by genesis-core.
      const shadowHead = { id: "h", mode: "shadow" };
      const liveHead = { id: "h", mode: "live" };
      assert.equal(genesisRefusal({ reason: "initial", mode: "shadow", supersedesGenesisId: null }, null), null);
      assert.equal(genesisRefusal({ reason: "initial", mode: "live", supersedesGenesisId: null }, null), "ops_observer_genesis_transition");
      assert.equal(genesisRefusal({ reason: "recovery", mode: "live", supersedesGenesisId: "h" }, shadowHead), "ops_observer_genesis_transition");
      assert.equal(genesisRefusal({ reason: "activation", mode: "live", supersedesGenesisId: "h" }, shadowHead), null);
      assert.equal(genesisRefusal({ reason: "activation", mode: "live", supersedesGenesisId: "h" }, liveHead), "ops_observer_genesis_transition");
      assert.equal(genesisRefusal({ reason: "recovery", mode: "live", supersedesGenesisId: "x" }, liveHead), "ops_observer_genesis_not_head");
    });

    await t.test("genesis rows are never updated or deleted", async () => {
      const { id } = await head();
      await refused(q(`UPDATE "OpsObserverGenesis" SET mode = 'shadow' WHERE id = $1`, [id]), /ops_observer_genesis_immutable/);
      await refused(q(`DELETE FROM "OpsObserverGenesis" WHERE id = $1`, [id]), /ops_observer_genesis_immutable/);
    });

    await t.test("state starts at generation 0 with trigger-written stamps", async () => {
      const { id } = await head();
      await refused(
        q(`INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration", "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
           VALUES ($1, 1, '{}'::jsonb, 1, 1, 'x', 'x', ${soon(60)})`, [id]),
        /ops_observer_state_initial_shape/,
      );
      await insertState(id);
      const { rows } = await q(
        `SELECT "invariantVersion", "stampGeneration",
                "stampKeysSha256" = ops_observer_sha256_hex(keys::text) AS "keysStamped",
                "stampCheckpointSha256" = ops_observer_sha256_hex('0::') AS "checkpointStamped"
           FROM "OpsObserverState" WHERE "genesisId" = $1`, [id]);
      assert.deepEqual(rows[0], { invariantVersion: 1, stampGeneration: 0, keysStamped: true, checkpointStamped: true });
    });

    await t.test("every update is exactly the next generation of the same genesis", async () => {
      const { id } = await head();
      const advance = (generation: number, extra = "") =>
        q(`UPDATE "OpsObserverState" SET generation = $2, keys = '{"P3#x":{"status":"open"}}'::jsonb, "runDeadlineAt" = ${soon(60)} ${extra}
            WHERE "genesisId" = $1`, [id, generation]);
      await refused(advance(2), /ops_observer_state_not_next_generation/);
      await refused(advance(0), /ops_observer_state_not_next_generation/);
      await advance(1);
      await advance(2);
      await refused(advance(3, `, "verifiedThroughGeneration" = 3`), /ops_observer_state_checkpoint_order/);
      await refused(advance(3, `, "verifiedThroughGeneration" = 2`), /OpsObserverState_checkpoint_check/);
      await advance(3, `, "verifiedThroughGeneration" = 2, "verifiedThroughAuditId" = 'a', "verifiedThroughAuditHash" = 'h'`);
      await refused(advance(4, `, "verifiedThroughGeneration" = 1`), /ops_observer_state_checkpoint_order/);
      // The audit row a checkpoint names cannot be swapped under the same checkpoint.
      await refused(advance(4, `, "verifiedThroughAuditId" = 'b'`), /ops_observer_state_checkpoint_order/);
      await refused(advance(4, `, "verifiedThroughAuditHash" = 'other'`), /ops_observer_state_checkpoint_order/);
      const { rows } = await q(`SELECT generation, "stampGeneration", "stampKeysSha256" = ops_observer_sha256_hex(keys::text) AS ok FROM "OpsObserverState" WHERE "genesisId" = $1`, [id]);
      assert.deepEqual(rows[0], { generation: 3, stampGeneration: 3, ok: true });
      await refused(q(`DELETE FROM "OpsObserverState" WHERE "genesisId" = $1`, [id]), /ops_observer_state_not_deletable/);
    });

    await t.test("a superseded genesis's state cannot advance", async () => {
      const old = await head();
      const { rows } = await q(`SELECT generation FROM "OpsObserverState" WHERE "genesisId" = $1`, [old.id]);
      await genesis("recovery", old.mode, old.id);
      await refused(
        q(`UPDATE "OpsObserverState" SET generation = $2, "runDeadlineAt" = ${soon(60)} WHERE "genesisId" = $1`, [old.id, rows[0].generation + 1]),
        /ops_observer_state_superseded/,
      );
    });

    await t.test("a claimed deadline is required and at most 180 s ahead", async () => {
      const { id } = await head();
      await refused(
        q(`INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration", "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
           VALUES ($1, 0, '{}'::jsonb, 1, 0, 'x', 'x', ${soon(200)})`, [id]),
        /ops_observer_deadline_too_far/,
      );
      const current = await head();
      await refused(q(genesisSql(200), [randomUUID(), "recovery", current.mode, current.id, DIGEST]), /ops_observer_deadline_too_far/);
      await insertState(id);
    });

    await t.test("a state write evaluated past its deadline does not commit", async () => {
      const { id } = await head();
      await q("BEGIN");
      await q(`UPDATE "OpsObserverState" SET generation = 1, "runDeadlineAt" = ${soon(1)} WHERE "genesisId" = $1`, [id]);
      await q(`SELECT pg_sleep(1.5)`);
      await refused(q("COMMIT"), /ops_observer_late_commit/);
      const { rows } = await q(`SELECT generation FROM "OpsObserverState" WHERE "genesisId" = $1`, [id]);
      assert.equal(rows[0].generation, 0);
    });

    await t.test("a genesis evaluated past its deadline does not commit", async () => {
      const current = await head();
      await q("BEGIN");
      await q(genesisSql(1), [randomUUID(), "recovery", current.mode, current.id, DIGEST]);
      await q(`SELECT pg_sleep(1.5)`);
      await refused(q("COMMIT"), /ops_observer_late_commit/);
      assert.equal((await head()).id, current.id);
    });

    const second = async () => {
      const other = new pg.Client({ connectionString: rawUrl });
      other.on("error", () => {});
      await other.connect();
      await other.query(`SET search_path TO "${schema}"`);
      return other;
    };

    await t.test("a state write in flight holds off the genesis that would replace it", async () => {
      const current = await head();
      const { rows } = await q(`SELECT generation FROM "OpsObserverState" WHERE "genesisId" = $1`, [current.id]);
      const other = await second();
      try {
        await q("BEGIN");
        await q(`UPDATE "OpsObserverState" SET generation = $2, "runDeadlineAt" = ${soon(60)} WHERE "genesisId" = $1`, [current.id, rows[0].generation + 1]);
        let replaced = false;
        const replacing = genesis("recovery", current.mode, current.id, other).then((id) => {
          replaced = true;
          return id;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(replaced, false, "the replacement waits for the state write");
        await q("COMMIT");
        const replacement = await replacing;
        assert.equal((await head()).id, replacement);
        // The state committed while its genesis was still the head; now it is not.
        await refused(
          q(`UPDATE "OpsObserverState" SET generation = $2, "runDeadlineAt" = ${soon(60)} WHERE "genesisId" = $1`, [current.id, rows[0].generation + 2]),
          /ops_observer_state_superseded/,
        );
      } finally {
        await other.end();
      }
    });

    await t.test("a genesis replacement in flight makes the waiting state write fail as superseded", async () => {
      const current = await head();
      await insertState(current.id);
      const other = await second();
      try {
        await other.query("BEGIN");
        await genesis("recovery", current.mode, current.id, other);
        const advancing = q(
          `UPDATE "OpsObserverState" SET generation = 1, "runDeadlineAt" = ${soon(60)} WHERE "genesisId" = $1`,
          [current.id],
        ).then(() => null, (e: Error) => e);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await other.query("COMMIT");
        const error = await advancing;
        assert.ok(error, "the state write must not advance a superseded genesis");
        assert.match(error!.message, /ops_observer_state_superseded/);
        const { rows } = await q(`SELECT generation FROM "OpsObserverState" WHERE "genesisId" = $1`, [current.id]);
        assert.equal(rows[0].generation, 0);
      } finally {
        await other.end();
      }
    });

    for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
      await t.test(`genesis and state writes refuse ${level}, where the superseded check would read a stale snapshot`, async () => {
        const current = await head();
        const existing = await q(`SELECT 1 FROM "OpsObserverState" WHERE "genesisId" = $1`, [current.id]);
        if (existing.rowCount === 0) await insertState(current.id);
        await q(`BEGIN ISOLATION LEVEL ${level}`);
        await refused(
          q(`UPDATE "OpsObserverState" SET generation = generation + 1, "runDeadlineAt" = ${soon(60)} WHERE "genesisId" = $1`, [current.id]),
          /ops_observer_isolation_not_read_committed/,
        );
        await q("ROLLBACK");
        await q(`BEGIN ISOLATION LEVEL ${level}`);
        await refused(q(genesisSql(), [randomUUID(), "recovery", current.mode, current.id, DIGEST]), /ops_observer_isolation_not_read_committed/);
        await q("ROLLBACK");
      });
    }

    await t.test("trigger functions pin search_path", async () => {
      const { rows } = await q(
        `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname IN ('ops_observer_genesis_guard', 'ops_observer_state_guard', 'ops_observer_deadline_check', 'ops_observer_deadline_claim')
          ORDER BY p.proname`, [schema]);
      assert.equal(rows.length, 4);
      for (const row of rows) assert.deepEqual(row.proconfig, ["search_path=pg_catalog, pg_temp"], row.proname);
    });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await client.end();
  }
});
