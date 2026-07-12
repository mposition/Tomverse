export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  sendRefundRequestApprovedEmail,
  sendRefundRequestRejectedEmail,
} from "@/lib/billingEmails";
import { prisma } from "@/lib/prisma";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

const updateRefundRequestSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    adminNote: z.string().trim().max(1_000).optional(),
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

async function createStripeRefundForSubscription(subscriptionId: string | null) {
  if (!subscriptionId || !isStripeConfigured()) {
    return {
      stripeRefundId: null,
      stripeRefundStatus: null,
      stripeChargeId: null,
      refundAmountCents: null,
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
    };
  }

  const amount = charge.amount - charge.amount_refunded;
  const refund = await stripe.refunds.create({
    charge: charge.id,
    amount,
    reason: "requested_by_customer",
    metadata: {
      tomverseRefundRequest: "true",
      subscriptionId,
    },
  });

  return {
    stripeRefundId: refund.id,
    stripeRefundStatus: refund.status || "pending",
    stripeChargeId: charge.id,
    refundAmountCents: amount,
  };
}

export async function PATCH(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
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

    const userSettings = refundRequest.userId
      ? await prisma.userSettings.findUnique({
          where: { userId: refundRequest.userId },
          select: { language: true },
        })
      : null;

    if (body.action === "approve") {
      let stripeRefund;
      try {
        stripeRefund = await createStripeRefundForSubscription(
          refundRequest.stripeSubscriptionId
        );
      } catch (error) {
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

        return request;
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
        },
      });

      await sendRefundRequestApprovedEmail({
        to: updated.email,
        plan: updated.plan,
        requestId: updated.id,
        adminNote: updated.adminNote,
        language: userSettings?.language,
      }).catch((error) => {
        console.error("Refund approval email failed:", error);
      });

      return NextResponse.json({ success: true, refundRequest: updated });
    }

    const updated = await prisma.refundRequest.update({
      where: { id: refundRequest.id },
      data: {
        status: "rejected",
        adminNote: body.adminNote || null,
        reviewedByUserId: session.user.id,
        reviewedAt: new Date(),
      },
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

    await sendRefundRequestRejectedEmail({
      to: updated.email,
      plan: updated.plan,
      requestId: updated.id,
      adminNote: updated.adminNote,
      language: userSettings?.language,
    }).catch((error) => {
      console.error("Refund rejection email failed:", error);
    });

    return NextResponse.json({ success: true, refundRequest: updated });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Refund request update failed:", error);
    return NextResponse.json(
      { error: "Failed to update refund request." },
      { status: 500 }
    );
  }
}
