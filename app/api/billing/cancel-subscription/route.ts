export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type Stripe from "stripe";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { analyticsAttributionSchema } from "@/lib/productAnalyticsShared";
import {
  analyticsCountryFromHeaders,
  recordProductAnalyticsEvent,
} from "@/lib/productAnalyticsServer";

const cancelSubscriptionSchema = z
  .object({ analytics: analyticsAttributionSchema.optional() })
  .strict();

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
    const body = await readLimitedJson(
      req,
      4 * 1024,
      cancelSubscriptionSchema
    );

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
        subscriptionBillingInterval: true,
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

    const edgeCountry = analyticsCountryFromHeaders(req.headers);
    const trustedAnalytics = body.analytics
      ? {
          ...body.analytics,
          country: edgeCountry === "ZZ" ? body.analytics.country : edgeCountry,
        }
      : null;
    const subscription = await getStripe().subscriptions.update(
      user.stripeSubscriptionId,
      {
        cancel_at_period_end: true,
        ...(trustedAnalytics
          ? {
              metadata: {
                analyticsClientId: trustedAnalytics.client_id,
                analyticsSessionId: trustedAnalytics.session_id,
                analyticsUtmSource: trustedAnalytics.utm_source,
                analyticsUtmMedium: trustedAnalytics.utm_medium,
                analyticsUtmCampaign: trustedAnalytics.utm_campaign,
                analyticsLanguage: trustedAnalytics.language,
                analyticsCountry: trustedAnalytics.country,
              },
            }
          : {}),
      }
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

    if (trustedAnalytics) {
      await recordProductAnalyticsEvent({
        eventName: "subscription_cancelled",
        source: "server",
        userId: user.id,
        attribution: trustedAnalytics,
        modelCount: 0,
        plan: user.plan,
        properties: {
          billing_interval:
            user.subscriptionBillingInterval === "annual" ? "annual" : "monthly",
          plan_id: user.plan === "Max" ? "max" : "pro",
          transaction_id: subscription.id,
        },
        dedupeKey: `stripe-subscription-cancel-request:${subscription.id}`,
        sendToGa4: true,
      }).catch((analyticsError) => {
        console.warn("Subscription cancellation analytics failed.", {
          errorName:
            analyticsError instanceof Error
              ? analyticsError.name
              : "UnknownError",
        });
      });
    }

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
