import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { applyMobileCreditEvent, ensureMobileBillingId, syncMobileSubscription } from "@/lib/mobileBillingService";
import { lockCreditAccount } from "@/lib/creditDebt";
import { getPurchasedCreditSummary, expireCreditLots, reserveAddOnCredits, settleAddOnCredits } from "@/lib/creditLedger";

process.env.MOBILE_BILLING_PRODUCTS_JSON = JSON.stringify([
  { store: "app_store", productId: "credits500", kind: "credits", packId: "starter_500" },
  { store: "app_store", productId: "pro.month", kind: "subscription", plan: "Pro", interval: "monthly" },
]);
process.env.REVENUECAT_SECRET_API_KEY = "server-test-key";
const event = { id: "event-1", app_id: "app-test", app_user_id: "account-test", store: "APP_STORE" as const,
  environment: "PRODUCTION" as const, type: "NON_RENEWING_PURCHASE", product_id: "credits500", transaction_id: "tx-1", purchased_at_ms: Date.now() };
const reset = async () => { await prisma.user.deleteMany({ where: { email: { endsWith: "@mobile-billing.example.test" } } }); };
beforeEach(reset);
after(async () => { await reset(); await prisma.$disconnect(); });
const createUser = (suffix = "one") => prisma.user.create({ data: { email: `${suffix}@mobile-billing.example.test` } });
const deliver = (userId: string, overrides = {}) => prisma.$transaction(async (tx) => {
  await lockCreditAccount(tx, userId); await applyMobileCreditEvent(tx, userId, { ...event, ...overrides });
});

test("concurrent purchase delivery grants once and a second account cannot replay the store transaction", async () => {
  const user = await createUser();
  await Promise.all([deliver(user.id), deliver(user.id)]);
  assert.equal(await prisma.mobileStoreTransaction.count({ where: { userId: user.id } }), 1);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 500);
  const second = await createUser("two");
  await assert.rejects(deliver(second.id), /another account/);
  assert.equal((await getPurchasedCreditSummary(second.id)).remainingCredits, 0);
});
test("purchased store credits remain spendable with an old compatibility date and never expire", async () => {
  const user = await createUser(); await deliver(user.id);
  await prisma.creditLot.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date("2000-01-01") } });
  await expireCreditLots();
  const summary = await getPurchasedCreditSummary(user.id);
  assert.equal(summary.remainingCredits, 500); assert.equal(summary.earliestExpiry, null);
  const entries = await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, user.id);
    return reserveAddOnCredits(tx, { userId: user.id, reservationId: "use-1", credits: 20, fundedCostMicroUsd: 100 });
  });
  assert.equal(entries[0].credits, 20);
});
test("refund revokes the unused balance and records used credit debt exactly once", async () => {
  const user = await createUser(); await deliver(user.id);
  await prisma.creditLot.updateMany({ where: { userId: user.id }, data: { remainingCredits: 400, remainingFundedCostMicroUsd: BigInt(600_000) } });
  await Promise.all([deliver(user.id, { type: "CANCELLATION" }), deliver(user.id, { type: "CANCELLATION" })]);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 0);
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(updated.creditDebtCredits, 100); assert.equal(updated.creditDebtCostMicroUsd, BigInt(150_000));
});
test("refund arriving before the purchase leaves a tombstone and never grants credits", async () => {
  const user = await createUser();
  await deliver(user.id, { type: "CANCELLATION" }); await deliver(user.id);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 0);
  assert.equal(await prisma.creditLot.count({ where: { userId: user.id } }), 0);
});
test("releasing an in-flight reservation after a store refund clears debt without reviving the refunded lot", async () => {
  const user = await createUser(); await deliver(user.id);
  const entries = await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, user.id);
    return reserveAddOnCredits(tx, { userId: user.id, reservationId: "use-2", credits: 20, fundedCostMicroUsd: 100 });
  });
  await deliver(user.id, { type: "CANCELLATION" });
  await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, user.id);
    await settleAddOnCredits(tx, { userId: user.id, reservationId: "use-2", entries, settledCredits: 0, settledFundedCostMicroUsd: 0, outcome: "cancelled" });
  });
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).creditDebtCredits, 0);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 0);
});
test("subscription sync preserves credit usage, protects web subscriptions and rereads current store state", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const originalFetch = globalThis.fetch;
  let subscriptions = { "pro.month": { store: "app_store", is_sandbox: false, expires_date: "2099-01-01T00:00:00Z", unsubscribe_detected_at: "2026-10-25T00:00:00Z" } } as Record<string, unknown>;
  globalThis.fetch = async () => Response.json({ subscriber: { subscriptions } });
  try {
    await syncMobileSubscription(user.id, billingId);
    let account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Pro"); assert.equal(account.subscriptionCancelAtPeriodEnd, true);
    assert.equal(account.subscriptionStore, "app_store");
    subscriptions = {};
    await syncMobileSubscription(user.id, billingId);
    account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Free");
    await prisma.user.update({ where: { id: user.id }, data: { plan: "Max", subscriptionStore: null, stripeSubscriptionId: "sub-web", subscriptionStatus: "active" } });
    await syncMobileSubscription(user.id, billingId);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan, "Max");
  } finally { globalThis.fetch = originalFetch; }
});
