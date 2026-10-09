// What the database enforces on the sre-ops transition ledger
// (docs/policy/sre-ops.md §3 rules 7, 8 and 10, §10): a row is the advance of
// its own transaction, at the state's generation and key stamp; no generation
// is skipped; it names the signed state_advanced audit entry of the same
// genesis and copies its hash; rows never change and are never truncated; a
// row is deleted only after seven years and behind the verified checkpoint;
// a superseded genesis cannot append; the deadline and isolation rules of the
// state table apply. The migrations are applied to a throwaway schema.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

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
const schema = `ops_observer_transition_${randomUUID().replaceAll("-", "")}`;
const DIGEST = "b".repeat(64);
const soon = (seconds: number) => `clock_timestamp() + interval '${seconds} seconds'`;

let client: pg.Client;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

async function refused(work: Promise<unknown>, pattern: RegExp) {
  const error = await work.then(() => null, (e: Error) => e);
  assert.ok(error, `expected a refusal matching ${pattern}`);
  assert.match(error!.message, pattern);
}

async function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  await q("BEGIN");
  try {
    const result = await work();
    await q("COMMIT");
    return result;
  } catch (error) {
    await q("ROLLBACK");
    throw error;
  }
}

async function genesis(reason: string, mode: string, supersedes: string | null) {
  const id = randomUUID();
  await q(
    `INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
     VALUES ($1, $2, $3, $4, $5, 1, ${soon(60)})`,
    [id, reason, mode, supersedes, DIGEST],
  );
  await q(
    `INSERT INTO "OpsObserverState" ("genesisId", generation, keys, "invariantVersion", "stampGeneration",
       "stampKeysSha256", "stampCheckpointSha256", "runDeadlineAt")
     VALUES ($1, 0, '{}', 0, 0, '', '', ${soon(60)})`,
    [id],
  );
  return id;
}

type AuditOverrides = {
  action?: string;
  targetId?: string;
  entryHash?: string | null;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * The state_advanced entry the store writes for the state as this connection
 * now sees it: the ops-observer actor, this generation and key stamp.
 */
async function audit(genesisId: string, overrides: AuditOverrides = {}) {
  const id = randomUUID();
  const entryHash = overrides.entryHash === undefined ? randomUUID().replaceAll("-", "").padEnd(64, "0") : overrides.entryHash;
  const { rows } = await q(`SELECT generation, "stampKeysSha256" FROM "OpsObserverState" WHERE "genesisId" = $1`, [genesisId]);
  const metadata = {
    systemActor: "ops-observer",
    generation: rows[0]?.generation,
    keysSha256: rows[0]?.stampKeysSha256,
    ...overrides.metadata,
  };
  await q(
    `INSERT INTO "AdminAuditLog" (id, action, "targetType", "targetId", "entryHash", "actorUserId", metadata)
     VALUES ($1, $2, 'OpsObserverState', $3, $4, $5, $6)`,
    [id, overrides.action ?? "ops_observer.state_advanced", overrides.targetId ?? genesisId, entryHash,
      overrides.actorUserId ?? null, JSON.stringify(metadata)],
  );
  return { id, entryHash };
}

/** Advances the state one generation; returns the key stamp the trigger computed. */
async function advanceState(genesisId: string, keys: object = { n: Math.random() }) {
  const { rows } = await q(
    `UPDATE "OpsObserverState" SET generation = generation + 1, keys = $2, "runDeadlineAt" = ${soon(60)}
      WHERE "genesisId" = $1 RETURNING generation, "stampKeysSha256"`,
    [genesisId, JSON.stringify(keys)],
  );
  return rows[0] as { generation: number; stampKeysSha256: string };
}

const append = (row: { genesisId: string; generation: number; auditLogId: string; auditEntryHash: string | null; keysSha256: string }, deadline = soon(60)) =>
  q(
    `INSERT INTO "OpsObserverTransition" ("genesisId", generation, "auditLogId", "auditEntryHash", "keysSha256", "runDeadlineAt")
     VALUES ($1, $2, $3, $4, $5, ${deadline})`,
    [row.genesisId, row.generation, row.auditLogId, row.auditEntryHash, row.keysSha256],
  );

type AuditOverrideCase = [AuditOverrides, string | undefined];

/** Sets a ledger row's createdAt past the guard, as a fixture only. */
async function age(genesisId: string, generation: number) {
  await q(`ALTER TABLE "OpsObserverTransition" DISABLE TRIGGER USER`);
  try {
    await q(`UPDATE "OpsObserverTransition" SET "createdAt" = clock_timestamp() - interval '7 years 1 day'
              WHERE "genesisId" = $1 AND generation = $2`, [genesisId, generation]);
  } finally {
    await q(`ALTER TABLE "OpsObserverTransition" ENABLE TRIGGER USER`);
  }
}

/** Advances the state with no ledger row, optionally moving the checkpoint. */
async function advanceStateOnly(genesisId: string, checkpoint?: { generation: number; auditId: string; auditHash: string }) {
  await inTransaction(() =>
    q(
      `UPDATE "OpsObserverState" SET generation = generation + 1, keys = $2,
         "verifiedThroughGeneration" = coalesce($3, "verifiedThroughGeneration"),
         "verifiedThroughAuditId" = coalesce($4, "verifiedThroughAuditId"),
         "verifiedThroughAuditHash" = coalesce($5, "verifiedThroughAuditHash"), "runDeadlineAt" = ${soon(60)}
        WHERE "genesisId" = $1`,
      [genesisId, JSON.stringify({ n: Math.random() }), checkpoint?.generation ?? null, checkpoint?.auditId ?? null, checkpoint?.auditHash ?? null],
    ),
  );
}

/** A new head genesis replacing the current one, with its state at generation 0. */
async function newHead() {
  const { rows } = await q(`SELECT g.id FROM "OpsObserverGenesis" g
    WHERE NOT EXISTS (SELECT 1 FROM "OpsObserverGenesis" s WHERE s."supersedesGenesisId" = g.id)`);
  return genesis("recovery", "shadow", rows[0].id);
}

/** One full advance: state, audit entry and ledger row in one transaction. */
async function advance(genesisId: string) {
  return inTransaction(async () => {
    const state = await advanceState(genesisId);
    const entry = await audit(genesisId);
    await append({ genesisId, generation: state.generation, auditLogId: entry.id, auditEntryHash: entry.entryHash, keysSha256: state.stampKeysSha256 });
    return { ...state, ...entry };
  });
}

test("the sre-ops transition ledger", { skip: !rawUrl }, async (t) => {
  const url = new URL(rawUrl!);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.match(`${databaseName}_${url.searchParams.get("schema") || ""}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  client = new pg.Client({ connectionString: rawUrl });
  await client.connect();
  try {
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    // The columns of the shared audit table the ledger reads.
    await q(`CREATE TABLE "AdminAuditLog" (id TEXT PRIMARY KEY, action TEXT NOT NULL, "targetType" TEXT NOT NULL,
               "targetId" TEXT, "entryHash" TEXT UNIQUE, "actorUserId" TEXT, metadata JSONB)`);
    for (const file of migrations) await q(await readFile(file, "utf8"));

    const g = await genesis("initial", "shadow", null);

    await t.test("an advance appends its row at the state's generation", async () => {
      const first = await advance(g);
      const second = await advance(g);
      assert.deepEqual([first.generation, second.generation], [1, 2]);
      const { rows } = await q(
        `SELECT generation, "keysSha256", "createdAt" <= clock_timestamp() AS stamped FROM "OpsObserverTransition"
          WHERE "genesisId" = $1 ORDER BY generation`,
        [g],
      );
      assert.deepEqual(rows.map((r) => [r.generation, r.keysSha256, r.stamped]), [
        [1, first.stampKeysSha256, true],
        [2, second.stampKeysSha256, true],
      ]);
      // A caller-supplied createdAt is replaced by the database clock, so a row
      // cannot be backdated into the seven-year delete window.
      const third = await inTransaction(async () => {
        const state = await advanceState(g);
        const e = await audit(g);
        await q(
          `INSERT INTO "OpsObserverTransition" ("genesisId", generation, "auditLogId", "auditEntryHash", "keysSha256",
             "runDeadlineAt", "createdAt")
           VALUES ($1, $2, $3, $4, $5, ${soon(60)}, clock_timestamp() - interval '8 years')`,
          [g, state.generation, e.id, e.entryHash, state.stampKeysSha256],
        );
        return state.generation;
      });
      const backdated = await q(
        `SELECT "createdAt" > clock_timestamp() - interval '1 minute' AS fresh FROM "OpsObserverTransition"
          WHERE "genesisId" = $1 AND generation = $2`,
        [g, third],
      );
      assert.equal(backdated.rows[0].fresh, true);
    });

    await t.test("a row that is not this transaction's advance is refused", async () => {
      // No state write in this transaction.
      const { rows } = await q(`SELECT generation, "stampKeysSha256" FROM "OpsObserverState" WHERE "genesisId" = $1`, [g]);
      const entry = await audit(g);
      await refused(
        inTransaction(() => append({ genesisId: g, generation: rows[0].generation, auditLogId: entry.id, auditEntryHash: entry.entryHash, keysSha256: rows[0].stampKeysSha256 })),
        /ops_observer_transition_not_this_advance/,
      );
      // Another generation than the state's, and another key stamp.
      for (const bend of [{ generation: 1 }, { keysSha256: "c".repeat(64) }]) {
        await refused(
          inTransaction(async () => {
            const state = await advanceState(g);
            const e = await audit(g);
            await append({ genesisId: g, generation: state.generation, auditLogId: e.id, auditEntryHash: e.entryHash, keysSha256: state.stampKeysSha256, ...bend });
          }),
          /ops_observer_transition_not_this_advance/,
        );
      }
    });

    await t.test("a skipped generation is refused", async () => {
      // A state advance that wrote no ledger row leaves a hole the next append cannot cross.
      const g2 = await genesis("recovery", "shadow", g);
      await inTransaction(() => advanceState(g2));
      await refused(advance(g2), /ops_observer_transition_gap/);
    });

    await t.test("the audit entry must be the signed state advance of the same genesis", async () => {
      const head = await newHead();
      const other = randomUUID();
      for (const [overrides, hashOverride] of [
        [{ entryHash: null }, undefined],
        [{}, "d".repeat(64)],
        [{ action: "ops_observer.genesis_created" }, undefined],
        [{ targetId: other }, undefined],
        [{ actorUserId: "user-1" }, undefined],
        [{ metadata: { systemActor: "marketing-publisher" } }, undefined],
        [{ metadata: { generation: 99 } }, undefined],
        [{ metadata: { keysSha256: "e".repeat(64) } }, undefined],
      ] as AuditOverrideCase[]) {
        await refused(
          inTransaction(async () => {
            const state = await advanceState(head);
            const e = await audit(head, overrides);
            await append({ genesisId: head, generation: state.generation, auditLogId: e.id, auditEntryHash: hashOverride ?? e.entryHash, keysSha256: state.stampKeysSha256 });
          }),
          /ops_observer_transition_audit_mismatch/,
        );
      }
      // An entry committed by an earlier transaction, even one naming exactly
      // the generation and key stamp of this advance, is not this advance's.
      const keys = { fixed: "earlier" };
      const nextGeneration = (await q(`SELECT generation FROM "OpsObserverState" WHERE "genesisId" = $1`, [head])).rows[0].generation + 1;
      const stamp = (await q(`SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') AS h`, [JSON.stringify(keys)])).rows[0].h;
      const earlier = await audit(head, { metadata: { generation: nextGeneration, keysSha256: stamp } });
      await refused(
        inTransaction(async () => {
          const state = await advanceState(head, keys);
          assert.deepEqual([state.generation, state.stampKeysSha256], [nextGeneration, stamp]);
          await append({ genesisId: head, generation: state.generation, auditLogId: earlier.id, auditEntryHash: earlier.entryHash, keysSha256: state.stampKeysSha256 });
        }),
        /ops_observer_transition_audit_mismatch/,
      );
      // An id with no audit entry at all: there is no foreign key, so the guard is what refuses it.
      await refused(
        inTransaction(async () => {
          const state = await advanceState(head);
          await append({ genesisId: head, generation: state.generation, auditLogId: randomUUID(), auditEntryHash: "d".repeat(64), keysSha256: state.stampKeysSha256 });
        }),
        /ops_observer_transition_audit_mismatch/,
      );
    });

    await t.test("rows never change and are never truncated", async () => {
      const head = await newHead();
      await advance(head);
      await refused(q(`UPDATE "OpsObserverTransition" SET "keysSha256" = $2 WHERE "genesisId" = $1 AND generation = 1`, [head, "e".repeat(64)]),
        /ops_observer_transition_immutable/);
      await refused(q(`DELETE FROM "OpsObserverTransition" WHERE "genesisId" = $1 AND generation = 1`, [head]),
        /ops_observer_transition_retained/);
      await refused(q(`TRUNCATE "OpsObserverTransition"`), /ops_observer_transition_retained/);
    });

    await t.test("a seven-year-old row goes only once it is behind the verified checkpoint", async () => {
      // A fresh head with two ledger rows.
      const fresh = await newHead();
      const one = await advance(fresh);
      await advance(fresh);
      // Age the first row the only way possible: past the guard, as a test fixture.
      await age(fresh, 1);
      const purge = () => q(`DELETE FROM "OpsObserverTransition" WHERE "genesisId" = $1 AND generation = 1`, [fresh]);
      // Old, but the checkpoint has not passed it.
      await refused(purge(), /ops_observer_transition_retained/);
      // Move the checkpoint past generation 1 with the next advance.
      await inTransaction(async () => {
        const { rows } = await q(
          `UPDATE "OpsObserverState" SET generation = generation + 1, keys = '{"k":3}', "verifiedThroughGeneration" = 2,
             "verifiedThroughAuditId" = $2, "verifiedThroughAuditHash" = $3, "runDeadlineAt" = ${soon(60)}
            WHERE "genesisId" = $1 RETURNING generation, "stampKeysSha256"`,
          [fresh, one.id, one.entryHash],
        );
        const e = await audit(fresh);
        await append({ genesisId: fresh, generation: rows[0].generation, auditLogId: e.id, auditEntryHash: e.entryHash, keysSha256: rows[0].stampKeysSha256 });
      });
      await purge();
      const left = await q(`SELECT generation FROM "OpsObserverTransition" WHERE "genesisId" = $1 ORDER BY generation`, [fresh]);
      assert.deepEqual(left.rows.map((r) => r.generation), [2, 3]);
      // The row at the checkpoint itself stays, however old: the checkpoint is
      // 2, so generation 2 is not below it.
      await age(fresh, 2);
      await refused(q(`DELETE FROM "OpsObserverTransition" WHERE "genesisId" = $1 AND generation = 2`, [fresh]),
        /ops_observer_transition_retained/);
      // The newest row stays: the checkpoint can never pass it.
      await refused(q(`DELETE FROM "OpsObserverTransition" WHERE "genesisId" = $1 AND generation = 3`, [fresh]),
        /ops_observer_transition_retained/);
    });

    await t.test("a checkpoint the ledger never reached does not open deletion", async () => {
      // One ledger row, then advances that appended none while the checkpoint moved to 2.
      const lagging = await newHead();
      const one = await advance(lagging);
      await advanceStateOnly(lagging);
      await advanceStateOnly(lagging, { generation: 2, auditId: one.id, auditHash: one.entryHash! });
      await age(lagging, 1);
      await refused(q(`DELETE FROM "OpsObserverTransition" WHERE "genesisId" = $1 AND generation = 1`, [lagging]),
        /ops_observer_transition_checkpoint_missing/);
    });

    await t.test("the ledger of a superseded genesis is kept until a retirement record exists", async () => {
      // Old enough and behind a checkpoint whose row exists: deletable, until superseded.
      const retiring = await newHead();
      const one = await advance(retiring);
      await advance(retiring);
      await inTransaction(async () => {
        const { rows } = await q(
          `UPDATE "OpsObserverState" SET generation = generation + 1, keys = '{"k":4}', "verifiedThroughGeneration" = 2,
             "verifiedThroughAuditId" = $2, "verifiedThroughAuditHash" = $3, "runDeadlineAt" = ${soon(60)}
            WHERE "genesisId" = $1 RETURNING generation, "stampKeysSha256"`,
          [retiring, one.id, one.entryHash],
        );
        const e = await audit(retiring);
        await append({ genesisId: retiring, generation: rows[0].generation, auditLogId: e.id, auditEntryHash: e.entryHash, keysSha256: rows[0].stampKeysSha256 });
      });
      await age(retiring, 1);
      const purge = () => q(`DELETE FROM "OpsObserverTransition" WHERE "genesisId" = $1 AND generation = 1`, [retiring]);

      // Only READ COMMITTED may delete: an older snapshot could miss a replacement.
      await refused(
        (async () => {
          await q("BEGIN ISOLATION LEVEL REPEATABLE READ");
          try {
            await purge();
          } finally {
            await q("ROLLBACK");
          }
        })(),
        /ops_observer_isolation_not_read_committed/,
      );

      // A replacement in flight on another connection: the delete waits for its
      // lock on the genesis, then sees the committed replacement and refuses.
      const other = new pg.Client({ connectionString: rawUrl });
      await other.connect();
      try {
        await other.query(`SET search_path TO "${schema}"`);
        await other.query("BEGIN");
        await other.query(
          `INSERT INTO "OpsObserverGenesis" (id, reason, mode, "supersedesGenesisId", "requestDigest", "invariantVersion", "runDeadlineAt")
           VALUES ($1, 'recovery', 'shadow', $2, $3, 1, ${soon(60)})`,
          [randomUUID(), retiring, DIGEST],
        );
        const pending = purge().then(() => null, (e: Error) => e);
        const settledEarly = await Promise.race([pending.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))]);
        assert.equal(settledEarly, false, "the delete must wait for the replacement's lock");
        await other.query("COMMIT");
        const error = await pending;
        assert.match(error?.message ?? "", /ops_observer_transition_superseded/);
      } finally {
        await other.query("ROLLBACK").catch(() => undefined);
        await other.end();
      }
      await refused(purge(), /ops_observer_transition_superseded/);
    });

    await t.test("a superseded genesis cannot append", async () => {
      const old = await newHead();
      const { rows } = await q(`SELECT generation, "stampKeysSha256" FROM "OpsObserverState" WHERE "genesisId" = $1`, [old]);
      await newHead();
      const e = await audit(old);
      // The superseded refusal comes before the state check, so it names itself.
      await refused(
        inTransaction(() => append({ genesisId: old, generation: rows[0].generation, auditLogId: e.id, auditEntryHash: e.entryHash, keysSha256: rows[0].stampKeysSha256 })),
        /ops_observer_transition_superseded/,
      );
    });

    await t.test("the deadline and isolation rules of the state table apply", async () => {
      const head = await newHead();
      const attempt = (deadline: string) =>
        inTransaction(async () => {
          const state = await advanceState(head);
          const e = await audit(head);
          await append({ genesisId: head, generation: state.generation, auditLogId: e.id, auditEntryHash: e.entryHash, keysSha256: state.stampKeysSha256 }, deadline);
        });
      await refused(attempt("NULL"), /ops_observer_deadline_missing|null value/);
      await refused(attempt(soon(181)), /ops_observer_deadline_too_far/);
      // Accepted on the way in, refused at COMMIT once the deadline has passed.
      await refused(
        (async () => {
          await q("BEGIN");
          try {
            const state = await advanceState(head);
            const e = await audit(head);
            await append({ genesisId: head, generation: state.generation, auditLogId: e.id, auditEntryHash: e.entryHash, keysSha256: state.stampKeysSha256 },
              "clock_timestamp() + interval '1 second'");
            await q("SELECT pg_sleep(1.2)");
            await q("COMMIT");
          } catch (error) {
            await q("ROLLBACK").catch(() => undefined);
            throw error;
          }
        })(),
        /ops_observer_late_commit/,
      );
      await refused(
        (async () => {
          await q("BEGIN ISOLATION LEVEL REPEATABLE READ");
          try {
            await q(`INSERT INTO "OpsObserverTransition" ("genesisId", generation, "auditLogId", "auditEntryHash", "keysSha256", "runDeadlineAt")
                     VALUES ($1, 1, 'x', 'x', $2, ${soon(60)})`, [head, "a".repeat(64)]);
          } finally {
            await q("ROLLBACK");
          }
        })(),
        /ops_observer_isolation_not_read_committed/,
      );
    });
  } finally {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  }
});
