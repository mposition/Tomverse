// Internal cost limits, split into the two layers the approved policy calls
// for. Before this split there was exactly one per-user USD ceiling
// (CHAT_PRO_COST_MICROUSD_PER_DAY, default US$1.50/day) doing both jobs at
// once, so an ordinary Pro comparison with thousands of plan credits left was
// rejected as if it were an abuse event.
//
//   User entitlement       -- what the account is allowed to spend. Expressed
//                             in credits (plan credits + purchased credits) and
//                             enforced by lib/chatCreditAllocation.ts and the
//                             credit ledger. No hidden USD ceiling lives here.
//
//   Operational guardrail  -- a backstop against abnormal usage, cost blow-ups,
//                             mispriced models and provider incidents. Expressed
//                             in USD, deliberately far above what the plan's own
//                             credits can legitimately buy, and reported with
//                             its own error code, config and metrics.
//
// The guardrail is *derived from* the entitlement rather than picked by hand,
// which is what makes it impossible to reintroduce the original bug: a limit
// below "every credit this plan grants, spent on the most expensive model, at
// the largest allowed prompt" would block legitimate use by construction, so
// the derivation is the floor and any environment override is clamped up to it.

export type CostGuardrailScope =
    | "user_plan_cost"
    | "user_total_cost"
    | "provider_cost";

export type CostGuardrailPeriod = "day" | "month";

/**
 * Upper bound on what one credit can legitimately cost, in micro-USD.
 *
 * Derivation (worst legitimate case as of pricing version 2026-08-01):
 * a premium model is 8 base credits; the largest accepted user prompt is
 * CHAT_USER_MAX_INPUT_TOKENS = 128,000 tokens, which raises the request to the
 * 3x input multiplier, i.e. 24 credits. The most expensive priced premium model
 * at that size is Claude Opus 4.8 (US$5 input / US$25 output):
 *
 *     128,000 x 5      = 640,000 micro-USD input
 *   +   8,192 x 25     = 204,800 micro-USD output (full provider cap)
 *   -------------------------------------------
 *                        844,800 micro-USD / 24 credits = 35,200 per credit
 *
 * Rounded up to 40,000 to leave room for a native-search surcharge and for a
 * future premium model priced somewhat above Opus without needing a migration.
 */
export const COST_PER_CREDIT_CEILING_MICRO_USD = 40_000;

/** Extra headroom over the strict derivation, for rounding and tool overhead. */
export const GUARDRAIL_HEADROOM_MULTIPLIER = 1.25;

/**
 * How much more than the plan's own entitlement the total-cost guardrail
 * allows, so a user who buys add-on credits is bounded by the funded cost
 * allowance on their credit lots rather than by the plan-shaped guardrail.
 */
export const PURCHASED_CREDIT_HEADROOM_MULTIPLE = 5;

/**
 * Absolute floors so an account with a tiny or unconfigured credit limit still
 * gets a usable guardrail instead of a zero.
 */
const MINIMUM_GUARDRAIL_MICRO_USD = {
    day: 1_000_000,
    month: 10_000_000,
} as const;

export type PlanCreditEntitlement = {
    /** Plan credits granted per account-local day. 0 or less means unlimited. */
    dailyCreditLimit: number;
    /** Plan credits granted per calendar month. */
    monthlyCreditLimit: number;
};

export type CostGuardrailLimits = {
    /** Guardrail on plan-funded cost, in micro-USD. */
    planDay: number;
    planMonth: number;
    /** Guardrail on plan-funded + purchased-funded cost, in micro-USD. */
    totalDay: number;
    totalMonth: number;
    /** Derived values before any environment override was applied. */
    derived: {
        planDay: number;
        planMonth: number;
        totalDay: number;
        totalMonth: number;
    };
    /** Overrides that were raised back to the derived floor. */
    clampedOverrides: string[];
};

const positiveInteger = (value: string | undefined) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const planEnvKey = (plan: string, period: CostGuardrailPeriod, kind: "PLAN" | "TOTAL") =>
    `CHAT_COST_GUARDRAIL_${plan.toUpperCase()}_${kind}_MICROUSD_PER_${period.toUpperCase()}`;

/**
 * Environment names that used to hold the per-user *entitlement* ceiling. They
 * are no longer read: the value they carried (US$1.50/day, US$4.50/month for
 * Pro) is far below what a Pro plan's own credits can legitimately buy, so
 * honouring them would restore the bug this module exists to remove.
 */
export const RETIRED_COST_LIMIT_ENV_NAMES = [
    "CHAT_FREE_COST_MICROUSD_PER_DAY",
    "CHAT_FREE_COST_MICROUSD_PER_MONTH",
    "CHAT_PRO_COST_MICROUSD_PER_DAY",
    "CHAT_PRO_COST_MICROUSD_PER_MONTH",
    "CHAT_MAX_COST_MICROUSD_PER_DAY",
    "CHAT_MAX_COST_MICROUSD_PER_MONTH",
] as const;

export const findRetiredCostLimitEnvNames = (
    environment: Record<string, string | undefined> = process.env
) =>
    RETIRED_COST_LIMIT_ENV_NAMES.filter(
        (name) => typeof environment[name] === "string" && environment[name] !== ""
    );

const derivedGuardrail = (credits: number, period: CostGuardrailPeriod) =>
    Math.max(
        MINIMUM_GUARDRAIL_MICRO_USD[period],
        Math.ceil(
            Math.max(0, credits) *
                COST_PER_CREDIT_CEILING_MICRO_USD *
                GUARDRAIL_HEADROOM_MULTIPLIER
        )
    );

/**
 * Operational cost guardrails for one plan.
 *
 * An unlimited daily credit allowance (Max, or any plan configured with
 * `dailyCreditLimit <= 0`) means the day carries no separate constraint, so its
 * daily guardrail is the monthly one -- the month is then the only bound, which
 * is exactly what "no daily limit" should mean.
 */
export const getCostGuardrailLimits = (
    plan: string,
    entitlement: PlanCreditEntitlement,
    environment: Record<string, string | undefined> = process.env
): CostGuardrailLimits => {
    const monthlyCredits = Math.max(0, entitlement.monthlyCreditLimit || 0);
    const dailyCredits = entitlement.dailyCreditLimit;

    const derivedPlanMonth = derivedGuardrail(monthlyCredits, "month");
    const derivedPlanDay =
        dailyCredits > 0
            ? Math.min(derivedGuardrail(dailyCredits, "day"), derivedPlanMonth)
            : derivedPlanMonth;
    const derivedTotalDay = derivedPlanDay * PURCHASED_CREDIT_HEADROOM_MULTIPLE;
    const derivedTotalMonth =
        derivedPlanMonth * PURCHASED_CREDIT_HEADROOM_MULTIPLE;

    const clampedOverrides: string[] = [];
    const applyOverride = (
        envName: string,
        derived: number
    ) => {
        const override = positiveInteger(environment[envName]);
        if (override === null) return derived;
        if (override < derived) {
            // Never let configuration drop the guardrail below what the plan's
            // own credits can legitimately buy. Report it so the operator can
            // fix the value instead of silently blocking paying users.
            clampedOverrides.push(envName);
            return derived;
        }
        return override;
    };

    return {
        planDay: applyOverride(planEnvKey(plan, "day", "PLAN"), derivedPlanDay),
        planMonth: applyOverride(
            planEnvKey(plan, "month", "PLAN"),
            derivedPlanMonth
        ),
        totalDay: applyOverride(
            planEnvKey(plan, "day", "TOTAL"),
            derivedTotalDay
        ),
        totalMonth: applyOverride(
            planEnvKey(plan, "month", "TOTAL"),
            derivedTotalMonth
        ),
        derived: {
            planDay: derivedPlanDay,
            planMonth: derivedPlanMonth,
            totalDay: derivedTotalDay,
            totalMonth: derivedTotalMonth,
        },
        clampedOverrides,
    };
};

/** Guest guardrails stay small and absolute: a guest has no credit entitlement. */
export const getGuestCostGuardrailLimits = (
    environment: Record<string, string | undefined> = process.env
) => ({
    day: positiveInteger(environment.CHAT_GUEST_COST_MICROUSD_PER_DAY) ?? 20_000,
    month:
        positiveInteger(environment.CHAT_GUEST_COST_MICROUSD_PER_MONTH) ??
        100_000,
});

export const getProviderCostGuardrailLimits = (
    provider: string,
    environment: Record<string, string | undefined> = process.env
) => ({
    day:
        positiveInteger(
            environment[`CHAT_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_DAY`]
        ) ?? 10_000_000,
    month:
        positiveInteger(
            environment[
                `CHAT_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_MONTH`
            ]
        ) ?? 100_000_000,
});
