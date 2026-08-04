import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { isMemoryExtractionEnabled } from "@/lib/appSettings";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import {
    createDurableReservation,
    incrementUsageBucket,
    reservePlanCreditBuckets,
    reserveProviderCostBudget,
    usagePeriodStart,
    type ReservationEntry,
} from "@/lib/chatFinancePrimitives";
import {
    getMonthlyPlanCreditLimit,
    getUserChatUsageKey,
    type ChatAccess,
} from "@/lib/chatSecurity";
import { lockCreditAccount } from "@/lib/creditDebt";
import {
    MEMORY_EXTRACTION_LEASE_TTL_MS,
    resolveMemoryExtractionSubBudget,
} from "@/lib/memoryExtractionCore";
import type { MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import { resolveEffectiveExtractionPair } from "@/lib/memoryExtractionService";
import type { ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { getProviderCostBudget } from "@/lib/providerCostBudget";

/**
 * Atomic admission for one extraction chunk attempt (Release B, slice 1.6b).
 *
 * docs/policy/external-conversation-import-and-memory.md §3, §11;
 * docs/policy/credit-and-cost-limits.md §9.
 *
 * Everything that decides whether a provider may be called, and everything
 * that commits money to that call, happens in ONE transaction. A read-then-
 * reserve split would let two chunks see the same remaining budget and both
 * pass — which is the failure this shape exists to prevent, and the reason
 * `acquireChatAccess` could not simply be reused: it opens its own
 * transaction, so a caller cannot put a fencing check inside it.
 *
 * What this deliberately does NOT do (§3): it takes no chat lease, applies no
 * IP admission, and does not consult `aiChatEnabled`. Extraction has its own
 * background-concurrency layer and its own rollout flag. It also returns no
 * `leaseId` — a fake one would be a lie the rest of the system could act on.
 *
 * Lock order follows §9: credit account first, then the run advisory lock,
 * then buckets, then the reservation row.
 */

export type ExtractionAdmissionRejection =
    | "owner_missing"
    | "feature_disabled"
    | "pair_unavailable"
    | "lease_lost"
    | "chunk_not_claimable"
    | "quote_expired"
    | "requote_required"
    | "credits_insufficient"
    | "provider_budget_exhausted"
    | "sub_budget_exhausted";

export type ExtractionAdmission =
    | {
          admitted: true;
          attemptId: string;
          attemptNumber: number;
          reservationId: string;
          reservedCredits: number;
          reservedCostMicroUsd: number;
          pricingVersion: string;
      }
    | { admitted: false; reason: ExtractionAdmissionRejection };

/** Thrown inside the transaction to roll everything back with a reason. */
class AdmissionRejected extends Error {
    constructor(readonly reason: ExtractionAdmissionRejection) {
        super(reason);
        this.name = "AdmissionRejected";
    }
}

const subBudgetEnvFor = (
    provider: string,
    period: "DAY" | "MONTH",
    environment: Record<string, string | undefined>
) => ({
    percent: Number(
        environment[
            `MEMORY_EXTRACTION_PROVIDER_${provider.toUpperCase()}_MAX_PERCENT_PER_${period}`
        ]
    ),
    absolute: Number(
        environment[
            `MEMORY_EXTRACTION_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_${period}`
        ]
    ),
});

/**
 * Credits already committed to this run, so the just-in-time reservations can
 * be held to the ceiling the user confirmed. Summed from the chunks whose
 * attempts hold a reservation rather than from a counter, so a rolled-back
 * admission leaves nothing behind to count.
 */
const reservedCreditsForRun = async (
    tx: Prisma.TransactionClient,
    runId: string
): Promise<number> => {
    const rows = await tx.$queryRaw<Array<{ total: bigint | null }>>`
        SELECT SUM(c."estimatedCredits")::bigint AS total
        FROM "MemoryExtractionAttempt" a
        JOIN "MemoryExtractionChunk" c ON c."id" = a."chunkId"
        WHERE c."runId" = ${runId}
          AND a."reservationId" IS NOT NULL
    `;
    return Number(rows[0]?.total ?? 0);
};

export async function reserveMemoryExtractionAttempt(input: {
    runId: string;
    chunkIndex: number;
    /** The fencing token the caller claimed the run with. */
    leaseGeneration: number;
    /** Micro-USD this attempt may cost, from the chunk's quote. */
    reservedCostMicroUsd: number;
    now?: Date;
    environment?: Record<string, string | undefined>;
    register?: readonly MemoryExtractionEvalEntry[];
}): Promise<ExtractionAdmission> {
    const now = input.now ?? new Date();
    const environment = input.environment ?? process.env;

    // Read outside the transaction only to learn who owns the run, so the
    // credit account can be locked first (§9). Every authoritative check is
    // re-done under the lock below.
    const owner = await prisma.memoryExtractionRun.findUnique({
        where: { id: input.runId },
        select: { userId: true },
    });
    if (!owner) return { admitted: false, reason: "owner_missing" };

    if (!(await isMemoryExtractionEnabled())) {
        return { admitted: false, reason: "feature_disabled" };
    }
    const user = await prisma.user.findUnique({
        where: { id: owner.userId },
        select: { id: true, plan: true, planLimits: true },
    });
    if (!user) return { admitted: false, reason: "owner_missing" };

    try {
        return await prisma.$transaction(async (tx) => {
            // §9 lock order: credit account, then the run advisory lock.
            const userPlan: ModelTier =
                user.plan === "Pro" || user.plan === "Max"
                    ? user.plan
                    : "Free";
            await lockCreditAccount(tx, user.id);
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"memory-extraction:" + user.id}))`;

            const run = await tx.memoryExtractionRun.findUnique({
                where: { id: input.runId },
                select: {
                    id: true,
                    userId: true,
                    status: true,
                    leaseGeneration: true,
                    extractionModelId: true,
                    promptVersion: true,
                    confirmedCreditCeiling: true,
                    quoteExpiresAt: true,
                    quotePricingVersion: true,
                },
            });
            // Fencing. A worker that was superseded while it queued for these
            // locks must not reserve anything, and failing here rolls back
            // every bucket and row this transaction touched.
            if (
                !run ||
                run.status !== "running" ||
                run.leaseGeneration !== input.leaseGeneration
            ) {
                throw new AdmissionRejected("lease_lost");
            }
            if (run.quoteExpiresAt.getTime() <= now.getTime()) {
                throw new AdmissionRejected("quote_expired");
            }

            const chunk = await tx.memoryExtractionChunk.findUnique({
                where: {
                    runId_chunkIndex: {
                        runId: run.id,
                        chunkIndex: input.chunkIndex,
                    },
                },
                select: {
                    id: true,
                    status: true,
                    leaseGeneration: true,
                    attemptCount: true,
                    estimatedCredits: true,
                },
            });
            if (
                !chunk ||
                chunk.status !== "running" ||
                chunk.leaseGeneration !== input.leaseGeneration
            ) {
                throw new AdmissionRejected("chunk_not_claimable");
            }

            // The confirmed quote is a ceiling, not a suggestion: prices or the
            // plan may have moved since the user agreed, and exceeding what
            // they confirmed is a re-quote, never a larger charge (§11).
            const alreadyReserved = await reservedCreditsForRun(tx, run.id);
            if (
                alreadyReserved + chunk.estimatedCredits >
                run.confirmedCreditCeiling
            ) {
                throw new AdmissionRejected("requote_required");
            }

            // Re-checked here rather than cached from run creation: a pair can
            // be revoked without a deploy, and a plan can change while a run
            // sits pending (§12.1).
            let pricing;
            try {
                ({ pricing } = await resolveEffectiveExtractionPair({
                    extractionModelId: run.extractionModelId,
                    promptVersion: run.promptVersion,
                    plan: userPlan,
                    register: input.register,
                }));
            } catch {
                throw new AdmissionRejected("pair_unavailable");
            }

            const entries: ReservationEntry[] = [];
            const subjectKey = getUserChatUsageKey(user.id);
            const monthStart = usagePeriodStart("month", now);
            const monthlyLimit = getMonthlyPlanCreditLimit({
                kind: "user",
                plan: userPlan,
                planLimits:
                    (user.planLimits as ChatAccess["planLimits"]) ?? undefined,
            });

            const monthUsed = await tx.chatUsageBucket.findUnique({
                where: {
                    key_period_periodStart: {
                        key: subjectKey,
                        period: "month",
                        periodStart: monthStart,
                    },
                },
                select: { count: true },
            });
            const allocation = getChatCreditAllocation({
                requiredCredits: chunk.estimatedCredits,
                monthlyPlanCreditsRemaining: Math.max(
                    0,
                    monthlyLimit - Number(monthUsed?.count ?? 0)
                ),
                dailyPlanCreditsRemaining: null,
                // Purchased credits do not fund background extraction yet:
                // whether they should is a product decision, and quietly
                // spending them on work the user did not watch happen would
                // be the wrong default to pick silently.
                purchasedCreditsRemaining: 0,
            });
            if (allocation.planReservedCredits < chunk.estimatedCredits) {
                throw new AdmissionRejected("credits_insufficient");
            }

            entries.push(
                ...(await reservePlanCreditBuckets(
                    tx,
                    {
                        subjectKey,
                        credits: allocation.planReservedCredits,
                        monthly: { start: monthStart, limit: monthlyLimit },
                        // No daily window: the daily rule is a chat message
                        // quota, and a background run is not a chat message.
                        daily: null,
                    },
                    () => {
                        throw new AdmissionRejected("credits_insufficient");
                    }
                ))
            );

            const providerBudget = await getProviderCostBudget(
                pricing.provider,
                environment
            );
            entries.push(
                ...(await reserveProviderCostBudget(
                    tx,
                    {
                        provider: pricing.provider,
                        reservedCostMicroUsd: input.reservedCostMicroUsd,
                        dailyLimit: providerBudget.day,
                        monthlyLimit: providerBudget.month,
                        now,
                    },
                    () => {
                        throw new AdmissionRejected(
                            "provider_budget_exhausted"
                        );
                    }
                ))
            );

            // The batch sub-budget is a second ceiling inside the provider's
            // own (§3): extraction may spend a share of the provider budget,
            // never borrow the interactive share. Taken in the same
            // transaction, so failing it releases the provider budget too.
            const batchKey = `memory-extraction-provider:${pricing.provider}`;
            for (const [period, bucketPeriod, limit] of [
                [
                    "DAY" as const,
                    "provider-cost-day",
                    resolveMemoryExtractionSubBudget({
                        providerBudgetMicroUsd: providerBudget.day,
                        ...subBudgetEnvFor(pricing.provider, "DAY", environment),
                    }),
                ],
                [
                    "MONTH" as const,
                    "provider-cost-month",
                    resolveMemoryExtractionSubBudget({
                        providerBudgetMicroUsd: providerBudget.month,
                        ...subBudgetEnvFor(
                            pricing.provider,
                            "MONTH",
                            environment
                        ),
                    }),
                ],
            ] as const) {
                const start = usagePeriodStart(
                    period === "DAY" ? "day" : "month",
                    now
                );
                const allowed = await incrementUsageBucket(
                    tx,
                    batchKey,
                    bucketPeriod,
                    start,
                    limit,
                    input.reservedCostMicroUsd
                );
                if (!allowed) {
                    throw new AdmissionRejected("sub_budget_exhausted");
                }
                entries.push({
                    key: batchKey,
                    period: bucketPeriod,
                    periodStart: start,
                    amount: input.reservedCostMicroUsd,
                    metric: "cost",
                });
            }

            const attemptNumber = chunk.attemptCount;
            const reservationId = randomUUID();
            await createDurableReservation(tx, {
                reservationId,
                userId: user.id,
                subjectKey,
                traceId: `memory-extraction:${run.id}`,
                source: "memory_extraction",
                provider: pricing.provider,
                modelId: run.extractionModelId,
                // Bound to the attempt, not the chunk: a deliberate second
                // call is a new attempt and reserves again, while a replay of
                // the same attempt collides on this unique key instead of
                // paying twice (§11).
                idempotencyKey: `memory-extraction:${run.id}:${input.chunkIndex}:${attemptNumber}`,
                reservationPayload: {
                    runId: run.id,
                    chunkIndex: input.chunkIndex,
                    attemptNumber,
                    entries: entries.map((entry) => ({
                        ...entry,
                        periodStart: entry.periodStart.toISOString(),
                    })),
                    pricingVersion: run.quotePricingVersion,
                } satisfies Prisma.InputJsonValue,
                reservedCredits: allocation.planReservedCredits,
                reservedCostMicroUsd: input.reservedCostMicroUsd,
                planReservedCredits: allocation.planReservedCredits,
                addOnReservedCredits: 0,
                expiresAt: new Date(
                    now.getTime() + MEMORY_EXTRACTION_LEASE_TTL_MS
                ),
            });

            const attempt = await tx.memoryExtractionAttempt.create({
                data: {
                    chunkId: chunk.id,
                    attemptNumber,
                    status: "reserved",
                    leaseGeneration: input.leaseGeneration,
                    reservationId,
                    startedAt: now,
                },
            });

            return {
                admitted: true as const,
                attemptId: attempt.id,
                attemptNumber,
                reservationId,
                reservedCredits: allocation.planReservedCredits,
                reservedCostMicroUsd: input.reservedCostMicroUsd,
                pricingVersion: run.quotePricingVersion,
            };
        });
    } catch (error) {
        if (error instanceof AdmissionRejected) {
            return { admitted: false, reason: error.reason };
        }
        throw error;
    }
}
