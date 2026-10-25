import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCreditPack } from "@/lib/creditPacks";
import { getBillingPlans } from "@/lib/billingConfig";
import { getPurchasedCreditSummary } from "@/lib/creditLedger";
import { increaseCreditDebt, lockCreditAccount, offsetCreditDebt } from "@/lib/creditDebt";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";
import { getStripe } from "@/lib/stripe";
import { resyncSubscriptionFromStripe } from "@/lib/stripeWebhookProcessing";
import { lockSubscriptionAccount } from "@/lib/subscriptionEntitlements";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { assertMobileOwnershipConfigured, claimMobileStoreOwnership, mobileStoreOwnerHash, mobileStoreTransactionHash, storeOwnershipRefusal } from "@/lib/mobileStoreOwnership";
import {
  mobileBillingEnvironment, parseMobileBillingProducts, resolveMobileSubscriptions, mobileStoreSnapshotSchema, mobileSubscriptionAttemptSchema,
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
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Store verification unavailable.");
  return response.json() as Promise<unknown>;
}

export async function syncMobileSubscription(userId: string, billingId: string) {
  assertMobileOwnershipConfigured();
  const products = mobileBillingProducts();
  // Timestamp before HTTP; stale responses cannot replace newer provider state.
  const observedAt = new Date();
  const providerSnapshot = await readRevenueCatCustomer(billingId);
  const candidates = resolveMobileSubscriptions(providerSnapshot || { subscriber: { subscriptions: {} } }, products, mobileBillingEnvironment());
  const owned: typeof candidates = [];
  let ownershipConflict = false;
  const conflictingProducts = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.transactionId) continue;
    const ownership = await prisma.mobileStoreOwnership.findUnique({ where: {
      store_environment_transactionHash: { store: candidate.store, environment: mobileBillingEnvironment(), transactionHash: mobileStoreTransactionHash(candidate.transactionId) },
    } });
    if (!ownership) continue;
    if (ownership.ownerHash !== mobileStoreOwnerHash(billingId) || ownership.kind !== "subscription") {
      ownershipConflict = true; conflictingProducts.add(`${candidate.store}:${candidate.productId}`); continue;
    }
    owned.push(candidate);
  }
  const verificationPending = candidates.length > owned.length;
  const applied = await prisma.$transaction(async (tx) => {
    await lockSubscriptionAccount(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (!providerSnapshot && user.storeSubscriptionExpiresAt && user.storeSubscriptionExpiresAt > observedAt) throw new Error("Store customer lookup is temporarily unavailable.");
    if (user.mobileBillingId !== billingId) throw new Error("Billing identity changed.");
    if (user.storeSubscriptionSyncedAt && user.storeSubscriptionSyncedAt >= observedAt) {
      // Older/tied observations may tighten the payment gate, never reopen it.
      if (verificationPending && !user.storeSubscriptionVerificationPending) await tx.user.update({ where: { id: userId }, data: { storeSubscriptionVerificationPending: true } });
      return { verificationPending: user.storeSubscriptionVerificationPending || verificationPending, refused: false };
    }
    const prior = mobileStoreSnapshotSchema.array().safeParse(user.storeSubscriptionSnapshot || []);
    // A new, unbound renewal cannot extend access, but must not shorten the
    // already verified, unexpired period of the same store product.
    const retained = prior.success ? prior.data.filter((old) => new Date(old.expiresAt) > observedAt &&
      candidates.some((candidate) => candidate.store === old.store && candidate.productId === old.productId) &&
      !owned.some((candidate) => candidate.store === old.store && candidate.productId === old.productId) && !conflictingProducts.has(`${old.store}:${old.productId}`)) : [];
    const snapshots = [...owned.map(({ store, productId, plan, interval, expiresAt, cancelAtPeriodEnd }) =>
      ({ store, productId, plan, interval, expiresAt: expiresAt.toISOString(), cancelAtPeriodEnd })), ...retained]
      .sort((a, b) => (b.plan === "Max" ? 1 : 0) - (a.plan === "Max" ? 1 : 0));
    const primary = snapshots[0];
    const attempt = mobileSubscriptionAttemptSchema.safeParse(user.storeSubscriptionPurchaseAttempt);
    const verifiedAttempt = attempt.success && attempt.data.confirmed && owned.some((entry) => entry.store === attempt.data.store && entry.productId === attempt.data.productId);
    const data = {
      webSubscriptionPlan: user.webSubscriptionPlan ?? user.plan,
      subscriptionStore: primary?.store || null, subscriptionStoreProductId: primary?.productId || null,
      storeSubscriptionPlan: primary?.plan || "Free", storeSubscriptionExpiresAt: primary ? new Date(primary.expiresAt) : null,
      storeSubscriptionBillingInterval: primary?.interval || null,
      storeSubscriptionCancelAtPeriodEnd: primary?.cancelAtPeriodEnd || false, storeSubscriptionSyncedAt: observedAt,
      storeSubscriptionSnapshot: snapshots,
      storeSubscriptionVerificationPending: verificationPending,
      ...(verifiedAttempt ? { storeSubscriptionPurchaseAttempt: Prisma.JsonNull } : {}),
    };
    await tx.user.update({ where: { id: userId }, data: { ...data, plan: effectivePlanForAccess({ ...user, ...data, plan: data.webSubscriptionPlan }) } });
    return { verificationPending, refused: ownershipConflict && snapshots.length === 0 };
  });
  // Revoke absent/refunded rights even when another receipt is not yet bound
  // or has a different owner. A refusal must never preserve an old paid tier.
  if (applied.refused) throw storeOwnershipRefusal();
  return { verificationPending: applied.verificationPending };
}

export async function readMobileBillingState(userId: string, store: MobileStore): Promise<MobileBillingState> {
  const [user, summary, plans, creditPurchasesNeedingReview] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }), getPurchasedCreditSummary(userId), getBillingPlans(),
    prisma.mobileStoreTransaction.count({ where: { userId, needsReview: true, refunded: false } }),
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
    expiresAt: native?.expiresAt || (nativeActive ? user.storeSubscriptionExpiresAt : webActive ? user.subscriptionCurrentPeriodEnd : null)?.toISOString() || null,
    cancelAtPeriodEnd: native?.cancelAtPeriodEnd ?? (nativeActive ? user.storeSubscriptionCancelAtPeriodEnd : user.subscriptionCancelAtPeriodEnd),
    storeSubscriptions: stores,
    webSubscription: { active: webActive, cancelAtPeriodEnd: user.subscriptionCancelAtPeriodEnd, expiresAt: webActive ? user.subscriptionCurrentPeriodEnd?.toISOString() || null : null },
    active, purchasedCredits: summary.remainingCredits, creditPurchasesNeedingReview,
    verificationPending: user.storeSubscriptionVerificationPending,
    subscriptionPurchaseAttempt: mobileSubscriptionAttemptSchema.safeParse(user.storeSubscriptionPurchaseAttempt).success
      ? mobileSubscriptionAttemptSchema.parse(user.storeSubscriptionPurchaseAttempt) : null,
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

export async function prepareMobileSubscriptionPurchase(userId: string, store: MobileStore, productId: string) {
  const product = mobileBillingProducts().find((p) => p.store === store && p.productId === productId);
  if (!product || product.kind !== "subscription") throw new ApiSecurityError(400, "UNKNOWN_PRODUCT", "Unknown subscription.");
  await prisma.$transaction(async (tx) => {
    await lockSubscriptionAccount(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.storeSubscriptionVerificationPending) throw new ApiSecurityError(409, "SUBSCRIPTION_VERIFICATION_PENDING", "Wait for store verification before another purchase.");
    if (mobileSubscriptionAttemptSchema.safeParse(user.storeSubscriptionPurchaseAttempt).success) throw new ApiSecurityError(409, "SUBSCRIPTION_PURCHASE_PENDING", "Verify the previous store request before another subscription purchase.");
    const snapshots = mobileStoreSnapshotSchema.array().parse(user.storeSubscriptionSnapshot || []).filter((entry) => new Date(entry.expiresAt) > new Date());
    const native = snapshots[0];
    const rank = (plan: string) => plan === "Max" ? 2 : plan === "Pro" ? 1 : 0;
    const eligible = native ? native.store === store && !native.cancelAtPeriodEnd && native.interval === product.interval && native.plan !== product.plan
      : rank(product.plan) > rank(effectivePlanForAccess(user));
    if ((user.stripeSubscriptionId && ["active", "trialing", "past_due"].includes(user.subscriptionStatus || "")) || !eligible) throw new ApiSecurityError(409, "BILLING_PLAN_CHANGED", "Refresh the current subscription before purchasing.");
    await tx.user.update({ where: { id: userId }, data: { storeSubscriptionPurchaseAttempt: {
      id: randomUUID(), store, productId, startedAt: new Date().toISOString(),
    } } });
  });
}

export async function cancelMobileSubscriptionPurchase(userId: string, attemptId: string) {
  await prisma.$transaction(async (tx) => {
    await lockSubscriptionAccount(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const attempt = mobileSubscriptionAttemptSchema.safeParse(user.storeSubscriptionPurchaseAttempt);
    if (attempt.success && attempt.data.id === attemptId && !attempt.data.confirmed) {
      await tx.user.update({ where: { id: userId }, data: { storeSubscriptionPurchaseAttempt: Prisma.JsonNull } });
    }
  });
}

/** Authorize one credit purchase before opening the store payment sheet. */
export async function prepareMobileCreditPurchase(userId: string, store: MobileStore, productId: string) {
  const product = mobileBillingProducts().find((p) => p.store === store && p.productId === productId);
  const pack = product?.kind === "credits" ? getCreditPack(product.packId) : null;
  if (!pack) throw new Error("Unknown credit pack.");
  await prisma.$transaction(async (tx) => {
    await lockSubscriptionAccount(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (!pack.allowedPlans.includes(effectivePlanForAccess(user))) throw new ApiSecurityError(403, "PACK_NOT_AVAILABLE_FOR_PLAN", "Credit pack is not available for this plan.");
    if (await tx.mobileStoreTransaction.count({ where: { userId, needsReview: true, refunded: false } })) throw new Error("Resolve the previous store credit payment before purchasing again.");
    await tx.mobileStorePurchaseAuthorization.deleteMany({ where: { userId, createdAt: { lt: new Date(Date.now() - 31 * 86400000) } } });
    await tx.mobileStorePurchaseAuthorization.create({ data: { userId, store, productId } });
  });
}

/** Verified webhook only; the client cannot choose a quantity, owner or price. */
export async function applyMobileCreditEvent(tx: Prisma.TransactionClient, userId: string, event: StoreEvent) {
  const store: MobileStore = event.store === "APP_STORE" ? "app_store" : "play_store";
  const product = mobileBillingProducts().find((p) => p.store === store && p.productId === event.product_id);
  if (!product) throw new Error("Unmapped store product; configure the catalog before redelivery.");
  if (product.kind !== "credits") return;
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
  let authorized = false;
  if (!existing) {
    // A delayed/pending payment retains the plan authorization made before
    // its store sheet opened. Refunds and duplicate delivery need no new approval.
    const authorization = await tx.mobileStorePurchaseAuthorization.findFirst({
      where: { userId, store, productId: event.product_id, createdAt: {
        gte: new Date(event.purchased_at_ms - 86_400_000), lte: new Date(event.purchased_at_ms + 60_000),
      } },
      orderBy: { createdAt: "desc" },
    });
    if (authorization) {
      authorized = true;
      await tx.mobileStorePurchaseAuthorization.delete({ where: { id: authorization.id } });
    }
  }
  const purchase = existing || await tx.mobileStoreTransaction.create({ data: {
    userId, store, environment: event.environment, transactionId: event.transaction_id, productId: event.product_id,
    packId: pack.id, credits: pack.credits, fundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd),
    purchasedAt: new Date(event.purchased_at_ms), refunded: event.type === "CANCELLATION",
    needsReview: event.type === "NON_RENEWING_PURCHASE" && !authorized,
  } });
  if (event.type === "NON_RENEWING_PURCHASE" && purchase.needsReview) {
    console.error("Paid store credit purchase needs operator review; credits withheld.", { purchaseId: purchase.id, store, productId: event.product_id });
    return;
  }
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
    await tx.mobileStoreTransaction.update({ where: { id: purchase.id }, data: { refunded: true, needsReview: false } });
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
    await lockSubscriptionAccount(tx, user.id);
    const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    const attempt = mobileSubscriptionAttemptSchema.safeParse(current.storeSubscriptionPurchaseAttempt);
    if (attempt.success && attempt.data.productId === event.product_id &&
      attempt.data.store === (event.store === "APP_STORE" ? "app_store" : "play_store") &&
      ["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE"].includes(event.type) &&
      event.purchased_at_ms >= new Date(attempt.data.startedAt).getTime() - 60_000) {
      await tx.user.update({ where: { id: user.id }, data: { storeSubscriptionPurchaseAttempt: { ...attempt.data, confirmed: true } } });
    }
  });
  await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, user.id);
    await applyMobileCreditEvent(tx, user.id, event);
  });
  await syncMobileSubscription(user.id, event.app_user_id);
}
