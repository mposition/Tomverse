import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const child = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--conditions=react-server",
    "--import",
    "tsx",
    resolve("tests/support/marketingFactResolutionHarness.mjs"),
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  },
);

assert.equal(
  child.status,
  0,
  `resolver harness failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
);
const line = child.stdout
  .split(/\r?\n/u)
  .find((candidate) => candidate.startsWith("MARKETING_FACT_RESULTS="));
assert.ok(line, `resolver harness returned no result\n${child.stdout}`);
const results = JSON.parse(line.slice("MARKETING_FACT_RESULTS=".length));

for (const result of results) {
  test(`the production ${result.name} resolver survives and refuses in both directions`, () => {
    assert.notEqual(result.goodVerdict, "reject", JSON.stringify(result));
    assert.equal(
      (result.goodCodes ?? []).includes(result.refusal),
      false,
      JSON.stringify(result),
    );
    assert.equal(result.badVerdict, "reject", JSON.stringify(result));
    assert.equal(
      (result.badCodes ?? []).includes(result.refusal),
      true,
      JSON.stringify(result),
    );
  });
}
