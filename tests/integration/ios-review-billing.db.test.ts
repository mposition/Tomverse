import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { claimMobileStoreOwnership, mobileStoreTransactionHash } from "@/lib/mobileStoreOwnership";
import { ensureMobileBillingId, prepareMobileSubscriptionPurchase, processMobileStoreWebhook, readMobileBillingState, syncMobileSubscription } from "@/lib/mobileBillingService";
import { mobileStoreReviewSessionAllowed } from "@/lib/mobileAuthKeyring";

after(async () => { await prisma.$disconnect(); });

test("only the dedicated iOS reviewer can settle sandbox subscriptions in a production deployment", async () => {
  const keys = ["MOBILE_BILLING_ENVIRONMENT", "MOBILE_BILLING_PRODUCTS_JSON", "MOBILE_BILLING_OWNERSHIP_KEY", "REVENUECAT_SECRET_API_KEY", "MOBILE_STORE_REVIEW_IOS_ENABLED", "MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON", "MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const ids: string[] = [];
  try {
    Object.assign(process.env, { MOBILE_BILLING_ENVIRONMENT: "PRODUCTION", MOBILE_BILLING_OWNERSHIP_KEY: "synthetic-ios-review-store-owner-key-long-enough", REVENUECAT_SECRET_API_KEY: "synthetic-server-key", MOBILE_BILLING_PRODUCTS_JSON: JSON.stringify([
      { store: "app_store", productId: "ios.review.pro", kind: "subscription", plan: "Pro", interval: "monthly" },
      { store: "app_store", productId: "ios.review.credits", kind: "credits", packId: "starter_500" },
      { store: "play_store", productId: "play.review.pro", kind: "subscription", plan: "Pro", interval: "monthly" },
    ]) });
    const reviewer = await prisma.user.create({ data: { email: `appstore-review-${randomUUID()}@tomverse.app`, emailVerified: new Date(), emailLoginEnabled: true } }); ids.push(reviewer.id);
    const ordinary = await prisma.user.create({ data: { email: `${randomUUID()}@ios-review-billing.example.test` } }); ids.push(ordinary.id);
    const billingId = await ensureMobileBillingId(reviewer.id);
    const ordinaryBillingId = await ensureMobileBillingId(ordinary.id);
    const credential = { submissionId: "ios-review-integration", userId: reviewer.id, email: reviewer.email!, appId: "app.tomverse.shell", buildNumber: 11, plan: "Free", state: "submitted", validUntil: new Date(Date.now() + 86400000).toISOString(), salt: "a".repeat(64), codeHash: "b".repeat(64) };
    Object.assign(process.env, { MOBILE_STORE_REVIEW_IOS_ENABLED: "true", MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON: JSON.stringify(credential), MOBILE_BILLING_IOS_REVIEW_SANDBOX_ENABLED: "true" });
    const transaction = randomUUID();
    const event = { id: randomUUID(), app_id: "synthetic-apple-app", app_user_id: billingId, store: "APP_STORE" as const, environment: "SANDBOX" as const, type: "INITIAL_PURCHASE", product_id: "ios.review.pro", transaction_id: transaction, original_transaction_id: transaction, purchased_at_ms: Date.now() };
    globalThis.fetch = async url => {
      assert.ok(String(url).startsWith("https://api.revenuecat.com/v1/subscribers/"));
      return Response.json({ subscriber: { subscriptions: { "ios.review.pro": { store: "app_store", is_sandbox: true, store_transaction_id: transaction, expires_date: "2099-01-01T00:00:00Z" } } } });
    };
    await prepareMobileSubscriptionPurchase(reviewer.id, "app_store", "ios.review.pro");
    await processMobileStoreWebhook(event);
    const state = await readMobileBillingState(reviewer.id, "app_store");
    assert.equal(state.plan, "Pro");
    assert.equal(state.subscriptionPurchaseAttempt, null);
    assert.equal(await prisma.mobileStoreOwnership.count({ where: { environment: "SANDBOX", store: "app_store", transactionHash: mobileStoreTransactionHash(transaction) } }), 1);
    const current = await prisma.user.findUniqueOrThrow({ where: { id: reviewer.id } });
    assert.equal(mobileStoreReviewSessionAllowed(current), true);
    await syncMobileSubscription(ordinary.id, ordinaryBillingId);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ordinary.id } })).plan, "Free");
    await assert.rejects(prisma.$transaction(tx => claimMobileStoreOwnership(tx, { ...event, app_user_id: ordinaryBillingId, transaction_id: randomUUID(), original_transaction_id: randomUUID() })), /environment mismatch/);
    await assert.rejects(prisma.$transaction(tx => claimMobileStoreOwnership(tx, { ...event, product_id: "ios.review.credits", type: "NON_RENEWING_PURCHASE", transaction_id: randomUUID() })), /environment mismatch/);
    assert.equal(await prisma.creditLot.count({ where: { userId: reviewer.id } }), 0);
    process.env.MOBILE_STORE_REVIEW_IOS_CREDENTIAL_JSON = JSON.stringify({ ...credential, state: "accepted" });
    assert.equal(mobileStoreReviewSessionAllowed(current), false);
    await assert.rejects(processMobileStoreWebhook({ ...event, id: randomUUID(), transaction_id: randomUUID(), original_transaction_id: randomUUID() }), /environment mismatch/);
    await syncMobileSubscription(reviewer.id, billingId);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: reviewer.id } })).plan, "Free");
    assert.equal(process.env.MOBILE_BILLING_ENVIRONMENT, "PRODUCTION");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});
