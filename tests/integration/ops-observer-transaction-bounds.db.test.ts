// The arming function's guarantees, observed on a real PostgreSQL
// (docs/policy/sre-ops.md §6). Every fixture that ends a session gets its own
// connection. Fixtures marked "17" run where server_version_num >= 170000 and
// the rest everywhere: CI's database is PostgreSQL 16, and a PostgreSQL 17 job
// runs the same file.
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
      await client.query("BEGIN");
      await client.query(`CREATE TEMP TABLE probe (x int) ON COMMIT DROP`);
      const short = deadlineIn(TRANSACTION_BOUNDS[kind].cGuardedMs + ARM_MARGIN_MS - 200);
      await expectRejection(client.query(ARM_CALL, armArguments(kind, short)), /deadline_budget_insufficient/);
      await client.query("ROLLBACK");
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
 * Arm `assert` (statement 1 s, idle 0.5 s, transaction 6 s) in a session that
 * inherited `inherited`, and return the client inside the open transaction.
 */
async function armedAssertSession(inherited: string | null) {
  const client = await connect(inherited ? `-c transaction_timeout=${inherited}` : "");
  await client.query("BEGIN");
  const { rows } = await client.query(ARM_CALL, armArguments("assert", deadlineIn(60_000)));
  return { client, armed: rows[0] };
}

for (const inherited of ["200ms", "600s"]) {
  test(`17: inherited ${inherited} -- ours is re-armed and actually ends the transaction`, async (t) => {
    if (!(await only17(t))) return;

    if (inherited === "200ms") {
      // Survives past the inherited 200 ms: ours replaced it.
      const { client, armed } = await armedAssertSession(inherited);
      assert.equal(armed.priorTxTimeoutMs, 200);
      await client.query(`SELECT pg_sleep(0.6)`);
      await client.query(`SELECT pg_sleep(0.6)`);
      await client.end();

      // A statement longer than statement_timeout (1 s) is cancelled: the statement timer is armed.
      const second = await armedAssertSession(inherited);
      await expectRejection(second.client.query(`SELECT pg_sleep(1.5)`), /statement timeout/);
      await second.client.end().catch(() => {});

      // An idle gap longer than 0.5 s ends the session: the idle timer is armed.
      const third = await armedAssertSession(inherited);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const idleEnd = await third.client.query(`SELECT 1`).then(() => null, (error: Error) => error);
      assert.ok(idleEnd, "the idle gap must end the session");
      assert.match(reasons(third.client, idleEnd), /idle-in-transaction timeout/);
      await third.client.end().catch(() => {});
    } else {
      const { armed, client } = await armedAssertSession(inherited);
      assert.equal(armed.priorTxTimeoutMs, 600_000);
      await client.end();
    }

    // Short statements under every per-statement timer still end at ttArmedMs.
    const { client, armed } = await armedAssertSession(inherited);
    const started = Date.now();
    const ended = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        try {
          await client.query(`SELECT pg_sleep(0.3)`);
        } catch (error) {
          return error as Error;
        }
      }
      return null;
    })();
    const elapsed = Date.now() - started;
    assert.ok(ended, "the transaction must be ended by our timer");
    assert.match(reasons(client, ended!), /due to transaction timeout/);
    assert.doesNotMatch(reasons(client, ended!), /statement timeout|idle-in-transaction/);
    assert.ok(elapsed >= armed.ttArmedMs - 500 && elapsed <= armed.ttArmedMs + 2_000, `ended after ${elapsed} ms, armed ${armed.ttArmedMs}`);
    await client.end().catch(() => {});
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
  const armLine = `    PERFORM set_config('transaction_timeout', "ttArmedMs"::text, true);`;
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
