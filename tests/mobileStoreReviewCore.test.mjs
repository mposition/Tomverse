import assert from "node:assert/strict";
import test from "node:test";
import { readMobileStoreReviewCredential, hashMobileStoreReviewCode, matchesMobileStoreReviewCode, mobileStoreReviewSessionAllowed } from "../lib/mobileStoreReviewCore.ts";
import { effectivePlanForAccess } from "../lib/foundingTesterPassCore.ts";

const now = Date.now();
const credential = { submissionId: "play-closed-20261027", userId: "synthetic-review-user", email: "play-review-synthetic@tomverse.app", appId: "app.tomverse.shell", buildNumber: 16, state: "prepared", validUntil: new Date(now + 14 * 86400000).toISOString(), salt: "a".repeat(64), codeHash: "0".repeat(64) };
credential.codeHash = hashMobileStoreReviewCode(credential, "654321");
const env = value => ({ MOBILE_STORE_REVIEW_ENABLED: "true", MOBILE_STORE_REVIEW_CREDENTIAL_JSON: JSON.stringify(value) });
const input = { email: credential.email, code: "654321", platform: "android", appId: credential.appId, buildNumber: 16 };

test("store credential is disabled by default and invalid/expired configuration fails closed", () => {
  assert.equal(readMobileStoreReviewCredential({}, now), null);
  for (const value of [null, {}, { ...credential, codeHash: "plain-secret" }, { ...credential, validUntil: new Date(now).toISOString() }, { ...credential, validUntil: new Date(now + 32 * 86400000).toISOString() }]) assert.equal(readMobileStoreReviewCredential(env(value), now), null);
  assert.ok(readMobileStoreReviewCredential(env(credential), now));
});

test("only the intended account, app and build accept the salted code", () => {
  assert.equal(matchesMobileStoreReviewCode(credential, input), true);
  for (const changed of [{ email: "other@example.invalid" }, { code: "123456" }, { platform: "ios" }, { appId: "other.app" }, { buildNumber: 15 }, { buildNumber: undefined }, { appId: undefined }]) assert.equal(matchesMobileStoreReviewCode(credential, { ...input, ...changed }), false);
});

test("terminal submission states reject reuse and rotation rejects the previous code", () => {
  for (const state of ["accepted", "rejected", "withdrawn", "resubmitted"]) assert.equal(readMobileStoreReviewCredential(env({ ...credential, state }), now), null);
  const rotated = { ...credential, salt: "b".repeat(64) };
  rotated.codeHash = hashMobileStoreReviewCode(rotated, "112233");
  assert.equal(matchesMobileStoreReviewCode(rotated, input), false);
  assert.equal(matchesMobileStoreReviewCode(rotated, { ...input, code: "112233" }), true);
  assert.notEqual(hashMobileStoreReviewCode({ ...credential, submissionId: "another-submission" }, input.code), credential.codeHash);
});
test("an existing review session loses access at expiry or closure without relying on another login", () => {
  const config = { ...credential, plan: "Max" };
  const user = { id: config.userId, email: config.email, plan: "Max", subscriptionStatus: "mobile_store_review", periodEndMs: now + 1000 };
  assert.equal(mobileStoreReviewSessionAllowed(user, env(config), now), true);
  assert.equal(mobileStoreReviewSessionAllowed(user, env(config), now + 1001), false);
  assert.equal(mobileStoreReviewSessionAllowed(user, {}, now), false);
  assert.equal(mobileStoreReviewSessionAllowed(user, env({ ...config, state: "accepted" }), now), false);
  assert.equal(mobileStoreReviewSessionAllowed({ ...user, id: "other-review-user" }, env(config), now), false);
  assert.equal(mobileStoreReviewSessionAllowed({ id: "normal", email: "normal@example.invalid", plan: "Max" }, {}, now), true);
});
test("the existing entitlement resolver expires the dedicated review status", () => {
  const grant = { plan: "Max", webSubscriptionPlan: "Max", subscriptionStatus: "mobile_store_review", subscriptionCurrentPeriodEnd: new Date(now + 1000) };
  assert.equal(effectivePlanForAccess(grant, new Date(now)), "Max");
  assert.equal(effectivePlanForAccess(grant, new Date(now + 1000)), "Free");
});
