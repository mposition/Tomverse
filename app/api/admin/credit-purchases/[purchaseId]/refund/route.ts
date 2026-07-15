export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { handleCreditPackRefund } from "@/lib/creditPurchase";
import { prisma } from "@/lib/prisma";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

const inputSchema = z
  .object({
    reason: z.string().trim().min(5).max(1_000),
    confirmReviewed: z.literal(true),
    confirmText: z.literal("REFUND CREDIT PURCHASE"),
    expectedRemainingCredits: z.number().int().min(0),
    expectedRemainingFundedCostMicroUsd: z.number().int().min(0),
  })
  .strict();

type RouteContext = {
  params: Promise<{ purchaseId: string }>;
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
      return NextResponse.json(
        { error: "Stripe is not configured." },
        { status: 503 }
      );
    }
    await consumeApiRateLimit(req, session.user.id, "admin-credit-refund", {
      minute: 5,
      day: 50,
    });

    const { purchaseId } = await context.params;
    const body = await readLimitedJson(req, 4 * 1024, inputSchema);
    const purchase = await prisma.creditPurchase.findUnique({
      where: { id: purchaseId },
      include: {
        user: { select: { email: true } },
        lots: {
          select: {
            remainingCredits: true,
            remainingFundedCostMicroUsd: true,
          },
        },
      },
    });
    if (!purchase) {
      return NextResponse.json(
        { error: "Credit purchase not found." },
        { status: 404 }
      );
    }
    if (purchase.status === "refunded" || purchase.status === "disputed") {
      return NextResponse.json(
        { error: "This purchase cannot be refunded in its current state." },
        { status: 409 }
      );
    }

    const remainingCredits = purchase.lots.reduce(
      (sum, lot) => sum + lot.remainingCredits,
      0
    );
    const remainingFundedCostMicroUsd = purchase.lots.reduce(
      (sum, lot) => sum + Number(lot.remainingFundedCostMicroUsd),
      0
    );
    if (
      remainingCredits !== body.expectedRemainingCredits ||
      remainingFundedCostMicroUsd !==
        body.expectedRemainingFundedCostMicroUsd
    ) {
      return NextResponse.json(
        {
          error:
            "Credit balance changed after review. Reload the customer and review the latest balance before refunding.",
        },
        { status: 409 }
      );
    }

    const stripe = getStripe();
    const charge = purchase.stripeChargeId
      ? await stripe.charges.retrieve(purchase.stripeChargeId)
      : purchase.stripePaymentIntentId
        ? (
            await stripe.charges.list({
              payment_intent: purchase.stripePaymentIntentId,
              limit: 1,
            })
          ).data[0]
        : null;
    if (!charge || charge.amount_refunded >= charge.amount) {
      return NextResponse.json(
        {
          error: charge
            ? "Stripe already reports this charge as fully refunded."
            : "No refundable Stripe charge was found.",
        },
        { status: 409 }
      );
    }
    if (charge.currency.toUpperCase() !== purchase.currency.toUpperCase()) {
      return NextResponse.json(
        {
          error:
            "Stripe charge currency does not match the original credit purchase. Refund was stopped for manual review.",
        },
        { status: 409 }
      );
    }

    const amount = charge.amount - charge.amount_refunded;
    const estimatedUsedCredits = Math.max(
      0,
      purchase.creditsPurchased - remainingCredits - purchase.revokedCredits
    );
    const estimatedConsumedCostMicroUsd = Math.max(
      0,
      Number(purchase.fundedCostMicroUsd) -
        remainingFundedCostMicroUsd -
        Number(purchase.revokedCostMicroUsd)
    );
    const refund = await stripe.refunds.create(
      {
        charge: charge.id,
        amount,
        reason: "requested_by_customer",
        metadata: {
          tomverseCreditPurchaseId: purchase.id,
          reviewedByUserId: session.user.id,
        },
      },
      { idempotencyKey: `credit-purchase-refund:${purchase.id}:remaining` }
    );

    const refreshedCharge = await stripe.charges.retrieve(charge.id);
    await handleCreditPackRefund(refreshedCharge);

    await writeAdminAuditLog({
      session,
      request: req,
      action: "credit_purchase.refunded",
      targetType: "CreditPurchase",
      targetId: purchase.id,
      summary: `Refunded additional credit purchase for ${purchase.user.email || purchase.userId}.`,
      metadata: {
        reason: body.reason,
        stripeRefundId: refund.id,
        stripeChargeId: charge.id,
        refundAmountCents: amount,
        refundCurrency: charge.currency.toUpperCase(),
        creditsPurchased: purchase.creditsPurchased,
        remainingCreditsReviewed: remainingCredits,
        estimatedUsedCredits,
        remainingFundedCostMicroUsdReviewed: remainingFundedCostMicroUsd,
        estimatedConsumedCostMicroUsd,
      },
    });

    const updated = await prisma.creditPurchase.findUniqueOrThrow({
      where: { id: purchase.id },
      select: {
        status: true,
        refundedAmountCents: true,
        revokedCredits: true,
        unrecoveredCredits: true,
        unrecoveredCostMicroUsd: true,
      },
    });
    return NextResponse.json({
      success: true,
      stripeRefundId: refund.id,
      purchase: {
        ...updated,
        unrecoveredCostMicroUsd: Number(updated.unrecoveredCostMicroUsd),
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin credit purchase refund failed:", error);
    return NextResponse.json(
      { error: "Failed to refund credit purchase." },
      { status: 500 }
    );
  }
}
