export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  NOTIFICATION_KIND,
  deliverNotificationNow,
  enqueueNotificationDelivery,
} from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";

const refundRequestSchema = z
  .object({
    reason: z.string().trim().max(1_000).optional(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-refund-status", {
      minute: 30,
      day: 500,
    });

    const pendingRequest = await prisma.refundRequest.findFirst({
      where: { userId: session.user.id, status: "pending" },
      orderBy: { requestedAt: "desc" },
      select: {
        id: true,
        status: true,
        requestedAt: true,
      },
    });

    return NextResponse.json({
      pendingRequest: pendingRequest
        ? {
            id: pendingRequest.id,
            status: pendingRequest.status,
            requestedAt: pendingRequest.requestedAt.toISOString(),
          }
        : null,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Refund status failed:", error);
    return NextResponse.json(
      { error: "Failed to load refund request status." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    await consumeApiRateLimit(req, session.user.id, "billing-refund-request", {
      minute: 3,
      day: 10,
    });

    const body = await readLimitedJson(req, 4 * 1024, refundRequestSchema);
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        email: true,
        plan: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        settings: {
          select: { language: true },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    if (user.plan !== "Pro" && user.plan !== "Max") {
      return NextResponse.json(
        { error: "Only paid plans can request refund review." },
        { status: 400 }
      );
    }

    const existingPending = await prisma.refundRequest.findFirst({
      where: { userId: user.id, status: "pending" },
      select: { id: true },
    });
    if (existingPending) {
      return NextResponse.json(
        { error: "A refund request is already pending." },
        { status: 409 }
      );
    }

    // The request and the receipt we owe the user commit together: a failed
    // send used to be a console line and nothing else, so the customer was
    // left with no confirmation that their refund request had been recorded.
    const { refundRequest, delivery } = await prisma.$transaction(async (tx) => {
      const refundRequest = await tx.refundRequest.create({
        data: {
          userId: user.id,
          email: user.email,
          plan: user.plan,
          stripeCustomerId: user.stripeCustomerId,
          stripeSubscriptionId: user.stripeSubscriptionId,
          subscriptionStatus: user.subscriptionStatus,
          subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd,
          subscriptionBillingInterval: user.subscriptionBillingInterval,
          reason: body.reason || null,
        },
      });
      const delivery = await enqueueNotificationDelivery(tx, {
        kind: NOTIFICATION_KIND.refundRequestReceived,
        referenceId: refundRequest.id,
      });
      return { refundRequest, delivery };
    });

    await deliverNotificationNow({
      deliveryId: delivery.id,
      kind: NOTIFICATION_KIND.refundRequestReceived,
      referenceId: refundRequest.id,
    });

    return NextResponse.json({
      success: true,
      requestId: refundRequest.id,
      requestedAt: refundRequest.requestedAt.toISOString(),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Refund request failed:", error);
    return NextResponse.json(
      { error: "Failed to submit refund request." },
      { status: 500 }
    );
  }
}
