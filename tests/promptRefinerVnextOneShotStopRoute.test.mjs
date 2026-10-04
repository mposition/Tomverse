import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL(
  "./promptRefinerVnextOneShotStopRoute.fixture.mjs", import.meta.url));

test("runner stop route synthetic contract", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--conditions=react-server", "--experimental-test-module-mocks",
    "--import", "tsx", "--test", fixture,
  ], { encoding: "utf8", env });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# pass 4\b/);
});
