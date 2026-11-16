import assert from "node:assert/strict";
import { chmod, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { localAmuxHaltFile } from "../lib/amux/ideaLocalRetentionHaltFile.mjs";

// The paid API analysis path's (v4) blocking marker is unchanged (operator,
// 2026-11-16); retention no longer keeps a marker.
test("Linux analysis halt remains set across a new process instance",
  { skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "amux-v4-analysis-"));
    await chmod(directory, 0o700);
    try {
      const first = localAmuxHaltFile(directory, "analysis");
      assert.equal(await first.claim(), true);
      assert.equal(await localAmuxHaltFile(directory, "analysis").claim(), false);
      await first.release();
    } finally { await rmdir(directory); }
  });

test("Linux analysis halt still refuses while the legacy marker exists",
  { skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "amux-v4-shared-"));
    await chmod(directory, 0o700);
    try {
      await writeFile(join(directory, "outcome-unknown.halt"),
        "retention_outcome_unverified\n", { mode: 0o600 });
      assert.equal(await localAmuxHaltFile(directory, "analysis").claim(), false);
      await unlink(join(directory, "outcome-unknown.halt"));
    } finally { await rmdir(directory); }
  });

test("the marker module serves only the analysis capability", () => {
  assert.throws(() => localAmuxHaltFile("/state", "retention"),
    /local_state_unavailable/);
});
