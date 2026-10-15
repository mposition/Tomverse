import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("an observed approval and merge completes only the v22 implement card it names", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/amuxReviewMergeObservedHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
