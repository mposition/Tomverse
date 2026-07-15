import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type AddOnCreditReservationEntry = {
  lotId: string;
  purchaseId: string | null;
  credits: number;
  fundedCostMicroUsd: number;
};

export class AddOnCreditError extends Error {
  constructor(
    public readonly code:
      | "ADDON_CREDITS_INSUFFICIENT"
      | "ADDON_COST_ALLOWANCE_INSUFFICIENT",
    public readonly availableCredits: number,
    public readonly availableFundedCostMicroUsd: number
  ) {
    super(
      code === "ADDON_CREDITS_INSUFFICIENT"
        ? "Purchased credit balance is insufficient."
        : "Purchased credit cost allowance is insufficient."
    );
  }
}

const asSafeNumber = (value: bigint) => {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error("Credit ledger value exceeds the supported range.");
  }
  return converted;
};

export const getPurchasedCreditSummary = async (userId: string, now = new Date()) => {
  const lots = await prisma.creditLot.findMany({
    where: {
      userId,
      status: "active",
      expiresAt: { gt: now },
      OR: [
        { remainingCredits: { gt: 0 } },
        { remainingFundedCostMicroUsd: { gt: 0 } },
      ],
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      remainingCredits: true,
      remainingFundedCostMicroUsd: true,
      expiresAt: true,
    },
  });
  return {
    remainingCredits: lots.reduce((sum, lot) => sum + lot.remainingCredits, 0),
    remainingFundedCostMicroUsd: lots.reduce(
      (sum, lot) => sum + asSafeNumber(lot.remainingFundedCostMicroUsd),
      0
    ),
    earliestExpiry: lots[0]?.expiresAt || null,
    lotCount: lots.length,
  };
};

export const reserveAddOnCredits = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    reservationId,
    credits,
    fundedCostMicroUsd,
    now = new Date(),
  }: {
    userId: string;
    reservationId: string;
    credits: number;
    fundedCostMicroUsd: number;
    now?: Date;
  }
): Promise<AddOnCreditReservationEntry[]> => {
  if (credits <= 0 && fundedCostMicroUsd <= 0) return [];
  const lots = await tx.creditLot.findMany({
    where: {
      userId,
      status: "active",
      expiresAt: { gt: now },
      OR: [
        { remainingCredits: { gt: 0 } },
        { remainingFundedCostMicroUsd: { gt: 0 } },
      ],
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      purchaseId: true,
      remainingCredits: true,
      remainingFundedCostMicroUsd: true,
    },
  });
  const availableCredits = lots.reduce(
    (sum, lot) => sum + lot.remainingCredits,
    0
  );
  const availableFundedCostMicroUsd = lots.reduce(
    (sum, lot) => sum + asSafeNumber(lot.remainingFundedCostMicroUsd),
    0
  );
  if (availableCredits < credits) {
    throw new AddOnCreditError(
      "ADDON_CREDITS_INSUFFICIENT",
      availableCredits,
      availableFundedCostMicroUsd
    );
  }
  if (availableFundedCostMicroUsd < fundedCostMicroUsd) {
    throw new AddOnCreditError(
      "ADDON_COST_ALLOWANCE_INSUFFICIENT",
      availableCredits,
      availableFundedCostMicroUsd
    );
  }

  let creditsLeft = credits;
  let costLeft = fundedCostMicroUsd;
  const entries: AddOnCreditReservationEntry[] = [];
  for (const lot of lots) {
    const lotCost = asSafeNumber(lot.remainingFundedCostMicroUsd);
    const reservedCredits = Math.min(creditsLeft, lot.remainingCredits);
    const reservedCost = Math.min(costLeft, lotCost);
    if (reservedCredits <= 0 && reservedCost <= 0) continue;
    const updated = await tx.creditLot.update({
      where: { id: lot.id },
      data: {
        remainingCredits: { decrement: reservedCredits },
        remainingFundedCostMicroUsd: { decrement: BigInt(reservedCost) },
      },
      select: {
        remainingCredits: true,
        remainingFundedCostMicroUsd: true,
      },
    });
    await tx.creditLedgerEntry.create({
      data: {
        userId,
        creditLotId: lot.id,
        purchaseId: lot.purchaseId,
        type: "reserve",
        creditsDelta: -reservedCredits,
        fundedCostMicroUsdDelta: -BigInt(reservedCost),
        balanceAfterCredits: updated.remainingCredits,
        balanceAfterFundedCostMicroUsd:
          updated.remainingFundedCostMicroUsd,
        reservationId,
      },
    });
    entries.push({
      lotId: lot.id,
      purchaseId: lot.purchaseId,
      credits: reservedCredits,
      fundedCostMicroUsd: reservedCost,
    });
    creditsLeft -= reservedCredits;
    costLeft -= reservedCost;
    if (creditsLeft <= 0 && costLeft <= 0) break;
  }
  return entries;
};

export const settleAddOnCredits = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    reservationId,
    entries,
    settledCredits,
    settledFundedCostMicroUsd,
    outcome,
  }: {
    userId: string;
    reservationId: string;
    entries: AddOnCreditReservationEntry[];
    settledCredits: number;
    settledFundedCostMicroUsd: number;
    outcome: "completed" | "cancelled" | "failed" | "empty";
  }
) => {
  let creditsLeft = Math.max(0, settledCredits);
  let costLeft = Math.max(0, settledFundedCostMicroUsd);
  for (const entry of entries) {
    const usedCredits = Math.min(creditsLeft, entry.credits);
    const usedCost = Math.min(costLeft, entry.fundedCostMicroUsd);
    const refundCredits = entry.credits - usedCredits;
    const refundCost = entry.fundedCostMicroUsd - usedCost;
    let lot = await tx.creditLot.findUniqueOrThrow({
      where: { id: entry.lotId },
      select: {
        remainingCredits: true,
        remainingFundedCostMicroUsd: true,
      },
    });
    if (refundCredits > 0 || refundCost > 0) {
      lot = await tx.creditLot.update({
        where: { id: entry.lotId },
        data: {
          remainingCredits: { increment: refundCredits },
          remainingFundedCostMicroUsd: { increment: BigInt(refundCost) },
        },
        select: {
          remainingCredits: true,
          remainingFundedCostMicroUsd: true,
        },
      });
      await tx.creditLedgerEntry.create({
        data: {
          userId,
          creditLotId: entry.lotId,
          purchaseId: entry.purchaseId,
          type: "refund",
          creditsDelta: refundCredits,
          fundedCostMicroUsdDelta: BigInt(refundCost),
          balanceAfterCredits: lot.remainingCredits,
          balanceAfterFundedCostMicroUsd: lot.remainingFundedCostMicroUsd,
          reservationId,
          metadata: { outcome },
        },
      });
    }
    await tx.creditLedgerEntry.create({
      data: {
        userId,
        creditLotId: entry.lotId,
        purchaseId: entry.purchaseId,
        type: "settle",
        creditsDelta: 0,
        fundedCostMicroUsdDelta: BigInt(0),
        balanceAfterCredits: lot.remainingCredits,
        balanceAfterFundedCostMicroUsd: lot.remainingFundedCostMicroUsd,
        reservationId,
        metadata: {
          outcome,
          settledCredits: usedCredits,
          settledFundedCostMicroUsd: usedCost,
        },
      },
    });
    creditsLeft -= usedCredits;
    costLeft -= usedCost;
  }
};

export const expireCreditLots = async (now = new Date()) =>
  prisma.$transaction(async (tx) => {
    const lots = await tx.creditLot.findMany({
      where: { status: "active", expiresAt: { lte: now } },
      select: {
        id: true,
        userId: true,
        purchaseId: true,
        remainingCredits: true,
        remainingFundedCostMicroUsd: true,
      },
    });
    for (const lot of lots) {
      await tx.creditLot.update({
        where: { id: lot.id },
        data: {
          status: "expired",
          remainingCredits: 0,
          remainingFundedCostMicroUsd: BigInt(0),
        },
      });
      if (lot.remainingCredits > 0 || lot.remainingFundedCostMicroUsd > 0) {
        await tx.creditLedgerEntry.create({
          data: {
            userId: lot.userId,
            creditLotId: lot.id,
            purchaseId: lot.purchaseId,
            type: "expire",
            creditsDelta: -lot.remainingCredits,
            fundedCostMicroUsdDelta: -lot.remainingFundedCostMicroUsd,
            balanceAfterCredits: 0,
            balanceAfterFundedCostMicroUsd: BigInt(0),
          },
        });
      }
    }
    return lots.length;
  });
