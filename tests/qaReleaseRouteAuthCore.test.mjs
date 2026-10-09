import assert from "node:assert/strict";
import test from "node:test";

import { admitQaReleaseRouteCall, isQaReleaseRouteSecret } from "../lib/qaReleaseRouteAuthCore.ts";

const env = {
  QA_RELEASE_DIGEST_SECRET: "d".repeat(32),
  QA_RELEASE_MONITOR_SECRET: "m".repeat(40),
  QA_RELEASE_MERGE_LANE_SECRET: "l".repeat(48),
};

const call = (overrides = {}) =>
  admitQaReleaseRouteCall({
    role: "digest",
    authorization: `Bearer ${"d".repeat(32)}`,
    revisionHeader: "7",
    latestRevision: 7,
    env,
    ...overrides,
  });

test("the role's own secret and the latest revision admit the call", () => {
  assert.deepEqual(call(), { ok: true, revision: 7 });
  assert.deepEqual(
    call({ role: "mergeLane", authorization: `Bearer ${"l".repeat(48)}` }),
    { ok: true, revision: 7 },
  );
});

test("another role's secret, a wrong one, or a missing scheme is unauthorized", () => {
  for (const authorization of [
    `Bearer ${"m".repeat(40)}`,
    `Bearer ${"d".repeat(31)}`,
    "d".repeat(32),
    "Bearer ",
    `bearer ${"d".repeat(32)}`,
    null,
  ]) {
    assert.deepEqual(call({ authorization }), { ok: false, reason: "unauthorized" }, String(authorization));
  }
});

test("a short or shared secret authenticates nothing", () => {
  assert.equal(isQaReleaseRouteSecret("digest", "short", { QA_RELEASE_DIGEST_SECRET: "short" }), false);
  assert.equal(isQaReleaseRouteSecret("digest", "x".repeat(32), {}), false);
  const shared = { ...env, QA_RELEASE_MONITOR_SECRET: env.QA_RELEASE_DIGEST_SECRET };
  assert.equal(isQaReleaseRouteSecret("digest", env.QA_RELEASE_DIGEST_SECRET, shared), false);
  assert.equal(isQaReleaseRouteSecret("monitor", env.QA_RELEASE_DIGEST_SECRET, shared), false);
  // The merge lane's own distinct secret still works.
  assert.equal(isQaReleaseRouteSecret("mergeLane", env.QA_RELEASE_MERGE_LANE_SECRET, shared), true);
});

test("authentication is decided before the revision, so an outsider learns nothing about it", () => {
  assert.deepEqual(call({ authorization: null, latestRevision: null }), { ok: false, reason: "unauthorized" });
  assert.deepEqual(call({ authorization: null, revisionHeader: "6" }), { ok: false, reason: "unauthorized" });
});

test("no recorded revision is unavailable; a stale, missing or malformed number is a mismatch", () => {
  for (const latestRevision of [null, 0, -1, 1.5]) {
    assert.deepEqual(call({ latestRevision }), { ok: false, reason: "control_revision_unavailable" });
  }
  for (const revisionHeader of [null, "", "6", "8", "07", "7 ", "+7", "7.0", "1234567890"]) {
    assert.deepEqual(
      call({ revisionHeader }),
      { ok: false, reason: "control_revision_mismatch" },
      JSON.stringify(revisionHeader),
    );
  }
});
