export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { getBillingPlans, tierForPlanId, type BillingPlanId } from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

type RouteContext = {
  params: Promise<{ userId: string }>;
};

const activeStatuses = new Set(["active", "trialing", "past_due"]);

const normalizePlanId = (value: unknown): BillingPlanId | null =>
  value === "pro" || value === "max" || value === "free" ? value : null;

const subscriptionPeriodEnd = (subscription: unknown) => {
  const value = (subscription as { current_period_end?: number }).current_period_end;
  return typeof value === "number" ? new Date(value * 1000) : null;
};

const subscriptionInterval = (subscription: {
  items?: { data?: Array<{ price?: { recurring?: { interval?: string } | null } }> };
  metadata?: Record<string, string>;
}) => {
  const interval = subscription.items?.data?.[0]?.price?.recurring?.interval;
  if (interval === "year") return "annual";
  if (interval === "month") return "monthly";
  return subscription.metadata?.billingInterval === "annual" ? "annual" : "monthly";
};

export async function POST(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    if (!isStripeConfigured()) {
      return NextResponse.json({ error: "Stripe is not configured." }, { status: 503 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-user-billing-resync", {
      minute: 8,
      day: 80,
    });

    const { userId } = await context.params;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    if (!user.stripeCustomerId && !user.stripeSubscriptionId) {
      return NextResponse.json(
        { error: "User has no Stripe customer or subscription ID." },
        { status: 400 }
      );
    }

    const stripe = getStripe();
    const subscription = user.stripeSubscriptionId
      ? await stripe.subscriptions.retrieve(user.stripeSubscriptionId)
      : (
          await stripe.subscriptions.list({
            customer: user.stripeCustomerId || undefined,
            status: "all",
            limit: 1,
          })
        ).data[0];

    if (!subscription) {
      return NextResponse.json({ error: "No Stripe subscription found." }, { status: 404 });
    }

    const priceId = subscription.items.data[0]?.price.id || null;
    const plans = await getBillingPlans();
    const matchedPlan = priceId
      ? plans.find(
          (plan) =>
            plan.stripePriceId === priceId || plan.stripeAnnualPriceId === priceId
        )
      : null;
    const planId = normalizePlanId(subscription.metadata.planId) || matchedPlan?.id || "free";
    const plan = activeStatuses.has(subscription.status) ? tierForPlanId(planId) : "Free";
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        plan,
        stripeCustomerId:
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id,
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        subscriptionStatus: subscription.status,
        subscriptionCurrentPeriodEnd: subscriptionPeriodEnd(subscription),
        subscriptionBillingInterval: subscriptionInterval(subscription),
        subscriptionCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      },
      select: {
        id: true,
        email: true,
        plan: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        subscriptionCancelAtPeriodEnd: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripePriceId: true,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "billing.resynced",
      targetType: "User",
      targetId: user.id,
      summary: `Resynced Stripe billing for ${user.email || user.id}.`,
      metadata: {
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        plan,
      },
    });

    return NextResponse.json({ success: true, user: updated });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin billing resync failed:", error);
    return NextResponse.json(
      { error: "Failed to resync Stripe billing." },
      { status: 500 }
    );
  }
}
