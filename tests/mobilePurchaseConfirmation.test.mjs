import assert from "node:assert/strict";
import test from "node:test";
import { confirmedPurchase } from "../apps/mobile/src/billingPurchaseResult.ts";

const credit = { kind: "credits", productId: "credits500", store: "play_store", credits: 500 };
const subscription = { kind: "subscription", productId: "max:monthly", store: "play_store", plan: "Max", interval: "monthly" };
const before = { billingId: "account-a", purchasedCredits: 100, plan: "Pro", products: [credit, subscription] };
const observation = { before, productId: credit.productId };

test("credit confirmation requires the matching server balance increase on the same account", () => {
  assert.deepEqual(confirmedPurchase(observation, { ...before, purchasedCredits: 600 }), { kind: "credits", credits: 500 });
  for (const update of [{ purchasedCredits: 100 }, { purchasedCredits: 500 }, { purchasedCredits: 1100 }, { purchasedCredits: 600, billingId: "account-b" }, { purchasedCredits: 600, creditPurchasesNeedingReview: 1 }]) {
    assert.equal(confirmedPurchase(observation, { ...before, ...update }), null);
  }
  assert.equal(confirmedPurchase({ before, productId: "missing" }, { ...before, purchasedCredits: 600 }), null);
});

test("subscription confirmation requires an active matching SKU and no pending verification", () => {
  const observation = { before, productId: subscription.productId };
  const after = { ...before, active: true, subscriptionStore: "play_store", productId: "max:monthly", plan: "Max", interval: "monthly" };
  assert.deepEqual(confirmedPurchase(observation, after), { kind: "subscription", plan: "Max" });
  for (const update of [{ active: false }, { plan: "Pro" }, { productId: "pro:monthly" }, { interval: "annual" }, { subscriptionStore: "web" }, { verificationPending: true }, { subscriptionPurchaseAttempt: { id: "waiting" } }]) {
    assert.equal(confirmedPurchase(observation, { ...after, ...update }), null);
  }
});
