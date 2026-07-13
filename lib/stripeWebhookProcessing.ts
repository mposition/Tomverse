import "server-only";

import type Stripe from "stripe";
import { getBillingPlans, tierForPlanId, type BillingPlanId } from "@/lib/billingConfig";
import { sendBillingWelcomeEmail } from "@/lib/billingEmails";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import {
  analyticsAttributionFromMetadata,
  recordProductAnalyticsEvent,
} from "@/lib/productAnalyticsServer";

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
  subscriptionId: string
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

  await prisma.$transaction(async (tx) => {
    const promotion = await tx.billingPromotion.findUnique({
      where: { id: promotionId },
      select: { id: true, isActive: true, maxRedemptions: true },
    });

    if (!promotion?.isActive) {
      throw new Error("Promotion is not active.");
    }

    const existing = await tx.billingPromotionRedemption.findUnique({
      where: { stripeCheckoutSessionId: session.id },
      select: { id: true },
    });
    if (existing) return;

    await tx.billingPromotionRedemption.create({
      data: {
        promotionId,
        userId,
        planId,
        billingInterval,
        stripeCheckoutSessionId: session.id,
        stripeSubscriptionId: subscriptionId,
      },
    });

    const updatedPromotion = await tx.billingPromotion.updateMany({
      where: {
        id: promotionId,
        isActive: true,
        ...(promotion.maxRedemptions
          ? { redeemedCount: { lt: promotion.maxRedemptions } }
          : {}),
      },
      data: { redeemedCount: { increment: 1 } },
    });

    if (updatedPromotion.count !== 1) {
      throw new Error("Promotion redemption limit reached.");
    }
  });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (!session.subscription) return;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  await recordPromotionRedemptionFromCheckout(session, subscriptionId).catch((error) => {
    console.error("Promotion redemption record failed:", error);
  });
  const synced = await syncSubscription(subscription);
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
    const value = Number(session.metadata?.analyticsValue);
    await recordProductAnalyticsEvent({
      eventName: "purchase_completed",
      source: "server",
      userId: synced.user.id,
      attribution: analytics,
      modelCount: 0,
      plan: synced.plan,
      properties: {
        billing_interval: synced.billingInterval || "monthly",
        plan_id:
          synced.plan === "Max" ? "max" : synced.plan === "Pro" ? "pro" : "free",
        value: Number.isFinite(value) && value >= 0 ? value : 0,
        currency: "USD",
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
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
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
