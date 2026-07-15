import "server-only";

import type Stripe from "stripe";
import { getBillingPlans, tierForPlanId, type BillingPlanId } from "@/lib/billingConfig";
import { sendBillingWelcomeEmail } from "@/lib/billingEmails";
import {
  encodePromotionRiskFlags,
  hashPaymentMethodFingerprint,
  parsePromotionRiskFlags,
  paymentMethodFingerprint,
  releasePromotionCheckout,
} from "@/lib/billingPromotionSecurity";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import {
  analyticsAttributionFromMetadata,
  recordProductAnalyticsEvent,
} from "@/lib/productAnalyticsServer";
import { purchaseAnalyticsFromMetadata } from "@/lib/purchaseAnalytics";
import {
  grantCreditPackFromCheckout,
  handleCreditPackDisputeClosed,
  handleCreditPackDispute,
  handleCreditPackDisputeReinstated,
  handleCreditPackRefund,
} from "@/lib/creditPurchase";
import {
  billingSnapshotFromCheckoutSession,
  recordBillingTransactionFromCheckout,
  type CheckoutBillingSnapshot,
} from "@/lib/billingTransactions";
import {
  billingMinorToMajor,
  normalizeBillingCurrency,
} from "@/lib/billingMarkets";
import { getUsdRevenueSnapshot } from "@/lib/billingPriceCatalog";

const subscriptionActiveStatuses = new Set(["active", "trialing", "past_due"]);

const normalizePlanId = (value: unknown): BillingPlanId | null =>
  value === "pro" || value === "max" || value === "free" ? value : null;

const getPeriodEnd = (subscription: Stripe.Subscription) => {
  const value = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  return typeof value === "number" ? new Date(value * 1000) : null;
};

const getBillingInterval = (
  subscription: Stripe.Subscription
): "monthly" | "annual" | null => {
  const interval = subscription.items.data[0]?.price.recurring?.interval;
  if (interval === "year") return "annual";
  if (interval === "month") return "monthly";
  const metadataInterval = subscription.metadata.billingInterval;
  return metadataInterval === "annual" || metadataInterval === "monthly"
    ? metadataInterval
    : null;
};

const addBillingPeriod = (
  date: Date,
  billingInterval: "monthly" | "annual" | null
) => {
  const next = new Date(date);
  if (billingInterval === "annual") {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
};

async function syncSubscription(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const priceId = subscription.items.data[0]?.price.id || null;
  const plans = await getBillingPlans();
  const planByPrice = priceId
    ? plans.find(
        (plan) =>
          plan.stripePriceId === priceId || plan.stripeAnnualPriceId === priceId
      )
    : null;
  const planId =
    normalizePlanId(subscription.metadata.planId) ||
    (planByPrice?.id ?? null);
  const active = subscriptionActiveStatuses.has(subscription.status);
  const plan = active && planId ? tierForPlanId(planId) : "Free";
  const billingInterval = getBillingInterval(subscription);
  const periodEnd =
    getPeriodEnd(subscription) || addBillingPeriod(new Date(), billingInterval);

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      email: true,
      settings: {
        select: { language: true },
      },
    },
  });
  if (!user) return null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      plan,
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      subscriptionStatus: subscription.status,
      subscriptionCurrentPeriodEnd: periodEnd,
      subscriptionBillingInterval: billingInterval,
      subscriptionCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    },
  });

  return { user, plan, periodEnd, billingInterval };
}

async function recordPromotionRedemptionFromCheckout(
  session: Stripe.Checkout.Session,
  subscriptionId: string,
  paymentMethodFingerprintHash: string | null
) {
  const promotionId = session.metadata?.promotionId || null;
  const planId = normalizePlanId(session.metadata?.planId);
  const billingInterval = session.metadata?.billingInterval;
  const userId =
    session.client_reference_id ||
    (typeof session.metadata?.userId === "string" ? session.metadata.userId : null);

  if (
    !promotionId ||
    !userId ||
    !planId ||
    (billingInterval !== "monthly" && billingInterval !== "annual")
  ) {
    return;
  }

  const clientIpHash = /^[a-f0-9]{64}$/.test(
    session.metadata?.promotionIpHash || ""
  )
    ? session.metadata?.promotionIpHash || null
    : null;
  const metadataRiskFlags = parsePromotionRiskFlags(
    session.metadata?.promotionRiskFlags
  );

  try {
    await prisma.$transaction(async (tx) => {
      const promotion = await tx.billingPromotion.findUnique({
        where: { id: promotionId },
        select: {
          id: true,
          isActive: true,
          maxRedemptions: true,
          startsAt: true,
          endsAt: true,
          appliesToPlanIds: true,
          allowAnnualStacking: true,
        },
      });
      const now = new Date();
      let eligiblePlanIds: unknown = [];
      try {
        eligiblePlanIds = JSON.parse(promotion?.appliesToPlanIds || "[]");
      } catch {
        eligiblePlanIds = [];
      }

      if (
        !promotion?.isActive ||
        !promotion.maxRedemptions ||
        !promotion.endsAt ||
        (promotion.startsAt && promotion.startsAt > now) ||
        promotion.endsAt <= now ||
        !Array.isArray(eligiblePlanIds) ||
        !eligiblePlanIds.includes(planId) ||
        (billingInterval === "annual" && !promotion.allowAnnualStacking)
      ) {
        throw new Error("Promotion policy is no longer redeemable.");
      }

      const existing = await tx.billingPromotionRedemption.findUnique({
        where: { stripeCheckoutSessionId: session.id },
        select: { id: true },
      });
      if (existing) return;

      const paymentMethodReuse = paymentMethodFingerprintHash
        ? await tx.billingPromotionRedemption.findFirst({
            where: {
              promotionId,
              paymentMethodFingerprintHash,
              userId: { not: userId },
            },
            select: { id: true },
          })
        : null;
      const riskFlags = new Set(metadataRiskFlags);
      if (paymentMethodReuse) riskFlags.add("shared_payment_method");

      const updatedPromotion = await tx.billingPromotion.updateMany({
        where: {
          id: promotionId,
          isActive: true,
          endsAt: { gt: now },
          redeemedCount: { lt: promotion.maxRedemptions },
        },
        data: { redeemedCount: { increment: 1 } },
      });

      if (updatedPromotion.count !== 1) {
        throw new Error("Promotion redemption limit reached.");
      }

      await tx.billingPromotionRedemption.create({
        data: {
          promotionId,
          userId,
          planId,
          billingInterval,
          stripeCheckoutSessionId: session.id,
          stripeSubscriptionId: subscriptionId,
          clientIpHash,
          paymentMethodFingerprintHash,
          riskFlags: encodePromotionRiskFlags(riskFlags),
        },
      });
    });
  } finally {
    await releasePromotionCheckout(promotionId, userId).catch(() => undefined);
  }
}

async function getSubscriptionPaymentMethodFingerprintHash(
  subscription: Stripe.Subscription
) {
  try {
    const stripe = getStripe();
    const value = subscription.default_payment_method;
    const paymentMethod =
      typeof value === "string"
        ? await stripe.paymentMethods.retrieve(value)
        : value && typeof value === "object"
          ? value
          : null;
    const fingerprint = paymentMethodFingerprint(paymentMethod);
    return fingerprint ? hashPaymentMethodFingerprint(fingerprint) : null;
  } catch (error) {
    console.warn("Promotion payment-method risk check skipped.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.metadata?.purchaseType === "credit_pack") {
    await grantCreditPackFromCheckout(session);
    return;
  }
  if (!session.subscription) return;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method"],
  });
  const paymentMethodFingerprintHash =
    await getSubscriptionPaymentMethodFingerprintHash(subscription);
  await recordPromotionRedemptionFromCheckout(
    session,
    subscriptionId,
    paymentMethodFingerprintHash
  ).catch((error) => {
    console.error("Promotion redemption record failed:", error);
  });
  const synced = await syncSubscription(subscription);
  let billingSnapshot: CheckoutBillingSnapshot | null = null;
  if (synced && session.amount_total !== null) {
    const legacyCurrency = normalizeBillingCurrency(session.currency);
    const signedBilling = session.metadata?.billingCurrency
      ? billingSnapshotFromCheckoutSession(session)
      : legacyCurrency
        ? {
            currency: legacyCurrency,
            country: "ZZ",
            expectedAmountMinor: session.amount_total,
            amountUsdMicroUsd:
              legacyCurrency === "USD"
                ? BigInt(session.amount_total) * BigInt(10_000)
                : BigInt(0),
            usdConversionRate: legacyCurrency === "USD" ? "1" : null,
            usdConversionSource: "legacy_checkout",
            pricingVersion: 1,
          }
        : null;
    if (signedBilling) {
      const paymentRevenueSnapshot = await getUsdRevenueSnapshot({
        amountMinor: signedBilling.expectedAmountMinor,
        currency: signedBilling.currency,
        fallbackUsdMinor: Number(
          signedBilling.amountUsdMicroUsd / BigInt(10_000)
        ),
      });
      billingSnapshot = {
        ...signedBilling,
        amountUsdMicroUsd: paymentRevenueSnapshot.amountUsdMicroUsd,
        usdConversionRate: paymentRevenueSnapshot.usdConversionRate,
        usdConversionSource: paymentRevenueSnapshot.source,
      };
    }
    if (billingSnapshot) {
      await recordBillingTransactionFromCheckout({
        db: prisma,
        session,
        userId: synced.user.id,
        productType: "subscription",
        productId: `subscription_${
          synced.plan === "Max" ? "max" : synced.plan === "Pro" ? "pro" : "free"
        }_${synced.billingInterval || "monthly"}`,
        billingInterval: synced.billingInterval || "monthly",
        snapshot: billingSnapshot,
      });
    }
  }
  if (synced && synced.plan !== "Free") {
    await sendBillingWelcomeEmail({
      to: synced.user.email,
      plan: synced.plan,
      billingInterval: synced.billingInterval,
      periodEnd: synced.periodEnd,
      language: synced.user.settings?.language,
    }).catch((emailError) => {
      console.error("Billing welcome email failed:", emailError);
    });
  }
  const analytics = analyticsAttributionFromMetadata(session.metadata);
  if (synced && analytics) {
    const completedPlanId =
      synced.plan === "Max" ? "max" : synced.plan === "Pro" ? "pro" : "free";
    const completedBillingInterval = synced.billingInterval || "monthly";
    const purchaseAnalytics = purchaseAnalyticsFromMetadata(session.metadata, {
      currentPlan: "free",
      productId: `subscription_${completedPlanId}_${completedBillingInterval}`,
      creditQuantity:
        synced.plan === "Max" ? 10_000 : synced.plan === "Pro" ? 3_000 : 300,
    });
    await recordProductAnalyticsEvent({
      eventName: "purchase_completed",
      source: "server",
      userId: synced.user.id,
      attribution: analytics,
      modelCount: 0,
      plan: synced.plan,
      properties: {
        billing_interval: completedBillingInterval,
        plan_id: completedPlanId,
        purchase_type: "subscription",
        product_id: purchaseAnalytics.productId,
        monthly_credits_included: purchaseAnalytics.creditQuantity,
        current_plan: purchaseAnalytics.currentPlan,
        trigger: purchaseAnalytics.trigger,
        plan_credits_remaining: purchaseAnalytics.planCreditsRemaining,
        addon_credits_remaining: purchaseAnalytics.addonCreditsRemaining,
        value: billingSnapshot
          ? billingMinorToMajor(
              billingSnapshot.expectedAmountMinor,
              billingSnapshot.currency
            )
          : 0,
        currency: billingSnapshot?.currency || "USD",
        transaction_id: session.id,
      },
      dedupeKey: `stripe-checkout:${session.id}`,
      sendToGa4: true,
    }).catch((analyticsError) => {
      console.warn("Stripe purchase analytics failed.", {
        errorName:
          analyticsError instanceof Error
            ? analyticsError.name
            : "UnknownError",
      });
    });
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  await prisma.user.updateMany({
    where: { stripeCustomerId: customerId },
    data: {
      plan: "Free",
      stripeSubscriptionId: null,
      stripePriceId: null,
      subscriptionStatus: subscription.status,
      subscriptionCurrentPeriodEnd: getPeriodEnd(subscription),
      subscriptionBillingInterval: null,
      subscriptionCancelAtPeriodEnd: false,
    },
  });
}

export async function processStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case "charge.refunded":
      await handleCreditPackRefund(event.data.object as Stripe.Charge);
      break;
    case "charge.dispute.created":
    case "charge.dispute.updated":
      await handleCreditPackDispute(event.data.object as Stripe.Dispute);
      break;
    case "charge.dispute.closed":
      await handleCreditPackDisputeClosed(event.data.object as Stripe.Dispute);
      break;
    case "charge.dispute.funds_reinstated":
      await handleCreditPackDisputeReinstated(
        event.data.object as Stripe.Dispute
      );
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await syncSubscription(event.data.object as Stripe.Subscription);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;
    default:
      break;
  }
}
