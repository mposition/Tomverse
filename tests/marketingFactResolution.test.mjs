import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
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

const snapshotLine = child.stdout
  .split(/\r?\n/u)
  .find((candidate) => candidate.startsWith("MARKETING_FACT_SNAPSHOT="));
assert.ok(snapshotLine, `resolver harness returned no snapshot\n${child.stdout}`);
const recorded = JSON.parse(snapshotLine.slice("MARKETING_FACT_SNAPSHOT=".length));

test("a new draft's facts are sealed against the rows that answered them (S3a2)", () => {
  assert.deepEqual(recorded.factSnapshot, {
    priceRows: [{ rowId: "pro", updatedAt: "2026-10-01T00:00:00.000Z" }],
    // No price claim here rests on the catalogue, so it is not recorded.
    catalogue: null,
    modelRegistryRows: [{ rowId: "model.fixture", updatedAt: "2026-09-30T00:00:00.000Z" }],
    evidenceDigests: [
      createHash("sha256").update("Three answers to one question, side by side.", "utf8").digest("hex"),
    ],
  });
  // The decision is bound to exactly that record.
  assert.equal(recorded.sealedDigest, recorded.recomputedDigest);
});
