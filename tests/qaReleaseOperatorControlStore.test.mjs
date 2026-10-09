import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// lib/qaReleaseOperatorControlStore.ts is server-only; its limits and lock are
// read from source here, and its behaviour is covered by
// tests/integration/qa-release-operator-control.db.test.ts.

const STORE = readFileSync(new URL("../lib/qaReleaseOperatorControlStore.ts", import.meta.url), "utf8");
const AUDIT = readFileSync(new URL("../lib/adminAudit.ts", import.meta.url), "utf8");

test("the write takes the audit chain lock as its own statement, after the limits are armed", () => {
  // set_config arms statement_timeout for the statements after it, so a lock
  // folded into that statement would wait without the 2 s limit.
  assert.equal(STORE.includes("pg_advisory"), false);
  const limitsAt = STORE.indexOf("set_config('statement_timeout'");
  const lockAt = STORE.indexOf("await takeAuditChainLock(tx);");
  const readAt = STORE.indexOf("tx.qaReleaseOperatorControl.findFirst(");
  assert.ok(limitsAt > 0 && limitsAt < lockAt && lockAt < readAt);
  assert.match(AUDIT, /export async function takeAuditChainLock/);
});

test("the limits follow 3A + 5 for eight statements, with Prisma five seconds longer", () => {
  const block = STORE.slice(STORE.indexOf("QA_RELEASE_CONTROL_WRITE_LIMITS = Object.freeze({"));
  assert.match(block, /statements: 8,/);
  assert.match(block, /transactionMs: \(3 \* 8 \+ 5\) \* 1_000,/);
  assert.match(block, /prismaMs: \(3 \* 8 \+ 5\) \* 1_000 \+ 5_000,/);
  assert.match(STORE, /set_config\('transaction_timeout'/);
});
