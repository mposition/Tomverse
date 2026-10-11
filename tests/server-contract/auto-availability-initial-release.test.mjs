import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import { mintChatRefinerInitialAutoRouterAuthority } from
  "../../lib/chatRefinerInitialAutoRouterAuthority.ts";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "..", "..", path)).href;
const originalEnv = { ...process.env };
let plan = "Pro";
let authorityReads = 0;
let billingReads = 0;
let authorityFailure = false;
let readiness = {
  ready: false,
  outstanding: ["shadow_report", "offline_quality_evaluation", "attempt_manifest_boundary"],
  problems: [],
};

const authority = mintChatRefinerInitialAutoRouterAuthority({
  routerActivationAuditLogId: "audit_router_initial_release",
  runtimeCommitSha: "a".repeat(40),
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
});

mock.module(mod("lib/billingEntitlements.ts"), { namedExports: {
  getUserBillingPlan: async () => {
    billingReads += 1;
    return { tier: plan };
  },
} });
mock.module(mod("lib/chatRefinerInitialAutoReleaseStore.ts"), { namedExports: {
  readChatRefinerInitialAutoRouterAuthority: async () => {
    authorityReads += 1;
    if (authorityFailure) throw new Error("database outcome unknown");
    return authority;
  },
} });
mock.module(mod("lib/autoRolloutReadiness.ts"), { namedExports: {
  autoRolloutReadiness: () => readiness,
} });

const { autoAvailabilityFor } = await import(mod("lib/autoAvailability.ts"));

test.beforeEach(() => {
  process.env.TOMVERSE_AUTO_ROUTER_UI_ENABLED = "true";
  process.env.AUTO_ROUTER_KILL_SWITCH = "off";
  process.env.AUTO_ROUTER_ROLLOUT_PERCENT = "100";
  process.env.AUTO_ROUTER_ELIGIBLE_PLANS = "Pro,Max";
  process.env.AUTO_ROUTER_COHORT_SALT = "initial-release-test";
  plan = "Pro";
  authorityReads = 0;
  billingReads = 0;
  authorityFailure = false;
  readiness = {
    ready: false,
    outstanding: ["shadow_report", "offline_quality_evaluation", "attempt_manifest_boundary"],
    problems: [],
  };
});

test.after(() => {
  for (const key of [
    "TOMVERSE_AUTO_ROUTER_UI_ENABLED",
    "AUTO_ROUTER_KILL_SWITCH",
    "AUTO_ROUTER_ROLLOUT_PERCENT",
    "AUTO_ROUTER_ELIGIBLE_PLANS",
    "AUTO_ROUTER_COHORT_SALT",
  ]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("pending readiness consults the exact authority once and offers Auto", async () => {
  const result = await autoAvailabilityFor("user_initial_release", {
    productKey: "chat",
  });
  assert.equal(result.offered, true);
  assert.equal(result.cohort.initialReleaseAuthority,
    "chat_refiner_initial_auto_release");
  assert.equal(authorityReads, 1);
  assert.equal(billingReads, 1);
});

test("flag, product, kill, rollout and plan refusals do not read release evidence", async () => {
  process.env.TOMVERSE_AUTO_ROUTER_UI_ENABLED = "false";
  assert.equal((await autoAvailabilityFor("user_initial_release")).offered, false);
  assert.equal(authorityReads, 0);
  assert.equal(billingReads, 0);

  process.env.TOMVERSE_AUTO_ROUTER_UI_ENABLED = "true";
  assert.equal((await autoAvailabilityFor("user_initial_release", {
    productKey: "review",
  })).offered, false);
  assert.equal(authorityReads, 0);

  process.env.AUTO_ROUTER_KILL_SWITCH = "on";
  assert.equal((await autoAvailabilityFor("user_initial_release")).offered, false);
  assert.equal(authorityReads, 0);

  process.env.AUTO_ROUTER_KILL_SWITCH = "off";
  process.env.AUTO_ROUTER_ROLLOUT_PERCENT = "0";
  assert.equal((await autoAvailabilityFor("user_initial_release")).offered, false);
  assert.equal(authorityReads, 0);

  process.env.AUTO_ROUTER_ROLLOUT_PERCENT = "100";
  plan = "Free";
  assert.equal((await autoAvailabilityFor("user_initial_release")).offered, false);
  assert.equal(authorityReads, 0);
});

test("database uncertainty closes the exception without throwing or retrying", async () => {
  authorityFailure = true;
  const result = await autoAvailabilityFor("user_initial_release");
  assert.equal(result.offered, false);
  assert.equal(authorityReads, 1);
  assert.equal(result.cohort.reason, "readiness_incomplete");
});

test("an actually ready rollout does not read initial-release evidence", async () => {
  readiness = { ready: true, outstanding: [], problems: [] };
  const result = await autoAvailabilityFor("user_initial_release");
  assert.equal(result.offered, true);
  assert.equal(authorityReads, 0);
  assert.equal(result.cohort.initialReleaseAuthority, undefined);
});
