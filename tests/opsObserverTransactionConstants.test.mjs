// The nine transaction kinds (docs/policy/sre-ops.md §6, decision N-2): the
// code table equals the policy table row by row, C_guarded is derived rather
// than typed, and every row satisfies the ordering the arming function relies on.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ARM_MARGIN_MS,
  TRANSACTION_BOUNDS,
  armArguments,
  boundViolations,
} from "../scripts/ops-observer/transaction-bounds-core.mjs";

const policy = readFileSync(new URL("../docs/policy/sre-ops.md", import.meta.url), "utf8");

const POLICY_ROW_LABELS = {
  advance: "`advance`",
  confirm: "`confirm`",
  genesis: "Admin `genesis`",
  verify_result: "Admin `verify-result`",
  genesis_retirement: "Admin `genesis-retirement`",
  digest_submit: "`digest` 제출",
  state_read: "`state` 읽기",
  retention_batch: "보존 배치",
  assert: "`assert`(마감 확인)",
};

const ms = (cell) => Number(cell.replace(/[ ,]|ms/g, ""));
const seconds = (cell) => Math.round(Number(cell.replace("초", "")) * 1000);

test("every kind equals its row in the policy's §6 table", () => {
  assert.deepEqual(Object.keys(TRANSACTION_BOUNDS).sort(), Object.keys(POLICY_ROW_LABELS).sort());
  for (const [kind, label] of Object.entries(POLICY_ROW_LABELS)) {
    const row = policy.split("\n").find((line) => line.startsWith(`| ${label} |`));
    assert.ok(row, `policy §6 row for ${kind}`);
    const [, a, st, idle, guarded, tt, prisma] = row.split("|").slice(1, -1).map((c) => c.trim());
    const b = TRANSACTION_BOUNDS[kind];
    assert.equal(b.statementCeiling, Number(a), `${kind} A`);
    assert.equal(b.statementTimeoutMs, ms(st), `${kind} statement`);
    assert.equal(b.idleTimeoutMs, ms(idle), `${kind} idle`);
    assert.equal(b.cGuardedMs, seconds(guarded), `${kind} C_guarded`);
    assert.equal(b.transactionTimeoutMs, ms(tt), `${kind} transaction_timeout`);
    assert.equal(b.prismaTimeoutMs, ms(prisma), `${kind} Prisma`);
  }
});

test("every kind satisfies Prisma > transaction_timeout >= C_guarded > statement > idle, and fits the run deadline", () => {
  for (const [kind, b] of Object.entries(TRANSACTION_BOUNDS)) {
    assert.deepEqual(boundViolations(b), [], kind);
    assert.equal(b.cGuardedMs, b.statementCeiling * (b.statementTimeoutMs + b.idleTimeoutMs), kind);
  }
});

test("the violation check catches each broken link", () => {
  const good = TRANSACTION_BOUNDS.advance;
  assert.deepEqual(boundViolations({ ...good, prismaTimeoutMs: good.transactionTimeoutMs }), ["prisma_gt_transaction"]);
  assert.deepEqual(boundViolations({ ...good, transactionTimeoutMs: good.cGuardedMs - 1 }), ["transaction_ge_guarded"]);
  assert.deepEqual(boundViolations({ ...good, idleTimeoutMs: good.statementTimeoutMs }), ["statement_gt_idle"]);
});

test("the arm margin is the policy's 250 ms and the arguments are in the function's order", () => {
  assert.equal(ARM_MARGIN_MS, 250);
  const deadline = new Date("2026-10-05T03:23:00.000Z");
  assert.deepEqual(armArguments("assert", deadline), [1_000, 500, 6_000, 4_500, 250, "2026-10-05T03:23:00.000Z"]);
  assert.throws(() => armArguments("nope", deadline), /kind_unknown/);
  assert.throws(() => armArguments("advance", new Date("x")), /run_deadline_invalid/);
});
