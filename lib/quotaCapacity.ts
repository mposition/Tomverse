/**
 * How much room a quota scope has left, and what that means for a request.
 *
 * Dark. Nothing calls this yet.
 *
 * ## Capacity is not health
 *
 * A 429 says this key is spending too fast. A 5xx says the provider could not
 * serve the request. They call for opposite responses -- wait, versus go
 * somewhere else -- and today they increment the same counter:
 * `PROVIDER_SCOPED` in `lib/providerErrorClassification.ts` puts `RATE_LIMIT`
 * beside `SERVER_ERROR` and `NETWORK`, and one heartbeat adds to
 * `ProviderHealthState.consecutiveFailures` for all of them. A peak-hour rate
 * limit therefore marches a healthy provider toward a breaker and pushes its
 * traffic onto a fallback about to meet the same wall.
 *
 * Nothing here reads provider health and nothing here writes it.
 *
 * ## A demotion expires; a failure count does not
 *
 * `deprioritizeUntil` is a timestamp. A scope that was busy this afternoon
 * comes back on its own, with nobody noticing it recovered and nothing writing
 * a recovery probe. A counter needs somebody to clear it, and the somebody is
 * usually a success that never arrives because the counter is what stopped the
 * traffic.
 *
 * Pure: no database, no clock (the caller passes `at`), no network.
 */

/** The state as much of it as a decision needs. */
export type QuotaCapacityFacts = {
    retryAfterUntil?: Date | null;
    deprioritizeUntil?: Date | null;
    concurrencyLimit?: number | null;
    concurrencyInUse?: number | null;
    tokenBucketRemaining?: number | null;
};

/**
 * Why a scope cannot take a request now, as a fixed identifier.
 *
 * Separate values rather than one `unavailable`, because the operator reading
 * a refusal needs to know whether to wait, add a key, or look at the provider.
 */
export const CAPACITY_REFUSALS = [
    /** The provider told us when to come back. */
    "retry_after",
    /** Every slot this scope may hold is held. */
    "concurrency_exhausted",
    /** The local bucket is empty. */
    "token_bucket_empty",
] as const;

export type CapacityRefusal = (typeof CAPACITY_REFUSALS)[number];

/**
 * Whether this scope can take a request, and why not.
 *
 * `deprioritizeUntil` is deliberately not a refusal. It orders candidates; it
 * does not remove them. A scope that is merely busy is still better than no
 * answer, and turning a demotion into a refusal is how a rate limit becomes an
 * outage.
 */
export const capacityRefusal = (
    facts: QuotaCapacityFacts,
    at: Date
): CapacityRefusal | null => {
    if (facts.retryAfterUntil && facts.retryAfterUntil.getTime() > at.getTime()) {
        return "retry_after";
    }
    const limit = facts.concurrencyLimit;
    if (typeof limit === "number" && (facts.concurrencyInUse ?? 0) >= limit) {
        return "concurrency_exhausted";
    }
    if (
        typeof facts.tokenBucketRemaining === "number" &&
        facts.tokenBucketRemaining <= 0
    ) {
        return "token_bucket_empty";
    }
    return null;
};

/**
 * Whether this scope should be ranked behind its peers.
 *
 * True only while the window is open. An absent or past `deprioritizeUntil`
 * demotes nobody, which is what makes this recover without anybody watching.
 */
export const isDeprioritized = (facts: QuotaCapacityFacts, at: Date): boolean =>
    Boolean(
        facts.deprioritizeUntil &&
            facts.deprioritizeUntil.getTime() > at.getTime()
    );

/**
 * Whether these facts are internally consistent.
 *
 * The database holds the same rules. Stated here so a caller can say which
 * part is wrong rather than only that the write failed.
 */
export const capacityStateProblems = (facts: {
    rateLimitedCount?: number | null;
    windowStartedAt?: Date | null;
    concurrencyLimit?: number | null;
    concurrencyInUse?: number | null;
    tokenBucketRemaining?: number | null;
    tokenBucketRefilledAt?: Date | null;
}): readonly string[] => {
    const problems: string[] = [];

    const negative = (value: number | null | undefined) =>
        typeof value === "number" && value < 0;
    // A negative in-use count reads as spare capacity, which is the direction
    // that lets too much through.
    if (negative(facts.rateLimitedCount)) problems.push("a count is not negative");
    if (negative(facts.concurrencyInUse)) problems.push("a count is not negative");
    if (negative(facts.concurrencyLimit)) problems.push("a limit is not negative");
    if (negative(facts.tokenBucketRemaining)) problems.push("a bucket is not negative");

    // "Seven rate limits" with no period attached is a number every reader
    // scales differently.
    if ((facts.rateLimitedCount ?? 0) > 0 && !facts.windowStartedAt) {
        problems.push("a count belongs to a window");
    }

    // A level with no fill time cannot be aged, so it would be believed
    // forever.
    const hasLevel = typeof facts.tokenBucketRemaining === "number";
    const hasFill = Boolean(facts.tokenBucketRefilledAt);
    if (hasLevel !== hasFill) {
        problems.push("a bucket level carries the time it was filled");
    }

    return problems;
};
