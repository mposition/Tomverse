// The transaction every publisher batch runs in (S2 plan, S2d1).
//
// What a fake can show: the order the three timeouts are set in, the refusal
// below PostgreSQL 17, the isolation level, and the statement count. What it
// cannot -- that PostgreSQL actually arms the timers -- is in
// tests/integration/marketing-automation-schema.db.test.ts, against the server
// CI runs, which this slice moves to 17 for exactly that reason.

import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  finishMarketingPublisherRun,
  MARKETING_PUBLISHER_LATE_SUCCESS_SQLSTATE,
  MARKETING_PUBLISHER_START_AFTER_DEADLINE_SQLSTATE,
  MarketingPublisherTransactionRefusedError,
  runBoundedMarketingTransaction,
  startMarketingPublisherRun,
} from "@/lib/marketingPublisherRun";
import {
  MARKETING_PUBLISHER_IDLE_TIMEOUT_MS,
  MARKETING_PUBLISHER_MAX_STATEMENTS,
  MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS,
  MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS,
} from "@/lib/marketingPublisherRunCore";

const statementText = (query: unknown): string => {
  if (Array.isArray(query)) return query.join("?");
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(query);
};

const statementValues = (query: unknown): readonly unknown[] =>
  (query as { values?: readonly unknown[] }).values ?? [];

/** A client whose transaction records every statement and every option. */
const fakeClient = (serverVersionNum: number) => {
  const seen = {
    settings: [] as { name: string; value: string }[],
    options: null as Record<string, unknown> | null,
    workStatements: 0,
  };
  const tx = {
    async $queryRaw(query: unknown) {
      const sql = statementText(query);
      if (sql.includes("server_version_num")) return [{ num: serverVersionNum }];
      if (sql.includes("set_config")) {
        const values = statementValues(query);
        const name = /set_config\(\s*'([a-z_]+)'/.exec(sql)?.[1] ?? "?";
        seen.settings.push({ name, value: String(values[0]) });
        return [{ set_config: values[0] }];
      }
      seen.workStatements += 1;
      return [];
    },
    marketingPost: {
      async findMany() {
        seen.workStatements += 1;
        return [];
      },
    },
  };
  const client = {
    async $transaction(
      fn: (tx: unknown) => Promise<unknown>,
      options: Record<string, unknown>,
    ) {
      seen.options = options;
      return fn(tx);
    },
  };
  return { client: client as unknown as PrismaClient, seen };
};

test("transaction_timeout is set first, and the two ceilings after it", async () => {
  // The ordering trap: statement_timeout and idle_in_transaction_session_timeout
  // are armed only while shorter than transaction_timeout. Set them first and a
  // later, lower transaction_timeout would switch them off without a word.
  const { client, seen } = fakeClient(170002);
  await runBoundedMarketingTransaction(client, async () => "done");
  assert.deepEqual(seen.settings, [
    {
      name: "transaction_timeout",
      value: String(MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS),
    },
    {
      name: "statement_timeout",
      value: String(MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS),
    },
    {
      name: "idle_in_transaction_session_timeout",
      value: String(MARKETING_PUBLISHER_IDLE_TIMEOUT_MS),
    },
  ]);
  assert.equal(seen.options?.isolationLevel, "Serializable");
  // Prisma's own ceiling sits above the database's, so the database says no
  // first and says why.
  assert.ok(Number(seen.options?.timeout) > MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS);
});

test("below PostgreSQL 17 it refuses rather than run without the bound", async () => {
  // 16 has no transaction_timeout. Running anyway would promise a bound the
  // server cannot give; the version is read each time because a managed
  // database can be restored onto a different major.
  const { client, seen } = fakeClient(160004);
  let ran = false;
  await assert.rejects(
    runBoundedMarketingTransaction(client, async () => {
      ran = true;
    }),
    (error: unknown) =>
      error instanceof MarketingPublisherTransactionRefusedError &&
      error.code === "server_too_old",
  );
  assert.equal(ran, false, "the work must not start on a server that cannot bound it");
  assert.deepEqual(seen.settings, [], "nothing is set on a server that is refused");
});

test("the work may issue twelve statements and not a thirteenth", async () => {
  const { client, seen } = fakeClient(170002);
  await runBoundedMarketingTransaction(client, async (tx) => {
    for (let i = 0; i < MARKETING_PUBLISHER_MAX_STATEMENTS; i += 1) {
      await tx.$queryRaw`SELECT 1`;
    }
  });
  assert.equal(seen.workStatements, MARKETING_PUBLISHER_MAX_STATEMENTS);

  const second = fakeClient(170002);
  await assert.rejects(
    runBoundedMarketingTransaction(second.client, async (tx) => {
      for (let i = 0; i <= MARKETING_PUBLISHER_MAX_STATEMENTS; i += 1) {
        await tx.$queryRaw`SELECT 1`;
      }
    }),
    (error: unknown) =>
      error instanceof MarketingPublisherTransactionRefusedError &&
      error.code === "statement_budget_exhausted",
  );
  // Refused on the call, before the statement is sent: the thirteenth never
  // reaches the database.
  assert.equal(second.seen.workStatements, MARKETING_PUBLISHER_MAX_STATEMENTS);
});

test("a model delegate call counts as a statement too", async () => {
  // Not only raw queries. A counter that watched `$queryRaw` alone would let a
  // batch written with the query builder run unbounded.
  const { client } = fakeClient(170002);
  await assert.rejects(
    runBoundedMarketingTransaction(client, async (tx) => {
      for (let i = 0; i <= MARKETING_PUBLISHER_MAX_STATEMENTS; i += 1) {
        await (tx as unknown as { marketingPost: { findMany(): Promise<unknown> } })
          .marketingPost.findMany();
      }
    }),
    (error: unknown) =>
      error instanceof MarketingPublisherTransactionRefusedError &&
      error.code === "statement_budget_exhausted",
  );
});

test("the wrapper's own settings are not charged to the work", async () => {
  // The version probe and the three set_config calls are four statements the
  // wrapper issues; if they counted, the work would have eight, not twelve.
  const { client, seen } = fakeClient(170002);
  await runBoundedMarketingTransaction(client, async (tx) => {
    for (let i = 0; i < MARKETING_PUBLISHER_MAX_STATEMENTS; i += 1) {
      await tx.$queryRaw`SELECT 1`;
    }
  });
  assert.equal(seen.settings.length, 3);
  assert.equal(seen.workStatements, MARKETING_PUBLISHER_MAX_STATEMENTS);
});

test("the work cannot open a transaction inside its budget", async () => {
  // A nested transaction would be somewhere for statements the counter does
  // not see.
  const { client } = fakeClient(170002);
  await assert.rejects(
    runBoundedMarketingTransaction(client, async (tx) =>
      (tx as unknown as { $transaction(): unknown }).$transaction(),
    ),
    (error: unknown) => error instanceof MarketingPublisherTransactionRefusedError,
  );
});

// ---------------------------------------------------------------------------
// Opening and closing the run row
// ---------------------------------------------------------------------------

/**
 * The error Prisma actually throws for a trigger's own SQLSTATE.
 *
 * Built with Prisma's own class, the way its runtime builds it: `P2039`, the
 * code at `meta.driverAdapterError.cause.originalCode`, and **no `cause`**.
 * The helper this replaces attached a `cause` -- a shape Prisma never
 * produces -- and so proved a code path that was dead in production.
 *
 * The message deliberately says nothing about a deadline and carries no code,
 * so the only way a test using it can pass is by finding the SQLSTATE where
 * Prisma really puts it.
 */
const raised = (sqlstate: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code: "P2039",
    clientVersion: "test",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: { kind: "postgres", originalCode: sqlstate, originalMessage: message },
      },
    },
  });

test("the helper builds the shape Prisma throws, which has no cause", () => {
  // Pinned, because the fix rests on it: if Prisma starts setting `cause`,
  // this fails and is worth a look -- the reader would still work.
  const error = raised("TMDL1", "late");
  assert.equal("cause" in error, false);
  assert.equal(error.code, "P2039");
});

test("a close that closed nothing is not reported as a success", async () => {
  // Round one: the close's row count was ignored, so a run already closed by
  // something else -- or never opened -- came back "succeeded" and the route
  // said so.
  for (const outcome of [
    { status: "succeeded" as const, processedCount: 0, result: {} },
    { status: "failed" as const, error: "test" },
  ]) {
    const client = {
      scheduledJobRun: { updateMany: async () => ({ count: 0 }) },
    } as unknown as PrismaClient;
    assert.deepEqual(
      await finishMarketingPublisherRun(client, "run-1", outcome),
      { status: "not_running" },
    );
  }
});

test("a late success is recognised by its SQLSTATE, whatever the message says", async () => {
  // The point of giving the refusal its own code: a driver that rewords the
  // message must not turn a recognised late run into an unexplained failure.
  const writes: Record<string, unknown>[] = [];
  let calls = 0;
  const client = {
    scheduledJobRun: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls += 1;
        writes.push(data);
        if (calls === 1) {
          throw raised(MARKETING_PUBLISHER_LATE_SUCCESS_SQLSTATE, "a message nobody wrote");
        }
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  assert.deepEqual(
    await finishMarketingPublisherRun(client, "run-1", {
      status: "succeeded",
      processedCount: 0,
      result: {},
    }),
    { status: "failed" },
  );
  assert.equal(writes[1]?.status, "failed");
  assert.equal(writes[1]?.error, "deadline_exceeded");
});

test("any other refusal on close is not mistaken for a late run", async () => {
  const client = {
    scheduledJobRun: {
      updateMany: async () => {
        throw raised("23514", "something else entirely");
      },
    },
  } as unknown as PrismaClient;
  await assert.rejects(
    finishMarketingPublisherRun(client, "run-1", {
      status: "succeeded",
      processedCount: 0,
      result: {},
    }),
    /something else entirely/,
  );
});

test("a start the database says is already past its deadline is an answer", async () => {
  // The route checks the deadline with its own clock; the trigger with the
  // database's. When they disagree the database is right, and the service
  // should hear "this run cannot start", not a framework 500.
  const client = {
    scheduledJobRun: {
      create: async () => {
        throw raised(MARKETING_PUBLISHER_START_AFTER_DEADLINE_SQLSTATE, "reworded");
      },
    },
  } as unknown as PrismaClient;
  assert.deepEqual(
    await startMarketingPublisherRun(client, {
      runId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      deadlineAt: new Date(Date.now() + 60_000),
    }),
    { started: false, reason: "deadline_passed_at_database" },
  );
});
