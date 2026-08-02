import "server-only";

import { prisma } from "@/lib/prisma";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import { AVAILABLE_MODELS } from "@/lib/models";
import {
    classifyProviderBudgetUtilisation,
    getActiveProviders,
    getProviderCostBudget,
} from "@/lib/providerCostBudget";

// Provider budget windows are UTC, matching the buckets the reservation path
// writes. They are not user-local: this is a global operational cap, not an
// entitlement, so there is no account whose time zone it should follow.
const utcDayStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const utcMonthStart = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const utcDayEnd = (now: Date) =>
    new Date(utcDayStart(now).getTime() + 86_400_000);

const utcMonthEnd = (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

export type ProviderBudgetStatusReport = Awaited<
    ReturnType<typeof getProviderBudgetStatuses>
>;

/**
 * Every active provider's budget: configured value, enforced value, what each
 * window has used, how close that is, and when it resets.
 *
 * Reports the configured and the enforced value separately on purpose. They
 * differ exactly when a configured budget was raised to the floor, and an
 * operator looking at a blocked provider needs to see that the number they set
 * is not the number in force.
 */
export const getProviderBudgetStatuses = async ({
    now = new Date(),
}: { now?: Date } = {}) => {
    const providers = getActiveProviders(AVAILABLE_MODELS);
    const dayStart = utcDayStart(now);
    const monthStart = utcMonthStart(now);

    let usage = new Map<string, number>();
    let usageUnavailable = false;
    try {
        const rows = await prisma.chatUsageBucket.findMany({
            where: {
                key: { in: providers.map((provider) => `provider:${provider}`) },
                OR: [
                    { period: "provider-cost-day", periodStart: dayStart },
                    { period: "provider-cost-month", periodStart: monthStart },
                ],
            },
            select: { key: true, period: true, count: true },
        });
        usage = new Map(
            rows.map((row) => [
                `${row.key}|${row.period}`,
                usageBucketCount(row.count),
            ])
        );
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        usageUnavailable = true;
    }

    return {
        generatedAt: now.toISOString(),
        usageUnavailable,
        providers: providers.map((provider) => {
            const budget = getProviderCostBudget(provider);
            const periods = (
                [
                    {
                        period: "day" as const,
                        bucketPeriod: "provider-cost-day",
                        limitMicroUsd: budget.day,
                        configuredMicroUsd: budget.configured.day,
                        floorMicroUsd: budget.floor.day,
                        resetAt: utcDayEnd(now).toISOString(),
                    },
                    {
                        period: "month" as const,
                        bucketPeriod: "provider-cost-month",
                        limitMicroUsd: budget.month,
                        configuredMicroUsd: budget.configured.month,
                        floorMicroUsd: budget.floor.month,
                        resetAt: utcMonthEnd(now).toISOString(),
                    },
                ]
            ).map((entry) => {
                const usedMicroUsd =
                    usage.get(`provider:${provider}|${entry.bucketPeriod}`) ?? 0;
                const utilisation = classifyProviderBudgetUtilisation({
                    usedMicroUsd,
                    requiredMicroUsd: 0,
                    limitMicroUsd: entry.limitMicroUsd,
                });
                return {
                    ...entry,
                    usedMicroUsd,
                    remainingMicroUsd: Math.max(
                        0,
                        entry.limitMicroUsd - usedMicroUsd
                    ),
                    utilisationRatio: utilisation.ratio,
                    level: utilisation.level,
                    clamped: budget.clampedPeriods.includes(entry.period),
                    timeZone: "UTC",
                };
            });
            return {
                provider,
                source: budget.source,
                problems: budget.problems,
                periods,
            };
        }),
    };
};
