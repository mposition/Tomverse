import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_ROUTER_LIMITED_RELEASE_COMMIT_ENV,
  AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_ENV,
  AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_VALUE,
  autoRouterLimitedReleaseApprovalProblems,
  resolveAutoRouterLimitedRelease,
} from "../lib/autoRouterLimitedRelease.ts";
import { AUTO_ROUTER_LIMITED_RELEASE_APPROVAL } from
  "../lib/autoRouterLimitedReleaseApproval.ts";

const COMMIT = "a".repeat(40);
const POLICY_COMMIT = "b".repeat(40);
const IMPLEMENTATION_COMMIT = "c".repeat(40);
const ENVIRONMENT_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-11T00:00:00.000Z");

const approval = (overrides = {}) => ({
  ...AUTO_ROUTER_LIMITED_RELEASE_APPROVAL,
  status: "approved",
  approvedBy: "mposition",
  approvedAt: "2026-10-10T23:00:00.000Z",
  policyCommit: POLICY_COMMIT,
  policySha256: "d".repeat(64),
  evaluatedImplementationCommit: IMPLEMENTATION_COMMIT,
  targetEnvironmentName: "production",
  targetEnvironmentId: ENVIRONMENT_ID,
  targetServiceId: SERVICE_ID,
  maxRolloutPercent: 100,
  eligiblePlans: ["Pro", "Max"],
  expiresAt: "2026-11-11T00:00:00.000Z",
  evidenceRef: "docs/ops/tomverse-chat-auto-router-limited-release-v1-approval.md",
  knownLimitations:
    "The three ordinary readiness gates remain pending and offline quality is not established.",
  activationAuthority: "operator_runtime_selector",
  paidDispatchAuthority: "existing_chat_request_only",
  ...overrides,
});

const environment = (overrides = {}) => ({
  [AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_ENV]:
    AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_VALUE,
  [AUTO_ROUTER_LIMITED_RELEASE_COMMIT_ENV]: COMMIT,
  RAILWAY_GIT_COMMIT_SHA: COMMIT,
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
  RAILWAY_SERVICE_ID: SERVICE_ID,
  ROUTING_DISPATCH_INSTRUMENTATION: "enforce",
  MANIFEST_HASH_KEYS: `release:${"s".repeat(32)}`,
  MANIFEST_HASH_ACTIVE_KEY_ID: "release",
  AUTO_ROUTER_FALLBACK_ENABLED: "off",
  AUTO_ROUTER_ROLLOUT_PERCENT: "100",
  AUTO_ROUTER_ELIGIBLE_PLANS: "Pro,Max",
  AUTO_ROUTER_COHORT_SALT: "limited-release-v1",
  ...overrides,
});

const resolve = (overrides = {}) => resolveAutoRouterLimitedRelease({
  environment: environment(),
  approval: approval(),
  now: () => NOW,
  ...overrides,
});

test("the checked-in pending record grants no authority", () => {
  const decision = resolveAutoRouterLimitedRelease({
    environment: environment(),
    now: () => NOW,
  });
  assert.deepEqual(decision, { admitted: false, reason: "approval_pending" });
  assert.ok(autoRouterLimitedReleaseApprovalProblems().length > 0);
});

test("the selector is independently default-off", () => {
  const decision = resolve({ environment: environment({
    [AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_ENV]: undefined,
  }) });
  assert.deepEqual(decision, { admitted: false, reason: "selector_off" });
});

test("an exact bounded approval admits without exposing the manifest key", () => {
  const decision = resolve();
  assert.equal(decision.admitted, true);
  assert.equal(decision.servingCommitSha, COMMIT);
  assert.deepEqual(decision.eligiblePlans, ["Pro", "Max"]);
  assert.equal(JSON.stringify(decision).includes("s".repeat(32)), false);
});

test("100 percent is permitted only when the human record permits it", () => {
  assert.equal(resolve().admitted, true);
  assert.deepEqual(
    resolve({ approval: approval({ maxRolloutPercent: 99 }) }),
    { admitted: false, reason: "rollout_percent_exceeds_approval" },
  );
});

test("the runtime target and serving commit must match exactly", () => {
  assert.equal(resolve({ environment: environment({
    RAILWAY_ENVIRONMENT_ID: "33333333-3333-4333-8333-333333333333",
  }) }).reason, "target_environment_mismatch");
  assert.equal(resolve({ environment: environment({
    RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333",
  }) }).reason, "target_service_mismatch");
  assert.equal(resolve({ environment: environment({
    [AUTO_ROUTER_LIMITED_RELEASE_COMMIT_ENV]: "e".repeat(40),
  }) }).reason, "serving_commit_mismatch");
});

test("manifest enforcement and a valid keyring are non-waivable", () => {
  assert.equal(resolve({ environment: environment({
    ROUTING_DISPATCH_INSTRUMENTATION: "observe",
  }) }).reason, "instrumentation_not_enforce");
  assert.equal(resolve({ environment: environment({
    MANIFEST_HASH_ACTIVE_KEY_ID: "missing",
  }) }).reason, "manifest_keyring_unavailable");
});

test("automatic fallback stays off so the exception adds no provider attempt", () => {
  assert.equal(resolve({ environment: environment({
    AUTO_ROUTER_FALLBACK_ENABLED: "on",
  }) }).reason, "fallback_enabled");
});

test("the approved plans are exact and the rollout must remain enabled", () => {
  assert.equal(resolve({ environment: environment({
    AUTO_ROUTER_ELIGIBLE_PLANS: "Pro",
  }) }).reason, "eligible_plans_mismatch");
  assert.equal(resolve({ environment: environment({
    AUTO_ROUTER_ROLLOUT_PERCENT: "0",
  }) }).reason, "rollout_disabled");
  assert.equal(resolve({ environment: environment({
    AUTO_ROUTER_COHORT_SALT: "",
  }) }).reason, "rollout_disabled");
});

test("an expired or malformed human record fails closed", () => {
  assert.equal(resolve({ approval: approval({
    expiresAt: "2026-10-10T00:00:00.000Z",
  }) }).reason, "approval_expired");
  assert.equal(resolve({ approval: approval({
    knownLimitations: null,
  }) }).reason, "approval_invalid");
  assert.equal(resolve({ approval: approval({
    exceptionId: "CHAT-01-WRONG-EXCEPTION",
  }) }).reason, "approval_invalid");
  assert.equal(resolve({ approval: approval({
    workId: "OTHER-WORK",
  }) }).reason, "approval_invalid");
});
