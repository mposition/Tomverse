import "server-only";

import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { getCreditPack } from "@/lib/creditPacks";
import {
  increaseCreditDebt,
  lockCreditAccount,
  offsetCreditDebt,
} from "@/lib/creditDebt";
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
      await lockCreditAccount(tx, userId);
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
      const debtOffset = await offsetCreditDebt(tx, {
        userId,
        purchaseId: purchase.id,
        availableCredits: pack.credits,
        availableFundedCostMicroUsd: BigInt(pack.fundedCostMicroUsd),
        type: "purchase_offset",
        metadata: {
          packId: pack.id,
          stripeCheckoutSessionId: session.id,
        },
      });
      if (
        debtOffset.offsetCredits > 0 ||
        debtOffset.offsetFundedCostMicroUsd > BigInt(0)
      ) {
        const updatedLot = await tx.creditLot.update({
          where: { id: lot.id },
          data: {
            remainingCredits: { decrement: debtOffset.offsetCredits },
            remainingFundedCostMicroUsd: {
              decrement: debtOffset.offsetFundedCostMicroUsd,
            },
          },
        });
        await tx.creditLedgerEntry.create({
          data: {
            userId,
            creditLotId: lot.id,
            purchaseId: purchase.id,
            type: "debt_offset",
            creditsDelta: -debtOffset.offsetCredits,
            fundedCostMicroUsdDelta: -debtOffset.offsetFundedCostMicroUsd,
            balanceAfterCredits: updatedLot.remainingCredits,
            balanceAfterFundedCostMicroUsd:
              updatedLot.remainingFundedCostMicroUsd,
            metadata: {
              source: "credit_pack_purchase",
              stripeCheckoutSessionId: session.id,
            },
          },
        });
      }
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
  disputeId,
  disputeStatus,
  disputedAmountCents,
}: {
  paymentIntentId?: string | null;
  chargeId?: string | null;
  refundedAmountCents?: number;
  disputed?: boolean;
  disputeId?: string | null;
  disputeStatus?: string | null;
  disputedAmountCents?: number;
}) {
  if (!paymentIntentId && !chargeId && !disputeId) return false;
  const candidate = await prisma.creditPurchase.findFirst({
    where: {
      OR: [
        ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
        ...(chargeId ? [{ stripeChargeId: chargeId }] : []),
        ...(disputeId ? [{ stripeDisputeId: disputeId }] : []),
      ],
    },
    select: { id: true, userId: true },
  });
  if (!candidate) return false;

  await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, candidate.userId);
    const purchase = await tx.creditPurchase.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    const refundAmount = disputed
      ? purchase.stripeDisputeId === disputeId
        ? purchase.refundedAmountCents
        : Math.min(
            purchase.amountPaidCents,
            purchase.refundedAmountCents +
              Math.max(0, disputedAmountCents || purchase.amountPaidCents)
          )
      : Math.min(
          purchase.amountPaidCents,
          Math.max(0, refundedAmountCents || 0)
        );
    const targetCredits = Math.floor(
      (purchase.creditsPurchased * refundAmount) / purchase.amountPaidCents
    );
    const targetCost =
      (purchase.fundedCostMicroUsd * BigInt(refundAmount)) /
      BigInt(purchase.amountPaidCents);
    const previouslyProcessedAmount = Math.min(
      purchase.amountPaidCents,
      Math.max(0, purchase.refundedAmountCents)
    );
    const previouslyProcessedCredits = Math.floor(
      (purchase.creditsPurchased * previouslyProcessedAmount) /
        purchase.amountPaidCents
    );
    const previouslyProcessedCost =
      (purchase.fundedCostMicroUsd * BigInt(previouslyProcessedAmount)) /
      BigInt(purchase.amountPaidCents);
    const creditsToRevoke = Math.max(
      0,
      targetCredits - previouslyProcessedCredits
    );
    const costToRevoke = targetCost > previouslyProcessedCost
      ? targetCost - previouslyProcessedCost
      : BigInt(0);
    const processedDisputeAmount = disputed
      ? Math.max(0, refundAmount - previouslyProcessedAmount)
      : 0;
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
          metadata: {
            refundedAmountCents: refundAmount,
            disputeId: disputeId || undefined,
          },
        },
      });
      creditsLeft -= removeCredits;
      costLeft -= removeCost;
      creditsRevoked += removeCredits;
      costRevoked += removeCost;
    }
    const unrecoveredCredits = creditsLeft;
    const unrecoveredCost = costLeft;
    await increaseCreditDebt(tx, {
      userId: purchase.userId,
      purchaseId: purchase.id,
      credits: unrecoveredCredits,
      fundedCostMicroUsd: unrecoveredCost,
      type: disputed ? "dispute_unrecovered" : "refund_unrecovered",
      metadata: {
        refundedAmountCents: refundAmount,
        disputeId: disputeId || undefined,
        disputeStatus: disputeStatus || undefined,
      },
    });
    await tx.creditPurchase.update({
      where: { id: purchase.id },
      data: {
        stripeChargeId: chargeId || purchase.stripeChargeId,
        refundedAmountCents: Math.max(purchase.refundedAmountCents, refundAmount),
        revokedCredits: { increment: creditsRevoked },
        revokedCostMicroUsd: { increment: costRevoked },
        unrecoveredCredits: { increment: unrecoveredCredits },
        unrecoveredCostMicroUsd: { increment: unrecoveredCost },
        stripeDisputeId: disputed
          ? disputeId || purchase.stripeDisputeId
          : purchase.stripeDisputeId,
        disputeStatus: disputed
          ? disputeStatus || purchase.disputeStatus || "needs_response"
          : purchase.disputeStatus,
        disputeAmountCents: disputed
          ? { increment: processedDisputeAmount }
          : undefined,
        disputeRevokedCredits: disputed
          ? { increment: creditsRevoked }
          : undefined,
        disputeRevokedCostMicroUsd: disputed
          ? { increment: costRevoked }
          : undefined,
        disputeDebtCredits: disputed
          ? { increment: unrecoveredCredits }
          : undefined,
        disputeDebtCostMicroUsd: disputed
          ? { increment: unrecoveredCost }
          : undefined,
        status: disputed || purchase.status === "disputed"
          ? "disputed"
          : refundAmount >= purchase.amountPaidCents
            ? "refunded"
            : "partially_refunded",
      },
    });
    if (disputed) {
      await tx.user.update({
        where: { id: purchase.userId },
        data: {
          billingRiskStatus: "disputed_hold",
          billingRiskReason: disputeId
            ? `Stripe dispute ${disputeId} requires review.`
            : "A Stripe payment dispute requires review.",
          billingRiskAt: new Date(),
        },
      });
    }
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
    disputeId: dispute.id,
    disputeStatus: dispute.status,
    disputedAmountCents: dispute.amount,
  });

export async function handleCreditPackDisputeReinstated(
  dispute: Stripe.Dispute
) {
  const chargeId = stripeId(dispute.charge);
  const paymentIntentId = stripeId(dispute.payment_intent);
  const candidate = await prisma.creditPurchase.findFirst({
    where: {
      OR: [
        { stripeDisputeId: dispute.id },
        ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
        ...(chargeId ? [{ stripeChargeId: chargeId }] : []),
      ],
    },
    select: { id: true, userId: true },
  });
  if (!candidate) return false;

  await prisma.$transaction(async (tx) => {
    await lockCreditAccount(tx, candidate.userId);
    const purchase = await tx.creditPurchase.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    if (
      (purchase.stripeDisputeId && purchase.stripeDisputeId !== dispute.id) ||
      (purchase.disputeStatus === "won" &&
        purchase.disputeRevokedCredits === 0 &&
        purchase.disputeDebtCredits === 0)
    ) {
      return;
    }
    const user = await tx.user.findUniqueOrThrow({
      where: { id: purchase.userId },
      select: {
        creditDebtCredits: true,
        creditDebtCostMicroUsd: true,
      },
    });
    const disputeDebtOutstandingCredits = Math.max(
      0,
      purchase.disputeDebtCredits - purchase.disputeOffsetCredits
    );
    const disputeDebtOutstandingCost =
      purchase.disputeDebtCostMicroUsd > purchase.disputeOffsetCostMicroUsd
        ? purchase.disputeDebtCostMicroUsd - purchase.disputeOffsetCostMicroUsd
        : BigInt(0);
    const debtCreditsToClear = Math.min(
      disputeDebtOutstandingCredits,
      purchase.unrecoveredCredits,
      user.creditDebtCredits
    );
    const debtCostToClear = [
      disputeDebtOutstandingCost,
      purchase.unrecoveredCostMicroUsd,
      user.creditDebtCostMicroUsd,
    ].reduce((lowest, value) => (value < lowest ? value : lowest));

    let debtBalanceCredits = user.creditDebtCredits;
    let debtBalanceCost = user.creditDebtCostMicroUsd;
    if (debtCreditsToClear > 0 || debtCostToClear > BigInt(0)) {
      const updatedUser = await tx.user.update({
        where: { id: purchase.userId },
        data: {
          creditDebtCredits: { decrement: debtCreditsToClear },
          creditDebtCostMicroUsd: { decrement: debtCostToClear },
        },
        select: {
          creditDebtCredits: true,
          creditDebtCostMicroUsd: true,
        },
      });
      debtBalanceCredits = updatedUser.creditDebtCredits;
      debtBalanceCost = updatedUser.creditDebtCostMicroUsd;
      await tx.creditDebtEntry.create({
        data: {
          userId: purchase.userId,
          purchaseId: purchase.id,
          type: "dispute_reinstated",
          creditsDelta: -debtCreditsToClear,
          fundedCostMicroUsdDelta: -debtCostToClear,
          balanceAfterCredits: debtBalanceCredits,
          balanceAfterCostMicroUsd: debtBalanceCost,
          metadata: { disputeId: dispute.id },
        },
      });
    }

    const restoredCredits =
      purchase.disputeRevokedCredits + purchase.disputeOffsetCredits;
    const restoredCost =
      purchase.disputeRevokedCostMicroUsd +
      purchase.disputeOffsetCostMicroUsd;
    if (restoredCredits > 0 || restoredCost > BigInt(0)) {
      const minimumExpiry = addDays(new Date(), 30);
      const expiresAt =
        purchase.expiresAt > minimumExpiry
          ? purchase.expiresAt
          : minimumExpiry;
      const lot = await tx.creditLot.create({
        data: {
          userId: purchase.userId,
          purchaseId: purchase.id,
          source: "dispute_reinstatement",
          originalCredits: restoredCredits,
          remainingCredits: restoredCredits,
          originalFundedCostMicroUsd: restoredCost,
          remainingFundedCostMicroUsd: restoredCost,
          expiresAt,
        },
      });
      await tx.creditLedgerEntry.create({
        data: {
          userId: purchase.userId,
          purchaseId: purchase.id,
          creditLotId: lot.id,
          type: "dispute_reinstatement",
          creditsDelta: restoredCredits,
          fundedCostMicroUsdDelta: restoredCost,
          balanceAfterCredits: restoredCredits,
          balanceAfterFundedCostMicroUsd: restoredCost,
          metadata: { disputeId: dispute.id },
        },
      });
    }

    const remainingRefundAmount = Math.max(
      0,
      purchase.refundedAmountCents - purchase.disputeAmountCents
    );
    await tx.creditPurchase.update({
      where: { id: purchase.id },
      data: {
        refundedAmountCents: remainingRefundAmount,
        revokedCredits: { decrement: purchase.disputeRevokedCredits },
        revokedCostMicroUsd: {
          decrement: purchase.disputeRevokedCostMicroUsd,
        },
        unrecoveredCredits: { decrement: debtCreditsToClear },
        unrecoveredCostMicroUsd: { decrement: debtCostToClear },
        disputeStatus: "won",
        disputeAmountCents: 0,
        disputeRevokedCredits: 0,
        disputeRevokedCostMicroUsd: BigInt(0),
        disputeDebtCredits: 0,
        disputeDebtCostMicroUsd: BigInt(0),
        disputeOffsetCredits: 0,
        disputeOffsetCostMicroUsd: BigInt(0),
        status:
          remainingRefundAmount > 0 ? "partially_refunded" : "paid",
      },
    });

    const otherOpenDisputes = await tx.creditPurchase.count({
      where: {
        userId: purchase.userId,
        id: { not: purchase.id },
        status: "disputed",
      },
    });
    if (otherOpenDisputes === 0) {
      await tx.user.update({
        where: { id: purchase.userId },
        data: {
          billingRiskStatus: "normal",
          billingRiskReason: null,
          billingRiskAt: null,
        },
      });
    }
  });
  return true;
}

export const handleCreditPackDisputeClosed = (dispute: Stripe.Dispute) =>
  dispute.status === "won"
    ? handleCreditPackDisputeReinstated(dispute)
    : handleCreditPackDispute(dispute);
