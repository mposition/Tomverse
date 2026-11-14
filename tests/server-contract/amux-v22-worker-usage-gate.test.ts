import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// A worker with an ended attempt whose CLI usage is unknown takes no new
// cost-bound assignment. An attempt on an archived card no longer counts:
// production 2026-11-06 had five such attempts, one per worker, all on
// archived cards that cannot be retried, and no Task was assigned after
// 2026-11-02.

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

function capture(rows: Array<{ id: string }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?").replace(/\s+/g, " "), values });
      return rows;
    },
  };
  return { calls, tx };
}

test("the usage gate skips attempts on archived cards and keeps every other unknown", async () => {
  const { amuxV22WorkerUsageUnverified } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const { calls, tx } = capture([]);
  assert.equal(await amuxV22WorkerUsageUnverified(tx, "codex-impl", null, "task-a"), false);
  assert.equal(calls.length, 1);
  const { sql, values } = calls[0];
  // The switch is off here: the paid-only filter passes every attempt.
  assert.deepEqual(values, ["codex-impl", null, "task-a",
    ["cli_turn_limit", "cli_execution_error", "cli_budget_limit"],
    "review_server_rejected_twice", true]);
  assert.match(sql, /w\."archivedAt" IS NULL/);
  // The unknown-usage conditions themselves are unchanged.
  assert.match(sql, /a\."endedAt" IS NOT NULL/);
  assert.match(sql, /w\."sourceSystem" = 'admin-idea-v4'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "AmuxCliUsageEvent" u WHERE u\."attemptId" = a\."id"\)/);
  assert.match(sql, /u\."completeness" <> 'reported_complete'/);
  assert.match(sql, /a\."id" IS DISTINCT FROM \?/);
});

test("only the claimed Task's own named CLI failure, retried by the owner against that attempt, is left out", async () => {
  const { amuxV22WorkerUsageUnverified } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const { calls, tx } = capture([]);
  await amuxV22WorkerUsageUnverified(tx, "claude-chore", null, "task-a");
  const { sql } = calls[0];
  // COALESCE: a NULL reason or status never drops a row from the gate.
  assert.match(sql, /AND NOT COALESCE\(a\."taskId" = \? AND a\."v22AssignmentId" IS NOT NULL AND a\."toStatus" = 'blocked'/);
  assert.match(sql, /AND \(\(a\."outcome" = 'blocked' AND a\."reason" = ANY\(\?::text\[\]\)\)/);
  // A finished run the v52 review rejected twice is left out only with its
  // own reject record (owner decision 2026-11-07).
  assert.match(sql, /OR \(a\."outcome" = 'succeeded' AND a\."reason" = \? AND EXISTS \(SELECT 1 FROM "AmuxV52ReviewRecord" r WHERE r\."attemptId" = a\."id" AND r\."taskId" = a\."taskId" AND r\."verdict" = 'reject'\)\)\)/);
  assert.match(sql, /JOIN "AmuxReviewDecision" d ON d\."proposalId" = p\."id" AND d\."escalationId" = p\."escalationId"/);
  assert.match(sql, /p\."attemptId" = a\."id" AND p\."taskId" = a\."taskId" AND p\."outcome" = 'retry' AND d\."outcome" = 'retry'\), FALSE\)/);
});

test("an expired attempt is left out only when the Task's latest stored result is exactly that attempt", async () => {
  const { amuxV22WorkerUsageUnverified } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const { calls, tx } = capture([]);
  await amuxV22WorkerUsageUnverified(tx, "codex-impl", null, "task-a");
  const { sql, values } = calls[0];
  // AMUX-FILEGEN-003: the lease expired after the result was stored and
  // before the bridge reported usage. The evidence is the review rule's
  // (amuxV22ReviewRetryHasVerifiedOutcome): the latest result of this Task,
  // ordered as reviewApproval.ts reads it, must be this attempt's.
  assert.match(sql, /OR \(a\."outcome" = 'expired' AND \(SELECT r\."attemptId" FROM "AmuxV22TaskResult" r WHERE r\."taskId" = a\."taskId" ORDER BY r\."createdAt" DESC, r\."attemptId" DESC LIMIT 1\) = a\."id"\) OR \(a\."outcome" = 'succeeded'/);
  // Every branch still needs the owner's retry decision bound to that attempt.
  assert.ok(sql.indexOf("'expired'") < sql.indexOf('FROM "AmuxReviewProposal" p'));
  assert.ok(sql.indexOf("'succeeded'") < sql.indexOf('FROM "AmuxReviewProposal" p'));
  assert.equal(values.length, 6);
});

test("an unsettled worker leaves the claim to the next settled route, checked once per worker", async () => {
  const { amuxV22RoutesWithSettledUsage } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const asked: unknown[] = [];
  const tasks: unknown[] = [];
  const tx = { $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    asked.push(values[0]);
    tasks.push(values[2]);
    return values[0] === "codex-chore" ? [{ id: "attempt" }] : [];
  } };
  // Production 2026-11-06, investigate/routine: the cheapest route's worker
  // (codex-chore) was unsettled and copilot-chore was never tried.
  const routes = [{ workerName: "codex-chore", routeId: "a" },
    { workerName: "copilot-chore", routeId: "b" }, { workerName: "codex-chore", routeId: "c" }];
  const settled = await amuxV22RoutesWithSettledUsage(tx as never, routes, null, "task-a");
  assert.deepEqual(settled.routes, [{ workerName: "copilot-chore", routeId: "b" }]);
  assert.equal(settled.unsettled, true);
  assert.deepEqual(asked, ["codex-chore", "copilot-chore"]);
  assert.deepEqual(tasks, ["task-a", "task-a"]);
  const none = await amuxV22RoutesWithSettledUsage(tx as never,
    [{ workerName: "codex-chore" }], null, "task-a");
  assert.deepEqual(none, { routes: [], unsettled: true });
  assert.deepEqual(await amuxV22RoutesWithSettledUsage(tx as never,
    [{ workerName: "copilot-chore" }], null, "task-a"),
  { routes: [{ workerName: "copilot-chore" }], unsettled: false });
});

test("an unarchived unknown-usage attempt still refuses the assignment", async () => {
  const { amuxV22WorkerUsageUnverified } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const { calls, tx } = capture([{ id: "attempt" }]);
  assert.equal(await amuxV22WorkerUsageUnverified(tx, "claude-chore", "prior", "task-a"), true);
  assert.deepEqual(calls[0].values.slice(0, 3), ["claude-chore", "prior", "task-a"]);
});

// Owner decision 2026-11-10: an attempt the owner accepted as unknown (alone,
// or with an owner-approved retry of its Task) no longer holds its worker.
test("an attempt with an owner usage acceptance is left out for every Task", async () => {
  const { amuxV22WorkerUsageUnverified } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const { calls, tx } = capture([]);
  await amuxV22WorkerUsageUnverified(tx, "codex-impl", null, "task-a");
  const { sql } = calls[0];
  assert.match(sql, /AND NOT EXISTS \(SELECT 1 FROM "AmuxV22AttemptUsageAcceptance" x WHERE x\."attemptId" = a\."id"\)/);
  // The acceptance is not tied to the claimed Task: it sits outside the
  // owner-retry exemption, which binds only the Task's own attempt.
  assert.ok(sql.indexOf('"AmuxV22AttemptUsageAcceptance"') < sql.indexOf("AND NOT COALESCE("));
});

test("the Task's unknown-usage list uses the gate's rule and skips accepted attempts", async () => {
  const { amuxV22TaskUnknownUsageAttemptIds } = await import(mod("lib/amux/v22AttemptUsageAcceptance.ts"));
  const { calls, tx } = capture([{ id: "attempt-1" }, { id: "attempt-2" }]);
  assert.deepEqual(await amuxV22TaskUnknownUsageAttemptIds(tx as never, "task-a"),
    ["attempt-1", "attempt-2"]);
  const { sql, values } = calls[0];
  assert.deepEqual(values, ["task-a"]);
  assert.match(sql, /WHERE a\."taskId" = \? AND a\."endedAt" IS NOT NULL AND w\."sourceSystem" = 'admin-idea-v4'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "AmuxCliUsageEvent" u WHERE u\."attemptId" = a\."id"\)/);
  assert.match(sql, /u\."completeness" <> 'reported_complete'/);
  assert.match(sql, /AND NOT EXISTS \(SELECT 1 FROM "AmuxV22AttemptUsageAcceptance" x WHERE x\."attemptId" = a\."id"\)/);
});

test("with read-back proceed on, only a budget-bound (paid) attempt holds a worker", async () => {
  const { amuxV22WorkerUsageUnverified } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const { calls, tx } = capture([]);
  await amuxV22WorkerUsageUnverified(tx, "codex-impl", null, "task-a", true);
  const { sql, values } = calls[0];
  assert.equal(values.at(-1), false);
  assert.ok(sql.includes(`AND (? OR EXISTS (SELECT 1 FROM "AmuxV22WorkerAssignment" g JOIN "AmuxV22TaskRecoveryApproval" ap ON ap."id" = g."recoveryApprovalId" WHERE g."id" = a."v22AssignmentId" AND ap."riskAcceptanceId" IS NOT NULL))`), sql);
});

test("the read-back proceed switch is off unless exactly enabled", async () => {
  const core = await import(mod("lib/amux/v22ReadBackProceedCore.ts"));
  assert.equal(core.amuxV22ReadBackProceedEnabled(undefined), false);
  assert.equal(core.amuxV22ReadBackProceedEnabled("true"), false);
  assert.equal(core.amuxV22ReadBackProceedEnabled("enabled"), true);
  assert.equal(core.amuxExecutionLeaseMs(false), 90_000);
  assert.equal(core.amuxExecutionLeaseMs(true), 180_000);
  assert.equal(core.amuxV22CliUsageRecordOnly({ enabled: true, budgetBound: false, apiReceipt: false }), true);
  assert.equal(core.amuxV22CliUsageRecordOnly({ enabled: true, budgetBound: true, apiReceipt: false }), false);
  assert.equal(core.amuxV22CliUsageRecordOnly({ enabled: true, budgetBound: false, apiReceipt: true }), false);
  assert.equal(core.amuxV22CliUsageRecordOnly({ enabled: false, budgetBound: false, apiReceipt: false }), false);
});
