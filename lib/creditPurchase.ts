import "server-only";

import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { getCreditPack } from "@/lib/creditPacks";
import { prisma } from "@/lib/prisma";
import {
  analyticsAttributionFromMetadata,
  recordProductAnalyticsEvent,
} from "@/lib/productAnalyticsServer";

const stripeId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id || null;

const addDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

export async function grantCreditPackFromCheckout(
  session: Stripe.Checkout.Session
) {
  if (session.metadata?.purchaseType !== "credit_pack") return false;
  if (session.payment_status !== "paid") return false;

  const userId = session.client_reference_id || session.metadata.userId;
  const pack = getCreditPack(session.metadata.packId || "");
  if (!userId || !pack) throw new Error("Invalid credit-pack checkout metadata.");
  if (
    session.amount_total !== pack.priceCents ||
    session.currency?.toUpperCase() !== pack.currency
  ) {
    throw new Error("Credit-pack checkout amount did not match the server price.");
  }

  const paymentIntentId = stripeId(session.payment_intent);
  const purchasedAt = new Date((session.created || Math.floor(Date.now() / 1000)) * 1000);
  const expiresAt = addDays(purchasedAt, pack.validityDays);
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.creditPurchase.findUnique({
        where: { stripeCheckoutSessionId: session.id },
        select: { id: true },
      });
      if (existing) return;

      const purchase = await tx.creditPurchase.create({
        data: {
          userId,
          packId: pack.id,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          creditsPurchased: pack.credits,
          fundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd),
          amountPaidCents: pack.priceCents,
          currency: pack.currency,
          purchasedAt,
          expiresAt,
          status: "paid",
        },
      });
      const lot = await tx.creditLot.create({
        data: {
          userId,
          purchaseId: purchase.id,
          source: "add_on",
          originalCredits: pack.credits,
          remainingCredits: pack.credits,
          originalFundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd),
          remainingFundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd),
          expiresAt,
        },
      });
      await tx.creditLedgerEntry.create({
        data: {
          userId,
          creditLotId: lot.id,
          purchaseId: purchase.id,
          type: "purchase",
          creditsDelta: pack.credits,
          fundedCostMicroUsdDelta: BigInt(pack.fundedCostMicroUsd),
          balanceAfterCredits: pack.credits,
          balanceAfterFundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd),
          metadata: {
            packId: pack.id,
            stripeCheckoutSessionId: session.id,
          },
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
  const attribution = analyticsAttributionFromMetadata(session.metadata);
  if (attribution) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    const planId = user?.plan === "Max" ? "max" : user?.plan === "Pro" ? "pro" : "free";
    await recordProductAnalyticsEvent({
      eventName: "purchase_completed",
      source: "server",
      userId,
      attribution,
      modelCount: 0,
      plan: user?.plan || "Free",
      properties: {
        plan_id: planId,
        value: pack.priceCents / 100,
        currency: "USD",
        transaction_id: session.id,
      },
      dedupeKey: `stripe-credit-pack:${session.id}`,
      sendToGa4: true,
    }).catch((error) => {
      console.warn("Credit-pack purchase analytics failed.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }
  return true;
}

async function revokePurchaseBalance({
  paymentIntentId,
  chargeId,
  refundedAmountCents,
  disputed,
}: {
  paymentIntentId?: string | null;
  chargeId?: string | null;
  refundedAmountCents?: number;
  disputed?: boolean;
}) {
  const purchase = await prisma.creditPurchase.findFirst({
    where: {
      OR: [
        ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
        ...(chargeId ? [{ stripeChargeId: chargeId }] : []),
      ],
    },
  });
  if (!purchase) return false;

  const refundAmount = disputed
    ? purchase.amountPaidCents
    : Math.min(purchase.amountPaidCents, Math.max(0, refundedAmountCents || 0));
  const targetCredits = Math.floor(
    (purchase.creditsPurchased * refundAmount) / purchase.amountPaidCents
  );
  const targetCost =
    (purchase.fundedCostMicroUsd * BigInt(refundAmount)) /
    BigInt(purchase.amountPaidCents);
  const creditsToRevoke = Math.max(0, targetCredits - purchase.revokedCredits);
  const costToRevoke =
    targetCost > purchase.revokedCostMicroUsd
      ? targetCost - purchase.revokedCostMicroUsd
      : BigInt(0);

  await prisma.$transaction(async (tx) => {
    const lots = await tx.creditLot.findMany({
      where: { purchaseId: purchase.id },
      orderBy: { createdAt: "desc" },
    });
    let creditsLeft = creditsToRevoke;
    let costLeft = costToRevoke;
    let creditsRevoked = 0;
    let costRevoked = BigInt(0);
    for (const lot of lots) {
      const removeCredits = Math.min(creditsLeft, lot.remainingCredits);
      const removeCost = costLeft < lot.remainingFundedCostMicroUsd
        ? costLeft
        : lot.remainingFundedCostMicroUsd;
      if (removeCredits <= 0 && removeCost <= 0) continue;
      const updated = await tx.creditLot.update({
        where: { id: lot.id },
        data: {
          remainingCredits: { decrement: removeCredits },
          remainingFundedCostMicroUsd: { decrement: removeCost },
          status:
            removeCredits === lot.remainingCredits &&
            removeCost === lot.remainingFundedCostMicroUsd
              ? disputed
                ? "disputed"
                : "refunded"
              : lot.status,
        },
      });
      await tx.creditLedgerEntry.create({
        data: {
          userId: purchase.userId,
          creditLotId: lot.id,
          purchaseId: purchase.id,
          type: disputed ? "chargeback" : "payment_refund",
          creditsDelta: -removeCredits,
          fundedCostMicroUsdDelta: -removeCost,
          balanceAfterCredits: updated.remainingCredits,
          balanceAfterFundedCostMicroUsd: updated.remainingFundedCostMicroUsd,
          metadata: { refundedAmountCents: refundAmount },
        },
      });
      creditsLeft -= removeCredits;
      costLeft -= removeCost;
      creditsRevoked += removeCredits;
      costRevoked += removeCost;
    }
    await tx.creditPurchase.update({
      where: { id: purchase.id },
      data: {
        stripeChargeId: chargeId || purchase.stripeChargeId,
        refundedAmountCents: Math.max(purchase.refundedAmountCents, refundAmount),
        revokedCredits: { increment: creditsRevoked },
        revokedCostMicroUsd: { increment: costRevoked },
        status: disputed
          ? "disputed"
          : refundAmount >= purchase.amountPaidCents
            ? "refunded"
            : "partially_refunded",
      },
    });
  });
  return true;
}

export const handleCreditPackRefund = (charge: Stripe.Charge) =>
  revokePurchaseBalance({
    chargeId: charge.id,
    paymentIntentId: stripeId(charge.payment_intent),
    refundedAmountCents: charge.amount_refunded,
  });

export const handleCreditPackDispute = (dispute: Stripe.Dispute) =>
  revokePurchaseBalance({
    chargeId: stripeId(dispute.charge),
    paymentIntentId: stripeId(dispute.payment_intent),
    disputed: true,
  });
