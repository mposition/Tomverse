// The transaction every publisher batch runs in (S2 plan, S2d1).
//
// What a fake can show: the order the three timeouts are set in, the refusal
// below PostgreSQL 17, the isolation level, and the statement count. What it
// cannot -- that PostgreSQL actually arms the timers -- is in
// tests/integration/marketing-automation-schema.db.test.ts, against the server
// CI runs, which this slice moves to 17 for exactly that reason.

import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  MarketingPublisherTransactionRefusedError,
  runBoundedMarketingTransaction,
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
