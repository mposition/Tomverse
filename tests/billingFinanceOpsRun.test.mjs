import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isBillingFinanceOpsDeadlineError,
  isBillingFinanceOpsRunAuthorized,
  runBillingFinanceOpsDeadline,
} from "../lib/billingFinanceOpsRun.ts";

// docs/policy/billing-finance-ops.md §1.1 item 2 and §1.2: the branches that
// answer before the database clock is read. The write path is covered against
// PostgreSQL in tests/integration/billing-finance-ops-run.db.test.ts.

const SECRET = "s".repeat(32);
const ENV = { BILLING_FINANCE_OPS_RUN_SECRET: SECRET, APP_ENV: "staging" };
const ON = '{"enabled":true,"revision":1,"enabledAt":"2026-10-04T00:00:00.000Z"}';
const OFF = '{"enabled":false,"revision":0,"enabledAt":null}';

const request = ({ auth = `Bearer ${SECRET}`, body } = {}) =>
  new Request("https://example.invalid/api/internal/agents/billing-finance-ops/runs", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
    body,
  });

const fakeDb = ({ stored = ON, throws = false } = {}) => {
  const calls = { clock: 0 };
  return {
    calls,
    appSetting: {
      findUnique: async () => {
        if (throws) throw new Error("connection refused");
        return stored === null ? null : { value: stored };
      },
    },
    $queryRaw: async () => {
      calls.clock += 1;
      return [{ startedAtMs: Date.parse("2026-10-04T01:00:00.000Z") }];
    },
  };
};

test("the secret must be at least 32 characters, Bearer, and equal", () => {
  assert.equal(isBillingFinanceOpsRunAuthorized(`Bearer ${SECRET}`, ENV), true);
  assert.equal(isBillingFinanceOpsRunAuthorized(`Bearer ${SECRET}x`, ENV), false);
  assert.equal(isBillingFinanceOpsRunAuthorized(SECRET, ENV), false);
  assert.equal(isBillingFinanceOpsRunAuthorized("Bearer ", ENV), false);
  assert.equal(isBillingFinanceOpsRunAuthorized(null, ENV), false);
  const short = { BILLING_FINANCE_OPS_RUN_SECRET: "short" };
  assert.equal(isBillingFinanceOpsRunAuthorized("Bearer short", short), false);
});

test("an unauthenticated call learns nothing, not even whether the switch is on", async () => {
  const db = fakeDb({ throws: true });
  const answer = await runBillingFinanceOpsDeadline(request({ auth: "Bearer wrong" }), { env: ENV, db });
  assert.deepEqual(answer, { status: 401, body: { result: "unauthorized" } });
});

test("off answers disabled; a missing, malformed or unreadable switch answers control_unreadable", async () => {
  assert.deepEqual(await runBillingFinanceOpsDeadline(request(), { env: ENV, db: fakeDb({ stored: OFF }) }), {
    status: 200,
    body: { result: "disabled" },
  });
  for (const db of [fakeDb({ stored: null }), fakeDb({ stored: "{" }), fakeDb({ throws: true })]) {
    assert.deepEqual(await runBillingFinanceOpsDeadline(request(), { env: ENV, db }), {
      status: 503,
      body: { result: "control_unreadable" },
    });
    assert.equal(db.calls.clock, 0);
  }
});

test("a body is refused before the clock is read", async () => {
  const db = fakeDb();
  assert.deepEqual(await runBillingFinanceOpsDeadline(request({ body: "{}" }), { env: ENV, db }), {
    status: 400,
    body: { result: "body_not_allowed" },
  });
  assert.equal(db.calls.clock, 0);
});

test("only production and staging may record", async () => {
  for (const APP_ENV of ["development", "test"]) {
    const answer = await runBillingFinanceOpsDeadline(request(), { env: { ...ENV, APP_ENV }, db: fakeDb() });
    assert.deepEqual(answer, { status: 503, body: { result: "environment_not_eligible" } });
  }
});

test("a register past the ceiling is refused before anything is written", async () => {
  const register = Array.from({ length: 61 }, (_, i) => ({ modelId: `qa-${i}` }));
  const answer = await runBillingFinanceOpsDeadline(request(), { env: ENV, db: fakeDb(), register, models: [] });
  assert.deepEqual(answer, { status: 409, body: { result: "register_too_large" } });
});

test("only the database's deadline refusal is read as deadline_exceeded", () => {
  assert.equal(isBillingFinanceOpsDeadlineError(new Error("Raw query failed. Message: `billing_finance_ops_deadline_passed`")), true);
  assert.equal(isBillingFinanceOpsDeadlineError(new Error("support_triage_deadline_passed")), false);
  assert.equal(isBillingFinanceOpsDeadlineError("billing_finance_ops_deadline_passed"), false);
});

test("the route answers codes only and declares a 60-second maxDuration", () => {
  const route = readFileSync("app/api/internal/agents/billing-finance-ops/runs/route.ts", "utf8");
  assert.match(route, /export const maxDuration = 60;/);
  assert.match(route, /runBillingFinanceOpsDeadline\(request\)/);
  const code = route.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /payload|modelId|ticket\b/i);
});

test("the database clock is read as epoch milliseconds, never as a raw timestamptz", () => {
  // Prisma hands a raw timestamptz back as the session's wall-clock time
  // labelled UTC; on a +10:00 database that put the run's start, its UTC date
  // and its deadline ten hours late (found on PostgreSQL 17.10, 2026-10-04).
  const source = readFileSync("lib/billingFinanceOpsRun.ts", "utf8").replace(/\/\/[^\n]*/g, "");
  assert.match(source, /extract\(epoch FROM clock_timestamp\(\)\) \* 1000/);
  assert.doesNotMatch(source, /SELECT clock_timestamp\(\) AS/);
});
