import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// The media CLI asks which assets a person approved (owner decision
// 2026-11-04), with the store stood in for: the answer is ids and metadata
// only, behind the media secret and the kill switch.

const child = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--conditions=react-server",
    "--import",
    "tsx",
    resolve("tests/support/marketingAssetApprovedRouteHarness.mjs"),
  ],
  { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
);
assert.equal(child.status, 0, `harness failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
const line = child.stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith("MARKETING_ASSET_APPROVED_RESULTS="));
assert.ok(line, child.stdout);
const results = Object.fromEntries(
  JSON.parse(line.slice("MARKETING_ASSET_APPROVED_RESULTS=".length)).map((result) => [result.scenario, result]),
);

test("the approved assets are listed as ids and metadata, never a file, key or words", () => {
  const listed = results.listed;
  assert.equal(listed.status, 200);
  assert.equal(listed.cache, "no-store");
  assert.deepEqual(listed.body, {
    result: {
      assets: [
        {
          id: "media-20261103-review-compare-ko-card",
          kind: "image",
          allowedChannels: ["facebook", "instagram"],
          altLocales: ["ko"],
          validUntil: "2027-02-01",
        },
      ],
    },
  });
});

test("without the media secret nothing is read", () => {
  for (const scenario of ["wrong secret", "no secret"]) {
    assert.equal(results[scenario].status, 401, scenario);
    assert.equal(results[scenario].reads, 0, scenario);
  }
});

test("the kill switch answers 503 before anything is read", () => {
  assert.equal(results["kill switch"].status, 503);
  assert.deepEqual(results["kill switch"].body, { code: "kill_switch" });
  assert.equal(results["kill switch"].reads, 0);
});

test("a store failure is a 503 with a closed code, not the error", () => {
  assert.equal(results["store fails"].status, 503);
  assert.deepEqual(results["store fails"].body, { code: "unavailable" });
});
