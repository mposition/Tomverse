// The storage contract behind the operational cost guardrails.
//
// `ChatUsageBucket."count"` carries three different metrics: request counts,
// token counts, and the cost guardrails in micro-USD. The guardrails are
// derived from the plan's own credit grant, so the largest value the column
// ever has to hold is a product of policy constants -- change any one of them
// and the storage requirement moves with it.
//
// That product outgrew int4 once already: the Max plan's default 10,000
// monthly credits produce a 2,500,000,000 micro-USD total-cost guardrail
// against int4's 2,147,483,647 ceiling, so PostgreSQL raised 22003 instead of
// returning an allow/deny decision and every Max-plan request failed. The
// column is BIGINT now; this module is what keeps the arithmetic and the
// column in agreement, so the next constant change is caught in CI rather
// than in production.
//
// See docs/policy/credit-and-cost-limits.md, "저장 자료형 계약".

import { getDefaultBillingPlans } from "@/lib/billingPlanDefaults";
import { getCostGuardrailLimits } from "@/lib/chatCostGuardrails";

/** PostgreSQL `integer` upper bound. The ceiling the column outgrew. */
export const POSTGRES_INT4_MAX = 2_147_483_647;

/** PostgreSQL `bigint` upper bound. The column's current capacity. */
// Constructed rather than written as a `n` literal: the compile target is
// below ES2020, where BigInt literals are a syntax error.
export const POSTGRES_INT8_MAX = BigInt("9223372036854775807");

export type PlanGuardrailStorage = {
    plan: string;
    dailyCreditLimit: number;
    monthlyCreditLimit: number;
    /** Largest micro-USD value this plan's guardrails can put in the column. */
    largestStoredValue: number;
    /** Which derived limit produced it. */
    largestLimit: "planDay" | "planMonth" | "totalDay" | "totalMonth";
    exceedsInt4: boolean;
};

/**
 * The largest value each built-in plan can store in `ChatUsageBucket.count`.
 *
 * A bucket is allowed to reach its limit, so the limit itself is the storage
 * requirement -- not an approximation of it.
 */
export const getPlanGuardrailStorage = (
    environment: Record<string, string | undefined> = {}
): PlanGuardrailStorage[] =>
    getDefaultBillingPlans().map((plan) => {
        const limits = getCostGuardrailLimits(
            plan.tier,
            {
                dailyCreditLimit: plan.dailyMessageLimit,
                monthlyCreditLimit: plan.monthlyMessageLimit,
            },
            environment
        );
        const candidates = [
            ["planDay", limits.planDay],
            ["planMonth", limits.planMonth],
            ["totalDay", limits.totalDay],
            ["totalMonth", limits.totalMonth],
        ] as const;
        const [largestLimit, largestStoredValue] = candidates.reduce(
            (best, candidate) => (candidate[1] > best[1] ? candidate : best)
        );
        return {
            plan: plan.tier,
            dailyCreditLimit: plan.dailyMessageLimit,
            monthlyCreditLimit: plan.monthlyMessageLimit,
            largestStoredValue,
            largestLimit,
            exceedsInt4: largestStoredValue > POSTGRES_INT4_MAX,
        };
    });

/**
 * Monthly credits at which the total-cost guardrail passes int4.
 *
 * Recorded so the boundary in the policy document stays a computed fact rather
 * than a number someone has to trust. Roughly 8,590 with today's constants.
 */
export const getInt4CreditBoundary = () => {
    // Binary search the smallest monthly credit grant whose derived total-month
    // guardrail exceeds int4, using the same derivation the runtime uses.
    const totalMonthFor = (monthlyCreditLimit: number) =>
        getCostGuardrailLimits(
            "Max",
            { dailyCreditLimit: 0, monthlyCreditLimit },
            {}
        ).derived.totalMonth;

    let low = 1;
    let high = 1_000_000;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (totalMonthFor(middle) > POSTGRES_INT4_MAX) high = middle;
        else low = middle + 1;
    }
    return low;
};

export type UsageBucketRangeProblem = {
    severity: "error";
    message: string;
};

/**
 * Every way the storage contract can be broken, checked together: the column's
 * declared type, a migration narrowing it back, and any plan whose derived
 * guardrail would not survive the column or JavaScript's exact integer range.
 */
export const findUsageBucketRangeProblems = ({
    prismaSchema,
    migrationSql,
    environment = {},
}: {
    prismaSchema: string;
    /** Concatenated SQL of every migration, for the narrowing check. */
    migrationSql: string;
    environment?: Record<string, string | undefined>;
}): UsageBucketRangeProblem[] => {
    const problems: UsageBucketRangeProblem[] = [];

    const model = prismaSchema.match(
        /model\s+ChatUsageBucket\s*\{([\s\S]*?)\n\}/
    );
    if (!model) {
        problems.push({
            severity: "error",
            message: "ChatUsageBucket is missing from prisma/schema.prisma.",
        });
    } else if (!/^\s*count\s+BigInt\b/m.test(model[1])) {
        problems.push({
            severity: "error",
            message:
                'ChatUsageBucket.count must stay `BigInt`. The cost guardrails stored in it pass int4 for any plan above ~8,590 monthly credits, where PostgreSQL raises 22003 instead of returning an allow/deny decision.',
        });
    }

    // A migration that narrows the column back re-creates the original outage.
    const narrowing =
        /ALTER\s+TABLE\s+"ChatUsageBucket"[\s\S]{0,200}?ALTER\s+COLUMN\s+"count"[\s\S]{0,80}?\b(INTEGER|INT4|INT|SMALLINT)\b/gi;
    if (narrowing.test(migrationSql)) {
        problems.push({
            severity: "error",
            message:
                'A migration narrows ChatUsageBucket."count" back to an integer type. Widen-only: see docs/policy/credit-and-cost-limits.md.',
        });
    }

    for (const plan of getPlanGuardrailStorage(environment)) {
        if (BigInt(plan.largestStoredValue) > POSTGRES_INT8_MAX) {
            problems.push({
                severity: "error",
                message: `${plan.plan} plan's ${plan.largestLimit} guardrail (${plan.largestStoredValue}) exceeds PostgreSQL bigint.`,
            });
        }
        if (!Number.isSafeInteger(plan.largestStoredValue)) {
            problems.push({
                severity: "error",
                message: `${plan.plan} plan's ${plan.largestLimit} guardrail (${plan.largestStoredValue}) is not a safe JavaScript integer, so usageBucketCount() would reject it on read.`,
            });
        }
    }

    return problems;
};
