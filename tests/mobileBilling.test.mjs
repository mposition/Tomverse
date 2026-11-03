import assert from "node:assert/strict";
import test from "node:test";
import { parseMobileBillingProducts, resolveMobileSubscription, mobileBillingEnabled, mobileBillingRequestSchema } from "../lib/mobileBillingCore.ts";
import { effectivePlanForAccess } from "../lib/foundingTesterPassCore.ts";
import { canPurchaseMobileProduct, createNativeBillingClient } from "../apps/mobile/src/billingClient.ts";
import { withBillingLaunchMode } from "../apps/mobile/scripts/configure-store-billing.mjs";
import { assertMobileOwnershipConfigured } from "../lib/mobileStoreOwnership.ts";

const products = [
  { store: "app_store", productId: "pro.month", kind: "subscription", plan: "Pro", interval: "monthly" },
  { store: "app_store", productId: "max.month", kind: "subscription", plan: "Max", interval: "monthly" },
  { store: "play_store", productId: "pro:monthly", kind: "subscription", plan: "Pro", interval: "monthly" },
  { store: "play_store", productId: "max:monthly", kind: "subscription", plan: "Max", interval: "monthly" },
  { store: "play_store", productId: "credits500", kind: "credits", packId: "starter_500" },
];
const now = new Date("2026-10-25T00:00:00Z");
test("store ownership protection has no permissive default key", () => {
  const prior = process.env.MOBILE_BILLING_OWNERSHIP_KEY;
  try { delete process.env.MOBILE_BILLING_OWNERSHIP_KEY; assert.throws(assertMobileOwnershipConfigured, /not configured/); }
  finally { if (prior === undefined) delete process.env.MOBILE_BILLING_OWNERSHIP_KEY; else process.env.MOBILE_BILLING_OWNERSHIP_KEY = prior; }
});
test("Android billing keeps banking-app confirmation alive and manifest sync is idempotent", () => {
  const source = '<application><activity android:name=".MainActivity" android:launchMode="singleTask"></activity><activity android:name=".Other" /></application>';
  const result = withBillingLaunchMode(source);
  assert.match(result, /android:launchMode="singleTop"/);
  assert.equal(withBillingLaunchMode(result), result);
  assert.match(result, /android:name=".Other" \/>/);
});
const subscription = (overrides = {}) => ({ store: "app_store", is_sandbox: false, expires_date: "2026-11-25T00:00:00Z", ...overrides });
const resolve = (subscriptions, environment = "PRODUCTION") => resolveMobileSubscription({ subscriber: { subscriptions } }, products, environment, now);

test("billing is default-off and catalog/request cannot supply credit quantities or arbitrary identity", () => {
  assert.equal(mobileBillingEnabled({}), false);
  assert.deepEqual(parseMobileBillingProducts(JSON.stringify(products)), products);
  assert.throws(() => parseMobileBillingProducts(JSON.stringify([products[0], products[0]])));
  assert.throws(() => parseMobileBillingProducts(JSON.stringify([{ ...products[4], credits: 100000 }])));
  assert.equal(mobileBillingRequestSchema.safeParse({ action: "sync", store: "app_store", userId: "victim" }).success, false);
});
test("only a mapped, paid, unexpired store subscription grants access", () => {
  assert.equal(resolve({ "pro.month": subscription() }).plan, "Pro");
  assert.equal(resolve({ "pro.month": subscription({ is_sandbox: true }) }), null);
  assert.equal(resolve({ "pro.month": subscription({ is_sandbox: true }) }, "SANDBOX").plan, "Pro");
  assert.equal(resolve({ "pro.month": subscription({ refunded_at: now.toISOString() }) }), null);
  assert.equal(resolve({ unknown: subscription() }), null);
  assert.equal(resolve({ "pro.month": subscription({ store: "promotional" }) }), null);
  assert.equal(resolve({ "pro.month": subscription({ expires_date: "2026-10-24T00:00:00Z" }) }), null);
  assert.equal(resolve({ "pro.month": subscription({ expires_date: null }) }), null);
  assert.throws(() => resolveMobileSubscription({}, products, "PRODUCTION", now));
});
test("cancellation preserves paid access; grace uses the verified grace deadline", () => {
  assert.equal(resolve({ pro: subscription({ store: "play_store", product_plan_identifier: "monthly" }) }).productId, "pro:monthly");
  const cancelled = resolve({ "pro.month": subscription({ unsubscribe_detected_at: now.toISOString() }) });
  assert.equal(cancelled.plan, "Pro"); assert.equal(cancelled.cancelAtPeriodEnd, true);
  const grace = resolve({ "pro.month": subscription({ expires_date: "2026-10-24T00:00:00Z", grace_period_expires_date: "2026-10-26T00:00:00Z", billing_issues_detected_at: now.toISOString() }) });
  assert.equal(grace.status, "past_due");
  assert.equal(resolve({ "pro.month": subscription(), "max.month": subscription() }).plan, "Max");
});
test("store access expires even if the expiration webhook is delayed", () => {
  assert.equal(effectivePlanForAccess({ plan: "Pro", webSubscriptionPlan: "Free" }, now), "Pro", "old-code web upgrades during rollout remain authoritative before native activation");
  assert.equal(effectivePlanForAccess({ plan: "Free", webSubscriptionPlan: "Pro" }, now), "Free", "old-code expiry during rollout cannot leave an unearned web tier");
  assert.equal(effectivePlanForAccess({ plan: "Max", webSubscriptionPlan: "Free", storeSubscriptionPlan: "Max", storeSubscriptionExpiresAt: "2026-10-24" }, now), "Free");
  assert.equal(effectivePlanForAccess({ plan: "Max", webSubscriptionPlan: "Pro", storeSubscriptionPlan: "Max", storeSubscriptionExpiresAt: "2026-10-24" }, now), "Pro");
  assert.equal(effectivePlanForAccess({ plan: "Free", webSubscriptionPlan: "Free", storeSubscriptionPlan: "Pro", storeSubscriptionExpiresAt: "2026-11-24" }, now), "Pro");
  for (const status of ["mobile_store_active", "mobile_store_grace", "mobile_store_expired"]) {
    assert.equal(effectivePlanForAccess({ plan: "Max", subscriptionStatus: status, subscriptionCurrentPeriodEnd: "2026-10-24" }, now), "Free");
    assert.equal(effectivePlanForAccess({ plan: "Max", subscriptionStatus: status }, now), "Free");
  }
});
const base = { billingId: "opaque-account", plan: "Pro", subscriptionStore: "play_store", productId: "pro:monthly", interval: "monthly", active: true, cancelAtPeriodEnd: false, products, purchasedCredits: 0 };

test("native pass redemption normalizes the code, reads canonical access and never starts a store purchase", async () => {
  const paths = []; const bodies = []; let activated = false;
  const state = { ...base, plan: "Free", promotionPasses: true };
  const client = createNativeBillingClient({ store: "play_store", apiKey: "", isCurrent: () => true,
    sdk: { purchaseStoreProduct: async () => assert.fail("A pass must never purchase a store product") },
    api: async (path, init) => {
      paths.push(path); bodies.push(JSON.parse(init().body));
      if (path === "/api/billing/checkout") {
        activated = true;
        return Response.json({ success: true, accessType: "founding_tester_pass", automaticRenewal: false, paymentMethodRequired: false, periodEnd: "2099-01-01T00:00:00Z" });
      }
      return Response.json({ ...state, ...(activated ? { plan: "Pro", accessPass: { expiresAt: "2099-01-01T00:00:00Z" } } : {}) });
    } });
  const result = await client.redeemPass("  trial-pass  ", "ko");
  assert.equal(result.plan, "Pro");
  assert.deepEqual(paths, ["/api/mobile/billing", "/api/billing/checkout", "/api/mobile/billing"]);
  assert.deepEqual(bodies[1], { planId: "pro", billingInterval: "monthly", promoCode: "TRIAL-PASS", language: "ko" });
});

test("an older backend never receives a pass redemption on its cookie-only checkout route", async () => {
  const paths = [];
  const client = createNativeBillingClient({ sdk: {}, store: "play_store", apiKey: "", isCurrent: () => true,
    api: async (path) => { paths.push(path); return Response.json(base); } });
  await assert.rejects(client.redeemPass("trial-pass", "en"), /NATIVE_PASS_UNAVAILABLE/);
  assert.deepEqual(paths, ["/api/mobile/billing"]);
});

for (const failure of ["lost-receipt", "paid-coupon", "expired", "already-used", "stale-state"]) test(`native pass does not repeat redemption or report success after ${failure}`, async () => {
  let redemptions = 0;
  const client = createNativeBillingClient({ sdk: {}, store: "play_store", apiKey: "", isCurrent: () => true,
    api: async path => {
      if (path !== "/api/billing/checkout") return Response.json({ ...base, plan: "Free", promotionPasses: true });
      redemptions++;
      if (failure === "lost-receipt") throw Error("connection lost");
      if (failure === "expired" || failure === "already-used") return Response.json({ code: failure === "expired" ? "PROMOTION_EXPIRED" : "PROMOTION_ALREADY_USED" }, { status: 409 });
      return Response.json({ success: true, accessType: failure === "paid-coupon" ? "stripe_subscription" : "founding_tester_pass", automaticRenewal: false, paymentMethodRequired: false, periodEnd: "2099-01-01T00:00:00Z" });
    } });
  await assert.rejects(client.redeemPass("test-pass", "en"));
  assert.equal(redemptions, 1);
});
test("subscription changes cannot create duplicate or cross-provider subscriptions or silently resume renewal", () => {
  assert.equal(canPurchaseMobileProduct({ ...base, active: false, plan: "Max" }, products[1], "app_store"), false);
  assert.equal(canPurchaseMobileProduct({ ...base, active: false, plan: "Pro" }, products[0], "app_store"), false);
  assert.equal(canPurchaseMobileProduct({ ...base, active: false, plan: "Pro" }, products[1], "app_store"), true);
  assert.equal(canPurchaseMobileProduct(base, products[3], "play_store"), true);
  assert.equal(canPurchaseMobileProduct({ ...base, verificationPending: true }, products[3], "play_store"), false);
  for (const state of [{ ...base, subscriptionStore: "web" }, { ...base, cancelAtPeriodEnd: true }, { ...base, interval: "annual" }, { ...base, plan: "Max" }]) {
    assert.equal(canPurchaseMobileProduct(state, products[3], "play_store"), false);
  }
  assert.equal(canPurchaseMobileProduct(base, products[1], "play_store"), false);
  assert.equal(canPurchaseMobileProduct({ ...base, subscriptionStore: "web" }, products[4], "play_store"), true);
  assert.equal(canPurchaseMobileProduct({ ...base, creditPurchasesNeedingReview: 1 }, products[4], "play_store"), false);
});
test("Android changes pass replacement modes; account changes fence any later authenticated synchronization", async () => {
  let state = { ...base }; let active = true; const requests = []; const purchases = [];
  const sdk = { configure: async () => {}, logIn: async () => {}, purchaseStoreProduct: async (input) => { purchases.push(input); } };
  const api = async (path, init) => { requests.push(JSON.parse(init().body)); return Response.json(state); };
  const client = createNativeBillingClient({ sdk, api, store: "play_store", apiKey: "public-test-key", isCurrent: () => active });
  await client.purchase({ identifier: "max:monthly" });
  assert.deepEqual(purchases[0].storeProductChangeInfo, { oldProductIdentifier: "pro:monthly", replacementMode: "CHARGE_PRORATED_PRICE" });
  state = { ...base, plan: "Max", productId: "max:monthly" };
  await client.purchase({ identifier: "pro:monthly" });
  assert.equal(purchases[1].storeProductChangeInfo.replacementMode, "DEFERRED");
  sdk.purchaseStoreProduct = async () => { active = false; };
  const before = requests.length;
  await assert.rejects(client.purchase({ identifier: "pro:monthly" }), /BILLING_ACCOUNT_CHANGED/);
  assert.equal(requests.length, before + 2);
});
test("pending/cancelled payments cannot grant client entitlements or repeat the purchase", async () => {
  let calls = 0; let syncs = 0;
  const client = createNativeBillingClient({ store: "play_store", apiKey: "public-test-key", isCurrent: () => true,
    api: async () => { syncs++; return Response.json(base); },
    sdk: { logIn: async () => {}, purchaseStoreProduct: async () => { calls++; throw { code: "20" }; } } });
  await assert.rejects(client.purchase({ identifier: "max:monthly" }));
  assert.equal(calls, 1); assert.equal(syncs, 2);
});

test("pending store approval persists across clients and prevents a second subscription sheet", async () => {
  let state = { ...base, active: false, plan: "Free", subscriptionStore: null }; let purchases = 0;
  const api = async (_path, build) => {
    const body = JSON.parse(build().body);
    if (body.action === "prepare_subscription_purchase") state = { ...state, subscriptionPurchaseAttempt: { id: "attempt", store: "play_store", productId: body.productId, startedAt: new Date().toISOString() } };
    return Response.json(state);
  };
  const sdk = { logIn: async () => {}, purchaseStoreProduct: async () => { purchases++; throw { code: "20" }; } };
  const options = { sdk, api, store: "play_store", apiKey: "public-test-key", isCurrent: () => true };
  await assert.rejects(createNativeBillingClient(options).purchase({ identifier: "pro:monthly" }));
  await assert.rejects(createNativeBillingClient(options).purchase({ identifier: "max:monthly" }), /BILLING_PLAN_CHANGED/);
  assert.equal(purchases, 1);
});

test("cancelling a credit payment never clears an unrelated pending subscription", async () => {
  const state = { ...base, subscriptionPurchaseAttempt: { id: "subscription-pending", store: "play_store", productId: "max:monthly", startedAt: new Date().toISOString() } };
  const actions = [];
  const client = createNativeBillingClient({ store: "play_store", apiKey: "public-test-key", isCurrent: () => true,
    api: async (_path, build) => { actions.push(JSON.parse(build().body).action); return Response.json(state); },
    sdk: { logIn: async () => {}, purchaseStoreProduct: async () => { throw { code: "1" }; } },
  });
  await assert.rejects(client.purchase({ identifier: "credits500" }));
  assert.deepEqual(actions, ["sync", "prepare_credit_purchase"]);
  assert.equal(canPurchaseMobileProduct(state, products[3], "play_store"), false);
});
