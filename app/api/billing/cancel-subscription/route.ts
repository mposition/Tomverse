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

const RESUMABLE_STATUSES = new Set(["active", "trialing"]);

/**
 * Undo a scheduled cancellation: the subscription renews again on its current
 * plan. It is its own control with its own label -- a plan change never does
 * this as a side effect (docs/policy/plan-change.md section 1) -- and it is the
 * step the plan-change refusal PLAN_CHANGE_BLOCKED_BY_CANCELLATION tells the
 * customer to take first.
 *
 * Refused while an account deletion or a refund request is pending: both of
 * those scheduled the cancellation themselves, and renewing underneath them
 * would charge an account that asked to leave or to be refunded.
 */
export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { code: "AUTHENTICATION_REQUIRED", error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-resume-renewal", {
      minute: 3,
      day: 10,
    });

    if (!isStripeConfigured()) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured." },
        { status: 503 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        plan: true,
        accountStatus: true,
        stripeSubscriptionId: true,
        subscriptionCurrentPeriodEnd: true,
      },
    });
    if (!user) {
      return NextResponse.json(
        { code: "USER_NOT_FOUND", error: "User not found." },
        { status: 404 }
      );
    }
    if (!user.stripeSubscriptionId) {
      return NextResponse.json(
        { code: "NO_ACTIVE_SUBSCRIPTION", error: "No Stripe subscription to renew." },
        { status: 409 }
      );
    }
    if (user.accountStatus === "pending_deletion") {
      return NextResponse.json(
        { code: "ACCOUNT_DELETION_PENDING", error: "The account is scheduled for deletion." },
        { status: 409 }
      );
    }
    const pendingRefund = await prisma.refundRequest.findFirst({
      where: { userId: user.id, status: "pending" },
      select: { id: true },
    });
    if (pendingRefund) {
      return NextResponse.json(
        { code: "REFUND_REQUEST_PENDING", error: "A refund request is pending." },
        { status: 409 }
      );
    }

    // Decided on the subscription as Stripe has it now, not on the stored
    // flag, which a missed webhook can leave stale.
    const stripe = getStripe();
    const current = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    if (!current.cancel_at_period_end) {
      // Already renewing: nothing to undo, and saying so is idempotent. The
      // stored flag is corrected too -- a missed webhook would otherwise keep
      // showing a cancellation (and this button) after a reload.
      await prisma.user.update({
        where: { id: user.id },
        data: { subscriptionCancelAtPeriodEnd: false, subscriptionStatus: current.status },
      });
      return NextResponse.json({
        success: true,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: getPeriodEnd(current)?.toISOString() || null,
        status: current.status,
      });
    }
    if (!RESUMABLE_STATUSES.has(current.status)) {
      return NextResponse.json(
        {
          code: "SUBSCRIPTION_NOT_CHANGEABLE",
          error: `A subscription in status "${current.status}" cannot be renewed here.`,
        },
        { status: 409 }
      );
    }

    const subscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    // A deletion or refund request may have landed between the checks above
    // and this write. Account deletion schedules the cancellation at Stripe
    // and then records pending_deletion, and re-asserts the cancellation after
    // that record (lib/accountDeletion.ts), so between the two of them the
    // cancellation always wins: if the record is here now, put it back.
    const [after, refundAfter] = await Promise.all([
      prisma.user.findUnique({ where: { id: user.id }, select: { accountStatus: true } }),
      prisma.refundRequest.findFirst({
        where: { userId: user.id, status: "pending" },
        select: { id: true },
      }),
    ]);
    if (after?.accountStatus === "pending_deletion" || refundAfter) {
      try {
        await stripe.subscriptions.update(user.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
      } catch (revertError) {
        // The one state worth a page: renewal is on for an account that asked
        // to leave or to be refunded. Not retried blindly -- the outcome of
        // the write is unknown and is read back by whoever picks this up.
        console.error("billing.subscription.resume_revert_failed", {
          userId: user.id,
          subscriptionId: user.stripeSubscriptionId,
          errorName: revertError instanceof Error ? revertError.name : "UnknownError",
        });
        throw revertError;
      }
      return NextResponse.json(
        after?.accountStatus === "pending_deletion"
          ? { code: "ACCOUNT_DELETION_PENDING", error: "The account is scheduled for deletion." }
          : { code: "REFUND_REQUEST_PENDING", error: "A refund request is pending." },
        { status: 409 }
      );
    }

    const periodEnd = getPeriodEnd(subscription) || user.subscriptionCurrentPeriodEnd;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: subscription.status,
        subscriptionCurrentPeriodEnd: periodEnd,
        subscriptionCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      },
    });
    console.info("billing.subscription.renewal_resumed", {
      userId: user.id,
      subscriptionId: subscription.id,
    });

    return NextResponse.json({
      success: true,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      currentPeriodEnd: periodEnd?.toISOString() || null,
      status: subscription.status,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Subscription renewal resume failed:", error);
    return NextResponse.json(
      { code: "STRIPE_ERROR", error: "Failed to resume subscription renewal." },
      { status: 500 }
    );
  }
}
