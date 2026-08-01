// Error taxonomy for every reason a chat request can be refused on cost or
// credit grounds, plus the user-facing rendering of the diagnostic details.
//
// The codes are split along the same line as lib/chatCostGuardrails.ts:
// entitlement failures tell the user something actionable about their own
// account, while operational guardrail failures are internal safety events and
// deliberately carry no raw internal USD figures into the client response.

/** The account does not have enough credits (plan + purchased) for the request. */
export const CREDIT_BALANCE_INSUFFICIENT = "CREDIT_BALANCE_INSUFFICIENT";
/** Plan credits are used up and the account holds no purchased credits. */
export const PLAN_ENTITLEMENT_EXHAUSTED = "PLAN_ENTITLEMENT_EXHAUSTED";
/** An internal cost safety guardrail fired. Not an entitlement decision. */
export const OPERATIONAL_COST_GUARDRAIL_TRIGGERED =
    "OPERATIONAL_COST_GUARDRAIL_TRIGGERED";
/** A provider-wide spend budget is exhausted. Affects everyone, not one user. */
export const PROVIDER_BUDGET_EXHAUSTED = "PROVIDER_BUDGET_EXHAUSTED";
/** Two requests raced for the same credits; the caller should retry. */
export const CONCURRENT_RESERVATION_CONFLICT =
    "CONCURRENT_RESERVATION_CONFLICT";

export const CHAT_ENTITLEMENT_CODES = [
    CREDIT_BALANCE_INSUFFICIENT,
    PLAN_ENTITLEMENT_EXHAUSTED,
    "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
    "PLAN_DAILY_CREDIT_LIMIT_REACHED",
    "CHAT_QUOTA_EXCEEDED",
    "FREE_PRO_MODEL_QUOTA_EXCEEDED",
] as const;

export const CHAT_OPERATIONAL_GUARDRAIL_CODES = [
    OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
    PROVIDER_BUDGET_EXHAUSTED,
] as const;

/**
 * Codes retired in favour of OPERATIONAL_COST_GUARDRAIL_TRIGGERED. Still
 * recognised so a client cached from before the change keeps rendering a
 * sensible message, but never emitted any more.
 */
export const LEGACY_CHAT_COST_SAFETY_CODES = [
    "INTERNAL_DAILY_COST_SAFETY_LIMIT",
    "INTERNAL_MONTHLY_COST_SAFETY_LIMIT",
    "PROVIDER_DAILY_SPEND_LIMIT_REACHED",
    "PROVIDER_SPEND_LIMIT_REACHED",
] as const;

export const CHAT_COST_SAFETY_CODES = [
    ...CHAT_OPERATIONAL_GUARDRAIL_CODES,
    ...LEGACY_CHAT_COST_SAFETY_CODES,
] as const;

export const isChatCostSafetyCode = (value: unknown): value is string =>
    typeof value === "string" &&
    CHAT_COST_SAFETY_CODES.includes(
        value as (typeof CHAT_COST_SAFETY_CODES)[number]
    );

export const isChatEntitlementCode = (value: unknown): value is string =>
    typeof value === "string" &&
    CHAT_ENTITLEMENT_CODES.includes(
        value as (typeof CHAT_ENTITLEMENT_CODES)[number]
    );

export type ChatLimitLayer = "entitlement" | "operational_guardrail" | "other";

/**
 * Which of the two limit layers refused the request. The UI uses this to decide
 * whether to talk about the user's own credits or about a temporary internal
 * safety hold -- they are never the same conversation.
 */
export const classifyChatLimitCode = (value: unknown): ChatLimitLayer => {
    if (isChatEntitlementCode(value)) return "entitlement";
    if (isChatCostSafetyCode(value)) return "operational_guardrail";
    return "other";
};

const finiteNonNegative = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : null;

const formatMicroUsd = (value: number) =>
    `US$${(value / 1_000_000).toFixed(4)}`;

const formatResetAt = (candidate: Record<string, unknown>) => {
    if (typeof candidate.resetAt !== "string") return null;
    const resetAt = new Date(candidate.resetAt);
    if (Number.isNaN(resetAt.getTime())) return null;
    const timeZone =
        typeof candidate.timeZone === "string" ? candidate.timeZone : "UTC";
    try {
        return `Reset: ${new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone,
        }).format(resetAt)} (${timeZone})`;
    } catch {
        return `Reset: ${resetAt.toISOString()} (UTC)`;
    }
};

/**
 * Renders the diagnostic line appended under a cost-limit error.
 *
 * Raw internal USD is only rendered when the caller actually supplied it. For
 * an operational guardrail the server omits those fields from the client
 * response on purpose (they go to the structured limit-decision event and the
 * admin console instead), so this degrades to the reset time alone.
 */
export const formatChatCostSafetyDetails = (details: unknown) => {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
        return "";
    }
    const candidate = details as Record<string, unknown>;
    const required = finiteNonNegative(
        candidate.requiredCostMicroUsd ?? candidate.newEstimatedCostMicroUsd
    );
    const available = finiteNonNegative(candidate.availableCostMicroUsd);
    const parts: string[] = [];
    if (required !== null && available !== null) {
        parts.push(
            `Estimated internal cost: ${formatMicroUsd(required)}`,
            `Remaining safety allowance: ${formatMicroUsd(available)}`
        );
    }
    const resetLine = formatResetAt(candidate);
    if (resetLine) parts.push(resetLine);
    return parts.join(" · ");
};
