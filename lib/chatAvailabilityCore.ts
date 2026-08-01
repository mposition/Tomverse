// Can this exact request run right now?
//
// The same arithmetic the reservation performs, minus the writes, so the
// composer can answer "will this be accepted" before the user presses send
// instead of after. Pure and shared on purpose: a preview that disagrees with
// the enforcement path is worse than no preview.

import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import {
    CREDIT_BALANCE_INSUFFICIENT,
    OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
    PLAN_ENTITLEMENT_EXHAUSTED,
    PROVIDER_BUDGET_EXHAUSTED,
    type ChatLimitLayer,
} from "@/lib/chatCostSafetyCore";

export type ChatAvailabilityUsage = {
    planCostDayMicroUsd: number;
    planCostMonthMicroUsd: number;
    totalCostDayMicroUsd: number;
    totalCostMonthMicroUsd: number;
};

export type ChatAvailabilityGuardrails = {
    planDay: number;
    planMonth: number;
    totalDay: number;
    totalMonth: number;
};

export type ChatAvailabilityProviderUsage = {
    provider: string;
    requiredCostMicroUsd: number;
    usedDayMicroUsd: number;
    usedMonthMicroUsd: number;
    dayLimitMicroUsd: number;
    monthLimitMicroUsd: number;
};

export type ChatAvailabilityInput = {
    requiredCredits: number;
    planCreditsRemaining: number;
    dailyPlanCreditsRemaining: number | null;
    purchasedCreditsRemaining: number;
    purchasedFundedCostMicroUsd: number;
    /** Cost of the whole request, whoever funds it. */
    totalReservedCostMicroUsd: number;
    /** Share of that cost funded by plan credits. */
    planReservedCostMicroUsd: number;
    /** Share funded by purchased credits. */
    purchasedReservedCostMicroUsd: number;
    guardrails: ChatAvailabilityGuardrails;
    usage: ChatAvailabilityUsage;
    providers?: ChatAvailabilityProviderUsage[];
};

export type ChatAvailabilityBlock = {
    code: string;
    layer: ChatLimitLayer;
    scope: string;
};

export type ChatAvailabilityResult = {
    runnable: boolean;
    block: ChatAvailabilityBlock | null;
    requiredCredits: number;
    planCreditsUsedByRequest: number;
    purchasedCreditsUsedByRequest: number;
    creditsAvailableNow: number;
    creditShortfall: number;
};

const exceeds = (used: number, required: number, limit: number) =>
    required > 0 && used + required > limit;

export const evaluateChatAvailability = (
    input: ChatAvailabilityInput
): ChatAvailabilityResult => {
    const allocation = getChatCreditAllocation({
        requiredCredits: input.requiredCredits,
        monthlyPlanCreditsRemaining: input.planCreditsRemaining,
        dailyPlanCreditsRemaining: input.dailyPlanCreditsRemaining,
        purchasedCreditsRemaining: input.purchasedCreditsRemaining,
    });

    const base = {
        requiredCredits: allocation.requiredCredits,
        planCreditsUsedByRequest: allocation.planReservedCredits,
        purchasedCreditsUsedByRequest: allocation.addOnCreditsRequired,
        creditsAvailableNow: allocation.totalCreditsAvailableNow,
        creditShortfall: Math.max(
            0,
            allocation.requiredCredits - allocation.totalCreditsAvailableNow
        ),
    };

    const blocked = (
        code: string,
        layer: ChatLimitLayer,
        scope: string
    ): ChatAvailabilityResult => ({
        ...base,
        runnable: false,
        block: { code, layer, scope },
    });

    // Entitlement first: a user who simply does not have the credits should be
    // told that, never that an internal safety check fired.
    if (allocation.balanceInsufficient) {
        return blocked(
            input.purchasedCreditsRemaining === 0
                ? PLAN_ENTITLEMENT_EXHAUSTED
                : CREDIT_BALANCE_INSUFFICIENT,
            "entitlement",
            "credits"
        );
    }
    if (allocation.dailyPlanGuardrailBlocked) {
        return blocked(
            "PLAN_DAILY_CREDIT_LIMIT_REACHED",
            "entitlement",
            "daily_plan_credits"
        );
    }
    if (input.purchasedReservedCostMicroUsd > input.purchasedFundedCostMicroUsd) {
        return blocked(
            "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
            "entitlement",
            "purchased_cost_allowance"
        );
    }

    const guardrailChecks: Array<[string, number, number, number]> = [
        [
            "user_plan_cost_day",
            input.usage.planCostDayMicroUsd,
            input.planReservedCostMicroUsd,
            input.guardrails.planDay,
        ],
        [
            "user_plan_cost_month",
            input.usage.planCostMonthMicroUsd,
            input.planReservedCostMicroUsd,
            input.guardrails.planMonth,
        ],
        [
            "user_total_cost_day",
            input.usage.totalCostDayMicroUsd,
            input.totalReservedCostMicroUsd,
            input.guardrails.totalDay,
        ],
        [
            "user_total_cost_month",
            input.usage.totalCostMonthMicroUsd,
            input.totalReservedCostMicroUsd,
            input.guardrails.totalMonth,
        ],
    ];
    for (const [scope, used, required, limit] of guardrailChecks) {
        if (exceeds(used, required, limit)) {
            return blocked(
                OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
                "operational_guardrail",
                scope
            );
        }
    }

    for (const provider of input.providers ?? []) {
        if (
            exceeds(
                provider.usedDayMicroUsd,
                provider.requiredCostMicroUsd,
                provider.dayLimitMicroUsd
            )
        ) {
            return blocked(
                PROVIDER_BUDGET_EXHAUSTED,
                "operational_guardrail",
                `provider_cost_day:${provider.provider}`
            );
        }
        if (
            exceeds(
                provider.usedMonthMicroUsd,
                provider.requiredCostMicroUsd,
                provider.monthLimitMicroUsd
            )
        ) {
            return blocked(
                PROVIDER_BUDGET_EXHAUSTED,
                "operational_guardrail",
                `provider_cost_month:${provider.provider}`
            );
        }
    }

    return { ...base, runnable: true, block: null };
};

/**
 * Splits a request's reserved cost between plan-funded and purchased-funded
 * shares the same way the reservation does: plan credits are consumed first,
 * per model, and each model's cost follows its own credit split.
 */
export const splitReservedCost = (
    budgets: ReadonlyArray<{
        usageCredits: number;
        reservedCostMicroUsd: number;
    }>,
    planCreditsAvailableNow: number
) => {
    let planCreditsLeft = Math.max(0, planCreditsAvailableNow);
    let planCost = 0;
    let purchasedCost = 0;
    for (const budget of budgets) {
        const planCredits = Math.min(planCreditsLeft, budget.usageCredits);
        planCreditsLeft -= planCredits;
        const purchasedCredits = budget.usageCredits - planCredits;
        const purchasedShare =
            purchasedCredits > 0 && budget.usageCredits > 0
                ? Math.ceil(
                      (budget.reservedCostMicroUsd * purchasedCredits) /
                          budget.usageCredits
                  )
                : 0;
        purchasedCost += purchasedShare;
        planCost += budget.reservedCostMicroUsd - purchasedShare;
    }
    return { planCost, purchasedCost };
};
