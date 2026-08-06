import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
    MEMORY_EXTRACTION_DEFAULT_BUDGET_PERCENT,
    resolveMemoryExtractionSubBudget,
} from "@/lib/memoryExtractionCore";
import { getProviderCostBudget } from "@/lib/providerCostBudget";

/**
 * Operational provider-cost accounting for extraction, per actual call
 * (policy §3, §11; AGENTS.md "Credit entitlement vs operational guardrail").
 *
 * **This is not the user's credits, and the two fail in opposite directions.**
 *
 * User credits are reserved once per run and settled at a terminal state,
 * charging only the chunks that completed — a chunk that failed is refunded,
 * because the user did not get it (`lib/memoryExtractionCredits.ts`). That is
 * an entitlement decision and it is right.
 *
 * The provider budget cannot follow it. If a request was actually issued, the
 * provider may have billed for it whether or not the chunk produced anything,
 * and whether or not the worker still held its lease. Refunding the budget on
 * failure would let a run that keeps failing consume an unbounded share of a
 * budget that reads as untouched — the operational guardrail would stop
 * guarding exactly when it matters most.
 *
 * So: released in full only when **no call went out**. Once `callIssued` is
 * true the cost stays, adjusted to actual usage when the provider reports it
 * and left at the conservative reservation when it does not.
 *
 * Everything here is scoped to one attempt, identified by (chunk, attempt
 * count) — the §11 identity. A replayed attempt collides on the unique index
 * instead of consuming the budget a second time.
 */

const DAY = "provider-cost-day" as const;
const MONTH = "provider-cost-month" as const;

const utcDayStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const utcMonthStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const subBudgetEnv = (
    provider: string,
    period: "DAY" | "MONTH",
    environment: Record<string, string | undefined>
) => {
    const percent = Number(
        environment[
            `MEMORY_EXTRACTION_PROVIDER_${provider.toUpperCase()}_MAX_PERCENT_PER_${period}`
        ]
    );
    const absolute = Number(
        environment[
            `MEMORY_EXTRACTION_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_${period}`
        ]
    );
    return {
        percentOverride: Number.isFinite(percent) ? percent : null,
        absoluteOverrideMicroUsd: Number.isFinite(absolute) ? absolute : null,
    };
};

/**
 * Adds `amount` to a usage bucket only if it fits under `limit`.
 *
 * The check and the write are one statement: two concurrent attempts must not
 * both pass a ceiling they can only jointly exceed. Negative amounts (a
 * downward settlement) skip the ceiling, since giving budget back can never
 * breach it — but never below zero.
 */
const consumeBucket = async (
    tx: Prisma.TransactionClient,
    key: string,
    period: string,
    start: Date,
    limit: number,
    amount: number
): Promise<boolean> => {
    if (amount === 0) return true;
    if (amount > 0 && (!Number.isSafeInteger(amount) || amount > limit)) {
        // Checked before the statement, because `ON CONFLICT ... DO UPDATE ...
        // WHERE` guards only the UPDATE path: on a bucket that does not exist
        // yet the INSERT succeeds unconditionally, so the first spend of a
        // period could otherwise blow the whole ceiling in one call. Chat's
        // own primitive carries the same guard for the same reason.
        return false;
    }
    if (amount < 0) {
        await tx.$executeRaw`
            UPDATE "ChatUsageBucket"
            SET "count" = GREATEST(0, "count" + ${amount}),
                "updatedAt" = NOW()
            WHERE "key" = ${key}
              AND "period" = ${period}
              AND "periodStart" = ${start}
        `;
        return true;
    }
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${key}, ${period}, ${start}, ${amount}, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET
            "count" = "ChatUsageBucket"."count" + ${amount},
            "updatedAt" = NOW()
        WHERE "ChatUsageBucket"."count" <= ${limit - amount}
        RETURNING "count"
    `;
    return rows.length > 0;
};

export type ExtractionProviderBudgetScope =
    | "provider_cost_day"
    | "provider_cost_month"
    | "extraction_sub_budget_day"
    | "extraction_sub_budget_month";

export type ExtractionProviderCostAdmission =
    | { admitted: true; providerCallId: string }
    | { admitted: false; scope: ExtractionProviderBudgetScope };

/**
 * Reserves this attempt's operational cost against the provider total AND the
 * extraction sub-budget, in one transaction with the durable attempt record.
 *
 * Both ceilings, always: the sub-budget is a share of the provider's own (§3),
 * so extraction may spend its slice but never borrow the interactive one. They
 * are consumed in the same transaction so a sub-budget refusal gives the
 * provider total back automatically.
 */
export async function admitExtractionProviderCall(input: {
    chunkId: string;
    attemptCount: number;
    provider: string;
    modelId: string;
    estimatedCostMicroUsd: number;
    now?: Date;
    environment?: Record<string, string | undefined>;
}): Promise<ExtractionProviderCostAdmission> {
    const now = input.now ?? new Date();
    const environment = input.environment ?? process.env;
    const budget = getProviderCostBudget(input.provider, environment);
    const amount = Math.max(0, Math.ceil(input.estimatedCostMicroUsd));

    const providerKey = `provider:${input.provider}`;
    const batchKey = `memory-extraction-provider:${input.provider}`;
    const dayStart = utcDayStart(now);
    const monthStart = utcMonthStart(now);

    const ceilings = [
        {
            key: providerKey,
            period: DAY,
            start: dayStart,
            limit: budget.day,
            scope: "provider_cost_day" as const,
        },
        {
            key: providerKey,
            period: MONTH,
            start: monthStart,
            limit: budget.month,
            scope: "provider_cost_month" as const,
        },
        {
            key: batchKey,
            period: DAY,
            start: dayStart,
            limit: resolveMemoryExtractionSubBudget({
                providerBudgetMicroUsd: budget.day,
                ...subBudgetEnv(input.provider, "DAY", environment),
            }),
            scope: "extraction_sub_budget_day" as const,
        },
        {
            key: batchKey,
            period: MONTH,
            start: monthStart,
            limit: resolveMemoryExtractionSubBudget({
                providerBudgetMicroUsd: budget.month,
                ...subBudgetEnv(input.provider, "MONTH", environment),
            }),
            scope: "extraction_sub_budget_month" as const,
        },
    ];

    type Rejected = { scope: ExtractionProviderBudgetScope };
    class BudgetExhausted extends Error {
        constructor(readonly scope: ExtractionProviderBudgetScope) {
            super(scope);
        }
    }

    try {
        return await prisma.$transaction(async (tx) => {
            for (const ceiling of ceilings) {
                const ok = await consumeBucket(
                    tx,
                    ceiling.key,
                    ceiling.period,
                    ceiling.start,
                    ceiling.limit,
                    amount
                );
                if (!ok) throw new BudgetExhausted(ceiling.scope);
            }

            const call = await tx.memoryExtractionProviderCall.create({
                data: {
                    chunkId: input.chunkId,
                    attemptCount: input.attemptCount,
                    provider: input.provider,
                    modelId: input.modelId,
                    reservedCostMicroUsd: BigInt(amount),
                    startedAt: now,
                },
            });
            return { admitted: true as const, providerCallId: call.id };
        });
    } catch (error) {
        if (error instanceof BudgetExhausted) {
            return { admitted: false as const, scope: error.scope } as Rejected & {
                admitted: false;
            };
        }
        throw error;
    }
}

/**
 * Marks the request as issued, durably, BEFORE it leaves.
 *
 * The ordering is the whole point: after this, a crash is recoverable as "may
 * have cost something" rather than as "nothing happened", and the release path
 * below refuses to give the budget back.
 */
export async function markExtractionProviderCallIssued(
    providerCallId: string
): Promise<void> {
    await prisma.memoryExtractionProviderCall.update({
        where: { id: providerCallId },
        data: { callIssued: true },
    });
}

/**
 * Gives the whole reservation back, for a failure BEFORE any request went out.
 *
 * Refuses once `callIssued` is set. That refusal is the guardrail: a caller
 * that reaches here after a call has gone out is asking to erase a cost that
 * may really have been billed.
 */
export async function releaseUnusedExtractionProviderCall(input: {
    providerCallId: string;
    failureCode: string;
    now?: Date;
}): Promise<{ released: boolean }> {
    const now = input.now ?? new Date();
    return prisma.$transaction(async (tx) => {
        const call = await tx.memoryExtractionProviderCall.findUnique({
            where: { id: input.providerCallId },
        });
        if (!call || call.callIssued || call.settledAt) {
            return { released: false };
        }
        const amount = -Number(call.reservedCostMicroUsd);
        if (amount !== 0) {
            const providerKey = `provider:${call.provider}`;
            const batchKey = `memory-extraction-provider:${call.provider}`;
            for (const [key, period, start] of [
                [providerKey, DAY, utcDayStart(now)],
                [providerKey, MONTH, utcMonthStart(now)],
                [batchKey, DAY, utcDayStart(now)],
                [batchKey, MONTH, utcMonthStart(now)],
            ] as const) {
                await consumeBucket(tx, key, period, start, 0, amount);
            }
        }
        await tx.memoryExtractionProviderCall.update({
            where: { id: call.id },
            data: {
                settledCostMicroUsd: BigInt(0),
                failureCode: input.failureCode,
                settledAt: now,
            },
        });
        return { released: true };
    });
}

export type ExtractionProviderUsage = {
    inputTokens?: number;
    outputTokens?: number;
    /** False when the provider reported no usage at all. */
    usageFromProvider: boolean;
    actualCostMicroUsd?: number;
    responseId?: string | null;
};

/**
 * Settles an attempt whose request was issued.
 *
 * Adjusts the buckets by the difference between what was reserved and what the
 * call actually cost. When usage is unknown the reservation stands: settling
 * an issued call as free would understate the budget, and the conservative
 * direction is the only safe one when the truth is unavailable.
 *
 * Deliberately independent of the lease. A worker that was fenced out after
 * its call still spent the money, and the guardrail has to see it.
 */
export async function settleExtractionProviderCall(input: {
    providerCallId: string;
    usage: ExtractionProviderUsage;
    failureCode?: string;
    now?: Date;
}): Promise<{ settled: boolean }> {
    const now = input.now ?? new Date();
    return prisma.$transaction(async (tx) => {
        const call = await tx.memoryExtractionProviderCall.findUnique({
            where: { id: input.providerCallId },
        });
        // Idempotent: a replayed settlement must not move the budget twice.
        if (!call || call.settledAt) return { settled: false };

        const reserved = Number(call.reservedCostMicroUsd);
        const actual =
            input.usage.usageFromProvider &&
            typeof input.usage.actualCostMicroUsd === "number"
                ? Math.max(0, Math.ceil(input.usage.actualCostMicroUsd))
                : reserved;
        const delta = actual - reserved;

        if (delta !== 0) {
            const providerKey = `provider:${call.provider}`;
            const batchKey = `memory-extraction-provider:${call.provider}`;
            for (const [key, period, start] of [
                [providerKey, DAY, utcDayStart(now)],
                [providerKey, MONTH, utcMonthStart(now)],
                [batchKey, DAY, utcDayStart(now)],
                [batchKey, MONTH, utcMonthStart(now)],
            ] as const) {
                // An upward correction is not refused: the call already
                // happened, so the budget records what it cost even when that
                // pushes it over. The ceiling stops the NEXT admission, which
                // is the only place refusing still prevents anything.
                await consumeBucket(
                    tx,
                    key,
                    period,
                    start,
                    Number.MAX_SAFE_INTEGER,
                    delta
                );
            }
        }

        await tx.memoryExtractionProviderCall.update({
            where: { id: call.id },
            data: {
                settledCostMicroUsd: BigInt(actual),
                usageConfirmed: input.usage.usageFromProvider,
                inputTokens: input.usage.inputTokens ?? null,
                outputTokens: input.usage.outputTokens ?? null,
                responseId: input.usage.responseId ?? null,
                failureCode: input.failureCode ?? null,
                settledAt: now,
            },
        });
        return { settled: true };
    });
}

/**
 * Reconciles attempts whose request went out and never settled — a worker that
 * died mid-call, or a settlement that failed after the call.
 *
 * Settles at the reservation, which is what "we know it happened and not what
 * it cost" means. Leaving them open would understate the provider budget for
 * as long as nobody looked.
 */
export async function reconcileUnsettledExtractionProviderCalls(input: {
    olderThanMs?: number;
    limit?: number;
    now?: Date;
} = {}): Promise<{ settled: number }> {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - (input.olderThanMs ?? 15 * 60_000));
    const stale = await prisma.memoryExtractionProviderCall.findMany({
        where: { callIssued: true, settledAt: null, startedAt: { lt: cutoff } },
        take: input.limit ?? 200,
        select: { id: true },
    });
    let settled = 0;
    for (const call of stale) {
        const result = await settleExtractionProviderCall({
            providerCallId: call.id,
            usage: { usageFromProvider: false },
            failureCode: "reconciled_unsettled",
            now,
        }).catch(() => ({ settled: false }));
        if (result.settled) settled += 1;
    }
    if (settled > 0) {
        console.warn(
            JSON.stringify({
                event: "memory_extraction_provider_call_reconciled",
                settled,
            })
        );
    }
    return { settled };
}

export { MEMORY_EXTRACTION_DEFAULT_BUDGET_PERCENT };
