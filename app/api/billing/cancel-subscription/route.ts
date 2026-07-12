export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type Stripe from "stripe";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

const getPeriodEnd = (subscription: Stripe.Subscription) => {
  const value = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  return typeof value === "number" ? new Date(value * 1000) : null;
};

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-cancel-subscription", {
      minute: 3,
      day: 10,
    });

    if (!isStripeConfigured()) {
      return NextResponse.json(
        { error: "Stripe is not configured." },
        { status: 503 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        plan: true,
        stripeSubscriptionId: true,
        subscriptionCurrentPeriodEnd: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    if ((user.plan !== "Pro" && user.plan !== "Max") || !user.stripeSubscriptionId) {
      return NextResponse.json(
        { error: "No active Stripe subscription is available to cancel." },
        { status: 400 }
      );
    }

    const subscription = await getStripe().subscriptions.update(
      user.stripeSubscriptionId,
      { cancel_at_period_end: true }
    );
    const periodEnd = getPeriodEnd(subscription) || user.subscriptionCurrentPeriodEnd;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: subscription.status,
        subscriptionCurrentPeriodEnd: periodEnd,
        subscriptionCancelAtPeriodEnd: true,
      },
    });

    return NextResponse.json({
      success: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: periodEnd?.toISOString() || null,
      status: subscription.status,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Subscription cancellation failed:", error);
    return NextResponse.json(
      { error: "Failed to schedule subscription cancellation." },
      { status: 500 }
    );
  }
}
