/**
 * Which attempt is holding what against which provider's budget.
 *
 * ## Why this is a separate list and not just the reservation's entries
 *
 * A reservation's `entries` are what settlement reads: one row per bucket, and
 * settlement moves each bucket to what it actually owes. That shape has no
 * room for "who put this here", and for a single-attempt turn it never needed
 * one — there was one holder.
 *
 * §7's automatic fallback gives a turn two, and it broke both directions at
 * once. A fallback on a *different* provider needs its own hold, which the
 * entries could express. A fallback on the *same* provider needs one too --
 * the primary's hold is sized for one attempt and a second call on the same
 * provider costs more -- but the entries cannot express it, because a second
 * row under the same key would be settled twice: settlement moves every
 * `provider:` entry to that provider's whole actual cost, so two rows for one
 * provider each claim the full amount. And a compensating release keyed on the
 * provider would take the primary's hold away with the fallback's.
 *
 * So the holds are recorded per attempt and the entries are *derived* from
 * them. One provider entry per bucket, its amount the sum of what every
 * attempt put there. Releasing an attempt's hold subtracts that attempt's
 * numbers and re-derives, which is the only way to give back exactly what one
 * attempt added on a provider two attempts share.
 *
 * ## The consistency rule, and why storing both needs one
 *
 * Both live in the same JSON on the same row, so they commit together. That
 * makes them atomic and does nothing at all for whether they *agree*: two
 * fields of one object can be written inconsistently in a single write.
 *
 * `providerHoldProblems` is what closes that. It is checked on every read, so
 * a payload whose entries disagree with its holds is refused rather than
 * settled — an entry that overstates the holds would release budget nobody
 * reserved, and one that understates them would leave a provider holding
 * money for a call that finished long ago.
 */

export const PROVIDER_BUCKET_PREFIX = "provider:";

export const providerBucketKey = (provider: string) =>
    `${PROVIDER_BUCKET_PREFIX}${provider}`;

/** The two periods a provider's spend is bounded over. */
export const PROVIDER_BUDGET_PERIODS = [
    "provider-cost-day",
    "provider-cost-month",
] as const;

export type ProviderBudgetPeriod = (typeof PROVIDER_BUDGET_PERIODS)[number];

/** §6's two-build budget, so an index outside it is refused rather than stored. */
export const MAX_ATTEMPT_INDEX = 1;

export type AttemptHold = {
    /** 0 for the primary. Matches `RoutingAttempt.attemptIndex`. */
    attemptIndex: number;
    key: string;
    period: string;
    periodStart: Date;
    amount: number;
};

export type DerivedEntry = {
    key: string;
    period: string;
    periodStart: Date;
    amount: number;
    metric: "cost";
};

const bucketOf = (hold: { key: string; period: string; periodStart: Date }) =>
    [hold.key, hold.period, hold.periodStart.toISOString()].join("|");

/**
 * The provider entries a set of holds adds up to.
 *
 * Deterministic: sorted by bucket, so two payloads holding the same amounts
 * serialize identically and a diff between them is a real difference rather
 * than a reordering.
 */
export const deriveProviderEntries = (
    holds: readonly AttemptHold[]
): DerivedEntry[] => {
    const byBucket = new Map<string, DerivedEntry>();
    for (const hold of holds) {
        const bucket = bucketOf(hold);
        const existing = byBucket.get(bucket);
        if (existing) {
            existing.amount += hold.amount;
            continue;
        }
        byBucket.set(bucket, {
            key: hold.key,
            period: hold.period,
            periodStart: hold.periodStart,
            amount: hold.amount,
            metric: "cost",
        });
    }
    return [...byBucket.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, entry]) => entry);
};

/**
 * Everything wrong with a payload's provider holds, or nothing.
 *
 * Read on every deserialize. A payload that fails this is not settled, because
 * every failure here is a way for money to move that nobody authorized:
 *
 * - **entries disagreeing with holds** — settlement would release an amount
 *   that was never reserved, or leave one that was;
 * - **a duplicate hold** — one attempt claiming the same bucket twice, which
 *   double-counts on release;
 * - **an attempt index outside 0..1** — §6's build budget was exceeded
 *   somewhere upstream and the money is where it shows;
 * - **a hold that is not one provider, one day and one month at one amount**
 *   — every other shape leaves a bucket that release cannot fully give back,
 *   because release subtracts what the holds say was put there.
 */
export const providerHoldProblems = (input: {
    holds: readonly AttemptHold[];
    entries: readonly {
        key: string;
        period: string;
        periodStart: Date;
        amount: number;
    }[];
}): readonly string[] => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const holdsByAttempt = new Map<number, AttemptHold[]>();

    for (const hold of input.holds) {
        if (
            !Number.isInteger(hold.attemptIndex) ||
            hold.attemptIndex < 0 ||
            hold.attemptIndex > MAX_ATTEMPT_INDEX
        ) {
            problems.push(
                `attempt ${hold.attemptIndex} is outside the 0..${MAX_ATTEMPT_INDEX} build budget`
            );
        }
        if (!hold.key.startsWith(PROVIDER_BUCKET_PREFIX)) {
            problems.push(`"${hold.key}" is not a provider bucket`);
        }
        if (!(PROVIDER_BUDGET_PERIODS as readonly string[]).includes(hold.period)) {
            problems.push(`"${hold.period}" is not a provider budget period`);
        }
        if (hold.amount < 0) {
            problems.push(`attempt ${hold.attemptIndex} holds a negative amount`);
        }
        const identity = `${hold.attemptIndex}|${bucketOf(hold)}`;
        if (seen.has(identity)) {
            problems.push(
                `attempt ${hold.attemptIndex} holds ${hold.key}/${hold.period} twice`
            );
        }
        seen.add(identity);
        holdsByAttempt.set(hold.attemptIndex, [
            ...(holdsByAttempt.get(hold.attemptIndex) ?? []),
            hold,
        ]);
    }

    // A hold is one provider, one day, one month, both the same amount.
    //
    // The looser "no more than two periods" this replaces was nearly vacuous:
    // there are only two allowed periods, so almost nothing could fail it. The
    // shapes it let through are all reachable and all wrong -- a day hold on
    // one provider and a month hold on another, a day hold with no month, two
    // periods holding different amounts. Each leaves a bucket that release
    // cannot fully give back, because release subtracts what the holds say.
    for (const [attemptIndex, holds] of holdsByAttempt) {
        const keys = new Set(holds.map((hold) => hold.key));
        if (keys.size > 1) {
            problems.push(
                `attempt ${attemptIndex} holds ${keys.size} providers; an attempt runs on one`
            );
        }
        for (const period of PROVIDER_BUDGET_PERIODS) {
            const count = holds.filter((hold) => hold.period === period).length;
            if (count !== 1) {
                problems.push(
                    `attempt ${attemptIndex} holds ${count} ${period} rows; a hold is exactly one of each`
                );
            }
        }
        const amounts = new Set(holds.map((hold) => hold.amount));
        if (amounts.size > 1) {
            problems.push(
                `attempt ${attemptIndex} holds ${[...amounts].join(" and ")}; ` +
                    "the day and month holds are the same reservation"
            );
        }
    }

    // The agreement check. Compared bucket by bucket rather than by total,
    // because two errors that cancel out in a sum are still two errors.
    const derived = new Map(
        deriveProviderEntries(input.holds).map((entry) => [
            bucketOf(entry),
            entry.amount,
        ])
    );
    for (const entry of input.entries) {
        if (!entry.key.startsWith(PROVIDER_BUCKET_PREFIX)) continue;
        const bucket = bucketOf(entry);
        const expected = derived.get(bucket);
        if (expected === undefined) {
            problems.push(
                `${entry.key}/${entry.period} is held by no attempt`
            );
            continue;
        }
        if (expected !== entry.amount) {
            problems.push(
                `${entry.key}/${entry.period} holds ${entry.amount} but its attempts add to ${expected}`
            );
        }
        derived.delete(bucket);
    }
    for (const [bucket, amount] of derived) {
        problems.push(
            `${bucket.split("|")[0]} has ${amount} held by an attempt and no entry to settle it`
        );
    }

    return problems;
};

/**
 * The holds after one attempt gives its own back.
 *
 * By attempt index, never by provider. Two attempts on one provider share a
 * bucket, and releasing "the provider's hold" would take the primary's away
 * with the fallback's -- which is the bug this whole module exists to make
 * unrepresentable.
 */
export const withoutAttemptHolds = (
    holds: readonly AttemptHold[],
    attemptIndex: number
): AttemptHold[] => holds.filter((hold) => hold.attemptIndex !== attemptIndex);

/**
 * What an attempt was authorized to spend, and at what rates.
 *
 * Written when the hold is taken, which is before the provider is called.
 * That order is what makes a crash recoverable: the sweep that finds a
 * `pending` attempt half an hour later has no memory of the request, and the
 * only honest thing it can record is what the attempt was allowed to spend.
 * Without this it would have to write 0, which is a claim that a call which
 * demonstrably happened used nothing.
 *
 * Not the same as the hold. The hold is the money reserved in the bucket; this
 * is how to turn that reservation back into a cost row -- which model, which
 * provider, at which rates, against which estimate.
 */
export type AttemptCostIntent = {
    attemptIndex: number;
    modelId: string;
    provider: string;
    /** The estimate the reservation was sized on. */
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier: number;
    pricingVersion?: string | null;
    /** What the hold put in the bucket. The upper bound a crash records. */
    reservedCostMicroUsd: number;
    /**
     * The native web search this attempt was authorized to run, if any.
     *
     * Here rather than on the reservation because an authorization is a
     * contract with one dispatched attempt: a fallback runs a different model
     * at a different provider, with its own rate and its own ceiling. Native
     * search is excluded from fallback today, and putting this at the top
     * level would mean changing the schema again on the day it is not.
     *
     * Frozen so settlement prices what was authorized. Recomputing from the
     * live registry would let a price change between dispatch and settlement
     * silently rewrite what a turn was allowed to spend.
     */
    nativeSearchAuthorization?: {
        reservedCostMicroUsd: number;
        costPerQueryMicroUsd: number;
        maxQueries: number;
    };
};

/**
 * Whether the intents and the holds agree about what was authorized.
 *
 * The two answer different questions and are deliberately not required to
 * match one-for-one. An intent is the authorization -- which model, at which
 * rates, up to what -- and every dispatched attempt has one, including a turn
 * whose rates are all zero. A hold is money actually put in a budget bucket,
 * which only a positive authorization does.
 *
 * So: zero authorized and no hold is the normal shape of a free turn, and
 * needs no special case anywhere downstream. Positive authorized with a
 * missing bucket is a lost hold. Zero authorized with a hold is money nothing
 * authorized. And a hold with no intent is the one that can never be
 * reconstructed -- the bucket moved and nothing says why.
 */
export const attemptCostIntentProblems = (input: {
    holds: readonly AttemptHold[];
    intents: readonly AttemptCostIntent[];
    /** The period this reservation's provider budget was anchored to. */
    periodStarts?: { day: Date; month: Date };
}): readonly string[] => {
    const problems: string[] = [];
    const intentAttempts = new Set(input.intents.map((intent) => intent.attemptIndex));
    if (intentAttempts.size !== input.intents.length) {
        problems.push("two cost intents share an attemptIndex");
    }

    const holdsByAttempt = new Map<number, AttemptHold[]>();
    for (const hold of input.holds) {
        holdsByAttempt.set(hold.attemptIndex, [
            ...(holdsByAttempt.get(hold.attemptIndex) ?? []),
            hold,
        ]);
    }

    // A hold with no intent is corruption in every case. The intent is the
    // record of what was authorized and at what rates; money moved in a bucket
    // with nothing saying why is the one combination that can never be
    // reconstructed.
    for (const attemptIndex of holdsByAttempt.keys()) {
        if (!intentAttempts.has(attemptIndex)) {
            problems.push(`attempt ${attemptIndex} has a hold and no cost intent`);
        }
    }

    for (const intent of input.intents) {
        // The parts have to add up to the whole. `reservedCostMicroUsd` is
        // what the hold put in the bucket, and it is the sum of the token
        // reservation and the search reservation -- an authorization whose
        // components disagree with its total is one nobody can audit.
        const search = intent.nativeSearchAuthorization;
        if (search) {
            const expectedSearch = Math.ceil(
                search.costPerQueryMicroUsd * search.maxQueries
            );
            if (search.reservedCostMicroUsd !== expectedSearch) {
                problems.push(
                    `attempt ${intent.attemptIndex} authorized ${search.reservedCostMicroUsd} for search but ${search.maxQueries} queries at ${search.costPerQueryMicroUsd} is ${expectedSearch}`
                );
            }
            const tokens =
                Math.ceil(
                    intent.estimatedInputTokens * intent.inputUsdPerMillionTokens
                ) +
                Math.ceil(
                    intent.reservedOutputTokens * intent.outputUsdPerMillionTokens
                );
            if (
                intent.reservedCostMicroUsd !==
                tokens + search.reservedCostMicroUsd
            ) {
                problems.push(
                    `attempt ${intent.attemptIndex} reserved ${intent.reservedCostMicroUsd}, which is not ${tokens} of tokens plus ${search.reservedCostMicroUsd} of search`
                );
            }
        }
        const held = holdsByAttempt.get(intent.attemptIndex) ?? [];
        if (intent.reservedCostMicroUsd > 0) {
            // A positive authorization has to have moved both buckets. One of
            // them missing means a hold was lost, and release would give back
            // less than was taken.
            const missing = PROVIDER_BUDGET_PERIODS.filter(
                (period) => !held.some((hold) => hold.period === period)
            );
            if (missing.length > 0) {
                problems.push(
                    `attempt ${intent.attemptIndex} authorized ${intent.reservedCostMicroUsd} and holds no ${missing.join(" or ")}`
                );
            }
            continue;
        }
        // Zero authorized, so nothing was put in a bucket. A hold here would
        // be money reserved against an authorization that says none was.
        if (held.length > 0) {
            problems.push(
                `attempt ${intent.attemptIndex} authorized nothing and holds ${held.length} bucket(s)`
            );
        }
    }
    // Every hold belongs to the period the reservation was authorized in.
    // A hold on another period is one settlement would not release: it
    // subtracts from the bucket the payload names, and that would be a
    // different row.
    if (input.periodStarts) {
        const anchored: Record<string, Date> = {
            "provider-cost-day": input.periodStarts.day,
            "provider-cost-month": input.periodStarts.month,
        };
        for (const hold of input.holds) {
            const expected = anchored[hold.period];
            if (expected && hold.periodStart.getTime() !== expected.getTime()) {
                problems.push(
                    `attempt ${hold.attemptIndex} holds ${hold.period} at ${hold.periodStart.toISOString()}, not the reservation's ${expected.toISOString()}`
                );
            }
        }
    }
    return problems;
};

/** The intent for one attempt, or null when the payload predates them. */
export const costIntentFor = (
    intents: readonly AttemptCostIntent[] | undefined,
    attemptIndex: number
): AttemptCostIntent | null =>
    intents?.find((intent) => intent.attemptIndex === attemptIndex) ?? null;
