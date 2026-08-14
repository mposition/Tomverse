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
