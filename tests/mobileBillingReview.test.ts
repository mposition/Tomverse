import assert from "node:assert/strict";
import test from "node:test";
import { iosReviewSandboxUserAllowed } from "../lib/mobileBillingReviewCore";
import { mobileStoreReviewSessionAllowed } from "../lib/mobileAuthKeyring";

const now = Date.now();
const credential = { submissionId: "ios-sandbox-review", userId: "ios-review", email: "appstore-review-test@tomverse.app", appId: "app.tomverse.shell", buildNumber: 11, plan: "Free", state: "prepared", validUntil: new Date(now + 86400000).toISOString(), salt: "a".repeat(64), codeHash: "b".repeat(64) };
const environment = { MOBILE_BILLING_ENVIRONMENT: "PRODUCTION", MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED: "true", MOBILE_STORE_REVIEW_IOS_ENABLED: "true", MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON: JSON.stringify(credential) };
const user = { id: credential.userId, email: credential.email, accountStatus: "active", plan: "Free", mobileBillingId: "opaque-review-billing" };

test("review sandbox is default-off and cannot change the shared production environment", () => {
  assert.equal(iosReviewSandboxUserAllowed(user, {}, now), false);
  assert.equal(iosReviewSandboxUserAllowed(user, { ...environment, MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED: "false" }, now), false);
  assert.equal(iosReviewSandboxUserAllowed(user, { ...environment, MOBILE_BILLING_ENVIRONMENT: "SANDBOX" }, now), false);
  assert.equal(iosReviewSandboxUserAllowed(user, environment, now), true);
  assert.equal(iosReviewSandboxUserAllowed(user, { ...environment, MOBILE_BILLING_ENVIRONMENT: undefined }, now), true);
  assert.equal(environment.MOBILE_BILLING_ENVIRONMENT, "PRODUCTION");
});

test("only the active dedicated non-admin account with a server billing identity qualifies", () => {
  for (const change of [{ id: "ordinary" }, { email: "ordinary@example.com" }, { accountStatus: "suspended" }, { accountStatus: "pending_deletion" }, { mobileBillingId: null }, { plan: "Guest" }]) {
    assert.equal(iosReviewSandboxUserAllowed({ ...user, ...change }, environment, now), false);
  }
  assert.equal(iosReviewSandboxUserAllowed(user, { ...environment, ADMIN_USER_IDS: user.id }, now), false);
  assert.equal(iosReviewSandboxUserAllowed(user, { ...environment, ADMIN_EMAILS: user.email }, now), false);
  for (const change of [{ state: "accepted" }, { state: "rejected" }, { state: "withdrawn" }, { validUntil: new Date(now).toISOString() }, { plan: "Max" }]) {
    assert.equal(iosReviewSandboxUserAllowed(user, { ...environment, MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON: JSON.stringify({ ...credential, ...change }) }, now), false);
  }
});

test("a verified review subscription may update its tier without making a terminal credential valid", () => {
  for (const plan of ["Free", "Pro", "Max"]) {
    assert.equal(mobileStoreReviewSessionAllowed({ ...user, plan }, environment, now), true);
    assert.equal(mobileStoreReviewSessionAllowed({ ...user, plan }, { ...environment, MOBILE_BILLING_ENVIRONMENT: undefined }, now), true);
    assert.equal(mobileStoreReviewSessionAllowed({ ...user, plan }, { ...environment, MOBILE_STORE_REVIEW_IOS_ENABLED: "false" }, now), false);
  }
  assert.equal(mobileStoreReviewSessionAllowed({ ...user, plan: "Pro" }, { ...environment, MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED: "false" }, now), false);
});
