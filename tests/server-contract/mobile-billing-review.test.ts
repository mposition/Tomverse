import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const credential = { submissionId: "ios-review-test-1", userId: "review-user", email: "appstore-review-test@tomverse.app", appId: "app.tomverse.shell", buildNumber: 11, plan: "Free", state: "submitted", validUntil: new Date(Date.now() + 86400000).toISOString(), salt: "a".repeat(64), codeHash: "b".repeat(64) };
let user: { id: string; email: string; accountStatus: string; plan: string; mobileBillingId: string };
let reads = 0, processed = 0;
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { user: { findUnique: async (input: { where: { id?: string; mobileBillingId?: string } }) => { reads++; return input.where.id === user.id || input.where.mobileBillingId === user.mobileBillingId ? user : null; } } } } });
mock.module(mod("lib/mobileBillingService.ts"), { namedExports: { processMobileStoreWebhook: async () => { processed++; } } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { apiSecurityResponse: () => null, readLimitedJson: async (request: Request, _limit: number, schema: { parse(value: unknown): unknown }) => schema.parse(await request.json()) } });
let api: typeof import("../../lib/mobileBillingReview");
let webhook: typeof import("../../app/api/webhooks/revenuecat/route");
before(async () => { api = await import("../../lib/mobileBillingReview"); webhook = await import("../../app/api/webhooks/revenuecat/route"); });
beforeEach(() => {
  Object.assign(process.env, { MOBILE_BILLING_ENABLED: "true", MOBILE_BILLING_ENVIRONMENT: "PRODUCTION", MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED: "true", MOBILE_STORE_REVIEW_IOS_ENABLED: "true", MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON: JSON.stringify(credential), REVENUECAT_APPLE_APP_ID: "app-apple", REVENUECAT_WEBHOOK_AUTHORIZATION: "Bearer synthetic-review-webhook-authorization", MOBILE_BILLING_PRODUCTS_JSON: JSON.stringify([
    { store: "app_store", productId: "pro.month", kind: "subscription", plan: "Pro", interval: "monthly" },
    { store: "app_store", productId: "credits500", kind: "credits", packId: "starter_500" },
    { store: "play_store", productId: "play.pro", kind: "subscription", plan: "Pro", interval: "monthly" },
  ]) });
  delete process.env.ADMIN_USER_IDS; delete process.env.ADMIN_EMAILS;
  user = { id: credential.userId, email: credential.email, accountStatus: "active", plan: "Free", mobileBillingId: "opaque-review-id" }; reads = 0; processed = 0;
});
const event = { id: "review-event", app_id: "app-apple", store: "APP_STORE", environment: "SANDBOX", app_user_id: "opaque-review-id", product_id: "pro.month", type: "INITIAL_PURCHASE", transaction_id: "review-tx", original_transaction_id: "review-original", purchased_at_ms: Date.now() };
const post = (changes = {}, authorization = process.env.REVENUECAT_WEBHOOK_AUTHORIZATION!) => webhook.POST(new Request("https://tomverse.app/api/webhooks/revenuecat", { method: "POST", headers: { authorization }, body: JSON.stringify({ api_version: "1.0", event: { ...event, ...changes } }) }));

test("only the configured review user's subscription snapshot selects sandbox", async () => {
  assert.equal(await api.mobileSubscriptionEnvironment("ordinary-user"), "PRODUCTION"); assert.equal(reads, 0);
  assert.equal(await api.mobileSubscriptionEnvironment(user.id), "SANDBOX");
  user.accountStatus = "suspended";
  assert.equal(await api.mobileSubscriptionEnvironment(user.id), "PRODUCTION");
});
test("review webhooks accept only the bound App Store subscription and never consumables or Google", async () => {
  assert.equal(await api.iosReviewSandboxWebhookAllowed(event), true);
  for (const change of [{ app_user_id: "ordinary" }, { product_id: "credits500" }, { product_id: "play.pro" }, { store: "PLAY_STORE" }, { environment: "PRODUCTION" }]) assert.equal(await api.iosReviewSandboxWebhookAllowed({ ...event, ...change }), false);
  delete process.env.MOBILE_STORE_REVIEW_IOS_ENABLED;
  assert.equal(await api.iosReviewSandboxWebhookAllowed(event), false);
});
test("the authenticated endpoint checks app and secret before applying a review receipt", async () => {
  assert.equal((await post({}, "forged")).status, 401); assert.equal(reads, 0);
  assert.equal((await (await post({ app_id: "other-app" })).json()).ignored, "STORE_ENVIRONMENT_MISMATCH"); assert.equal(reads, 0);
  assert.equal((await (await post({ app_user_id: "ordinary" })).json()).ignored, "STORE_ENVIRONMENT_MISMATCH"); assert.equal(processed, 0);
  assert.deepEqual(await (await post()).json(), { received: true }); assert.equal(processed, 1);
});
test("revoked, replaced or privileged review accounts receive no sandbox entitlement", async () => {
  process.env.ADMIN_USER_IDS = user.id;
  assert.equal(await api.iosReviewSandboxWebhookAllowed(event), false);
  delete process.env.ADMIN_USER_IDS;
  process.env.MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON = JSON.stringify({ ...credential, state: "accepted" });
  assert.equal(await api.iosReviewSandboxWebhookAllowed(event), false);
  assert.equal(await api.mobileSubscriptionEnvironment(user.id), "PRODUCTION");
});
