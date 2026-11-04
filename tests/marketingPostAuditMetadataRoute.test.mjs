import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// The audit entry a route writes is the evidence the store checks: every key
// the store requires must be in the entry with the same value
// (verifyMarketingAuditEvidence, `metadata_mismatch`). The schedule route
// wrote only the digest and the unpublish route left out the external post
// id, so neither write could ever succeed in production.

const child = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--conditions=react-server",
    "--import",
    "tsx",
    resolve("tests/support/marketingPostAuditMetadataRouteHarness.mjs"),
  ],
  { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
);
assert.equal(child.status, 0, `harness failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
const line = child.stdout
  .split(/\r?\n/u)
  .find((candidate) => candidate.startsWith("MARKETING_POST_AUDIT_METADATA="));
assert.ok(line, child.stdout);
const routes = JSON.parse(line.slice("MARKETING_POST_AUDIT_METADATA=".length));

const covers = (written, required) => {
  for (const [key, value] of Object.entries(required)) {
    assert.deepEqual(written[key], value, `audit metadata ${key}`);
  }
};

test("a schedule's audit entry carries everything the store requires of it", () => {
  assert.equal(routes.schedule.action, "marketing_post.schedule");
  assert.deepEqual(routes.schedule.required, { digest: "a".repeat(64), historyVersion: 3 });
  covers(routes.schedule.written, routes.schedule.required);
});

test("an unpublish's audit entry carries everything the store requires of it", () => {
  assert.equal(routes.unpublish.action, "marketing_post.unpublish");
  assert.deepEqual(routes.unpublish.required, {
    externalPostId: "ext-1",
    evidenceRef: "checked the profile",
    historyVersion: 5,
  });
  covers(routes.unpublish.written, routes.unpublish.required);
  assert.equal(routes.unpublish.written.expectedStatus, "published");
});

test("a withdrawal's audit entry carries everything the store requires of it", () => {
  assert.equal(routes.withdraw.action, "marketing_post.withdraw_approval");
  assert.deepEqual(routes.withdraw.required, { digest: "a".repeat(64), historyVersion: 2 });
  covers(routes.withdraw.written, routes.withdraw.required);
});
