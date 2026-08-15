/**
 * What two dispatched attempts cost, and who pays for which.
 *
 * Step 2 of `docs/ops/tomverse-chat-auto-router-rollout.md` §9.1, second half.
 * `ChatCreditReservation` carries one `modelId`, one `provider` and one price
 * snapshot, and `settleChatUsage` prices actual usage from that snapshot. A
 * fallback settled through it would have the second model's tokens priced at
 * the first model's rates, the second provider's spend charged to the first
 * provider's budget, and the second attempt's request id dropped on the floor
 * -- `linkChatReservationProviderRequest` writes only into a row whose
 * identifier columns are still null, so the primary wins and the fallback
 * leaves no trace.
 *
 * ## The two ledgers, which are the policy's own
 *
 * Routing policy §7: "Settlement uses actual accepted provider usage. A
 * configured early-failure goodwill threshold may refund the full user charge
 * when failure happens within the first bounded number of tokens, but the rule
 * must be idempotent and must not rewrite provider cost accounting."
 *
 * That sentence separates two ledgers that a single-attempt turn never had to
 * distinguish, because there they are the same number:
 *
 * - **Provider cost** is every attempt, priced at its own provider's rates and
 *   charged to its own provider's budget. A primary that failed after reading
 *   the prompt still cost money at that provider, and pretending otherwise is
 *   the "rewriting provider cost accounting" the policy forbids.
 * - **The user's charge** is the accepted usage only, and only ever from one
 *   attempt. A fallback is Tomverse's decision to retry; charging somebody
 *   twice for one answer because we chose to ask two models is not a
 *   defensible bill, and no wording in §7 supports it.
 *
 * Everything below follows from those two sentences. The module is pure so the
 * split can be argued about in a test rather than in a billing incident.
 */

import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import type { AiModel } from "@/lib/models";

/** Bump when an allocation rule changes, so a settled row can be attributed. */
export const MULTI_ATTEMPT_SETTLEMENT_VERSION = "chat-multi-attempt-v1";

export type AttemptOutcome = "completed" | "cancelled" | "failed" | "empty";

/**
 * The rates one attempt was priced at.
 *
 * Per attempt and not per reservation, which is the entire point: this is the
 * field `ChatBudget` already computes for whichever model is about to run, and
 * the fallback's is a different one.
 */
export type AttemptPriceSnapshot = {
    provider: AiModel["provider"];
    modelId: string;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
    pricingVersion?: string | null;
};

export type AttemptUsage = {
    /** 0 for the primary. §5 numbers attempts within one run. */
    attemptIndex: number;
    price: AttemptPriceSnapshot;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    /** False when the numbers are the estimator's rather than the provider's. */
    usageFromProvider: boolean;
    outcome: AttemptOutcome;
    /** Native web search's own per-call provider cost, where one applies. */
    searchCostMicroUsd?: number;
    searchQueryCount?: number;
    /**
     * The provider's own reported total, where the provider reports one
     * (Perplexity). Authoritative over the token estimate for that attempt,
     * and for that attempt only.
     */
    providerReportedCostMicroUsd?: number | null;
    providerRequestId?: string | null;
    providerResponseId?: string | null;
};

export type PricedAttempt = AttemptUsage & {
    /** What this attempt cost at its own provider, in micro-USD. */
    costMicroUsd: number;
    costSource: "provider_response" | "token_estimate";
    /** Whether the user's charge was computed from this attempt. */
    userBilled: boolean;
};

export type CombinedAttemptSettlement = {
    version: string;
    attempts: readonly PricedAttempt[];
    /** Every attempt, summed. The provider ledger's figure. */
    providerCostMicroUsd: number;
    /** Per provider, because each has its own budget. */
    costByProvider: ReadonlyMap<AiModel["provider"], number>;
    /**
     * The one attempt the user's charge is computed from, or null when there
     * were no attempts at all.
     */
    billedAttempt: PricedAttempt | null;
    /** The outcome of the logical response, not of any one attempt. */
    outcome: AttemptOutcome;
};

const nonNegative = (value: number | undefined) =>
    Number.isFinite(value) ? Math.max(0, Math.round(value!)) : 0;

/**
 * One attempt's own cost, without needing the set it belongs to.
 *
 * Exported because an attempt's cost is now recorded when *that attempt* ends,
 * which is before the set exists: the fallback has not run yet and the primary
 * is already over. `combineAttemptUsage` still prices the whole set the same
 * way -- it calls this -- so the number written at close and the number
 * settlement would have computed are the same number by construction rather
 * than by two implementations agreeing.
 */
export const priceAttempt = (
    attempt: AttemptUsage
): { costMicroUsd: number; costSource: PricedAttempt["costSource"] } =>
    priceOne(attempt);

const priceOne = (attempt: AttemptUsage): { costMicroUsd: number; costSource: PricedAttempt["costSource"] } => {
    const tokenCost = calculateProviderUsageCost({
        inputTokens: attempt.inputTokens,
        cachedInputTokens: attempt.cachedInputTokens,
        outputTokens: attempt.outputTokens,
        inputUsdPerMillionTokens: attempt.price.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: attempt.price.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: attempt.price.cachedInputPriceMultiplier,
    });
    const reported = attempt.providerReportedCostMicroUsd;
    const base =
        typeof reported === "number" && Number.isFinite(reported) && reported >= 0
            ? { costMicroUsd: Math.round(reported), costSource: "provider_response" as const }
            : { costMicroUsd: tokenCost.totalCostMicroUsd, costSource: "token_estimate" as const };
    return {
        ...base,
        costMicroUsd: base.costMicroUsd + nonNegative(attempt.searchCostMicroUsd),
    };
};

/**
 * Which attempt the user pays for.
 *
 * The last one the provider accepted -- `completed` or `empty`, both of which
 * are answers that arrived. If none arrived, the last attempt, which is the
 * one that ended the response and is exactly what a single-attempt failed turn
 * settles today; taking the last rather than the sum is also the conservative
 * direction, and a user should not be charged more because Tomverse retried.
 *
 * Never more than one. That rule is the reason this returns an attempt rather
 * than a total, and `tests/chatMultiAttemptSettlement.test.mjs` asserts it
 * against every ordering of outcomes rather than trusting the sentence.
 */
const billedAttemptIndex = (attempts: readonly AttemptUsage[]): number => {
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
        const outcome = attempts[index].outcome;
        if (outcome === "completed" || outcome === "empty") return index;
    }
    return attempts.length - 1;
};

/**
 * The outcome of the logical response.
 *
 * The user asked one question and got one answer or none, so the response has
 * one outcome and it is the billed attempt's. A primary that failed before a
 * fallback answered did not make the *response* fail; recording it as failed
 * would put a successful turn in the failure numbers, and those numbers are
 * what §10's dashboards read.
 */
export const combineAttemptUsage = (
    attempts: readonly AttemptUsage[]
): CombinedAttemptSettlement => {
    const billedIndex = billedAttemptIndex(attempts);
    const costByProvider = new Map<AiModel["provider"], number>();
    let providerCostMicroUsd = 0;

    const priced = attempts.map((attempt, index): PricedAttempt => {
        const { costMicroUsd, costSource } = priceOne(attempt);
        providerCostMicroUsd += costMicroUsd;
        costByProvider.set(
            attempt.price.provider,
            (costByProvider.get(attempt.price.provider) ?? 0) + costMicroUsd
        );
        return { ...attempt, costMicroUsd, costSource, userBilled: index === billedIndex };
    });

    return {
        version: MULTI_ATTEMPT_SETTLEMENT_VERSION,
        attempts: priced,
        providerCostMicroUsd,
        costByProvider,
        billedAttempt: priced[billedIndex] ?? null,
        outcome: priced[billedIndex]?.outcome ?? "failed",
    };
};

/**
 * Whether a set of attempts can be settled at all.
 *
 * Checked rather than assumed because these are the shapes that would settle
 * *silently wrong*: a duplicate index overwrites an audit row, a gap means an
 * attempt was lost between dispatch and settlement, and more than two attempts
 * means §6's two-build budget was exceeded somewhere upstream and the money is
 * the first place it would show.
 */
export const attemptSetProblems = (
    attempts: readonly AttemptUsage[],
    maximumAttempts = 2
): readonly string[] => {
    const problems: string[] = [];
    if (attempts.length === 0) {
        problems.push("A settlement needs at least one attempt.");
        return problems;
    }
    if (attempts.length > maximumAttempts) {
        problems.push(
            `${attempts.length} attempts exceeds the ${maximumAttempts}-attempt budget.`
        );
    }
    const indexes = attempts.map((attempt) => attempt.attemptIndex);
    if (new Set(indexes).size !== indexes.length) {
        problems.push("Two attempts share an attemptIndex.");
    }
    for (const [position, index] of [...indexes].sort((a, b) => a - b).entries()) {
        if (index !== position) {
            problems.push("Attempt indexes are not 0..n with no gaps.");
            break;
        }
    }
    return problems;
};
