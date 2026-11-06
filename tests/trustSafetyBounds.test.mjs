import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ARM_MARGIN_MS,
  CHILD_TIMEOUT_MS,
  DEAD_MAN_WINDOW_MS,
  DECLARED_PERIOD_MS,
  GUARDED_TOTAL_MS,
  IDLE_TIMEOUT_MS,
  MONOTONIC_PRECHECK_MS,
  PING_ABORT_MS,
  PING_FRESHNESS_MS,
  ROUND_WINDOW_FLOOR_MS,
  ROUND_WINDOW_MS,
  ROUTE_BUDGET_MS,
  STATEMENT_TIMEOUT_MS,
  SUPERVISOR_KILL_MS,
  TRUST_SAFETY_BOUNDS,
  boundViolations,
  outerOrderViolations,
} from "../lib/trustSafetyBoundsCore.ts";

/**
 * The numbers §12 (1) asks an operator to sign
 * (docs/policy/trust-safety-compliance-agent.md tables A, B and C).
 *
 * The figures below are read off those tables. They are here so that changing
 * one in the module without changing the policy fails, which is the only
 * reason the module may hold them at all.
 */

test("table B gives each kind its four figures", () => {
  // kind -> [A, C_guarded, transaction_timeout, Prisma timeout]
  const table = new Map([
    ["activation_read", [5, 15_000, 18_000, 25_000]],
    ["dsr_read", [3, 9_000, 12_000, 20_000]],
    ["run_write", [3, 9_000, 12_000, 20_000]],
    ["activation_write", [8, 24_000, 27_000, 40_000]],
  ]);
  assert.equal(TRUST_SAFETY_BOUNDS.size, table.size, "four kinds, no more");
  for (const [kind, [a, guarded, tt, prismaTimeout]] of table) {
    const bound = TRUST_SAFETY_BOUNDS.get(kind);
    assert.ok(bound, `${kind} exists`);
    assert.equal(bound.statementCeiling, a, `${kind} A`);
    assert.equal(bound.cGuardedMs, guarded, `${kind} C_guarded`);
    assert.equal(bound.transactionTimeoutMs, tt, `${kind} transaction_timeout`);
    assert.equal(bound.prismaTimeoutMs, prismaTimeout, `${kind} Prisma timeout`);
    assert.equal(bound.statementTimeoutMs, STATEMENT_TIMEOUT_MS);
    assert.equal(bound.idleTimeoutMs, IDLE_TIMEOUT_MS);
  }
  assert.equal(STATEMENT_TIMEOUT_MS, 2_000);
  assert.equal(IDLE_TIMEOUT_MS, 1_000);
});

test("a kind's deadline is its guarded budget, by the same expression", () => {
  // §12 corrected this: one revision's table said A x 3s and its test
  // requirement said (A - 1) x 3s, so no implementation without a literal
  // satisfied both. The deadline and the guarded budget are now one figure.
  for (const bound of TRUST_SAFETY_BOUNDS.values()) {
    assert.equal(bound.deadlineMs, bound.cGuardedMs);
    assert.equal(bound.deadlineMs, bound.statementCeiling * 3_000);
  }
  assert.equal(TRUST_SAFETY_BOUNDS.get("run_write").deadlineMs, 9_000, "the run row: 9s");
  assert.equal(TRUST_SAFETY_BOUNDS.get("activation_write").deadlineMs, 24_000, "activation: 24s");
});

test("dsr_read and run_write are separate entries, not one shared constant", () => {
  // §12: the two hold the same figures only because A is 3 for both. A
  // statement added to the run write must not move the read's budget.
  const source = readFileSync("lib/trustSafetyBoundsCore.ts", "utf8");
  assert.match(source, /\["dsr_read",\s*bound\(/);
  assert.match(source, /\["run_write",\s*bound\(/);
});

test("table C's derived figures come out of table B", () => {
  assert.equal(GUARDED_TOTAL_MS, 36_000);
  assert.equal(ROUTE_BUDGET_MS, 59_000);
  assert.equal(PING_FRESHNESS_MS, 51_000);
  assert.equal(CHILD_TIMEOUT_MS, 69_000);
  assert.equal(SUPERVISOR_KILL_MS, 99_000);
  assert.equal(ROUND_WINDOW_FLOOR_MS, 34_000, "the derived floor under the window");
});

test("the two free proposals and the margin", () => {
  assert.equal(ROUND_WINDOW_MS, 47_000);
  assert.equal(PING_ABORT_MS, 3_000);
  assert.equal(MONOTONIC_PRECHECK_MS, 1_000);
  assert.equal(ARM_MARGIN_MS, 250);
});

test("table A's period and window", () => {
  assert.equal(DECLARED_PERIOD_MS, 1_800_000, "P = 30 minutes");
  assert.equal(DEAD_MAN_WINDOW_MS, 7_200_000, "W = k x P = 120 minutes");
});

test("every kind satisfies the ordering §5.5 calls a contract", () => {
  for (const [kind, bound] of TRUST_SAFETY_BOUNDS.entries()) {
    assert.deepEqual(boundViolations(bound), [], kind);
  }
});

test("a transaction_timeout at or below the statement timer is caught on its own", () => {
  // The measurement record's trap: the per-statement limit turns off silently
  // and the guarded budget then rests on nothing. §5.5 asserts this link
  // separately, so a regression names it.
  const broken = {
    statementCeiling: 3,
    statementTimeoutMs: 2_000,
    idleTimeoutMs: 1_000,
    cGuardedMs: 9_000,
    deadlineMs: 9_000,
    transactionTimeoutMs: 1_500,
    prismaTimeoutMs: 20_000,
  };
  const violations = boundViolations(broken);
  assert.ok(violations.includes("transaction_gt_statement"));
  assert.ok(violations.includes("transaction_gt_guarded"));
});

test("the outer ordering and its two gaps hold", () => {
  assert.deepEqual(outerOrderViolations(), []);
  assert.equal(CHILD_TIMEOUT_MS - ROUTE_BUDGET_MS, 10_000);
  assert.equal(SUPERVISOR_KILL_MS - CHILD_TIMEOUT_MS, 30_000);
  assert.ok(SUPERVISOR_KILL_MS < DECLARED_PERIOD_MS);
});

test("the migration's own intervals are the module's figures", () => {
  // The two numbers the database enforces are written in SQL, where the
  // module cannot reach them. If either moves, these are two different
  // contracts claiming to be one.
  const run = readFileSync(
    "prisma/migrations/20261104060000_trust_safety_observer_run/migration.sql",
    "utf8",
  );
  const window = run.match(/interval '(\d+) seconds'[\s\S]{0,200}?window_exceeded/);
  assert.ok(window, "the window interval is in the migration");
  assert.equal(Number(window[1]) * 1_000, ROUND_WINDOW_MS);
  assert.ok(
    run.includes(`interval '${TRUST_SAFETY_BOUNDS.get("run_write").deadlineMs / 1_000} seconds'`),
    "the run row's reach check uses the kind's deadline",
  );

  const config = readFileSync(
    "prisma/migrations/20261104070000_trust_safety_observer_config/migration.sql",
    "utf8",
  );
  assert.ok(
    config.includes(`interval '${TRUST_SAFETY_BOUNDS.get("activation_write").deadlineMs / 1_000} seconds'`),
    "the activation write's reach check uses its own deadline",
  );
});
