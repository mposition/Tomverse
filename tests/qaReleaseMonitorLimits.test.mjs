import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// lib/qaReleaseMonitor.ts is server-only; the silence-alert write's limits
// and order are read from source, and its behaviour is covered by
// tests/integration/qa-release-monitor.db.test.ts.

const SOURCE = readFileSync(new URL("../lib/qaReleaseMonitor.ts", import.meta.url), "utf8");

test("the silence-alert write uses the policy's nine statements: 32 s, Prisma 37 s, Prisma > transaction > statement > idle", () => {
  const block = SOURCE.slice(SOURCE.indexOf("QA_RELEASE_STALE_WRITE_LIMITS = Object.freeze({"));
  assert.match(block, /statementMs: 2_000,/);
  assert.match(block, /idleMs: 1_000,/);
  assert.match(block, /statements: 9,/);
  assert.match(block, /transactionMs: \(3 \* 9 \+ 5\) \* 1_000,/);
  assert.match(block, /prismaMs: \(3 \* 9 \+ 5\) \* 1_000 \+ 5_000,/);
  assert.match(SOURCE, /set_config\('transaction_timeout'/);
});

test("the write locks after the limits, audits in the same transaction, and checks the deadline last on every path", () => {
  const fn = SOURCE.slice(SOURCE.indexOf("async function enqueueStaleAlert"), SOURCE.indexOf("export type QaReleaseMonitorAnswer"));
  const order = [
    "set_config('statement_timeout'",
    "await takeAuditChainLock(tx);",
    "tx.notificationDelivery.findUnique(",
    "await enqueueNotificationDelivery(tx,",
    "await writeSystemAuditLog({",
    'return "queued" as const;',
  ].map((marker) => fn.indexOf(marker));
  assert.ok(order.every((at) => at > 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  // The deadline is the last statement on the queued path and on the
  // already-queued path alike.
  const marker = "if (await late()) throw new StaleAlertLate();";
  const lateChecks = [];
  for (let at = fn.indexOf(marker); at >= 0; at = fn.indexOf(marker, at + 1)) lateChecks.push(at);
  assert.equal(lateChecks.length, 2);
  assert.ok(lateChecks[0] < fn.indexOf('return "already_queued" as const;'));
  assert.ok(lateChecks[1] > fn.indexOf("await writeSystemAuditLog({") && lateChecks[1] < fn.indexOf('return "queued" as const;'));
});

test("the round deadline is anchored on the database clock", () => {
  assert.ok(SOURCE.includes("new Date(read.dbNowMs + MONITOR_ROUND_BUDGET_MS - elapsedAfterReadMs)"));
});
