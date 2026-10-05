import assert from "node:assert/strict";
import { chmod, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { localRetentionHaltFile } from
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
