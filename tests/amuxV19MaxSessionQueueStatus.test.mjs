import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { amuxV19MaxQueueStatus } from
  "../scripts/amux-v19-max-session-queue-status.mjs";

test("Max queue status formatter emits only a fixed token", () => {
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

test("Linux Max queue entrypoint emits only a fixed refusal without credentials", {
  skip: process.platform !== "linux",
}, () => {
  const entry = fileURLToPath(new URL(
    "../scripts/amux-v19-max-session-queue-once.mjs", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "amux-max-queue-entry-"));
  const env = { ...process.env, HOME: home, NODE_NO_WARNINGS: "1" };
  delete env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  delete env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
  try {
    const child = spawnSync(process.execPath, [entry], {
      encoding: "utf8", env, timeout: 5_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "AMUX_V19_MAX_SESSION_QUEUE_refused\n");
    assert.equal(child.stderr, "");
  } finally {
    for (const path of [
      join(home, ".local/state/tomverse-amux-v19-max-analysis"),
      join(home, ".local/state"), join(home, ".local"), home,
    ]) {
      try { rmdirSync(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
});
