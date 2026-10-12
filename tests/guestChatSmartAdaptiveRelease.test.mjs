import assert from "node:assert/strict";
import { test } from "node:test";

import {
  guestChatSmartAdaptiveActivationMetadata,
  guestChatSmartAdaptiveAuthorityTtlSeconds,
  guestChatSmartAdaptiveRuntimeBinding,
} from "../lib/guestChatSmartAdaptiveRelease.ts";

const runtime = {
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111",
  CHAT_GUEST_SMART_ADAPTIVE_ROLLOUT_ENABLED: "1",
  CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_SECRET: "s".repeat(32),
  TOMVERSE_AUTO_ROUTER_UI_ENABLED: "true",
  AUTO_ROUTER_KILL_SWITCH: "off",
  AUTO_ROUTER_ROLLOUT_PERCENT: "100",
  AUTO_ROUTER_COHORT_SALT: "test-salt",
  AUTO_ROUTER_ELIGIBLE_PLANS: "Free,Max,Pro",
  ROUTING_DISPATCH_INSTRUMENTATION: "enforce",
  MANIFEST_HASH_KEYS: "2026-11:" + "k".repeat(32),
  MANIFEST_HASH_ACTIVE_KEY_ID: "2026-11",
};

test("Guest Smart Adaptive binding is exact-deployment and default-off", () => {
  assert.throws(() => guestChatSmartAdaptiveRuntimeBinding({ ...runtime,
    CHAT_GUEST_SMART_ADAPTIVE_ROLLOUT_ENABLED: "0" }),
  /rollout_disabled/);
  const binding = guestChatSmartAdaptiveRuntimeBinding(runtime);
  assert.equal(binding.runtimeCommitSha, "a".repeat(40));
  assert.equal(binding.runtimeDeploymentId,
    "11111111-1111-4111-8111-111111111111");
  assert.match(binding.configDigest, /^[0-9a-f]{64}$/);
});

test("Guest Smart Adaptive authority TTL is bounded and defaults to 60 seconds", () => {
  assert.equal(guestChatSmartAdaptiveAuthorityTtlSeconds({}), 60);
  assert.equal(guestChatSmartAdaptiveAuthorityTtlSeconds({
    CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_TTL_SECONDS: "15" }), 15);
  assert.throws(() => guestChatSmartAdaptiveAuthorityTtlSeconds({
    CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_TTL_SECONDS: "301" }), /ttl_invalid/);
});

test("activation metadata binds Guest scope to the existing exact release pair", () => {
  const binding = guestChatSmartAdaptiveRuntimeBinding(runtime);
  const metadata = guestChatSmartAdaptiveActivationMetadata({ binding,
    baseRouterActivationAuditLogId: "router-audit",
    baseProductActivationAuditLogId: "product-audit" });
  assert.equal(metadata.subjectKind, "guest");
  assert.equal(metadata.product, "chat");
  assert.equal(metadata.existingGuestQuotaOnly, true);
  assert.equal(metadata.logicalAnswersPerTurn, 1);
  assert.equal(metadata.promptRetention, "request_memory_only");
});
