export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
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
      await cancelStripeSubscription(refundRequest.stripeSubscriptionId);
      const updated = await prisma.$transaction(async (tx) => {
        const request = await tx.refundRequest.update({
          where: { id: refundRequest.id },
          data: {
            status: "approved",
            adminNote: body.adminNote || null,
            reviewedByUserId: session.user.id,
            reviewedAt: new Date(),
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
