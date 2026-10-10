import assert from "node:assert/strict";
import test from "node:test";
import { resolveAutoRouterLimitedRelease } from "../lib/autoRouterLimitedRelease.ts";
import { AUTO_ROUTER_LIMITED_RELEASE_APPROVAL } from "../lib/autoRouterLimitedReleaseApproval.ts";
import { autoCohortConfig } from "../lib/autoCohort.ts";
import { autoRolloutReadiness } from "../lib/autoRolloutReadiness.ts";
import { autoUiAvailability, autoSelectionCapability, mayStoreSelectionMode } from "../lib/autoRoutingUi.ts";
import { selectAutoModel } from "../lib/autoModelSelection.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

// Synthetic authorization fixtures only. No real attestation, evaluation
// corpus, database, network request, or provider dispatch is created here.
const now = () => Date.parse("2026-10-11T01:00:00.000Z");
const env = {
  AUTO_ROUTER_LIMITED_RELEASE_EXCEPTION: "v1",
  AUTO_ROUTER_LIMITED_RELEASE_COMMIT: "a".repeat(40),
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_ENVIRONMENT_ID: "11111111-1111-4111-8111-111111111111",
  RAILWAY_SERVICE_ID: "22222222-2222-4222-8222-222222222222",
  ROUTING_DISPATCH_INSTRUMENTATION: "enforce",
  MANIFEST_HASH_KEYS: `fixture:${"s".repeat(32)}`,
  MANIFEST_HASH_ACTIVE_KEY_ID: "fixture",
  AUTO_ROUTER_FALLBACK_ENABLED: "off",
  AUTO_ROUTER_ROLLOUT_PERCENT: "100",
  AUTO_ROUTER_ELIGIBLE_PLANS: "Pro",
  AUTO_ROUTER_COHORT_SALT: "synthetic-limited-release",
};
const approval = {
  ...AUTO_ROUTER_LIMITED_RELEASE_APPROVAL,
  status: "approved", approvedBy: "operator-fixture",
  approvedAt: "2026-10-11T00:00:00.000Z",
  policyCommit: "b".repeat(40), policySha256: "c".repeat(64),
  evaluatedImplementationCommit: "d".repeat(40),
  targetEnvironmentName: env.RAILWAY_ENVIRONMENT_NAME,
  targetEnvironmentId: env.RAILWAY_ENVIRONMENT_ID,
  targetServiceId: env.RAILWAY_SERVICE_ID,
  maxRolloutPercent: 100, eligiblePlans: ["Pro"],
  expiresAt: "2026-10-12T00:00:00.000Z",
  evidenceRef: "synthetic-fixture-only", knownLimitations: "No live evidence.",
  activationAuthority: "operator_runtime_selector",
  paidDispatchAuthority: "existing_chat_request_only",
};
const cohortConfig = {
  ...autoCohortConfig(env, now),
  limitedRelease: resolveAutoRouterLimitedRelease({ environment: env, approval, now }),
};
const common = {
  subjectKey: "synthetic-user", isGuest: false, plan: "Pro",
  productKey: "chat", readiness: autoRolloutReadiness(), cohortConfig,
};
const availability = (overrides = {}) => autoUiAvailability({
  ...common, flagEnabled: true, hasConversation: true, ...overrides,
});
const selection = (overrides = {}) => selectAutoModel({
  ...common,
  conversationId: "synthetic-conversation",
  conversation: { selectionMode: "auto", routerModelId: null, routerChallengerTurns: 0 },
  requestedModelId: "gpt-5-6-luna",
  models: AVAILABLE_MODELS,
  text: "Translate this ordinary sentence into Korean.",
  attachments: [], attachmentsUnmeasurable: false, webSearchRequested: false,
  reservedInputTokens: 1_200, requestOutputCapTokens: 4_000,
  ...overrides,
});

test("the same admitted exception offers Auto and routes without passing the register", () => {
  const ui = availability();
  const turn = selection();
  assert.equal(ui.offered, true);
  assert.equal(turn.routed, true);
  assert.deepEqual(turn.cohort.limitedReleaseException, ui.cohort.limitedReleaseException);
  assert.deepEqual(autoSelectionCapability(ui), { offered: true });
  assert.equal(common.readiness.ready, false);
  assert.equal(common.readiness.outstanding.length, 3);
  assert.equal(turn.cohort.drillOverride, undefined);
});

test("Review, guests and the kill switch cannot use the limited exception", () => {
  for (const overrides of [
    { productKey: "review" },
    { isGuest: true },
    { cohortConfig: { ...cohortConfig, killSwitch: true } },
  ]) {
    assert.equal(availability(overrides).offered, false);
    assert.equal(selection(overrides).routed, false);
  }
});

test("manual selection and a missing candidate preserve the requested model", () => {
  const manual = selection({ conversation: { selectionMode: "manual" } });
  assert.equal(manual.routed, false);
  assert.equal(manual.fallbackModelId, "gpt-5-6-luna");
  const empty = selection({ models: [] });
  assert.equal(empty.routed, false);
  assert.equal(empty.reason, "no_candidate");
  assert.equal(empty.fallbackModelId, "gpt-5-6-luna");
  assert.equal(mayStoreSelectionMode("manual", availability({ flagEnabled: false })), true);
});
