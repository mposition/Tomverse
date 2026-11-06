import assert from "node:assert/strict";
import test from "node:test";

import { TRUST_SAFETY_BOUNDS } from "../lib/trustSafetyBoundsCore.ts";
import {
  TrustSafetyRoundRefused,
  isActivationConflict,
  isBudgetInsufficient,
  withTrustSafetyTransaction,
} from "../lib/trustSafetyTransaction.ts";

/**
 * The wrapper every round opens its transactions through
 * (docs/policy/trust-safety-compliance-agent.md §5.4, §5.5, §5.6 item 3).
 *
 * The database side of this -- that the arming function refuses a short
 * budget, that the deadline string parses, that a late or stale round is
 * refused at COMMIT -- was verified against a throwaway PostgreSQL 17.10
 * cluster. What a unit test can hold is the sequence this module sends and the
 * refusals it makes itself, so that is what these assert.
 */

const ARM_ROW = {
  serverVersion: 170010,
  priorTxTimeoutMs: 0,
  txStart: new Date("2026-11-05T04:50:38.694Z"),
  ttArmedMs: 12_000,
  ttArmed: true,
};

/**
 * A client that records the statements sent instead of sending them. Prisma
 * passes a tagged `$queryRaw` its template strings and values, so the recorded
 * SQL is the literal text of the statement with its parameters separated.
 */
const fakeClient = ({ armRow = ARM_ROW, rowsFor = () => [] } = {}) => {
  const statements = [];
  let options = null;
  const tx = {
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push({ sql, values });
      if (sql.includes("ops_observer_arm_timeouts")) {
        return Promise.resolve(armRow === null ? [] : [armRow]);
      }
      return Promise.resolve(rowsFor(sql));
    },
  };
  return {
    statements,
    optionsSeen: () => options,
    client: {
      $transaction: (fn, opts) => {
        options = opts;
        return fn(tx);
      },
    },
  };
};

const deadline = () => new Date(Date.now() + 59_000);

test("a writing kind arms the timers first and makes the deadline second", async () => {
  // §5.4's order: the two database timers, then the deadline in a statement of
  // its own. A deadline computed in the arming statement would be the
  // application's claim about when it ran.
  const fake = fakeClient();
  await withTrustSafetyTransaction({
    kind: "run_write",
    runDeadline: deadline(),
    client: fake.client,
    fn: async () => "done",
  });
  assert.equal(fake.statements.length, 2);
  assert.match(fake.statements[0].sql, /ops_observer_arm_timeouts/);
  assert.match(fake.statements[1].sql, /set_config/);
  assert.deepEqual(
    fake.statements[0].values,
    [2_000, 1_000, 12_000, 9_000, 250, fake.statements[0].values[5]],
    "the kind's figures, in table B's order",
  );
  assert.equal(fake.statements[1].values[0], "trust_safety.run_deadline");
  assert.equal(fake.statements[1].values[1], 9, "the kind's deadline, in seconds");
});

test("the deadline string is pinned, not cast through the session DateStyle", async () => {
  // Verified on 17.10: `(clock_timestamp() + ...)::text` under `SQL, MDY` or
  // `German, DMY` renders `11/05/2026 14:50:38.704203 AEST`, the deadline
  // parser refuses it, and every round fails. `to_char` with this mask renders
  // `+00`, `+10` and `+05:30` alike, all of which the parser accepts.
  const fake = fakeClient();
  await withTrustSafetyTransaction({
    kind: "run_write",
    runDeadline: deadline(),
    client: fake.client,
    fn: async () => null,
  });
  const sql = fake.statements[1].sql;
  assert.match(sql, /to_char\(/);
  assert.match(sql, /'YYYY-MM-DD"T"HH24:MI:SS\.MSOF'/);
  assert.doesNotMatch(sql, /::text/, "a text cast would depend on DateStyle");
  assert.match(sql, /clock_timestamp\(\)/, "the database's clock, not the application's");
  assert.match(sql, /true\) AS armed/, "transaction-local, so nothing outside can reuse it");
});

test("a reading kind has no deadline statement", async () => {
  // Only the two writing kinds have a row whose trigger reads a deadline; a
  // read transaction setting one would be a statement spent on nothing.
  for (const kind of ["activation_read", "dsr_read"]) {
    const fake = fakeClient();
    const remaining = await withTrustSafetyTransaction({
      kind,
      runDeadline: deadline(),
      client: fake.client,
      fn: async (tx) => tx.remaining(),
    });
    assert.equal(fake.statements.length, 1, kind);
    assert.equal(
      remaining,
      TRUST_SAFETY_BOUNDS.get(kind).statementCeiling - 1,
      `${kind} leaves the callback A - 1`,
    );
  }
});

test("the callback is charged what the wrapper already spent", async () => {
  const fake = fakeClient();
  const remaining = await withTrustSafetyTransaction({
    kind: "run_write",
    runDeadline: deadline(),
    client: fake.client,
    fn: async (tx) => tx.remaining(),
  });
  assert.equal(remaining, 1, "A = 3, two spent by the wrapper, one for the INSERT");
});

test("the ceiling refuses the statement past A", async () => {
  // An application device, and §5.5 says so: no PostgreSQL version counts
  // statements, so this is the only thing that holds the round-trip bound.
  const fake = fakeClient();
  await assert.rejects(
    withTrustSafetyTransaction({
      kind: "run_write",
      runDeadline: deadline(),
      client: fake.client,
      fn: async (tx) => {
        await tx.statement(() => Promise.resolve("first"));
        await tx.statement(() => Promise.resolve("second past the ceiling"));
      },
    }),
    (error) =>
      error instanceof TrustSafetyRoundRefused &&
      error.code === "trust_safety_statement_ceiling",
  );
});

test("an inherited timer at or below the guarded budget ends the round before any write", async () => {
  // §5.5. The callback must not run at all: a refusal that still let the
  // INSERT through would leave a row claiming a budget that was not in force.
  for (const priorTxTimeoutMs of [1, 9_000]) {
    const fake = fakeClient({ armRow: { ...ARM_ROW, priorTxTimeoutMs } });
    let callbackRan = false;
    await assert.rejects(
      withTrustSafetyTransaction({
        kind: "run_write",
        runDeadline: deadline(),
        client: fake.client,
        fn: async () => {
          callbackRan = true;
        },
      }),
      (error) =>
        error instanceof TrustSafetyRoundRefused &&
        error.code === "trust_safety_inherited_transaction_timeout",
      `prior ${priorTxTimeoutMs}`,
    );
    assert.equal(callbackRan, false);
    assert.equal(fake.statements.length, 1, "the deadline statement is not sent either");
  }
});

test("a larger inherited timer, and none at all, both proceed", async () => {
  // Above the guarded budget the round runs, and §5.5 declines to claim what
  // the occupancy limit then is. A null is PostgreSQL 16, which has no such
  // setting to inherit -- judged on the reported value, never on the version.
  for (const priorTxTimeoutMs of [9_001, 60_000, null]) {
    const fake = fakeClient({ armRow: { ...ARM_ROW, priorTxTimeoutMs } });
    const ran = await withTrustSafetyTransaction({
      kind: "run_write",
      runDeadline: deadline(),
      client: fake.client,
      fn: async () => "ran",
    });
    assert.equal(ran, "ran", `prior ${String(priorTxTimeoutMs)}`);
  }
});

test("the arming result reaches the callback, including the database clock", async () => {
  const fake = fakeClient();
  const armed = await withTrustSafetyTransaction({
    kind: "dsr_read",
    runDeadline: deadline(),
    client: fake.client,
    fn: async (_tx, a) => a,
  });
  assert.equal(armed.txStart.toISOString(), "2026-11-05T04:50:38.694Z");
  assert.equal(armed.ttArmed, true);
});

test("an arming statement that returns nothing refuses the round", async () => {
  const fake = fakeClient({ armRow: null });
  await assert.rejects(
    withTrustSafetyTransaction({
      kind: "run_write",
      runDeadline: deadline(),
      client: fake.client,
      fn: async () => null,
    }),
    (error) => error instanceof TrustSafetyRoundRefused && error.code === "trust_safety_arm_no_row",
  );
});

test("the transaction options are the kind's, with the ordering §5.5 requires", async () => {
  for (const kind of ["activation_read", "dsr_read", "run_write", "activation_write"]) {
    const fake = fakeClient();
    await withTrustSafetyTransaction({
      kind,
      runDeadline: deadline(),
      client: fake.client,
      fn: async () => null,
    });
    const options = fake.optionsSeen();
    // REPEATABLE READ for the activation read only: §6 judges the config row
    // against the entries bound to it, and under READ COMMITTED a legitimate
    // activation write committing between those two reads reads as
    // `binding_mismatch`. The writing kinds stay READ COMMITTED -- a
    // serialization failure on a path that must not retry is worse.
    const expectedIsolation = kind === "activation_read" ? "RepeatableRead" : "ReadCommitted";
    assert.equal(options.isolationLevel, expectedIsolation, kind);
    assert.equal(options.timeout, TRUST_SAFETY_BOUNDS.get(kind).prismaTimeoutMs, kind);
    assert.equal(options.maxWait, 2_000, kind);
    // The database must end a run before the client library gives up on it.
    assert.ok(options.timeout > TRUST_SAFETY_BOUNDS.get(kind).transactionTimeoutMs, kind);
  }
});

test("the activation row's own refusals are recognised by SQLSTATE", () => {
  // TS005 is a version that did not move forward, TS006 a mode that did not
  // change. Both mean another write settled it and nothing of ours landed.
  for (const code of ["TS005", "TS006"]) {
    assert.equal(isActivationConflict({ code }), true, code);
    assert.equal(
      isActivationConflict({ code: "P2010", meta: { driverAdapterError: { cause: { code } } } }),
      true,
      `${code} through the adapter`,
    );
  }
  // The first activation has no row to transition from, so two requests can
  // both read null and both create; the second loses on the primary key, which
  // the database reports as Prisma's own code. Accepted review asked for it.
  assert.equal(isActivationConflict({ code: "P2002" }), true);
  assert.equal(isActivationConflict({ code: "TS002" }), false, "a late commit is a different answer");
  assert.equal(isActivationConflict({ message: "TS005" }), false, "never on prose");
});

test("the budget refusal is recognised by SQLSTATE, through either error shape", () => {
  assert.equal(isBudgetInsufficient({ code: "OB001" }), true);
  assert.equal(
    isBudgetInsufficient({ code: "P2010", meta: { driverAdapterError: { cause: { code: "OB001" } } } }),
    true,
  );
  assert.equal(
    isBudgetInsufficient({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "OB001" } } },
    }),
    true,
  );
  // Never on prose: a message match would hide a change in where the code travels.
  assert.equal(isBudgetInsufficient({ message: "deadline_budget_insufficient" }), false);
  assert.equal(isBudgetInsufficient(null), false);
});
