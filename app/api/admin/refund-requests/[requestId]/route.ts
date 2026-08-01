export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  AdminApprovalRequiredError,
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { refundApprovalThresholdCents } from "@/lib/adminApprovalCore";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import {
  NOTIFICATION_KIND,
  deliverNotificationNow,
  enqueueNotificationDelivery,
} from "@/lib/notificationDeliveries";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

/**
 * Queues the decision email and makes the first attempt inline.
 *
 * Both decisions used to `.catch(console.error)`, so a customer whose refund
 * was approved or rejected could simply never be told. The row is written
 * first, so a failed send is retried rather than lost.
 */
const notifyRefundDecision = async (
  requestId: string,
  kind: "refundRequestApproved" | "refundRequestRejected"
) => {
  const notificationKind = NOTIFICATION_KIND[kind];
  const delivery = await prisma.$transaction((tx) =>
    enqueueNotificationDelivery(tx, {
      kind: notificationKind,
      referenceId: requestId,
    })
  );
  await deliverNotificationNow({
    deliveryId: delivery.id,
    kind: notificationKind,
    referenceId: requestId,
  });
};

const updateRefundRequestSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    adminNote: z.string().trim().max(1_000).optional(),
    confirmCreditReview: z.boolean().optional(),
  })
  .strict();

type RouteContext = {
  params: Promise<{ requestId: string }>;
};

async function cancelStripeSubscription(subscriptionId: string | null) {
  if (!subscriptionId || !isStripeConfigured()) return;
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch (error) {
    console.error("Stripe subscription cancellation failed:", error);
  }
}

async function createStripeRefundForSubscription(
  subscriptionId: string | null,
  approval?: {
    session: Session;
    request: Request;
    requestId: string;
    payload: Record<string, unknown>;
    reason: string;
  }
) {
  if (!subscriptionId || !isStripeConfigured()) {
    return {
      stripeRefundId: null,
      stripeRefundStatus: null,
      stripeChargeId: null,
      refundAmountCents: null,
      refundCurrency: null,
    };
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["latest_invoice.payment_intent"],
  });
  const latestInvoice = subscription.latest_invoice;
  const invoice =
    typeof latestInvoice === "string"
      ? await stripe.invoices.retrieve(latestInvoice, {
          expand: ["payment_intent"],
        })
      : latestInvoice;

  const paymentIntent = (invoice as { payment_intent?: string | { id?: string } } | null)
    ?.payment_intent;
  const paymentIntentId =
    typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
  if (!paymentIntentId) {
    return {
      stripeRefundId: null,
      stripeRefundStatus: "no_payment_intent",
      stripeChargeId: null,
      refundAmountCents: null,
      refundCurrency: null,
    };
  }

  const charges = await stripe.charges.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  const charge = charges.data[0];
  if (!charge || charge.amount_refunded >= charge.amount) {
    return {
      stripeRefundId: null,
      stripeRefundStatus: charge ? "already_refunded" : "no_charge",
      stripeChargeId: charge?.id || null,
      refundAmountCents: 0,
      refundCurrency: charge?.currency?.toUpperCase() || null,
    };
  }

  const amount = charge.amount - charge.amount_refunded;
  const createRefund = async () => {
    if (approval) {
      await writeAdminAuditLog({
        session: approval.session,
        request: approval.request,
        action: "refund.execution_started",
        targetType: "RefundRequest",
        targetId: approval.requestId,
        summary: `Started Stripe refund for ${approval.requestId}.`,
        metadata: { amount, currency: charge.currency.toUpperCase(), chargeId: charge.id },
      });
    }
    return stripe.refunds.create({
      charge: charge.id,
      amount,
      reason: "requested_by_customer",
      metadata: {
        tomverseRefundRequest: "true",
        subscriptionId,
      },
    });
  };
  const refund =
    approval &&
    amount >= refundApprovalThresholdCents(process.env.ADMIN_REFUND_APPROVAL_THRESHOLD_CENTS)
      ? await runWithAdminApproval(
          {
            session: approval.session,
            request: approval.request,
            action: "refund.approve",
            targetType: "RefundRequest",
            targetId: approval.requestId,
            payload: {
              ...approval.payload,
              refundAmountCents: amount,
              refundCurrency: charge.currency.toUpperCase(),
              stripeChargeId: charge.id,
            },
            reason: approval.reason,
          },
          createRefund
        )
      : await createRefund();

  return {
    stripeRefundId: refund.id,
    stripeRefundStatus: refund.status || "pending",
    stripeChargeId: charge.id,
    refundAmountCents: amount,
    refundCurrency: charge.currency.toUpperCase(),
  };
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-refund-update", {
      minute: 10,
      day: 100,
    });

    const { requestId } = await context.params;
    const body = await readLimitedJson(req, 4 * 1024, updateRefundRequestSchema);
    const refundRequest = await prisma.refundRequest.findUnique({
      where: { id: requestId },
    });

    if (!refundRequest) {
      return NextResponse.json(
        { error: "Refund request not found." },
        { status: 404 }
      );
    }
    if (refundRequest.status !== "pending") {
      return NextResponse.json(
        { error: "Refund request has already been reviewed." },
        { status: 409 }
      );
    }

    // The recipient's language is no longer looked up here: the notification
    // queue re-renders the decision email from the stored request at send
    // time, and reads the language from the same place a retry would.
    const creditReview = refundRequest.userId
      ? await prisma.user.findUnique({
          where: { id: refundRequest.userId },
          select: {
            creditDebtCredits: true,
            creditDebtCostMicroUsd: true,
            billingRiskStatus: true,
            _count: { select: { creditPurchases: true } },
          },
        })
      : null;

    if (body.action === "approve") {
      if (
        (creditReview?._count.creditPurchases || 0) > 0 ||
        (creditReview?.creditDebtCredits || 0) > 0
      ) {
        if (!body.confirmCreditReview) {
          return NextResponse.json(
            {
              error:
                "Review the purchased credit balance and consumed AI cost before approving this refund.",
            },
            { status: 400 }
          );
        }
      }
      let stripeRefund;
      try {
        stripeRefund = await createStripeRefundForSubscription(
          refundRequest.stripeSubscriptionId,
          {
            session,
            request: req,
            requestId: refundRequest.id,
            payload: body,
            reason:
              body.adminNote ||
              `Approve refund request ${refundRequest.id}.`,
          }
        );
      } catch (error) {
        if (error instanceof AdminApprovalRequiredError) throw error;
        console.error("Stripe refund creation failed:", error);
        await writeAdminAuditLog({
          session,
          request: req,
          action: "refund.approve_failed",
          targetType: "RefundRequest",
          targetId: refundRequest.id,
          summary: `Stripe refund failed for ${refundRequest.email || "unknown customer"}.`,
          metadata: {
            plan: refundRequest.plan,
            stripeCustomerId: refundRequest.stripeCustomerId,
            stripeSubscriptionId: refundRequest.stripeSubscriptionId,
          },
        });
        return NextResponse.json(
          { error: "Stripe refund failed. The request was not approved." },
          { status: 502 }
        );
      }

      await cancelStripeSubscription(refundRequest.stripeSubscriptionId);
      const updated = await prisma.$transaction(async (tx) => {
        const request = await tx.refundRequest.update({
          where: { id: refundRequest.id },
          data: {
            status: "approved",
            adminNote: body.adminNote || null,
            reviewedByUserId: session.user.id,
            reviewedAt: new Date(),
            stripeRefundId: stripeRefund.stripeRefundId,
            stripeRefundStatus: stripeRefund.stripeRefundStatus,
            stripeChargeId: stripeRefund.stripeChargeId,
            refundAmountCents: stripeRefund.refundAmountCents,
            refundCurrency: stripeRefund.refundCurrency,
          },
          include: {
            timelineEvents: {
              orderBy: { createdAt: "asc" },
            },
          },
        });
        if (stripeRefund.stripeRefundId && refundRequest.stripeSubscriptionId) {
          await tx.billingTransaction.updateMany({
            where: {
              stripeSubscriptionId: refundRequest.stripeSubscriptionId,
            },
            data: { status: "refunded" },
          });
        }

        const event = await tx.refundRequestTimelineEvent.create({
          data: {
            refundRequestId: refundRequest.id,
            actorUserId: session.user.id,
            actorEmail: session.user.email || null,
            eventType: "approved",
            message: "Refund request approved. User membership was reset to Free.",
            metadata: {
              stripeRefundId: stripeRefund.stripeRefundId,
              stripeRefundStatus: stripeRefund.stripeRefundStatus,
              refundAmountCents: stripeRefund.refundAmountCents,
              creditReviewConfirmed: Boolean(body.confirmCreditReview),
              creditPurchaseCount: creditReview?._count.creditPurchases || 0,
              creditDebtCredits: creditReview?.creditDebtCredits || 0,
              creditDebtCostMicroUsd: Number(
                creditReview?.creditDebtCostMicroUsd || BigInt(0)
              ),
              billingRiskStatus: creditReview?.billingRiskStatus || "normal",
            },
          },
        });

        if (refundRequest.userId) {
          await tx.user.update({
            where: { id: refundRequest.userId },
            data: {
              plan: "Free",
              stripeCustomerId: null,
              stripeSubscriptionId: null,
              stripePriceId: null,
              subscriptionStatus: "cancelled_by_admin",
              subscriptionCurrentPeriodEnd: null,
              subscriptionBillingInterval: null,
            },
          });
        }

        return {
          ...request,
          timelineEvents: [...request.timelineEvents, event],
        };
      });

      await writeAdminAuditLog({
        session,
        request: req,
        action: "refund.approved",
        targetType: "RefundRequest",
        targetId: updated.id,
        summary: `Approved refund request for ${updated.email || "unknown customer"}.`,
        metadata: {
          plan: updated.plan,
          stripeCustomerId: updated.stripeCustomerId,
          stripeSubscriptionId: updated.stripeSubscriptionId,
          stripeRefundId: updated.stripeRefundId,
          refundAmountCents: updated.refundAmountCents,
          creditReviewConfirmed: Boolean(body.confirmCreditReview),
          creditPurchaseCount: creditReview?._count.creditPurchases || 0,
          creditDebtCredits: creditReview?.creditDebtCredits || 0,
          creditDebtCostMicroUsd: Number(
            creditReview?.creditDebtCostMicroUsd || BigInt(0)
          ),
        },
      });

      await notifyRefundDecision(updated.id, "refundRequestApproved");

      return NextResponse.json({ success: true, refundRequest: updated });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const request = await tx.refundRequest.update({
        where: { id: refundRequest.id },
        data: {
          status: "rejected",
          adminNote: body.adminNote || null,
          reviewedByUserId: session.user.id,
          reviewedAt: new Date(),
        },
        include: {
          timelineEvents: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
      const event = await tx.refundRequestTimelineEvent.create({
        data: {
          refundRequestId: refundRequest.id,
          actorUserId: session.user.id,
          actorEmail: session.user.email || null,
          eventType: "rejected",
          message: "Refund request rejected.",
          metadata: {
            adminNote: body.adminNote || null,
          },
        },
      });
      return {
        ...request,
        timelineEvents: [...request.timelineEvents, event],
      };
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "refund.rejected",
      targetType: "RefundRequest",
      targetId: updated.id,
      summary: `Rejected refund request for ${updated.email || "unknown customer"}.`,
      metadata: {
        plan: updated.plan,
        stripeCustomerId: updated.stripeCustomerId,
        stripeSubscriptionId: updated.stripeSubscriptionId,
      },
    });

    await notifyRefundDecision(updated.id, "refundRequestRejected");

    return NextResponse.json({ success: true, refundRequest: updated });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Refund request update failed:", error);
    return NextResponse.json(
      { error: "Failed to update refund request." },
      { status: 500 }
    );
  }
}
