import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const safeNumber = (value: bigint) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Credit debt exceeds the supported range.");
  }
  return result;
};

export const lockCreditAccount = (
  tx: Prisma.TransactionClient,
  userId: string
) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit-account:${userId}`}))`;

export const getCreditDebtSummary = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      creditDebtCredits: true,
      creditDebtCostMicroUsd: true,
      billingRiskStatus: true,
      billingRiskReason: true,
      billingRiskAt: true,
    },
  });
  return user
    ? {
        credits: user.creditDebtCredits,
        fundedCostMicroUsd: safeNumber(user.creditDebtCostMicroUsd),
        riskStatus: user.billingRiskStatus,
        riskReason: user.billingRiskReason,
        riskAt: user.billingRiskAt,
      }
    : null;
};

export const increaseCreditDebt = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    purchaseId,
    credits,
    fundedCostMicroUsd,
    type,
    metadata,
  }: {
    userId: string;
    purchaseId?: string | null;
    credits: number;
    fundedCostMicroUsd: bigint;
    type: "refund_unrecovered" | "dispute_unrecovered" | "admin_adjustment";
    metadata?: Prisma.InputJsonValue;
  }
) => {
  if (credits <= 0 && fundedCostMicroUsd <= 0) return null;
  const user = await tx.user.update({
    where: { id: userId },
    data: {
      creditDebtCredits: { increment: Math.max(0, credits) },
      creditDebtCostMicroUsd: {
        increment: fundedCostMicroUsd > 0 ? fundedCostMicroUsd : BigInt(0),
      },
    },
    select: {
      creditDebtCredits: true,
      creditDebtCostMicroUsd: true,
    },
  });
  return tx.creditDebtEntry.create({
    data: {
      userId,
      purchaseId: purchaseId || null,
      type,
      creditsDelta: Math.max(0, credits),
      fundedCostMicroUsdDelta:
        fundedCostMicroUsd > 0 ? fundedCostMicroUsd : BigInt(0),
      balanceAfterCredits: user.creditDebtCredits,
      balanceAfterCostMicroUsd: user.creditDebtCostMicroUsd,
      metadata,
    },
  });
};

export const offsetCreditDebt = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    purchaseId,
    availableCredits,
    availableFundedCostMicroUsd,
    type,
    metadata,
  }: {
    userId: string;
    purchaseId?: string | null;
    availableCredits: number;
    availableFundedCostMicroUsd: bigint;
    type: "purchase_offset" | "plan_offset" | "dispute_reinstated" | "admin_adjustment";
    metadata?: Prisma.InputJsonValue;
  }
) => {
  const current = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      creditDebtCredits: true,
      creditDebtCostMicroUsd: true,
    },
  });
  const credits = Math.min(
    current.creditDebtCredits,
    Math.max(0, availableCredits)
  );
  const usableCost = availableFundedCostMicroUsd > 0
    ? availableFundedCostMicroUsd
    : BigInt(0);
  const cost = current.creditDebtCostMicroUsd < usableCost
    ? current.creditDebtCostMicroUsd
    : usableCost;
  if (credits <= 0 && cost <= 0) {
    return {
      offsetCredits: 0,
      offsetFundedCostMicroUsd: BigInt(0),
      remainingCredits: current.creditDebtCredits,
      remainingFundedCostMicroUsd: current.creditDebtCostMicroUsd,
    };
  }
  const user = await tx.user.update({
    where: { id: userId },
    data: {
      creditDebtCredits: { decrement: credits },
      creditDebtCostMicroUsd: { decrement: cost },
    },
    select: {
      creditDebtCredits: true,
      creditDebtCostMicroUsd: true,
    },
  });
  let creditsLeft = credits;
  let costLeft = cost;
  let runningCredits = current.creditDebtCredits;
  let runningCost = current.creditDebtCostMicroUsd;
  const purchases = await tx.creditPurchase.findMany({
    where: {
      userId,
      OR: [
        { unrecoveredCredits: { gt: 0 } },
        { unrecoveredCostMicroUsd: { gt: BigInt(0) } },
      ],
    },
    orderBy: [{ purchasedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      unrecoveredCredits: true,
      unrecoveredCostMicroUsd: true,
      disputeDebtCredits: true,
      disputeDebtCostMicroUsd: true,
      disputeOffsetCredits: true,
      disputeOffsetCostMicroUsd: true,
    },
  });
  for (const purchase of purchases) {
    if (creditsLeft <= 0 && costLeft <= 0) break;
    const allocatedCredits = Math.min(creditsLeft, purchase.unrecoveredCredits);
    const allocatedCost = costLeft < purchase.unrecoveredCostMicroUsd
      ? costLeft
      : purchase.unrecoveredCostMicroUsd;
    const disputeCreditsOutstanding = Math.max(
      0,
      purchase.disputeDebtCredits - purchase.disputeOffsetCredits
    );
    const disputeCostOutstanding =
      purchase.disputeDebtCostMicroUsd > purchase.disputeOffsetCostMicroUsd
        ? purchase.disputeDebtCostMicroUsd - purchase.disputeOffsetCostMicroUsd
        : BigInt(0);
    const disputeCreditsOffset = Math.min(
      allocatedCredits,
      disputeCreditsOutstanding
    );
    const disputeCostOffset = allocatedCost < disputeCostOutstanding
      ? allocatedCost
      : disputeCostOutstanding;
    if (allocatedCredits <= 0 && allocatedCost <= 0) continue;
    await tx.creditPurchase.update({
      where: { id: purchase.id },
      data: {
        unrecoveredCredits: { decrement: allocatedCredits },
        unrecoveredCostMicroUsd: { decrement: allocatedCost },
        disputeOffsetCredits:
          disputeCreditsOffset > 0
            ? { increment: disputeCreditsOffset }
            : undefined,
        disputeOffsetCostMicroUsd:
          disputeCostOffset > BigInt(0)
            ? { increment: disputeCostOffset }
            : undefined,
      },
    });
    creditsLeft -= allocatedCredits;
    costLeft -= allocatedCost;
    runningCredits -= allocatedCredits;
    runningCost -= allocatedCost;
    await tx.creditDebtEntry.create({
      data: {
        userId,
        purchaseId: purchase.id,
        type,
        creditsDelta: -allocatedCredits,
        fundedCostMicroUsdDelta: -allocatedCost,
        balanceAfterCredits: runningCredits,
        balanceAfterCostMicroUsd: runningCost,
        metadata,
      },
    });
  }
  if (creditsLeft > 0 || costLeft > 0) {
    runningCredits -= creditsLeft;
    runningCost -= costLeft;
    await tx.creditDebtEntry.create({
      data: {
        userId,
        purchaseId: purchaseId || null,
        type,
        creditsDelta: -creditsLeft,
        fundedCostMicroUsdDelta: -costLeft,
        balanceAfterCredits: runningCredits,
        balanceAfterCostMicroUsd: runningCost,
        metadata,
      },
    });
  }
  return {
    offsetCredits: credits,
    offsetFundedCostMicroUsd: cost,
    remainingCredits: user.creditDebtCredits,
    remainingFundedCostMicroUsd: user.creditDebtCostMicroUsd,
  };
};

export const bigintToSafeNumber = safeNumber;
