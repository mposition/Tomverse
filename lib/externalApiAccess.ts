import "server-only";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
    EXTERNAL_API_PLAN_REQUIRED_MESSAGE,
    externalApiPlanAllowed,
    externalApiUserAllowed,
} from "@/lib/externalApiCatalogCore";

type BillingPlan = Awaited<ReturnType<typeof getUserBillingPlan>>;

export type ExternalApiAccountDecision =
    | { allowed: true; plan: BillingPlan }
    | { allowed: false; code: "account_not_enabled" | "plan_not_eligible"; message: string };

/**
 * The account check every keyed request makes after the key itself is
 * accepted: on the allowlist, and on a paid plan now. Read per request, so a
 * key made on a paid plan stops working as soon as the account is Free.
 */
export const externalApiAccountAccess = async (userId: string): Promise<ExternalApiAccountDecision> => {
    if (!externalApiUserAllowed(process.env, userId)) {
        return { allowed: false, code: "account_not_enabled", message: "The Tomverse API is not enabled for this account." };
    }
    const plan = await getUserBillingPlan(userId);
    if (!externalApiPlanAllowed(plan.tier)) {
        return { allowed: false, code: "plan_not_eligible", message: EXTERNAL_API_PLAN_REQUIRED_MESSAGE };
    }
    return { allowed: true, plan };
};
