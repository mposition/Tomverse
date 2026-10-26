import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test, mock } from "node:test";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { applyMobileCreditEvent, ensureMobileBillingId, syncMobileSubscription, readMobileBillingState, cancelMobileWebSubscription, processMobileStoreWebhook, prepareMobileCreditPurchase, prepareMobileSubscriptionPurchase, cancelMobileSubscriptionPurchase } from "@/lib/mobileBillingService";
import { claimMobileStoreOwnership } from "@/lib/mobileStoreOwnership";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";
import { lockCreditAccount } from "@/lib/creditDebt";
import { getPurchasedCreditSummary, expireCreditLots, reserveAddOnCredits, settleAddOnCredits } from "@/lib/creditLedger";
import { getStripe } from "@/lib/stripe";
import { resyncSubscriptionFromStripe, processStripeEvent } from "@/lib/stripeWebhookProcessing";

process.env.MOBILE_BILLING_PRODUCTS_JSON = JSON.stringify([
  { store: "app_store", productId: "credits500", kind: "credits", packId: "starter_500" },
  { store: "app_store", productId: "credits1500", kind: "credits", packId: "project_1500" },
  { store: "app_store", productId: "pro.month", kind: "subscription", plan: "Pro", interval: "monthly" },
  { store: "play_store", productId: "play.max:monthly", kind: "subscription", plan: "Max", interval: "monthly" },
]);
process.env.REVENUECAT_SECRET_API_KEY = "server-test-key";
process.env.MOBILE_BILLING_OWNERSHIP_KEY = "local-mobile-billing-ownership-test-key-2026";
const event = { id: "event-1", app_id: "app-test", app_user_id: "account-test", store: "APP_STORE" as const,
  environment: "PRODUCTION" as const, type: "NON_RENEWING_PURCHASE", product_id: "credits500", transaction_id: "tx-1", purchased_at_ms: Date.now() };
const reset = async () => { await prisma.user.deleteMany({ where: { email: { endsWith: "@mobile-billing.example.test" } } }); };
beforeEach(async () => { await reset(); event.transaction_id = randomUUID(); });
after(async () => { await reset(); await prisma.$disconnect(); });
const createUser = async (suffix = "one") => {
  const user = await prisma.user.create({ data: { email: `${suffix}@mobile-billing.example.test` } });
  await prepareMobileCreditPurchase(user.id, "app_store", "credits500");
  return user;
};
const deliver = (userId: string, overrides = {}) => prisma.$transaction(async (tx) => {
  await lockCreditAccount(tx, userId); await applyMobileCreditEvent(tx, userId, { ...event, ...overrides });
});
const bindSubscription = (billingId: string, transactionId: string, store: "APP_STORE" | "PLAY_STORE" = "APP_STORE", productId = "pro.month") => prisma.$transaction((tx) => claimMobileStoreOwnership(tx, {
  ...event, store, type: "INITIAL_PURCHASE", product_id: productId, app_user_id: billingId,
  transaction_id: transactionId, original_transaction_id: transactionId,
}));

test("a pending subscription blocks another device or store until cancellation or a verified purchase", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const prepared = await Promise.allSettled([prepareMobileSubscriptionPurchase(user.id, "app_store", "pro.month"), prepareMobileSubscriptionPurchase(user.id, "play_store", "play.max:monthly")]);
  assert.equal(prepared.filter((entry) => entry.status === "fulfilled").length, 1);
  const state = await readMobileBillingState(user.id, "app_store"); const attempt = state.subscriptionPurchaseAttempt!;
  await assert.rejects(prepareMobileSubscriptionPurchase(user.id, "app_store", "pro.month"), /previous store request/);
  await cancelMobileSubscriptionPurchase(user.id, "wrong-id");
  assert.ok((await readMobileBillingState(user.id, "app_store")).subscriptionPurchaseAttempt);
  await cancelMobileSubscriptionPurchase(user.id, attempt.id);
  await prepareMobileSubscriptionPurchase(user.id, "app_store", "pro.month");
  const transaction = randomUUID(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ subscriber: { subscriptions: { "pro.month": {
    store: "app_store", is_sandbox: false, store_transaction_id: transaction, expires_date: "2099-01-01T00:00:00Z",
  } } } });
  try {
    await processMobileStoreWebhook({ ...event, app_user_id: billingId, type: "INITIAL_PURCHASE", product_id: "pro.month", transaction_id: transaction, original_transaction_id: transaction, purchased_at_ms: Date.now() });
    const verified = await readMobileBillingState(user.id, "app_store");
    assert.equal(verified.plan, "Pro"); assert.equal(verified.subscriptionPurchaseAttempt, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("an unbound renewal retains only its previously verified period and a refund with incomplete remaining evidence revokes it", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const transaction = randomUUID(); await bindSubscription(billingId, transaction);
  const expiry = new Date(Date.now() + 86400000).toISOString();
  let subscriptions: Record<string, unknown> = { "pro.month": { store: "app_store", is_sandbox: false, store_transaction_id: transaction, expires_date: expiry } };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => Response.json({ subscriber: { subscriptions } });
  try {
    await syncMobileSubscription(user.id, billingId);
    subscriptions = { "pro.month": { store: "app_store", is_sandbox: false, store_transaction_id: randomUUID(), expires_date: "2099-01-01T00:00:00Z" } };
    assert.equal((await syncMobileSubscription(user.id, billingId)).verificationPending, true);
    const renewed = await readMobileBillingState(user.id, "app_store");
    assert.equal(renewed.plan, "Pro"); assert.equal(renewed.expiresAt, expiry);
    subscriptions = { "play.max:monthly": { store: "play_store", is_sandbox: false, expires_date: "2099-01-01T00:00:00Z" } };
    await syncMobileSubscription(user.id, billingId);
    assert.equal((await readMobileBillingState(user.id, "app_store")).plan, "Free");
  } finally { globalThis.fetch = originalFetch; }
});

test("a foreign receipt cannot erase a different product's verified unexpired renewal period", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const transaction = randomUUID(); await bindSubscription(billingId, transaction);
  const expiry = new Date(Date.now() + 86400000).toISOString();
  let subscriptions: Record<string, unknown> = { "pro.month": { store: "app_store", is_sandbox: false, store_transaction_id: transaction, expires_date: expiry } };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => Response.json({ subscriber: { subscriptions } });
  try {
    await syncMobileSubscription(user.id, billingId);
    const other = await createUser("other"); const otherBilling = await ensureMobileBillingId(other.id); const foreign = randomUUID();
    await bindSubscription(otherBilling, foreign, "PLAY_STORE", "play.max:monthly");
    subscriptions = {
      "pro.month": { store: "app_store", is_sandbox: false, store_transaction_id: randomUUID(), expires_date: "2099-01-01T00:00:00Z" },
      "play.max:monthly": { store: "play_store", is_sandbox: false, store_transaction_id: foreign, expires_date: "2099-01-01T00:00:00Z" },
    };
    await syncMobileSubscription(user.id, billingId); await syncMobileSubscription(user.id, billingId);
    const state = await readMobileBillingState(user.id, "app_store");
    assert.equal(state.plan, "Pro"); assert.equal(state.expiresAt, expiry);
  } finally { globalThis.fetch = originalFetch; }
});

test("a stale sync returns committed verification state and subscription admission rechecks it under lock", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  let release!: (response: Response) => void; let entered!: () => void;
  const firstRead = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<Response>((resolve) => { release = resolve; });
  const originalFetch = globalThis.fetch; let reads = 0;
  globalThis.fetch = async () => {
    if (++reads === 1) { entered(); return blocked; }
    return Response.json({ subscriber: { subscriptions: { "pro.month": { store: "app_store", is_sandbox: false, store_transaction_id: randomUUID(), expires_date: "2099-01-01T00:00:00Z" } } } });
  };
  try {
    const older = syncMobileSubscription(user.id, billingId); await firstRead;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await syncMobileSubscription(user.id, billingId);
    release(Response.json({ subscriber: { subscriptions: {} } }));
    assert.equal((await older).verificationPending, true);
    assert.equal((await readMobileBillingState(user.id, "app_store")).verificationPending, true);
    await assert.rejects(prepareMobileSubscriptionPurchase(user.id, "app_store", "pro.month"), /Wait for store verification/);
    await prisma.user.update({ where: { id: user.id }, data: { storeSubscriptionVerificationPending: false, storeSubscriptionSyncedAt: new Date(Date.now() + 60_000) } });
    assert.equal((await syncMobileSubscription(user.id, billingId)).verificationPending, true);
    assert.equal((await readMobileBillingState(user.id, "app_store")).verificationPending, true, "an old unbound observation may tighten the gate but cannot grant access");
  } finally { release(Response.json({ subscriber: { subscriptions: {} } })); globalThis.fetch = originalFetch; }
});

test("credit pack plan eligibility is server-authorized before payment and survives a delayed plan change", async () => {
  const user = await createUser();
  await assert.rejects(prepareMobileCreditPurchase(user.id, "app_store", "credits1500"), /not available/);
  const unauthorizedId = randomUUID();
  await deliver(user.id, { product_id: "credits1500", transaction_id: unauthorizedId });
  await deliver(user.id, { product_id: "credits1500", transaction_id: unauthorizedId });
  const withheld = await prisma.mobileStoreTransaction.findFirstOrThrow({ where: { userId: user.id, transactionId: unauthorizedId } });
  assert.equal(withheld.needsReview, true);
  await ensureMobileBillingId(user.id);
  assert.equal((await readMobileBillingState(user.id, "app_store")).creditPurchasesNeedingReview, 1);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 0);
  await prisma.user.update({ where: { id: user.id }, data: { plan: "Pro" } });
  await assert.rejects(prepareMobileCreditPurchase(user.id, "app_store", "credits1500"), /previous store credit payment/);
  await deliver(user.id, { product_id: "credits1500", transaction_id: unauthorizedId, type: "CANCELLATION" });
  await prepareMobileCreditPurchase(user.id, "app_store", "credits1500");
  await prisma.user.update({ where: { id: user.id }, data: { plan: "Free" } });
  const purchase = { product_id: "credits1500", purchased_at_ms: Date.now() };
  await Promise.all([deliver(user.id, purchase), deliver(user.id, purchase)]);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 1500);
  await deliver(user.id, { ...purchase, transaction_id: randomUUID() });
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 1500);
  await deliver(user.id, { ...purchase, type: "CANCELLATION" });
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 0);
  await assert.rejects(deliver(user.id, { product_id: "unmapped" }), /Unmapped/);
});

test("independent approvals let sequential same-SKU purchases complete before any webhook and tolerate reverse delivery", async () => {
  const user = await createUser();
  await prepareMobileCreditPurchase(user.id, "app_store", "credits500");
  const first = { transaction_id: randomUUID(), purchased_at_ms: Date.now() };
  const second = { transaction_id: randomUUID(), purchased_at_ms: Date.now() + 1000 };
  assert.equal(await prisma.mobileStorePurchaseAuthorization.count({ where: { userId: user.id } }), 2);
  await deliver(user.id, second); await deliver(user.id, first); await deliver(user.id, second);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 1000);
  assert.equal(await prisma.mobileStoreTransaction.count({ where: { userId: user.id, needsReview: true } }), 0);
  assert.equal(await prisma.mobileStorePurchaseAuthorization.count({ where: { userId: user.id } }), 0);
});

test("reverse delivery of purchases twenty hours apart uses the most recent matching approval", async () => {
  const user = await createUser(); const firstTime = Date.now() - 21 * 3600000;
  await prisma.mobileStorePurchaseAuthorization.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(firstTime) } });
  await prepareMobileCreditPurchase(user.id, "app_store", "credits500");
  await deliver(user.id, { transaction_id: randomUUID(), purchased_at_ms: Date.now() });
  await deliver(user.id, { transaction_id: randomUUID(), purchased_at_ms: firstTime + 3600000 });
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 1000);
  assert.equal(await prisma.mobileStoreTransaction.count({ where: { userId: user.id, needsReview: true } }), 0);
  await prisma.mobileStorePurchaseAuthorization.create({ data: { userId: user.id, store: "app_store", productId: "credits500", createdAt: new Date(Date.now() - 32 * 86400000) } });
  await prepareMobileCreditPurchase(user.id, "app_store", "credits500");
  assert.equal(await prisma.mobileStorePurchaseAuthorization.count({ where: { userId: user.id } }), 1);
});

test("expired authorizations retain paid purchases for support without granting credits", async () => {
  const user = await createUser();
  await prisma.mobileStorePurchaseAuthorization.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 172800000) } });
  await deliver(user.id, { purchased_at_ms: Date.now() });
  const paid = await prisma.mobileStoreTransaction.findFirstOrThrow({ where: { userId: user.id } });
  assert.equal(paid.needsReview, true);
  assert.equal((await getPurchasedCreditSummary(user.id)).remainingCredits, 0);
  await deliver(user.id, { type: "CANCELLATION", purchased_at_ms: Date.now() });
  assert.equal((await prisma.mobileStoreTransaction.findUniqueOrThrow({ where: { id: paid.id } })).needsReview, false);
});

test("account export includes store purchases and pending approvals while withholding receipt and authorization identifiers", async () => {
  const user = await createUser(); await deliver(user.id);
  await prepareMobileCreditPurchase(user.id, "app_store", "credits500");
  const authorization = await prisma.mobileStorePurchaseAuthorization.findFirstOrThrow({ where: { userId: user.id } });
  const { buildAccountDataExport } = await import("@/lib/accountDataExport");
  const result = await buildAccountDataExport(user.id);
  const serialized = JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  assert.match(serialized, /store_credit_purchases/); assert.match(serialized, /pending_store_credit_purchases/);
  assert.match(serialized, /credits500/);
  assert.equal(serialized.includes(event.transaction_id), false);
  assert.equal(serialized.includes(authorization.id), false);
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
test("each paid store stays manageable and an overlapping lower tier survives the higher tier's expiry", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const appleTransaction = `apple-${user.id}`; const playTransaction = `play-${user.id}`;
  await bindSubscription(billingId, appleTransaction);
  await bindSubscription(billingId, playTransaction, "PLAY_STORE", "play.max:monthly");
  const expires = new Date(Date.now() + 86400000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ subscriber: { subscriptions: {
    "pro.month": { store: "app_store", is_sandbox: false, store_transaction_id: appleTransaction, expires_date: "2099-01-01T00:00:00Z" },
    "play.max:monthly": { store: "play_store", is_sandbox: false, store_transaction_id: playTransaction, expires_date: expires.toISOString() },
  } } });
  try {
    await syncMobileSubscription(user.id, billingId);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Max");
    const state = await readMobileBillingState(user.id, "app_store");
    assert.equal(state.storeSubscriptions?.length, 2);
    assert.equal(effectivePlanForAccess(account, new Date(expires.getTime() + 1000)), "Pro");
  } finally { globalThis.fetch = originalFetch; }
});
test("a refunded tier is revoked even when the remaining store receipt is unbound or owned by another account", async () => {
  const user = await createUser(); const billingId = await ensureMobileBillingId(user.id);
  const appleTransaction = `apple-refund-${user.id}`; await bindSubscription(billingId, appleTransaction);
  const playTransaction = `play-pending-${user.id}`;
  const play = { store: "play_store", is_sandbox: false, store_transaction_id: playTransaction, expires_date: "2099-01-01T00:00:00Z" };
  const apple = { store: "app_store", is_sandbox: false, store_transaction_id: appleTransaction, expires_date: "2099-01-01T00:00:00Z" };
  let subscriptions: Record<string, unknown> = { "pro.month": apple, "play.max:monthly": play };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ subscriber: { subscriptions } });
  try {
    await syncMobileSubscription(user.id, billingId);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan, "Pro");
    subscriptions = { "play.max:monthly": play };
    const result = await syncMobileSubscription(user.id, billingId);
    assert.equal(result.verificationPending, true);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan, "Free");
    subscriptions = { "pro.month": apple }; await syncMobileSubscription(user.id, billingId);
    const other = await createUser("other"); const otherBillingId = await ensureMobileBillingId(other.id);
    await bindSubscription(otherBillingId, playTransaction, "PLAY_STORE", "play.max:monthly");
    subscriptions = { "play.max:monthly": play };
    await assert.rejects(syncMobileSubscription(user.id, billingId), /another account/);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan, "Free");
  } finally { globalThis.fetch = originalFetch; }
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
  const transactionId = `store-${user.id}`; await bindSubscription(billingId, transactionId);
  const originalFetch = globalThis.fetch;
  let subscriptions = { "pro.month": { store: "app_store", is_sandbox: false, store_transaction_id: transactionId, expires_date: "2099-01-01T00:00:00Z", unsubscribe_detected_at: "2026-10-25T00:00:00Z" } } as Record<string, unknown>;
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
  const transactionId = `store-${user.id}`; await bindSubscription(billingId, transactionId);
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
      store: "app_store", is_sandbox: false, store_transaction_id: transactionId, expires_date: "2099-01-01T00:00:00Z",
    } } } }));
    await mobile;
    const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(current.plan, "Pro"); assert.equal(current.subscriptionStore, "app_store");
    assert.equal(current.stripeSubscriptionId, subscription.id);
    // The earlier mobile response must not reclaim a paid web subscription.
    assert.equal(current.subscriptionStatus, "active");
  } finally { retrieve.mock.restore(); globalThis.fetch = originalFetch; }
});

test("deleting an account cannot make its paid consumable reusable by a new account", async () => {
  const first = await createUser(); const firstBilling = await ensureMobileBillingId(first.id);
  await deliver(first.id, { app_user_id: firstBilling });
  await prisma.user.delete({ where: { id: first.id } });
  const second = await createUser("replacement"); const secondBilling = await ensureMobileBillingId(second.id);
  await assert.rejects(deliver(second.id, { app_user_id: secondBilling }), /another account/);
  assert.equal((await getPurchasedCreditSummary(second.id)).remainingCredits, 0);
});
test("subscription access waits for a webhook and a transferred receipt cannot move after account deletion", async () => {
  const first = await createUser(); const firstBilling = await ensureMobileBillingId(first.id);
  const transactionId = `subscription-${first.id}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ subscriber: { subscriptions: { "pro.month": {
    store: "app_store", is_sandbox: false, store_transaction_id: transactionId, expires_date: "2099-01-01T00:00:00Z",
  } } } });
  try {
    await syncMobileSubscription(first.id, firstBilling);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: first.id } })).plan, "Free");
    await processMobileStoreWebhook({ ...event, type: "INITIAL_PURCHASE", product_id: "pro.month",
      app_user_id: firstBilling, transaction_id: transactionId, original_transaction_id: transactionId });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: first.id } })).plan, "Pro");
    await prisma.user.delete({ where: { id: first.id } });
    const second = await createUser("replacement"); const secondBilling = await ensureMobileBillingId(second.id);
    await assert.rejects(syncMobileSubscription(second.id, secondBilling), /another account/);
    await assert.rejects(processMobileStoreWebhook({ ...event, type: "RENEWAL", product_id: "pro.month",
      app_user_id: secondBilling, transaction_id: `${transactionId}-renewal`, original_transaction_id: transactionId }), /another account/);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).plan, "Free");
  } finally { globalThis.fetch = originalFetch; }
});

test("checkout completing after a store purchase stays recorded and cancellable, and web deletion preserves store access", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_local_mock_only";
  const user = await createUser(); await ensureMobileBillingId(user.id);
  const checkoutId = `cs_mobile_overlap_${user.id}`;
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
      id: checkoutId, subscription: subscription.id, amount_total: 1500, currency: "usd",
      created: Math.floor(Date.now() / 1000), metadata: {},
    } } } as unknown as Stripe.Event);
    let account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(account.plan, "Max"); assert.equal(account.stripeSubscriptionId, subscription.id);
    assert.equal(account.webSubscriptionPlan, "Pro");
    assert.equal(await prisma.billingTransaction.count({ where: { userId: user.id, stripeCheckoutSessionId: checkoutId } }), 1);
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
