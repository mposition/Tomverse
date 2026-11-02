import assert from "node:assert/strict";
import test from "node:test";
import { hashMobileStoreReviewCode, matchesMobileStoreReviewCode, mobileStoreReviewSessionAllowed, readMobileStoreReviewCredential, readMobileStoreReviewCredentials } from "../lib/mobileStoreReviewCore";

const now = Date.now();
const android = { submissionId: "android-submission", userId: "android-review", email: "play-review-test@tomverse.app", appId: "app.tomverse.shell" as const, buildNumber: 21, plan: "Free" as const, state: "prepared" as const, validUntil: new Date(now + 86400000).toISOString(), salt: "a".repeat(64), codeHash: "" };
android.codeHash = hashMobileStoreReviewCode(android, "654321");
const ios = { ...android, submissionId: "ios-submission", userId: "ios-review", email: "appstore-review-test@tomverse.app", buildNumber: 11, salt: "b".repeat(64), codeHash: "" };
ios.codeHash = hashMobileStoreReviewCode(ios, "123456");
const environment = { MOBILE_STORE_REVIEW_ENABLED: "true", MOBILE_STORE_REVIEW_CREDENTIAL_JSON: JSON.stringify(android), MOBILE_STORE_REVIEW_IOS_ENABLED: "true", MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON: JSON.stringify(ios) };

test("iOS review credentials require their independent switch and never replace Android", () => {
  assert.equal(readMobileStoreReviewCredential({ ...environment, MOBILE_STORE_REVIEW_IOS_ENABLED: "false" }, now, "ios"), null);
  assert.equal(readMobileStoreReviewCredential(environment, now)?.userId, android.userId);
  assert.equal(readMobileStoreReviewCredential(environment, now, "ios")?.userId, ios.userId);
  assert.equal(readMobileStoreReviewCredentials(environment, now).length, 2);
  assert.equal(readMobileStoreReviewCredential({ ...environment, MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON: JSON.stringify(android) }, now, "ios"), null);
  assert.equal(readMobileStoreReviewCredential({ ...environment, MOBILE_STORE_REVIEW_CREDENTIAL_JSON: JSON.stringify(ios) }, now), null);
});

test("iOS review proof binds platform, account, build, app, code and submission", () => {
  const input = { email: ios.email, code: "123456", platform: "ios", appId: ios.appId, buildNumber: ios.buildNumber };
  assert.equal(matchesMobileStoreReviewCode(ios, input), true);
  for (const changed of [{ platform: "android" }, { email: android.email }, { appId: "other.app" }, { buildNumber: 10 }, { code: "654321" }]) {
    assert.equal(matchesMobileStoreReviewCode(ios, { ...input, ...changed }), false);
  }
  assert.equal(matchesMobileStoreReviewCode({ ...ios, submissionId: "other-submission" }, input), false);
});

test("terminal, expired or rotated iOS credentials refuse existing sessions without affecting Android", () => {
  const user = (credential: typeof android) => ({ id: credential.userId, email: credential.email, plan: "Free" });
  assert.equal(mobileStoreReviewSessionAllowed(user(ios), environment, now), true);
  for (const modified of [{ state: "accepted" }, { state: "rejected" }, { state: "withdrawn" }, { validUntil: new Date(now - 1).toISOString() }, { userId: "other-user" }]) {
    const changed = { ...environment, MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON: JSON.stringify({ ...ios, ...modified }) };
    assert.equal(mobileStoreReviewSessionAllowed(user(ios), changed, now), false);
    assert.equal(mobileStoreReviewSessionAllowed(user(android), changed, now), true);
  }
  assert.equal(mobileStoreReviewSessionAllowed({ id: "ordinary", email: "member@example.com", plan: "Free" }, {}, now), true);
});
