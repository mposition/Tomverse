import assert from "node:assert/strict";
import test from "node:test";
import { parseMobileBillingProducts, resolveMobileSubscription, mobileBillingEnabled, mobileBillingRequestSchema } from "../lib/mobileBillingCore.ts";
import { effectivePlanForAccess } from "../lib/foundingTesterPassCore.ts";
import { canPurchaseMobileProduct, createNativeBillingClient } from "../apps/mobile/src/billingClient.ts";
import { withBillingLaunchMode } from "../apps/mobile/scripts/configure-store-billing.mjs";

const products = [
  { store: "app_store", productId: "pro.month", kind: "subscription", plan: "Pro", interval: "monthly" },
  { store: "app_store", productId: "max.month", kind: "subscription", plan: "Max", interval: "monthly" },
  { store: "play_store", productId: "pro:monthly", kind: "subscription", plan: "Pro", interval: "monthly" },
  { store: "play_store", productId: "max:monthly", kind: "subscription", plan: "Max", interval: "monthly" },
  { store: "play_store", productId: "credits500", kind: "credits", packId: "starter_500" },
];
const now = new Date("2026-10-25T00:00:00Z");
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
  assert.equal(effectivePlanForAccess({ plan: "Max", webSubscriptionPlan: "Free", storeSubscriptionPlan: "Max", storeSubscriptionExpiresAt: "2026-10-24" }, now), "Free");
  assert.equal(effectivePlanForAccess({ plan: "Max", webSubscriptionPlan: "Pro", storeSubscriptionPlan: "Max", storeSubscriptionExpiresAt: "2026-10-24" }, now), "Pro");
  assert.equal(effectivePlanForAccess({ plan: "Free", webSubscriptionPlan: "Free", storeSubscriptionPlan: "Pro", storeSubscriptionExpiresAt: "2026-11-24" }, now), "Pro");
  for (const status of ["mobile_store_active", "mobile_store_grace", "mobile_store_expired"]) {
    assert.equal(effectivePlanForAccess({ plan: "Max", subscriptionStatus: status, subscriptionCurrentPeriodEnd: "2026-10-24" }, now), "Free");
    assert.equal(effectivePlanForAccess({ plan: "Max", subscriptionStatus: status }, now), "Free");
  }
});
const base = { billingId: "opaque-account", plan: "Pro", subscriptionStore: "play_store", productId: "pro:monthly", interval: "monthly", active: true, cancelAtPeriodEnd: false, products, purchasedCredits: 0 };
test("subscription changes cannot create duplicate or cross-provider subscriptions or silently resume renewal", () => {
  assert.equal(canPurchaseMobileProduct(base, products[3], "play_store"), true);
  for (const state of [{ ...base, subscriptionStore: "web" }, { ...base, cancelAtPeriodEnd: true }, { ...base, interval: "annual" }, { ...base, plan: "Max" }]) {
    assert.equal(canPurchaseMobileProduct(state, products[3], "play_store"), false);
  }
  assert.equal(canPurchaseMobileProduct(base, products[1], "play_store"), false);
  assert.equal(canPurchaseMobileProduct({ ...base, subscriptionStore: "web" }, products[4], "play_store"), true);
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
  assert.equal(requests.length, before + 1);
});
test("pending/cancelled payments cannot grant client entitlements or repeat the purchase", async () => {
  let calls = 0; let syncs = 0;
  const client = createNativeBillingClient({ store: "play_store", apiKey: "public-test-key", isCurrent: () => true,
    api: async () => { syncs++; return Response.json(base); },
    sdk: { logIn: async () => {}, purchaseStoreProduct: async () => { calls++; throw { code: "20" }; } } });
  await assert.rejects(client.purchase({ identifier: "max:monthly" }));
  assert.equal(calls, 1); assert.equal(syncs, 1);
});
