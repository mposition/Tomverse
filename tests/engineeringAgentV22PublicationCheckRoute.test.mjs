import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("v22 publication check is authenticated, read-only and content-free", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/engineeringAgentV22PublicationCheckHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
