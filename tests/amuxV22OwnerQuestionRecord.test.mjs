import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("a result ending with an owner question records one question row", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--import", "tsx",
    resolve("tests/support/amuxV22OwnerQuestionRecordHarness.mjs"),
  ], { cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  assert.match(child.stdout, /AMUX_V22_OWNER_QUESTION_RECORD_OK/);
});
