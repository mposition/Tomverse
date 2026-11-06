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
  assert.equal(await amuxV22WorkerUsageUnverified(tx, "codex-impl", null), false);
  assert.equal(calls.length, 1);
  const { sql, values } = calls[0];
  assert.deepEqual(values, ["codex-impl", null]);
  assert.match(sql, /w\."archivedAt" IS NULL/);
  // The unknown-usage conditions themselves are unchanged.
  assert.match(sql, /a\."endedAt" IS NOT NULL/);
  assert.match(sql, /w\."sourceSystem" = 'admin-idea-v4'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "AmuxCliUsageEvent" u WHERE u\."attemptId" = a\."id"\)/);
  assert.match(sql, /u\."completeness" <> 'reported_complete'/);
  assert.match(sql, /a\."id" IS DISTINCT FROM \?/);
});

test("an unarchived unknown-usage attempt still refuses the assignment", async () => {
  const { amuxV22WorkerUsageUnverified } = await import(mod("lib/amux/v22WorkerUsageGate.ts"));
  const { calls, tx } = capture([{ id: "attempt" }]);
  assert.equal(await amuxV22WorkerUsageUnverified(tx, "claude-chore", "prior"), true);
  assert.deepEqual(calls[0].values, ["claude-chore", "prior"]);
});
