import assert from "node:assert/strict";
import { after, beforeEach, test, mock } from "node:test";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { applyMobileCreditEvent, ensureMobileBillingId, syncMobileSubscription, readMobileBillingState, cancelMobileWebSubscription } from "@/lib/mobileBillingService";
import { lockCreditAccount } from "@/lib/creditDebt";
import { getPurchasedCreditSummary, expireCreditLots, reserveAddOnCredits, settleAddOnCredits } from "@/lib/creditLedger";
import { getStripe } from "@/lib/stripe";
import { resyncSubscriptionFromStripe, processStripeEvent } from "@/lib/stripeWebhookProcessing";

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
  assert.equal(await prisma.creditLedgerEntry.count({ where: { userId: user.id, type: "settle", reservationId: "use-2" } }), 1);
});
test("subscription sync preserves credit usage, protects web subscriptions and rereads current store state", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const originalFetch = globalThis.fetch;
  let subscriptions = { "pro.month": { store: "app_store", is_sandbox: false, expires_date: "2099-01-01T00:00:00Z", unsubscribe_detected_at: "2026-10-25T00:00:00Z" } } as Record<string, unknown>;
  globalThis.fetch = async () => Response.json({ subscriber: { subscriptions } });
  try {
    await syncMobileSubscription(user.id, billingId);
    let account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Pro"); assert.equal(account.storeSubscriptionCancelAtPeriodEnd, true);
    assert.equal(account.subscriptionStore, "app_store");
    assert.equal(account.subscriptionSyncedAt, null, "mobile sync must not advance the Stripe observation clock");
    subscriptions = {};
    await syncMobileSubscription(user.id, billingId);
    account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Free");
    await prisma.user.update({ where: { id: user.id }, data: { plan: "Max", webSubscriptionPlan: "Max", subscriptionStore: null, stripeSubscriptionId: "sub-web", subscriptionStatus: "active" } });
    await syncMobileSubscription(user.id, billingId);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan, "Max");
  } finally { globalThis.fetch = originalFetch; }
});

test("a paid web subscription applies immediately after store expiry, including concurrent mobile reads", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_local_mock_only";
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const customer = "cus_mobile_transition";
  await prisma.user.update({ where: { id: user.id }, data: {
    plan: "Max", webSubscriptionPlan: "Free", subscriptionStore: "app_store", storeSubscriptionPlan: "Max",
    subscriptionStoreProductId: "old.max", storeSubscriptionExpiresAt: new Date("2000-01-01"), stripeCustomerId: customer,
  } });
  const subscription = { id: "sub_mobile_transition", customer, status: "active", cancel_at_period_end: false,
    metadata: { planId: "pro" }, current_period_end: Math.floor(Date.now() / 1000) + 86400,
    items: { data: [{ id: "item", price: { id: "price_test_mobile", product: "prod_test", recurring: { interval: "month" } } }] },
  } as unknown as Stripe.Subscription;
  const retrieve = mock.method(getStripe().subscriptions, "retrieve", async () => subscription);
  const originalFetch = globalThis.fetch;
  let release!: (value: Response) => void; let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  globalThis.fetch = async () => { entered(); return new Promise<Response>((resolve) => { release = resolve; }); };
  try {
    const mobile = syncMobileSubscription(user.id, billingId);
    await waiting;
    const synced = await resyncSubscriptionFromStripe(subscription.id);
    assert.equal(synced?.plan, "Pro");
    release(Response.json({ subscriber: { subscriptions: { "pro.month": {
      store: "app_store", is_sandbox: false, expires_date: "2099-01-01T00:00:00Z",
    } } } }));
    await mobile;
    const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(current.plan, "Pro"); assert.equal(current.subscriptionStore, "app_store");
    assert.equal(current.stripeSubscriptionId, subscription.id);
    // The earlier mobile response must not reclaim a paid web subscription.
    assert.equal(current.subscriptionStatus, "active");
  } finally { retrieve.mock.restore(); globalThis.fetch = originalFetch; }
});

test("checkout completing after a store purchase stays recorded and cancellable, and web deletion preserves store access", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_local_mock_only";
  const user = await createUser(); await ensureMobileBillingId(user.id);
  const customer = "cus_mobile_overlap";
  await prisma.user.update({ where: { id: user.id }, data: {
    plan: "Max", webSubscriptionPlan: "Free", subscriptionStore: "app_store",
    storeSubscriptionPlan: "Max", storeSubscriptionExpiresAt: new Date("2099-01-01"), stripeCustomerId: customer,
  } });
  const subscription = { id: "sub_mobile_overlap", customer, status: "active", cancel_at_period_end: false,
    metadata: { planId: "pro" }, current_period_end: Math.floor(Date.now() / 1000) + 86400,
    items: { data: [{ id: "item", price: { id: "price_test_mobile", product: "prod_test", recurring: { interval: "month" } } }] },
  } as unknown as Stripe.Subscription;
  const stripe = getStripe();
  const retrieve = mock.method(stripe.subscriptions, "retrieve", async () => subscription);
  const update = mock.method(stripe.subscriptions, "update", async () => { subscription.cancel_at_period_end = true; return subscription; });
  try {
    await processStripeEvent({ id: "evt_overlap", type: "checkout.session.completed", data: { object: {
      id: "cs_mobile_overlap", subscription: subscription.id, amount_total: 1500, currency: "usd",
      created: Math.floor(Date.now() / 1000), metadata: {},
    } } } as unknown as Stripe.Event);
    let account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Max"); assert.equal(account.stripeSubscriptionId, subscription.id);
    assert.equal(account.webSubscriptionPlan, "Pro");
    assert.equal(await prisma.billingTransaction.count({ where: { userId: user.id, stripeCheckoutSessionId: "cs_mobile_overlap" } }), 1);
    const state = await readMobileBillingState(user.id, "app_store");
    assert.equal(state.webSubscription?.active, true); assert.equal(state.subscriptionStore, "app_store");
    await cancelMobileWebSubscription(user.id);
    assert.equal(update.mock.callCount(), 1);
    account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.subscriptionCancelAtPeriodEnd, true); assert.equal(account.plan, "Max");
    await processStripeEvent({ id: "evt_delete_overlap", type: "customer.subscription.deleted", created: Math.floor(Date.now() / 1000),
      data: { object: { ...subscription, status: "canceled" } } } as unknown as Stripe.Event);
    account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Max"); assert.equal(account.webSubscriptionPlan, "Free");
    assert.equal(account.storeSubscriptionPlan, "Max"); assert.equal(account.stripeSubscriptionId, null);
  } finally { retrieve.mock.restore(); update.mock.restore(); }
});
