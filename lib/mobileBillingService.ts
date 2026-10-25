import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCreditPack } from "@/lib/creditPacks";
import { getBillingPlans } from "@/lib/billingConfig";
import { getPurchasedCreditSummary } from "@/lib/creditLedger";
import { increaseCreditDebt, lockCreditAccount, offsetCreditDebt } from "@/lib/creditDebt";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";
import { getStripe } from "@/lib/stripe";
import { resyncSubscriptionFromStripe } from "@/lib/stripeWebhookProcessing";
import { lockSubscriptionAccount } from "@/lib/subscriptionEntitlements";
import { assertMobileOwnershipConfigured, claimMobileStoreOwnership, mobileStoreOwnerHash, mobileStoreTransactionHash, storeOwnershipRefusal } from "@/lib/mobileStoreOwnership";
import {
  mobileBillingEnvironment, parseMobileBillingProducts, resolveMobileSubscriptions, mobileStoreSnapshotSchema,
  type MobileBillingState, type MobileStore, type revenueCatWebhookSchema,
} from "@/lib/mobileBillingCore";
import type { z } from "zod";

export const mobileBillingProducts = () => parseMobileBillingProducts(process.env.MOBILE_BILLING_PRODUCTS_JSON);

export async function ensureMobileBillingId(userId: string) {
  // CAS prevents two first-launch requests from registering different identities.
  await prisma.user.updateMany({ where: { id: userId, mobileBillingId: null }, data: { mobileBillingId: randomUUID() } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mobileBillingId: true } });
  if (!user.mobileBillingId) throw new Error("Mobile billing identity unavailable.");
  return user.mobileBillingId;
}

async function readRevenueCatCustomer(billingId: string) {
  const key = process.env.REVENUECAT_SECRET_API_KEY;
  if (!key) throw new Error("Mobile billing is not configured.");
  const response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(billingId)}`, {
    headers: { Authorization: `Bearer ${key}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return { subscriber: { subscriptions: {} } };
  if (!response.ok) throw new Error("Store verification unavailable.");
  return response.json() as Promise<unknown>;
}

export async function syncMobileSubscription(userId: string, billingId: string) {
  assertMobileOwnershipConfigured();
  const products = mobileBillingProducts();
  // Timestamp before HTTP; stale responses cannot replace newer provider state.
  const observedAt = new Date();
  const candidates = resolveMobileSubscriptions(await readRevenueCatCustomer(billingId), products, mobileBillingEnvironment());
  const owned: typeof candidates = [];
  let ownershipConflict = false;
  for (const candidate of candidates) {
    if (!candidate.transactionId) throw new Error("Store transaction evidence is incomplete.");
    const ownership = await prisma.mobileStoreOwnership.findUnique({ where: {
      store_environment_transactionHash: { store: candidate.store, environment: mobileBillingEnvironment(), transactionHash: mobileStoreTransactionHash(candidate.transactionId) },
    } });
    if (!ownership) continue;
    if (ownership.ownerHash !== mobileStoreOwnerHash(billingId) || ownership.kind !== "subscription") { ownershipConflict = true; continue; }
    owned.push(candidate);
  }
  const verificationPending = candidates.length > owned.length;
  const current = owned[0] || null;
  await prisma.$transaction(async (tx) => {
    await lockSubscriptionAccount(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mobileBillingId !== billingId) throw new Error("Billing identity changed.");
    if (user.storeSubscriptionSyncedAt && user.storeSubscriptionSyncedAt > observedAt) return;
    const data = {
      webSubscriptionPlan: user.webSubscriptionPlan ?? user.plan,
      subscriptionStore: current?.store || null, subscriptionStoreProductId: current?.productId || null,
      storeSubscriptionPlan: current?.plan || "Free", storeSubscriptionExpiresAt: current?.expiresAt || null,
      storeSubscriptionBillingInterval: current?.interval || null,
      storeSubscriptionCancelAtPeriodEnd: current?.cancelAtPeriodEnd || false, storeSubscriptionSyncedAt: observedAt,
      storeSubscriptionSnapshot: owned.map(({ store, productId, plan, interval, expiresAt, cancelAtPeriodEnd }) =>
        ({ store, productId, plan, interval, expiresAt: expiresAt.toISOString(), cancelAtPeriodEnd })),
    };
    await tx.user.update({ where: { id: userId }, data: { ...data, plan: effectivePlanForAccess({ ...user, ...data, plan: data.webSubscriptionPlan }) } });
  });
  // Revoke absent/refunded rights even when another receipt is not yet bound
  // or has a different owner. A refusal must never preserve an old paid tier.
  if (!owned.length && ownershipConflict) throw storeOwnershipRefusal();
  return { verificationPending };
}

export async function readMobileBillingState(userId: string, store: MobileStore): Promise<MobileBillingState> {
  const [user, summary, plans] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }), getPurchasedCreditSummary(userId), getBillingPlans(),
  ]);
  if (!user.mobileBillingId) throw new Error("Billing identity unavailable.");
  const plan = effectivePlanForAccess(user);
  const snapshots = mobileStoreSnapshotSchema.array().max(30).safeParse(user.storeSubscriptionSnapshot || []);
  const stores = snapshots.success ? snapshots.data.filter((entry) => new Date(entry.expiresAt) > new Date()) : [];
  const native = stores[0];
  const subscriptionStore = native?.store || (user.subscriptionStore === "app_store" || user.subscriptionStore === "play_store" ? user.subscriptionStore : null);
  const nativeActive = Boolean(native || (subscriptionStore && user.storeSubscriptionExpiresAt && user.storeSubscriptionExpiresAt > new Date()));
  const webActive = Boolean(user.stripeSubscriptionId && ["active", "trialing", "past_due"].includes(user.subscriptionStatus || ""));
  const active = nativeActive || webActive;
  return {
    billingId: user.mobileBillingId, plan, subscriptionStore: nativeActive ? subscriptionStore : webActive ? "web" : null,
    productId: native?.productId || user.subscriptionStoreProductId,
    interval: native?.interval || (nativeActive ? user.storeSubscriptionBillingInterval : user.subscriptionBillingInterval),
    expiresAt: native?.expiresAt || (nativeActive ? user.storeSubscriptionExpiresAt : user.subscriptionCurrentPeriodEnd)?.toISOString() || null,
    cancelAtPeriodEnd: native?.cancelAtPeriodEnd ?? (nativeActive ? user.storeSubscriptionCancelAtPeriodEnd : user.subscriptionCancelAtPeriodEnd),
    storeSubscriptions: stores,
    webSubscription: { active: webActive, cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd, expiresAt: user.subscriptionCurrentPeriodEnd?.toISOString() || null },
    active, purchasedCredits: summary.remainingCredits,
    products: mobileBillingProducts().filter((p) => p.store === store).flatMap<MobileBillingState["products"][number]>((p) => {
      if (p.kind === "credits") {
        const pack = getCreditPack(p.packId);
        return pack?.allowedPlans.includes(plan) ? [{ ...p, credits: pack.credits }] : [];
      }
      const config = plans.find((candidate) => candidate.tier === p.plan && candidate.isActive);
      return config ? [{ ...p, monthlyCredits: config.monthlyMessageLimit, maxModels: config.maxModels }] : [];
    }),
  };
}

export async function cancelMobileWebSubscription(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.stripeSubscriptionId) throw new Error("No web subscription to cancel.");
  // Idempotent update: retries never create a charge or restore auto-renewal.
  const subscription = await getStripe().subscriptions.retrieve(user.stripeSubscriptionId);
  if (subscription.status !== "canceled" && !subscription.cancel_at_period_end) {
    await getStripe().subscriptions.update(user.stripeSubscriptionId, { cancel_at_period_end: true });
  }
  await resyncSubscriptionFromStripe(user.stripeSubscriptionId);
}

type StoreEvent = z.infer<typeof revenueCatWebhookSchema>["event"];

/** Verified webhook only; the client cannot choose a quantity, owner or price. */
export async function applyMobileCreditEvent(tx: Prisma.TransactionClient, userId: string, event: StoreEvent) {
  const store: MobileStore = event.store === "APP_STORE" ? "app_store" : "play_store";
  const product = mobileBillingProducts().find((p) => p.store === store && p.productId === event.product_id);
  if (!product || product.kind !== "credits") return;
  if (event.type !== "NON_RENEWING_PURCHASE" && event.type !== "CANCELLATION") return;
  const pack = getCreditPack(product.packId);
  if (!pack) throw new Error("Unknown credit pack.");
  await claimMobileStoreOwnership(tx, event);
  const where = { store_environment_transactionId: { store, environment: event.environment, transactionId: event.transaction_id } };
  const existing = await tx.mobileStoreTransaction.findUnique({ where });
  if (existing && existing.userId !== userId) {
    throw storeOwnershipRefusal();
  }
  // A cancellation tombstone also handles refund-before-purchase delivery.
  if (existing?.refunded || (existing && event.type === "NON_RENEWING_PURCHASE")) return;
  const purchase = existing || await tx.mobileStoreTransaction.create({ data: {
    userId, store, environment: event.environment, transactionId: event.transaction_id, productId: event.product_id,
    packId: pack.id, credits: pack.credits, fundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd),
    purchasedAt: new Date(event.purchased_at_ms), refunded: event.type === "CANCELLATION",
  } });
  if (event.type === "CANCELLATION") {
    if (purchase.creditLotId) {
      const lot = await tx.creditLot.findUniqueOrThrow({ where: { id: purchase.creditLotId } });
      await tx.creditLot.update({ where: { id: lot.id }, data: { status: "refunded", remainingCredits: 0, remainingFundedCostMicroUsd: BigInt(0) } });
      await tx.creditLedgerEntry.create({ data: {
        userId, creditLotId: lot.id, type: "payment_refund", creditsDelta: -lot.remainingCredits,
        fundedCostMicroUsdDelta: -lot.remainingFundedCostMicroUsd, balanceAfterCredits: 0, balanceAfterFundedCostMicroUsd: BigInt(0),
        metadata: { mobileStoreTransactionId: purchase.id },
      } });
      await increaseCreditDebt(tx, { userId, credits: purchase.credits - lot.remainingCredits,
        fundedCostMicroUsd: purchase.fundedCostMicroUsd - lot.remainingFundedCostMicroUsd, type: "refund_unrecovered",
        metadata: { mobileStoreTransactionId: purchase.id } });
    }
    await tx.mobileStoreTransaction.update({ where: { id: purchase.id }, data: { refunded: true } });
    return;
  }
  const offset = await offsetCreditDebt(tx, { userId, availableCredits: pack.credits,
    availableFundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd), type: "purchase_offset", metadata: { mobileStoreTransactionId: purchase.id } });
  const credits = pack.credits - offset.offsetCredits;
  const cost = BigInt(pack.fundedCostMicroUsd) - offset.offsetFundedCostMicroUsd;
  const lot = await tx.creditLot.create({ data: {
    userId, source: "mobile_store_purchase", originalCredits: pack.credits, remainingCredits: credits,
    originalFundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd), remainingFundedCostMicroUsd: cost,
    // The flag, rather than this compatibility date, controls expiry everywhere.
    nonExpiring: true, expiresAt: new Date("9999-12-31T00:00:00Z"),
  } });
  await tx.mobileStoreTransaction.update({ where: { id: purchase.id }, data: { creditLotId: lot.id } });
  await tx.creditLedgerEntry.create({ data: { userId, creditLotId: lot.id, type: "purchase", creditsDelta: credits,
    fundedCostMicroUsdDelta: cost, balanceAfterCredits: credits, balanceAfterFundedCostMicroUsd: cost,
    metadata: { mobileStoreTransactionId: purchase.id, debtOffsetCredits: offset.offsetCredits } } });
}

export async function processMobileStoreWebhook(event: StoreEvent) {
  // Retain the one-owner tombstone even if account deletion beat delivery.
  await prisma.$transaction((tx) => claimMobileStoreOwnership(tx, event));
  const user = await prisma.user.findUnique({ where: { mobileBillingId: event.app_user_id }, select: { id: true } });
  if (!user) {
    // IDs are issued before the SDK can purchase. An unknown ID cannot become
    // valid on retry (e.g. account deletion); never remap its store receipt.
    console.warn("Unlinked mobile store notification ignored.");
    return;
  }
  await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, user.id);
    await applyMobileCreditEvent(tx, user.id, event);
  });
  await syncMobileSubscription(user.id, event.app_user_id);
}
