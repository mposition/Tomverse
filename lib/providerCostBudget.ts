// The provider-wide spend budget, and the contract that keeps it from becoming
// the hidden USD ceiling this system already had once.
//
// A provider budget is a real operational device: if a provider's cost runs
// away -- a mispriced model, a retry storm, an abusive account -- something has
// to stop it before the invoice does. But it is a *global* cap shared by every
// user, so it fails in the worst possible direction: one bad default rejects
// everybody, with credits in hand, and the 503 says nothing about credits.
//
// It shipped with a silent default of US$10/day and US$100/month per provider.
// That is below what a single Pro account's own plan guardrail allows
// (US$15/day, US$150/month) and far below a Max account's -- so the global cap
// for all users was tighter than one user's entitlement, and the first
// legitimate heavy day would have taken every provider down for everyone. It
// was never the cause of the reported incident, and it was never a regression;
// it was simply the same defect one layer down, waiting.
//
// The contract:
//
//   1. Production names its budgets. There is no production default: an active
//      provider with no configured budget fails readiness rather than silently
//      inheriting a number nobody chose.
//   2. A configured budget below the floor is raised to it and reported. The
//      floor is the largest single-account plan guardrail, because a global cap
//      under one account's own entitlement is incoherent by construction.
//   3. Values are validated, not trusted: positive safe integers, day <= month,
//      and micro-USD rather than dollars -- `10` means one thousandth of a cent,
//      and a budget that small is a typo, not a policy.
//   4. Utilisation is reported before it blocks, at 70/85/95%, so the 503 is
//      the last resort rather than the first news.
//
// See docs/policy/credit-and-cost-limits.md, "Provider 예산 계약".

import { getDefaultBillingPlans } from "@/lib/billingPlanDefaults";
import { getCostGuardrailLimits } from "@/lib/chatCostGuardrails";
import type { AiProvider } from "@/lib/models";

export type ProviderBudgetPeriod = "day" | "month";

/**
 * Defaults for local development and tests only. Never applied in production --
 * `findProviderBudgetProblems()` reports a production provider that would land
 * here, and readiness refuses to come up.
 */
export const DEVELOPMENT_PROVIDER_BUDGET_MICRO_USD = {
    day: 10_000_000,
    month: 100_000_000,
} as const;

/**
 * A budget below this is a unit mistake rather than a policy: US$1/day cannot
 * be an intended cap for a production provider, and the value someone meant to
 * write as micro-USD is a million times larger than the one they wrote in
 * dollars.
 */
export const PROVIDER_BUDGET_UNIT_SUSPICION_MICRO_USD = 1_000_000;

export const providerBudgetEnvName = (
    provider: string,
    period: ProviderBudgetPeriod
) =>
    `CHAT_PROVIDER_${provider.toUpperCase()}_COST_MICROUSD_PER_${period.toUpperCase()}`;

/**
 * The largest per-period cost one account's own *plan* guardrail permits.
 *
 * This is the floor a provider budget may not go below. The argument is not
 * that one account should be free to exhaust a provider -- it is that a global
 * cap *tighter* than a single account's entitlement fires before that account
 * has spent what it is entitled to, which makes the provider budget an
 * entitlement limit wearing an operational name. That is exactly the confusion
 * this codebase spent a release separating.
 *
 * Plan guardrails, not total: the purchased-credit headroom multiple describes
 * what one account may buy on top of its plan, and using it here would push the
 * floor up by 5x on an argument about entitlement that purchased credits do not
 * make. The plan grant is the conservative reading.
 */
export const getSingleAccountCostCeiling = (
    environment: Record<string, string | undefined> = process.env
) => {
    const ceilings = getDefaultBillingPlans().map((plan) => {
        const limits = getCostGuardrailLimits(
            plan.tier,
            {
                dailyCreditLimit: plan.dailyMessageLimit,
                monthlyCreditLimit: plan.monthlyMessageLimit,
            },
            environment
        );
        return { day: limits.planDay, month: limits.planMonth };
    });
    return {
        day: Math.max(...ceilings.map((entry) => entry.day)),
        month: Math.max(...ceilings.map((entry) => entry.month)),
    };
};

export type ProviderBudgetProblemReason =
    | "missing_in_production"
    | "not_a_positive_integer"
    | "below_single_account_ceiling"
    | "day_above_month"
    | "looks_like_dollars";

export type ProviderBudgetProblem = {
    severity: "error" | "warning";
    provider: string;
    period: ProviderBudgetPeriod | "both";
    reason: ProviderBudgetProblemReason;
    envName: string;
    message: string;
};

export type ProviderCostBudget = {
    provider: string;
    /** The budget actually enforced, in micro-USD. */
    day: number;
    month: number;
    /** What the environment said, before any clamp. `null` when unset. */
    configured: { day: number | null; month: number | null };
    /** The floor each period was held to. */
    floor: { day: number; month: number };
    source: "configured" | "development_fallback";
    /** Periods whose configured value was raised to the floor. */
    clampedPeriods: ProviderBudgetPeriod[];
    problems: ProviderBudgetProblem[];
};

const isProduction = (environment: Record<string, string | undefined>) =>
    environment.NODE_ENV === "production";

const readConfigured = (raw: string | undefined) => {
    if (raw === undefined || raw.trim() === "") return { value: null, malformed: false };
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return { value: null, malformed: true };
    }
    return { value: parsed, malformed: false };
};

/**
 * Resolves one provider's budget together with everything wrong with it.
 *
 * Always returns an enforceable pair of numbers, including when configuration
 * is missing or broken: a chat request must not fail open on a budget it could
 * not read. The problems are what readiness and the admin console act on.
 */
export const getProviderCostBudget = (
    provider: string,
    environment: Record<string, string | undefined> = process.env
): ProviderCostBudget => {
    const floor = getSingleAccountCostCeiling(environment);
    const problems: ProviderBudgetProblem[] = [];
    const clampedPeriods: ProviderBudgetPeriod[] = [];
    const production = isProduction(environment);

    const resolvePeriod = (period: ProviderBudgetPeriod) => {
        const envName = providerBudgetEnvName(provider, period);
        const { value, malformed } = readConfigured(environment[envName]);

        if (malformed) {
            problems.push({
                severity: "error",
                provider,
                period,
                reason: "not_a_positive_integer",
                envName,
                message: `${envName} must be a positive whole number of micro-USD; received ${JSON.stringify(environment[envName])}.`,
            });
        } else if (value === null && production) {
            problems.push({
                severity: "error",
                provider,
                period,
                reason: "missing_in_production",
                envName,
                message: `${envName} is not set. Production has no default provider budget -- set it explicitly before enabling ${provider}.`,
            });
        } else if (value !== null && value < PROVIDER_BUDGET_UNIT_SUSPICION_MICRO_USD) {
            problems.push({
                severity: "error",
                provider,
                period,
                reason: "looks_like_dollars",
                envName,
                message: `${envName}=${value} is under US$1 per ${period}. This value is micro-USD (US$1 = 1,000,000); ${value} looks like dollars.`,
            });
        }

        const requested =
            value ?? DEVELOPMENT_PROVIDER_BUDGET_MICRO_USD[period];
        if (requested < floor[period]) {
            if (value !== null) {
                problems.push({
                    severity: "error",
                    provider,
                    period,
                    reason: "below_single_account_ceiling",
                    envName,
                    message: `${envName}=${value} is below the ${floor[period]} micro-USD one account's own plan guardrail allows per ${period}. A provider-wide budget under a single account's entitlement blocks paying users before their own limit does; raised to the floor.`,
                });
            }
            clampedPeriods.push(period);
            return { value, effective: floor[period], envName };
        }
        return { value, effective: requested, envName };
    };

    const day = resolvePeriod("day");
    const month = resolvePeriod("month");

    if (day.effective > month.effective) {
        problems.push({
            severity: "error",
            provider,
            period: "both",
            reason: "day_above_month",
            envName: day.envName,
            message: `${day.envName}=${day.effective} exceeds ${month.envName}=${month.effective}. A daily budget above the monthly one cannot be reached, so the month is the only real limit.`,
        });
    }

    return {
        provider,
        day: day.effective,
        month: month.effective,
        configured: { day: day.value, month: month.value },
        floor,
        source:
            day.value === null && month.value === null
                ? "development_fallback"
                : "configured",
        clampedPeriods,
        problems,
    };
};

/**
 * Back-compatible shape for the reservation path, which only needs the numbers.
 */
export const getProviderCostGuardrailLimits = (
    provider: string,
    environment: Record<string, string | undefined> = process.env
) => {
    const budget = getProviderCostBudget(provider, environment);
    return { day: budget.day, month: budget.month };
};

/**
 * Providers a request can actually reach, and therefore the ones that need a
 * budget. A provider whose every model is disabled cannot spend anything, so
 * requiring configuration for it would only teach operators to set values they
 * do not use.
 */
export const getActiveProviders = (
    models: readonly { provider: AiProvider; enabled?: boolean; status?: string }[]
): AiProvider[] => [
    ...new Set(
        models
            .filter(
                (model) => model.enabled !== false && model.status !== "disabled"
            )
            .map((model) => model.provider)
    ),
];

export const findProviderBudgetProblems = (
    providers: readonly string[],
    environment: Record<string, string | undefined> = process.env
) =>
    providers.flatMap(
        (provider) => getProviderCostBudget(provider, environment).problems
    );

/**
 * Readiness gate. Errors here mean the deployment must not take traffic: either
 * a production provider has no budget, or one is configured so far wrong that
 * honouring it would block legitimate users.
 */
export const getProviderBudgetReadiness = (
    providers: readonly string[],
    environment: Record<string, string | undefined> = process.env
) => {
    const problems = findProviderBudgetProblems(providers, environment);
    const errors = problems.filter((problem) => problem.severity === "error");
    return {
        ready: errors.length === 0,
        errors,
        warnings: problems.filter((problem) => problem.severity === "warning"),
    };
};

export type ProviderBudgetUtilisationLevel =
    | "nominal"
    | "notice"
    | "warning"
    | "critical"
    | "exhausted";

/**
 * Thresholds at which a provider budget is reported before it refuses anything.
 * Ordered descending so the first match is the most severe.
 */
export const PROVIDER_BUDGET_UTILISATION_THRESHOLDS = [
    { level: "critical" as const, ratio: 0.95 },
    { level: "warning" as const, ratio: 0.85 },
    { level: "notice" as const, ratio: 0.7 },
];

/**
 * Where a provider stands against its budget.
 *
 * `usedMicroUsd` is what the bucket already holds; `requiredMicroUsd` is what
 * the request in hand would add. Both are counted, because a request that would
 * cross a threshold is the one worth reporting -- reporting only what has
 * already happened is a report that always arrives late.
 */
export const classifyProviderBudgetUtilisation = ({
    usedMicroUsd,
    requiredMicroUsd,
    limitMicroUsd,
}: {
    usedMicroUsd: number;
    requiredMicroUsd: number;
    limitMicroUsd: number;
}) => {
    const projected = Math.max(0, usedMicroUsd) + Math.max(0, requiredMicroUsd);
    const ratio = limitMicroUsd > 0 ? projected / limitMicroUsd : 1;
    // A non-positive limit cannot be reached by anything, so it is exhausted
    // rather than 0% used. The floor makes this unreachable today; it is here
    // so a future zero cannot read as "plenty of room".
    const level: ProviderBudgetUtilisationLevel =
        limitMicroUsd <= 0 || projected > limitMicroUsd
            ? "exhausted"
            : (PROVIDER_BUDGET_UTILISATION_THRESHOLDS.find(
                  (threshold) => ratio >= threshold.ratio
              )?.level ?? "nominal");
    return { level, ratio, projectedMicroUsd: projected };
};

/**
 * Models a blocked user can actually reach right now: same job, different
 * provider. A provider budget takes out one provider, not the product, so the
 * refusal should say which door is still open.
 *
 * Model IDs only -- never a price, a budget or a micro-USD figure, since this
 * goes into a user-facing error response.
 */
export const findAlternativeModelsForBlockedProvider = ({
    blockedProvider,
    candidateModelIds,
    models,
    limit = 3,
}: {
    blockedProvider: string;
    candidateModelIds: readonly string[];
    models: readonly {
        id: string;
        provider: AiProvider;
        enabled?: boolean;
        status?: string;
    }[];
    limit?: number;
}) =>
    candidateModelIds
        .map((modelId) => models.find((model) => model.id === modelId))
        .filter(
            (model): model is (typeof models)[number] =>
                Boolean(model) &&
                model!.provider !== blockedProvider &&
                model!.enabled !== false &&
                model!.status !== "disabled"
        )
        .slice(0, limit)
        .map((model) => model.id);
