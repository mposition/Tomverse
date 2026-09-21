import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("task sync cannot re-key claimed work outside its original WIP lock", async () => {
  const route = await readFile(
    new URL("../app/api/internal/amux/tasks/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /current\.status === "doing" \|\| current\.owner !== null/);
  assert.match(route, /status: current\.status,\s*owner: null,\s*revision: current\.revision/);
  assert.match(route, /AMUX_TASK_SNAPSHOT_CONFLICT/);
});

test("task sync binds an explicit review PR only to human-review work", async () => {
  const route = await readFile(
    new URL("../app/api/internal/amux/tasks/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /review_pr_number: z\.number\(\)\.int\(\)\.min\(1\)/);
  assert.match(route, /task\.review_pr_number && !task\.requires_human_review/);
  assert.match(route, /reviewPrNumber: task\.review_pr_number \?\? null/);
});

test("a settled review releases the worker owner so a later PR number can sync", async () => {
  const execution = await readFile(
    new URL("../lib/amux/execution.ts", import.meta.url),
    "utf8",
  );
  assert.match(execution, /effectiveToStatus === "todo" \|\| effectiveToStatus === "review"/);
  assert.match(execution, /status: effectiveToStatus,\s*owner: null,\s*claimedAt: null/);
});
