import assert from "node:assert/strict";
import { after, test } from "node:test";

import pg from "pg";

import { resolvePostgresConnectionConfig } from "@/lib/postgresConnectionConfigCore.mjs";

import { prisma } from "@/lib/prisma";
import { LANE_TIMEOUTS } from "@/lib/supportTriageCore";
import {
  SupportTriageTransactionRefused,
  armSupportTriageTransaction,
} from "@/lib/supportTriageTransaction";

// support_triage_arm_timeouts() and its wrapper (docs/policy/support-triage.md §4).
//
// What needs a database: whether a setting survives the function call, whether
// a timeout actually fires, and what an inherited session transaction_timeout
// does are server behaviour, not something a pure test can show. The suite
// runs on PostgreSQL 16 and 17; the transaction_timeout cases only mean
// something on 17 and skip themselves on 16.

after(async () => {
  await prisma.$disconnect();
});

const readSettings = async (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => {
  const { rows } = await client.query(
    `SELECT
       (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') AS statement,
       (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS idle,
       (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'transaction_timeout') AS transaction,
       current_setting('server_version_num')::int AS version`
  );
  return rows[0] as { statement: string; idle: string; transaction: string | null; version: number };
};

const directClient = async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "DATABASE_URL must point at the test database");
  // The same resolution lib/prisma.ts uses, so a ?schema= URL reaches the
  // schema the migrations built rather than public.
  const config = resolvePostgresConnectionConfig(url, { requireTestMarker: true });
  const client = new pg.Client({
    connectionString: config.connectionString,
    options: config.poolOptions,
  });
  await client.connect();
  return client;
};

test("one call arms all of the lane's timeouts, and they are still set after it returns", async () => {
  for (const lane of ["worker", "retention", "admin"] as const) {
    await prisma.$transaction(async (tx) => {
      const armed = await armSupportTriageTransaction(tx, lane);
      const [settings] = await tx.$queryRawUnsafe<
        { statement: string; idle: string; transaction: string | null }[]
      >(
        `SELECT
           (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') AS statement,
           (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout') AS idle,
           (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'transaction_timeout') AS transaction`
      );
      assert.equal(Number(settings.statement), LANE_TIMEOUTS[lane].statementTimeoutMs, lane);
      assert.equal(Number(settings.idle), LANE_TIMEOUTS[lane].idleInTransactionTimeoutMs, lane);
      if (armed.serverVersionNum >= 170000) {
        assert.equal(Number(settings.transaction), LANE_TIMEOUTS[lane].transactionTimeoutMs, lane);
      } else {
        assert.equal(settings.transaction, null, lane);
        assert.equal(armed.inheritedTransactionTimeoutMs, null, lane);
      }
      assert.ok(armed.nowUtc instanceof Date);
    });
  }
});

test("the settings are transaction-local: the next transaction on the connection starts clean", async () => {
  const client = await directClient();
  try {
    const before = await readSettings(client);
    await client.query("BEGIN");
    await client.query(`SELECT * FROM support_triage_arm_timeouts(400, 150, 20000)`);
    await client.query("COMMIT");
    assert.deepEqual(await readSettings(client), before);
  } finally {
    await client.end();
  }
});

test("the armed statement_timeout actually cancels a slow statement", async () => {
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await armSupportTriageTransaction(tx, "retention");
      await tx.$queryRawUnsafe(`SELECT pg_sleep(1)`);
    }),
    /statement timeout|57014/i
  );
});

test("the function refuses timeouts out of order", async () => {
  const client = await directClient();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      client.query(`SELECT * FROM support_triage_arm_timeouts(400, 400, 20000)`),
      /transaction > statement > idle/
    );
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
});

test("catalog: no SET clause, SECURITY INVOKER, VOLATILE, no EXCEPTION handler", async () => {
  const rows = await prisma.$queryRawUnsafe<
    { config: string[] | null; definer: boolean; volatile: string; handler: boolean }[]
  >(
    `SELECT proconfig AS config, prosecdef AS definer, provolatile::text AS volatile,
            prosrc ILIKE '%EXCEPTION WHEN%' AS handler
       FROM pg_proc WHERE proname = 'support_triage_arm_timeouts'`
  );
  assert.deepEqual(rows, [{ config: null, definer: false, volatile: "v", handler: false }]);
});

test("negative control: a copy with a SET clause loses the setting it names on return", async () => {
  // Why the catalog assertion above exists. Built in a temporary schema so the
  // real function is untouched, then dropped with the transaction.
  const client = await directClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE FUNCTION pg_temp.arm_with_set_clause() RETURNS void
         LANGUAGE plpgsql SET statement_timeout = '1000'
       AS $$ BEGIN PERFORM pg_catalog.set_config('statement_timeout', '400', true); END $$`
    );
    const before = (await readSettings(client)).statement;
    await client.query(`SELECT pg_temp.arm_with_set_clause()`);
    assert.equal((await readSettings(client)).statement, before);
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
});

const inheritedCase = async (inheritedMs: number) => {
  const client = await directClient();
  try {
    const { version } = await readSettings(client);
    if (version < 170000) return { skipped: true as const };
    await client.query(`SET transaction_timeout = ${inheritedMs}`);
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM support_triage_arm_timeouts(400, 150, 20000)`
    );
    await client.query("ROLLBACK");
    return { skipped: false as const, inherited: rows[0].inheritedTransactionTimeoutMs as number };
  } finally {
    await client.end();
  }
};

test("on 17 the function reports the session's inherited transaction_timeout", async (t) => {
  const zero = await inheritedCase(0);
  if (zero.skipped) {
    t.skip("PostgreSQL 16 has no transaction_timeout");
    return;
  }
  assert.equal(zero.inherited, 0);
  assert.equal((await inheritedCase(5_000)).inherited, 5_000);
  assert.equal((await inheritedCase(60_000)).inherited, 60_000);
});

// A transaction client over one pg connection, so a session-level SET is
// guaranteed to be on the connection the wrapper arms. Only $queryRaw is used.
const onConnection = (client: pg.Client) =>
  ({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((sql, part, index) => sql + "$" + index + part);
      return (await client.query(text, values)).rows;
    },
  }) as unknown as Parameters<typeof armSupportTriageTransaction>[0];

const armUnderInherited = async (inheritedMs: number) => {
  const client = await directClient();
  try {
    await client.query(`SET transaction_timeout = ${inheritedMs}`);
    await client.query("BEGIN");
    try {
      const armed = await armSupportTriageTransaction(onConnection(client), "retention");
      return { armed, settings: await readSettings(client) };
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
};

test("on 17 the wrapper refuses a short inherited timeout and proceeds under a long one", async (t) => {
  const probe = await inheritedCase(0);
  if (probe.skipped) {
    t.skip("PostgreSQL 16 has no transaction_timeout");
    return;
  }
  // 5,000 ms is at or below the retention lane's largest C_guarded (10,300 ms).
  await assert.rejects(armUnderInherited(5_000), (error: unknown) => {
    assert.ok(error instanceof SupportTriageTransactionRefused);
    assert.equal(error.reason, "inherited_transaction_timeout_too_short");
    return true;
  });
  // A long inherited timeout is left in place: the setting still reads the
  // inherited value, the timer that actually runs.
  const long = await armUnderInherited(60_000);
  assert.deepEqual(long.armed.decision, { action: "proceed", armedBy: "inherited" });
  assert.equal(Number(long.settings.transaction), 60_000);
  assert.equal(Number(long.settings.statement), LANE_TIMEOUTS.retention.statementTimeoutMs);
  const none = await armUnderInherited(0);
  assert.deepEqual(none.armed.decision, { action: "proceed", armedBy: "policy" });
  assert.equal(Number(none.settings.transaction), LANE_TIMEOUTS.retention.transactionTimeoutMs);
});
