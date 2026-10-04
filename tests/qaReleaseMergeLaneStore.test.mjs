import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// lib/qaReleaseMergeLaneStore.ts is server-only; its limits and statement
// order are read from source, and its behaviour is covered by
// tests/integration/qa-release-merge-lane-store.db.test.ts.

const SOURCE = readFileSync(new URL("../lib/qaReleaseMergeLaneStore.ts", import.meta.url), "utf8");

test("instruction issue uses the policy's nine statements: 32 s, Prisma 37 s, Prisma > transaction > statement > idle", () => {
  const block = SOURCE.slice(SOURCE.indexOf("QA_RELEASE_ISSUE_LIMITS = Object.freeze({"));
  assert.match(block, /statementMs: 2_000,/);
  assert.match(block, /idleMs: 1_000,/);
  assert.match(block, /statements: 9,/);
  assert.match(block, /transactionMs: \(3 \* 9 \+ 5\) \* 1_000,/);
  assert.match(block, /prismaMs: \(3 \* 9 \+ 5\) \* 1_000 \+ 5_000,/);
  assert.match(SOURCE, /set_config\('transaction_timeout'/);
});

test("issue locks after the limits, judges before writing, audits before the insert and checks the deadline last", () => {
  const fn = SOURCE.slice(SOURCE.indexOf("export async function issueQaReleaseMergeInstruction"));
  const order = [
    "set_config('statement_timeout'",
    "await takeAuditChainLock(tx);",
    'FROM "QaReleaseOperatorControl" ORDER BY "revision" DESC LIMIT 1',
    "judgeQaReleaseInstructionIssue(",
    "if (!judgement.issue) return",
    "await writeSystemAuditLog({",
    'INSERT INTO "QaReleaseMergeAttempt"',
    "SELECT clock_timestamp() >= ",
    "return { issued: true as const",
  ].map((marker) => fn.indexOf(marker));
  assert.ok(order.every((at) => at > 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  // The deadline is anchored on the database clock read in the lane read.
  assert.ok(fn.includes("new Date(Number(read.dbNowMs) + input.budget.budgetMs - (input.budget.clock() - input.budget.startedAt))"));
});

test("instruction consume uses the policy's nine statements and audits before its conditional update, deadline last", () => {
  const block = SOURCE.slice(SOURCE.indexOf("QA_RELEASE_CONSUME_LIMITS = Object.freeze({"));
  assert.match(block, /statements: 9,/);
  assert.match(block, /transactionMs: \(3 \* 9 \+ 5\) \* 1_000,/);
  assert.match(block, /prismaMs: \(3 \* 9 \+ 5\) \* 1_000 \+ 5_000,/);
  const fn = SOURCE.slice(SOURCE.indexOf("export async function consumeQaReleaseMergeInstruction"));
  const order = [
    "set_config('statement_timeout'",
    "await takeAuditChainLock(tx);",
    "FOR UPDATE",
    "judgeQaReleaseInstructionConsume(",
    "if (!judgement.consume) return",
    "await writeSystemAuditLog({",
    `SET "state" = 'consumed'`,
    "SELECT clock_timestamp() >= ",
    "return { consumed: true as const }",
  ].map((marker) => fn.indexOf(marker));
  assert.ok(order.every((at) => at > 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.match(fn, /WHERE "id" = \$\{input\.request\.attemptId\} AND "state" = 'issued'/);
});

test("result report arms ten statements, audits first, moves in one statement, then latch, alert and the deadline last", () => {
  const block = SOURCE.slice(SOURCE.indexOf("QA_RELEASE_REPORT_LIMITS = Object.freeze({"));
  assert.match(block, /statements: 10,/);
  assert.match(block, /transactionMs: \(3 \* 10 \+ 5\) \* 1_000,/);
  assert.match(block, /prismaMs: \(3 \* 10 \+ 5\) \* 1_000 \+ 5_000,/);
  const fn = SOURCE.slice(SOURCE.indexOf("export async function reportQaReleaseMergeResult"));
  const order = [
    "set_config('statement_timeout'",
    "await takeAuditChainLock(tx);",
    "await writeSystemAuditLog({",
    "WITH c AS (",
    'INSERT INTO "QaReleaseMergeLaneLatch"',
    "enqueueNotificationDeliveryOnce(tx,",
    "SELECT clock_timestamp() >= ",
    "return { recorded: true as const",
  ].map((marker) => fn.indexOf(marker));
  assert.ok(order.every((at) => at > 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  // A revision mismatch never closes a deploy as a success, in SQL as in the core.
  assert.match(fn, /AND \(\$\{!closesAsSuccess\} OR \(SELECT "revision" FROM c\) IS NOT DISTINCT FROM \$\{input\.callerRevision\}::int\)/);
});
