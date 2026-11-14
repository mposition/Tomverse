import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("the merge lane's list visits every Decision Maker approval in turn, so unmergeable ones never hide the rest", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/amuxDmT2MergeLaneRotationHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
