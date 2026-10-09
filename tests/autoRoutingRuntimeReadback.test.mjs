import assert from "node:assert/strict";
import test from "node:test";

import { autoRoutingRuntimeReadback } from "../lib/autoRoutingRuntimeReadback.ts";

const build = {
  environment: "production",
  commitSha: "a".repeat(40),
  shortCommitSha: "aaaaaaa",
  builtAt: "2026-10-09T00:00:00.000Z",
  deploymentId: "test-deployment",
  deploymentStartedAt: "2026-10-09T00:00:00.000Z",
  deployedAt: "2026-10-09T00:01:00.000Z",
  deploymentStatus: "success",
};
const now = () => Date.parse("2026-10-09T01:00:00.000Z");

test("runtime readback uses effective modes and retains pending readiness", () => {
  const snapshot = autoRoutingRuntimeReadback(build, {
    TOMVERSE_ROUTER_SHADOW_ENABLED: "true",
    ROUTING_DISPATCH_INSTRUMENTATION: "enforce",
    MANIFEST_HASH_KEYS: `test:${"s".repeat(32)}`,
    MANIFEST_HASH_ACTIVE_KEY_ID: "test",
    AUTO_ROUTER_ROLLOUT_PERCENT: "100",
  }, now);
  assert.equal(snapshot.observedAt, "2026-10-09T01:00:00.000Z");
  assert.deepEqual(snapshot.build, build);
  assert.equal(snapshot.shadowEnabled, true);
  assert.equal(snapshot.dispatchInstrumentationMode, "enforce");
  assert.equal(snapshot.manifestKeyringConfigured, true);
  assert.equal(snapshot.readiness.ready, false);
  assert.deepEqual(snapshot.readiness.outstanding, [
    "shadow_report", "offline_quality_evaluation", "attempt_manifest_boundary",
  ]);
});

test("missing or invalid settings stay off and do not expose keyring input", () => {
  const missing = autoRoutingRuntimeReadback(build, {}, now);
  assert.equal(missing.shadowEnabled, false);
  assert.equal(missing.dispatchInstrumentationMode, "off");
  assert.equal(missing.manifestKeyringConfigured, false);
  const secret = "private-secret-do-not-return";
  const snapshot = autoRoutingRuntimeReadback(build, {
    TOMVERSE_ROUTER_SHADOW_ENABLED: "on",
    ROUTING_DISPATCH_INSTRUMENTATION: "true",
    MANIFEST_HASH_KEYS: `${secret}:${secret}`,
    MANIFEST_HASH_ACTIVE_KEY_ID: secret,
    DATABASE_URL: secret,
    NEXTAUTH_SECRET: secret,
    AUTO_ROUTER_COHORT_SALT: secret,
  }, now);
  assert.equal(snapshot.shadowEnabled, false);
  assert.equal(snapshot.dispatchInstrumentationMode, "off");
  assert.equal(snapshot.manifestKeyringConfigured, false);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "build", "dispatchInstrumentationMode", "manifestKeyringConfigured",
    "observedAt", "readiness", "shadowEnabled",
  ]);
});
