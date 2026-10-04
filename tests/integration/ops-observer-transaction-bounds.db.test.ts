// The arming function's guarantees, observed on a real PostgreSQL
// (docs/policy/sre-ops.md §6). Every fixture that ends a session gets its own
// connection. Fixtures marked "17" run where server_version_num >= 170000 and
// the rest everywhere. The DB integration lanes run PostgreSQL 17; the
// "Ops observer transaction bounds (PostgreSQL 16)" job runs this file on 16
// and sets OPS_OBSERVER_EXPECT_SERVER_MAJOR so it cannot pass on the wrong one.
//
// Nothing here trusts current_setting() alone: a timer whose setting changed
// but was not armed reads the same as one that was, so the 17 fixtures watch
// the session actually end, or not end, at the time the policy says.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

import {
  ARM_MARGIN_MS,
  TRANSACTION_BOUNDS,
  armArguments,
} from "../../scripts/ops-observer/transaction-bounds-core.mjs";

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations/20261003060000_ops_observer_transaction_arm/migration.sql",
);
const rawUrl = process.env.TEST_DATABASE_URL?.trim();
const schema = `ops_observer_bounds_${randomUUID().replaceAll("-", "")}`;
const ARM_CALL = `SELECT * FROM ops_observer_arm_timeouts($1, $2, $3, $4, $5, $6::timestamptz)`;

type Kind = keyof typeof TRANSACTION_BOUNDS;

type Session = pg.Client & { serverErrors: string[] };

/** Every error message for this session: rejected queries and FATALs the server sent unprompted. */
function reasons(client: Session, rejection?: Error): string {
  return [...client.serverErrors, rejection?.message ?? ""].join(" | ");
}

async function connect(sessionOptions = ""): Promise<Session> {
  const client = new pg.Client({
    connectionString: rawUrl,
    ...(sessionOptions ? { options: sessionOptions } : {}),
  }) as Session;
  // A session the server terminates between queries emits 'error' with the
  // FATAL text; keep it so a fixture can say *which* timer ended the session.
  client.serverErrors = [];
  client.on("error", (error) => client.serverErrors.push(error.message));
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
  return client;
}

async function serverVersion(): Promise<number> {
  const client = await connect();
  try {
    const { rows } = await client.query(`SELECT current_setting('server_version_num')::int AS v`);
    return rows[0].v;
  } finally {
    await client.end();
  }
}

function deadlineIn(ms: number): Date {
  return new Date(Date.now() + ms);
}

async function expectRejection(work: Promise<unknown>, pattern: RegExp): Promise<Error> {
  try {
    await work;
  } catch (error) {
    assert.match(String((error as Error).message), pattern);
    return error as Error;
  }
  assert.fail(`expected a rejection matching ${pattern}`);
}

let setupDone = false;
async function setup() {
  if (setupDone) return;
  const url = new URL(rawUrl!);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const schemaName = url.searchParams.get("schema") || "";
  assert.match(`${databaseName}_${schemaName}`, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
    "only a dedicated test database is accepted");
  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(await readFile(migrationPath, "utf8"));
  } finally {
    await admin.end();
  }
  setupDone = true;
}

test.after(async () => {
  if (!rawUrl || !setupDone) return;
  const admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});

test("the server is the major version this job expects", { skip: !rawUrl }, async () => {
  await setup();
  const expected = process.env.OPS_OBSERVER_EXPECT_SERVER_MAJOR?.trim();
  const version = await serverVersion();
  if (expected) assert.equal(Math.floor(version / 10_000), Number(expected));
  assert.ok(version >= 160000, "PostgreSQL 16 or later");
});

test("a NULL argument is refused before any timer is set", { skip: !rawUrl }, async () => {
  await setup();
  const args = armArguments("assert", deadlineIn(60_000));
  for (let i = 0; i < args.length; i += 1) {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const withNull = args.map((v, j) => (j === i ? null : v));
      await expectRejection(client.query(ARM_CALL, withNull), /arm_argument_null/);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

test("the arming function has no SET clause, is SECURITY INVOKER and has no EXCEPTION block", { skip: !rawUrl }, async () => {
  await setup();
  const client = await connect();
  try {
    const { rows } = await client.query(
      `SELECT p.proconfig IS NULL AS "noSet", p.prosecdef AS "definer", p.prosrc AS src
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'ops_observer_arm_timeouts' AND n.nspname = $1`,
      [schema],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].noSet, true);
    assert.equal(rows[0].definer, false);
    assert.doesNotMatch(rows[0].src, /\bEXCEPTION\s+WHEN\b/i);
  } finally {
    await client.end();
  }
});

test("the digest helper hashes the UTF-8 bytes, as Node does", { skip: !rawUrl }, async () => {
  await setup();
  const client = await connect();
  try {
    for (const input of ["", "abc", "é", "운영 감시", "{\"a\": 1}"]) {
      const { rows } = await client.query(`SELECT ops_observer_sha256_hex($1) AS h`, [input]);
      assert.equal(rows[0].h, createHash("sha256").update(input, "utf8").digest("hex"), input);
    }
  } finally {
    await client.end();
  }
});

test("every kind refuses to start without C_guarded + 250 ms of budget, and writes nothing", { skip: !rawUrl }, async () => {
  await setup();
  for (const kind of Object.keys(TRANSACTION_BOUNDS) as Kind[]) {
    const client = await connect();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS probe (kind text)`);
      await client.query("BEGIN");
      await client.query(`INSERT INTO probe VALUES ($1)`, [kind]);
      const short = deadlineIn(TRANSACTION_BOUNDS[kind].cGuardedMs + ARM_MARGIN_MS - 200);
      await expectRejection(client.query(ARM_CALL, armArguments(kind, short)), /deadline_budget_insufficient/);
      // COMMIT of an aborted transaction rolls back: the write before the refusal is gone.
      await client.query("COMMIT");
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM probe WHERE kind = $1`, [kind]);
      assert.equal(rows[0].n, 0, kind);
    } finally {
      await client.end();
    }
  }
});

test("after the call the statement and idle timers read as set, and transaction_timeout is absent on 16", { skip: !rawUrl }, async () => {
  await setup();
  const version = await serverVersion();
  for (const kind of Object.keys(TRANSACTION_BOUNDS) as Kind[]) {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(ARM_CALL, armArguments(kind, deadlineIn(170_000)));
      const armed = rows[0];
      const readBack = await client.query(
        `SELECT current_setting('statement_timeout') AS st,
                current_setting('idle_in_transaction_session_timeout') AS idle,
                current_setting('transaction_timeout', true) AS tt`,
      );
      const b = TRANSACTION_BOUNDS[kind];
      const unit = (msValue: number) => (msValue % 1000 === 0 ? `${msValue / 1000}s` : `${msValue}ms`);
      assert.equal(readBack.rows[0].st, unit(b.statementTimeoutMs), `${kind} statement`);
      assert.equal(readBack.rows[0].idle, unit(b.idleTimeoutMs), `${kind} idle`);
      assert.equal(armed.serverVersion, version);
      if (version >= 170000) {
        assert.equal(armed.ttArmed, true, kind);
        assert.ok(armed.ttArmedMs >= b.cGuardedMs && armed.ttArmedMs <= b.transactionTimeoutMs, `${kind} ttArmedMs`);
        assert.equal(armed.priorTxTimeoutMs, 0);
      } else {
        assert.equal(armed.ttArmed, false);
        assert.equal(armed.ttArmedMs, null);
        assert.equal(armed.priorTxTimeoutMs, null);
        assert.equal(readBack.rows[0].tt, null, "16 has no transaction_timeout");
      }
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

// ---- PostgreSQL 17 ----------------------------------------------------------

async function only17(t: { skip: (message: string) => void }): Promise<boolean> {
  if (!rawUrl) return false;
  await setup();
  if ((await serverVersion()) < 170000) {
    t.skip("PostgreSQL 17 fixture; this server is older");
    return false;
  }
  return true;
}

/**
 * A profile with the shape of the policy's two-second kinds (statement 2 s,
 * idle 1 s) and a transaction timer short enough to watch expire: A = 2, so
 * C_guarded = 6 s, and the timer is 8 s. The real constants are pinned by
 * tests/opsObserverTransactionConstants.test.mjs; this fixture is about what
 * the database does with whatever the function arms.
 */
const PROFILE = { st: 2_000, idle: 1_000, tt: 8_000, guarded: 6_000 };

async function armedSession(inherited: string) {
  const client = await connect(`-c transaction_timeout=${inherited}`);
  await client.query("BEGIN");
  const { rows } = await client.query(ARM_CALL, [
    PROFILE.st, PROFILE.idle, PROFILE.tt, PROFILE.guarded, ARM_MARGIN_MS, deadlineIn(60_000).toISOString(),
  ]);
  return { client, armed: rows[0] };
}

for (const [inherited, inheritedMs] of [["200ms", 200], ["600s", 600_000]] as const) {
  test(`17: inherited ${inherited} -- every timer is armed and ours ends the transaction`, async (t) => {
    if (!(await only17(t))) return;

    // Survives pg_sleep(1): past an inherited 200 ms, so ours replaced it.
    const first = await armedSession(inherited);
    assert.equal(first.armed.priorTxTimeoutMs, inheritedMs);
    assert.equal(first.armed.ttArmedMs, PROFILE.tt);
    await first.client.query(`SELECT pg_sleep(1)`);
    await first.client.query("ROLLBACK");
    await first.client.end();

    // A statement longer than two seconds is cancelled: the statement timer is armed.
    const second = await armedSession(inherited);
    const cancelled = await second.client.query(`SELECT pg_sleep(2.5)`).then(() => null, (e: Error) => e);
    assert.ok(cancelled, "the long statement must be cancelled");
    assert.match(reasons(second.client, cancelled!), /statement timeout/);
    await second.client.end().catch(() => {});

    // A gap longer than the idle timeout ends the session: the idle timer is armed.
    const third = await armedSession(inherited);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const idleEnd = await third.client.query(`SELECT 1`).then(() => null, (e: Error) => e);
    assert.ok(idleEnd, "the idle gap must end the session");
    assert.match(reasons(third.client, idleEnd!), /idle-in-transaction timeout/);
    await third.client.end().catch(() => {});

    // Short statements under every per-statement timer still end at our 8 s.
    const fourth = await armedSession(inherited);
    const started = Date.now();
    let ended: Error | null = null;
    for (let i = 0; i < 40 && !ended; i += 1) {
      ended = await fourth.client.query(`SELECT pg_sleep(0.5)`).then(() => null, (e: Error) => e);
    }
    const elapsed = Date.now() - started;
    assert.ok(ended, "the transaction must be ended by our timer");
    assert.match(reasons(fourth.client, ended!), /due to transaction timeout/);
    assert.doesNotMatch(reasons(fourth.client, ended!), /statement timeout|idle-in-transaction/);
    assert.ok(elapsed >= PROFILE.tt - 500 && elapsed <= PROFILE.tt + 2_000, `ended after ${elapsed} ms`);
    await fourth.client.end().catch(() => {});
  });
}

test("17: a transaction_timeout at or below statement_timeout disarms the statement timer", async (t) => {
  if (!(await only17(t))) return;
  const client = await connect();
  await client.query("BEGIN");
  await client.query(`SELECT set_config('transaction_timeout', '1500', true), set_config('statement_timeout', '2000', true)`);
  const started = Date.now();
  const error = await client.query(`SELECT pg_sleep(5)`).then(() => null, (e: Error) => e);
  assert.ok(error, "the sleep must be ended");
  assert.match(reasons(client, error!), /due to transaction timeout/);
  assert.doesNotMatch(reasons(client, error!), /statement timeout/);
  assert.ok(Date.now() - started < 4_000);
  await client.end().catch(() => {});
});

test("17: the postcondition refuses a timer armed too late (a delayed copy of the function)", async (t) => {
  if (!(await only17(t))) return;
  const source = await readFile(migrationPath, "utf8");
  const original = source.slice(source.indexOf("CREATE FUNCTION ops_observer_arm_timeouts"));
  const armLine = `    PERFORM pg_catalog.set_config('transaction_timeout', "ttArmedMs"::text, true);`;
  assert.equal(original.split(armLine).length, 2, "the arm line occurs once");
  const delayed = original
    .replace("CREATE FUNCTION ops_observer_arm_timeouts", "CREATE FUNCTION ops_observer_arm_timeouts_delayed")
    .replace(armLine, `    PERFORM pg_sleep(0.4);\n${armLine}`);
  // The copy differs from the migration by the injected line and the name only.
  assert.equal(delayed.split("\n").length, original.split("\n").length + 1);
  assert.equal(
    delayed.replace("    PERFORM pg_sleep(0.4);\n", "").replace("ops_observer_arm_timeouts_delayed", "ops_observer_arm_timeouts"),
    original,
  );

  const client = await connect();
  try {
    await client.query(delayed);
    await client.query("BEGIN");
    const b = TRANSACTION_BOUNDS.assert;
    const deadline = deadlineIn(b.cGuardedMs + ARM_MARGIN_MS + 100);
    await expectRejection(
      client.query(`SELECT * FROM ops_observer_arm_timeouts_delayed($1, $2, $3, $4, $5, $6::timestamptz)`, armArguments("assert", deadline)),
      /transaction_timeout_arm_overshoot/,
    );
    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }
});

test("a set_config() earlier on the caller's search_path cannot stand in for the real one", { skip: !rawUrl }, async () => {
  await setup();
  const decoy = `${schema}_decoy`;
  const client = await connect();
  try {
    await client.query(`CREATE SCHEMA "${decoy}"`);
    await client.query(
      `CREATE FUNCTION "${decoy}".set_config(text, text, boolean) RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$`,
    );
    await client.query(`SET search_path TO "${decoy}", pg_catalog, "${schema}"`);
    await client.query("BEGIN");
    await client.query(ARM_CALL, armArguments("assert", deadlineIn(60_000)));
    const { rows } = await client.query(`SELECT pg_catalog.current_setting('statement_timeout') AS st`);
    assert.equal(rows[0].st, "1s");
    await client.query("ROLLBACK");
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${decoy}" CASCADE`).catch(() => {});
    await client.end();
  }
});
