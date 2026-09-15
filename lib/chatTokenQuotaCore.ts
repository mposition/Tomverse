// Cumulative token quotas for chat: who is capped, and what a refusal says.
//
// A signed-in account is not capped. Its allowance is credits
// (docs/policy/credit-and-cost-limits.md §2), and the day/month token counters
// that used to refuse it were a second, hidden entitlement: a Pro account with
// 2,744 credits left was refused at 993,616 of 1,000,000 daily tokens after
// about ten long-context turns. Runaway spend on an account is already caught
// by the plan-derived cost guardrail and the provider budgets, and a single
// request is bounded by CHAT_USER_MAX_INPUT_TOKENS.
//
// The `tokens-day` / `tokens-month` buckets are still written for an account,
// with no ceiling, so operators keep the observation.
//
// A guest has no credit ledger, so the token quota is still its allowance and
// stays enforced, per guest subject and per IP.

/** Environment variables that capped a signed-in account and are now ignored. */
export const RETIRED_USER_TOKEN_LIMIT_ENV = [
    "CHAT_USER_TOKENS_PER_DAY",
    "CHAT_USER_TOKENS_PER_MONTH",
] as const;

export const GUEST_TOKENS_PER_DAY_DEFAULT = 40_000;
export const GUEST_TOKENS_PER_MONTH_DEFAULT = 200_000;
/** The IP aggregate admits three guests' worth before refusing. */
export const GUEST_IP_TOKEN_MULTIPLIER = 3;

export type TokenQuotaScope = "day" | "month";

type Environment = Record<string, string | undefined>;

const positiveIntegerFrom = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The retired variables that are still set, so instrumentation.ts can name a
 * leftover at startup. Same test as findRetiredCostLimitEnvNames().
 */
export const findRetiredUserTokenLimitEnvNames = (env: Environment) =>
    RETIRED_USER_TOKEN_LIMIT_ENV.filter(
        (name) => typeof env[name] === "string" && env[name] !== ""
    );

export const guestTokenLimits = (env: Environment) => ({
    day: positiveIntegerFrom(
        env.CHAT_GUEST_TOKENS_PER_DAY,
        GUEST_TOKENS_PER_DAY_DEFAULT
    ),
    month: positiveIntegerFrom(
        env.CHAT_GUEST_TOKENS_PER_MONTH,
        GUEST_TOKENS_PER_MONTH_DEFAULT
    ),
});

/**
 * Response details for a refused guest token quota. Both the guest-subject and
 * the IP refusal carry the same fields, so the client never has to guess when
 * the quota comes back or by how much the request missed.
 */
export const tokenQuotaRefusalDetails = (input: {
    scope: TokenQuotaScope;
    used: number;
    limit: number;
    requiredTokens: number;
    resetAt: Date;
    timeZone: string;
}) => ({
    scope: input.scope,
    requiredTokens: input.requiredTokens,
    availableTokens: Math.max(0, input.limit - input.used),
    resetAt: input.resetAt.toISOString(),
    timeZone: input.timeZone,
});
