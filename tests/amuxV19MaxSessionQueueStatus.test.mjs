import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { amuxV19MaxQueueStatus } from
  "../scripts/amux-v19-max-session-queue-status.mjs";

test("Max queue command emits only a fixed status token", () => {
  for (const kind of ["idle", "discovered", "disabled",
    "catalog_unapproved", "more_unexamined"]) {
    assert.deepEqual(amuxV19MaxQueueStatus({ kind,
      candidate: { ideaId: "sensitive-id" },
      price: { priceVersionId: "sensitive-price" } }), {
      line: `AMUX_V19_MAX_SESSION_QUEUE_${kind}\n`, exitCode: 0 });
  }
  for (const kind of ["price_unavailable", "unavailable", "refused",
    "cursor_rejected"]) {
    assert.deepEqual(amuxV19MaxQueueStatus({ kind }), {
      line: `AMUX_V19_MAX_SESSION_QUEUE_${kind}\n`, exitCode: 1 });
  }
  assert.deepEqual(amuxV19MaxQueueStatus({ kind: "sensitive-id" }), {
    line: "AMUX_V19_MAX_SESSION_QUEUE_unavailable\n", exitCode: 1 });
});

test("Max queue entrypoint refuses non-Linux execution without stdout", {
  skip: process.platform === "linux",
}, () => {
  const entry = fileURLToPath(new URL(
    "../scripts/amux-v19-max-session-queue-once.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [entry], { encoding: "utf8" });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /^AMUX_V19_MAX_SESSION_QUEUE_REFUSED\n/);
});
