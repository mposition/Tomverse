import assert from "node:assert/strict";
import { chmod, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { localAmuxHaltFile, localRetentionHaltFile } from
  "../lib/amux/ideaLocalRetentionHaltFile.mjs";

test("Linux retention halt survives a new process instance until verified clearance",
  { skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "amux-v4-retention-"));
    await chmod(directory, 0o700);
    try {
      const first = localRetentionHaltFile(directory);
      assert.equal(await first.claim(), true);
      assert.equal(await localRetentionHaltFile(directory).claim(), false);
      await first.release();
      assert.equal(await localRetentionHaltFile(directory).claim(), true);
      await first.release();
    } finally { await rmdir(directory); }
  });

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

test("Linux analysis cannot release retention halt in a shared state directory",
  { skip: process.platform !== "linux" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "amux-v4-shared-"));
    await chmod(directory, 0o700);
    try {
      const analysis = localAmuxHaltFile(directory, "analysis");
      const retention = localRetentionHaltFile(directory);
      assert.equal(await analysis.claim(), true);
      assert.equal(await retention.claim(), true);
      await analysis.release();
      assert.equal(await retention.claim(), false);
      await retention.release();
      await writeFile(join(directory, "outcome-unknown.halt"),
        "retention_outcome_unverified\n", { mode: 0o600 });
      assert.equal(await analysis.claim(), false);
      assert.equal(await retention.claim(), false);
      await unlink(join(directory, "outcome-unknown.halt"));
    } finally { await rmdir(directory); }
  });
