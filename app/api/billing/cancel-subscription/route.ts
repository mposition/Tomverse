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
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
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
 * After a resume write -- answered or not -- make sure an account that has
 * meanwhile been scheduled for deletion ends with its cancellation back on.
 *
 * Runs on the failure path too: a timed-out write may still have been applied
 * at Stripe, and the deletion flow's own re-assert may already be behind it.
 * Putting the cancellation back is a different write (and idempotent), not a
 * retry of the resume. Anything that leaves the outcome unknown is raised as
 * an operational incident for a person to read back at Stripe.
 */
async function restoreCancellationIfDeletionPending(
  userId: string,
  subscriptionId: string,
  resumeOutcome: "applied" | "unknown"
): Promise<boolean> {
  const after = await prisma.user.findUnique({
    where: { id: userId },
    select: { accountStatus: true },
  });
  if (after?.accountStatus !== "pending_deletion") return false;
  try {
    await getStripe().subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
    return true;
  } catch (error) {
    await reportOperationalIncident({
      code: "BILLING_RESUME_RENEWAL_DELETION_CONFLICT",
      title: "Renewal resume raced an account deletion and the cancellation could not be restored",
      error,
      severity: "error",
      context: {
        component: "billing-resume-renewal",
        userId,
        subscriptionId,
        resumeOutcome,
      },
    }).catch(() => {});
    throw error;
  }
}

/**
 * Undo a scheduled cancellation: the subscription renews again on its current
 * plan. It is its own control with its own label -- a plan change never does
 * this as a side effect (docs/policy/plan-change.md section 1) -- and it is the
 * step the plan-change refusal PLAN_CHANGE_BLOCKED_BY_CANCELLATION tells the
 * customer to take first.
 *
 * Refused while an account deletion is pending: the deletion scheduled the
 * cancellation itself, and renewing underneath it would charge an account that
 * asked to leave. (A refund request does not cancel anything on its own --
 * approval settles the subscription -- so it is not a reason to refuse.)
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
    // Decided on the subscription as Stripe has it now, not on the stored
    // flag, which a missed webhook can leave stale.
    const stripe = getStripe();
    const current = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    // Status first: a canceled or unpaid subscription reports
    // cancel_at_period_end false too, and "renewal is on" would be untrue.
    if (!RESUMABLE_STATUSES.has(current.status)) {
      return NextResponse.json(
        {
          code: "SUBSCRIPTION_NOT_CHANGEABLE",
          error: `A subscription in status "${current.status}" cannot be renewed here.`,
        },
        { status: 409 }
      );
    }
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

    // A deletion may land between the check above and this write. Account
    // deletion schedules the cancellation at Stripe, records pending_deletion,
    // then re-asserts the cancellation (lib/accountDeletion.ts); this route
    // re-reads the account after its own write, answered or not. Between the
    // two of them the cancellation always wins.
    const subscriptionId = user.stripeSubscriptionId;
    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      });
    } catch (resumeError) {
      // The resume's own failure is what this request reports; a failed
      // restore has already raised its incident and is only logged here.
      await restoreCancellationIfDeletionPending(user.id, subscriptionId, "unknown").catch(
        (restoreError) => {
          console.error("billing.subscription.resume_restore_failed", {
            userId: user.id,
            errorName: restoreError instanceof Error ? restoreError.name : "UnknownError",
          });
        }
      );
      throw resumeError;
    }

    if (await restoreCancellationIfDeletionPending(user.id, subscriptionId, "applied")) {
      await prisma.user.update({
        where: { id: user.id },
        data: { subscriptionCancelAtPeriodEnd: true, subscriptionStatus: subscription.status },
      });
      return NextResponse.json(
        { code: "ACCOUNT_DELETION_PENDING", error: "The account is scheduled for deletion." },
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
