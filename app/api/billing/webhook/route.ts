export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getBillingPlans, tierForPlanId, type BillingPlanId } from "@/lib/billingConfig";
import { sendBillingWelcomeEmail } from "@/lib/billingEmails";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";

const subscriptionActiveStatuses = new Set(["active", "trialing", "past_due"]);

const normalizePlanId = (value: unknown): BillingPlanId | null =>
  value === "pro" || value === "max" || value === "free" ? value : null;

const getPeriodEnd = (subscription: Stripe.Subscription) => {
  const value = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  return typeof value === "number" ? new Date(value * 1000) : null;
};

const getBillingInterval = (subscription: Stripe.Subscription) => {
  const interval = subscription.items.data[0]?.price.recurring?.interval;
  if (interval === "year") return "annual";
  if (interval === "month") return "monthly";
  const metadataInterval = subscription.metadata.billingInterval;
  return metadataInterval === "annual" || metadataInterval === "monthly"
    ? metadataInterval
    : null;
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
  const periodEnd = getPeriodEnd(subscription);
  const billingInterval = getBillingInterval(subscription);

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
    },
  });

  return { user, plan, periodEnd, billingInterval };
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (!session.subscription) return;
  const promotionId = session.metadata?.promotionId || null;
  if (promotionId) {
    await prisma.billingPromotion
      .update({
        where: { id: promotionId },
        data: { redeemedCount: { increment: 1 } },
      })
      .catch(() => undefined);
  }
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const synced = await syncSubscription(subscription);
  if (synced && synced.plan !== "Free") {
    sendBillingWelcomeEmail({
      to: synced.user.email,
      plan: synced.plan,
      billingInterval: synced.billingInterval,
      periodEnd: synced.periodEnd,
      language: synced.user.settings?.language,
    }).catch((emailError) => {
      console.error("Billing welcome email failed:", emailError);
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
    },
  });
}

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return NextResponse.json(
      { error: "Stripe webhook is not configured." },
      { status: 503 }
    );
  }

  let event: Stripe.Event;
  try {
    const rawBody = await req.text();
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("Invalid Stripe webhook signature:", error);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
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
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);
    return NextResponse.json(
      { error: "Webhook processing failed." },
      { status: 500 }
    );
  }
}
