import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import {
    getUserChatUsageKey,
    incrementUsageBucket,
    readUsageBucketCount,
    usagePeriodStart,
} from "@/lib/chatSecurity";
import {
    reserveAddOnCredits,
    settleAddOnCredits,
    type AddOnCreditReservationEntry,
} from "@/lib/creditLedger";
import { getUserDayWindow } from "@/lib/userDailyUsage";

/**
 * Entitlement for a memory extraction run (policy §11).
 *
 * **One reservation per run, not per chunk.** §11 shows the chunk plan and its
 * credit total before the run starts and refuses a stale confirmation, so the
 * run is the unit the user agreed to. Reserving per chunk would let a run they
 * agreed to pay N credits for stop halfway because their balance moved
 * underneath it, which is a worse promise than the one they were shown.
 *
 * **This is entitlement, not the operational guardrail.** Provider budget is
 * re-checked at every chunk boundary by the slice driver and is a different
 * layer with different names and different failure codes (AGENTS.md). Nothing
 * here reads or writes it.
 *
 * **Settlement charges for chunks that completed.** A run that fails or is
 * cancelled after two of five chunks keeps two and refunds three -- the two
 * really did call the provider. The refund is idempotent through the
 * `reserved -> settling -> settled` transition rather than through a flag: a
 * second settle finds no `reserved` row to claim and gives nothing back twice.
 */

export const extractionReservationId = (runId: string) =>
    `memory-extraction-credit-reservation:${runId}:v1`;

const retryAfterSeconds = (value: Date, now: Date) =>
    Math.max(1, Math.ceil((value.getTime() - now.getTime()) / 1_000));

const parseEntries = (payload: unknown): AddOnCreditReservationEntry[] =>
    Array.isArray(payload) ? (payload as AddOnCreditReservationEntry[]) : [];

export type ExtractionReservationInput = {
    tx: Prisma.TransactionClient;
    userId: string;
    runId: string;
    plan: { monthlyMessageLimit: number; dailyMessageLimit: number };
    credits: number;
    costMicroUsd: number;
    chunkTotal: number;
    provider: string;
    extractionModelId: string;
    promptVersion: string;
    pricingVersion: string;
    costSource: string;
    pricingSnapshot: Prisma.InputJsonValue;
    now: Date;
};

/**
 * Reserves the whole run's credits. Runs inside the run-creation transaction,
 * so a run cannot exist without its reservation and a rejected reservation
 * leaves no run, no chunks and no charge.
 */
export async function reserveExtractionRunCredits(
    input: ExtractionReservationInput
): Promise<{
    planReservedCredits: number;
    addOnReservedCredits: number;
    entries: AddOnCreditReservationEntry[];
}> {
    const { tx, userId, now } = input;
    const subjectKey = getUserChatUsageKey(userId);
    const dayWindow = await getUserDayWindow(tx, userId, now);
    const monthStart = usagePeriodStart("month", now);
    const monthLimit = Math.max(0, Math.trunc(input.plan.monthlyMessageLimit));
    const dayLimit = Math.max(0, Math.trunc(input.plan.dailyMessageLimit));

    const monthlyUsed = await readUsageBucketCount(
        tx,
        subjectKey,
        "month",
        monthStart
    );
    const dailyRemaining =
        dayLimit > 0
            ? dayLimit -
              (await readUsageBucketCount(tx, subjectKey, "day", dayWindow.start))
            : null;
    const purchased = await tx.creditLot.aggregate({
        where: {
            userId,
            status: "active",
            remainingCredits: { gt: 0 },
            expiresAt: { gt: now },
        },
        _sum: { remainingCredits: true },
    });

    const allocation = getChatCreditAllocation({
        requiredCredits: input.credits,
        monthlyPlanCreditsRemaining: Math.max(0, monthLimit - monthlyUsed),
        dailyPlanCreditsRemaining: dailyRemaining,
        purchasedCreditsRemaining: purchased._sum.remainingCredits ?? 0,
    });

    if (allocation.balanceInsufficient) {
        throw new ApiSecurityError(
            402,
            "CREDIT_BALANCE_INSUFFICIENT",
            // No internal USD and no raw balances in the message: the
            // account-facing surfaces read the balance themselves, and
            // AGENTS.md keeps internal cost out of user-visible errors.
            "Not enough credits for this extraction run."
        );
    }
    if (allocation.dailyPlanGuardrailBlocked) {
        throw new ApiSecurityError(
            429,
            "PLAN_DAILY_CREDIT_LIMIT_REACHED",
            "Daily plan credits are exhausted.",
            // Always in the future, never a deadline that has already passed.
            retryAfterSeconds(dayWindow.end, now)
        );
    }

    if (allocation.planReservedCredits > 0) {
        if (dayLimit > 0) {
            const charged = await incrementUsageBucket(
                tx,
                subjectKey,
                "day",
                dayWindow.start,
                dayLimit,
                allocation.planReservedCredits
            );
            if (!charged) {
                throw new ApiSecurityError(
                    409,
                    "CONCURRENT_RESERVATION_CONFLICT",
                    "Another request is reserving credits. Try again."
                );
            }
        }
        const charged = await incrementUsageBucket(
            tx,
            subjectKey,
            "month",
            monthStart,
            monthLimit,
            allocation.planReservedCredits
        );
        if (!charged) {
            throw new ApiSecurityError(
                409,
                "CONCURRENT_RESERVATION_CONFLICT",
                "Another request is reserving credits. Try again."
            );
        }
    }

    const reservationId = extractionReservationId(input.runId);
    let entries: AddOnCreditReservationEntry[] = [];
    if (allocation.addOnCreditsRequired > 0) {
        // The funded cost attributed to add-on credits is that share of the
        // whole run's estimated cost, so a partial refund gives back exactly
        // the share the unrun chunks stood for.
        const fundedCostMicroUsd = Math.ceil(
            (input.costMicroUsd * allocation.addOnCreditsRequired) / input.credits
        );
        entries = await reserveAddOnCredits(tx, {
            userId,
            reservationId,
            credits: allocation.addOnCreditsRequired,
            fundedCostMicroUsd,
            now,
        });
    }

    await tx.memoryExtractionCreditReservation.create({
        data: {
            id: reservationId,
            userId,
            runId: input.runId,
            status: "reserved",
            provider: input.provider,
            extractionModelId: input.extractionModelId,
            promptVersion: input.promptVersion,
            chunkTotal: input.chunkTotal,
            reservedCredits: input.credits,
            planReservedCredits: allocation.planReservedCredits,
            addOnReservedCredits: allocation.addOnCreditsRequired,
            reservedCostMicroUsd: BigInt(Math.max(0, Math.round(input.costMicroUsd))),
            pricingVersion: input.pricingVersion,
            costSource: input.costSource,
            pricingSnapshot: input.pricingSnapshot,
            reservationPayload: entries as unknown as Prisma.InputJsonValue,
            createdAt: now,
        },
    });

    return {
        planReservedCredits: allocation.planReservedCredits,
        addOnReservedCredits: allocation.addOnCreditsRequired,
        entries,
    };
}

const refundPlanCredits = async (
    tx: Prisma.TransactionClient,
    userId: string,
    credits: number,
    reservedAt: Date
) => {
    if (credits <= 0) return;
    const subjectKey = getUserChatUsageKey(userId);
    const dayWindow = await getUserDayWindow(tx, userId, reservedAt);
    for (const window of [
        { period: "day", start: dayWindow.start },
        { period: "month", start: usagePeriodStart("month", reservedAt) },
    ]) {
        await tx.$executeRaw`
      UPDATE "ChatUsageBucket"
      SET "count" = GREATEST(0, "count" - ${credits}), "updatedAt" = NOW()
      WHERE "key" = ${subjectKey} AND "period" = ${window.period} AND "periodStart" = ${window.start}
    `;
    }
};

export type ExtractionSettlementResult = {
    /** False when another settle already claimed this reservation. */
    applied: boolean;
    settledCredits: number;
    refundedCredits: number;
};

/**
 * Settles a run's reservation once it reaches a terminal state.
 *
 * `chunksCharged` is the number of chunks that actually completed. Everything
 * the run did not run is refunded, plan credits first and then lot by lot, in
 * the same transaction that records the settlement.
 */
export async function settleExtractionRunCredits(
    tx: Prisma.TransactionClient,
    input: {
        runId: string;
        outcome: "completed" | "failed" | "cancelled";
        chunksCharged: number;
        now?: Date;
    }
): Promise<ExtractionSettlementResult> {
    const now = input.now ?? new Date();

    // Claiming by moving out of `reserved` is what makes this idempotent. A
    // duplicate settle -- a retry, a second sweep -- finds nothing to claim.
    const claim = await tx.memoryExtractionCreditReservation.updateMany({
        where: { runId: input.runId, status: "reserved" },
        data: { status: "settling" },
    });
    if (claim.count === 0) {
        return { applied: false, settledCredits: 0, refundedCredits: 0 };
    }

    const reservation = await tx.memoryExtractionCreditReservation.findUniqueOrThrow(
        { where: { runId: input.runId } }
    );

    const charged = Math.max(
        0,
        Math.min(reservation.chunkTotal, Math.trunc(input.chunksCharged))
    );
    // Credits were quoted per chunk, so the charge is that share of what was
    // reserved. Rounded down: the account is never charged for more than it
    // used because of arithmetic.
    const settledCredits =
        reservation.chunkTotal === 0
            ? 0
            : Math.min(
                  reservation.reservedCredits,
                  Math.floor(
                      (reservation.reservedCredits * charged) / reservation.chunkTotal
                  )
              );
    const settledCostMicroUsd =
        reservation.chunkTotal === 0
            ? 0
            : Math.floor(
                  (Number(reservation.reservedCostMicroUsd) * charged) /
                      reservation.chunkTotal
              );

    // Plan credits are consumed first, so they are also the first to be
    // charged and only the remainder falls to add-on lots.
    const planSettled = Math.min(reservation.planReservedCredits, settledCredits);
    const addOnSettled = settledCredits - planSettled;
    const planRefund = reservation.planReservedCredits - planSettled;

    if (reservation.userId) {
        await refundPlanCredits(
            tx,
            reservation.userId,
            planRefund,
            reservation.createdAt
        );
        const entries = parseEntries(reservation.reservationPayload);
        if (entries.length > 0) {
            const addOnFundedCost = entries.reduce(
                (sum, entry) => sum + entry.fundedCostMicroUsd,
                0
            );
            const settledFunded =
                reservation.addOnReservedCredits === 0
                    ? 0
                    : Math.floor(
                          (addOnFundedCost * addOnSettled) /
                              reservation.addOnReservedCredits
                      );
            await settleAddOnCredits(tx, {
                userId: reservation.userId,
                reservationId: reservation.id,
                entries,
                settledCredits: addOnSettled,
                settledFundedCostMicroUsd: settledFunded,
                outcome: input.outcome,
            });
        }
    }

    await tx.memoryExtractionCreditReservation.update({
        where: { runId: input.runId },
        data: {
            status: "settled",
            outcome: input.outcome,
            chunksCharged: charged,
            settledCredits,
            settledCostMicroUsd: BigInt(settledCostMicroUsd),
            settledAt: now,
            refundedAt:
                settledCredits < reservation.reservedCredits ? now : null,
        },
    });

    return {
        applied: true,
        settledCredits,
        refundedCredits: reservation.reservedCredits - settledCredits,
    };
}
