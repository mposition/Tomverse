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
  assert.deepEqual(values, ["codex-impl", null, "task-a",
    ["cli_turn_limit", "cli_execution_error", "cli_budget_limit"]]);
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
  assert.match(sql, /AND NOT COALESCE\(a\."taskId" = \? AND a\."v22AssignmentId" IS NOT NULL/);
  assert.match(sql, /a\."outcome" = 'blocked' AND a\."toStatus" = 'blocked'/);
  assert.match(sql, /a\."reason" = ANY\(\?::text\[\]\)/);
  assert.match(sql, /JOIN "AmuxReviewDecision" d ON d\."proposalId" = p\."id" AND d\."escalationId" = p\."escalationId"/);
  assert.match(sql, /p\."attemptId" = a\."id" AND p\."taskId" = a\."taskId" AND p\."outcome" = 'retry' AND d\."outcome" = 'retry'\), FALSE\)/);
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
