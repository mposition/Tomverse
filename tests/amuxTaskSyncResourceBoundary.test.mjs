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
