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
import { sendRefundRequestReceivedEmail } from "@/lib/billingEmails";
import { prisma } from "@/lib/prisma";

const refundRequestSchema = z
  .object({
    reason: z.string().trim().max(1_000).optional(),
  })
  .strict();

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
        { error: "Only paid plans can request cancellation or refund review." },
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

    const refundRequest = await prisma.refundRequest.create({
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

    await sendRefundRequestReceivedEmail({
      to: user.email,
      plan: user.plan,
      requestId: refundRequest.id,
      language: user.settings?.language,
    }).catch((error) => {
      console.error("Refund request received email failed:", error);
    });

    return NextResponse.json({
      success: true,
      requestId: refundRequest.id,
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
