/**
 * A total, transitive ranking built from criteria that are allowed to abstain.
 *
 * ## The problem this solves
 *
 * A router ranks models by several criteria in order, and two of the rules
 * that make it useful also make a pairwise comparator intransitive:
 *
 * - a criterion *abstains* when it has no reading for one of the two sides, so
 *   that an unmeasured candidate neither wins nor loses on a number it does
 *   not have;
 * - two readings within an epsilon count as the same reading.
 *
 * Each of those on its own produces cycles. With A and B carrying a quality
 * reading, C carrying none, and costs B < C < A: quality says A beats B, cost
 * says B beats C (quality abstained, and B is cheaper) and cost says C beats A
 * likewise. A > B > C > A. And at a 5% epsilon, 100 ties 104 and 104 ties 108
 * while 100 beats 108 outright.
 *
 * `Array.prototype.sort` answers an intransitive comparator with an
 * implementation-defined order rather than with an error, so the failure is
 * silent and depends on the order the caller happened to emit.
 *
 * ## The construction
 *
 * The order is built rather than compared. Every item starts in one group;
 * each criterion splits each surviving group into ordered buckets, and a
 * criterion that cannot speak for *every* member of a group leaves that group
 * whole. The bucket indices an item collects are its rank key, and the ranking
 * is the lexicographic order of those keys -- total and transitive by
 * construction, being integer vectors of equal length.
 *
 * Two rules change meaning under this construction, and both changes are the
 * point:
 *
 * - abstention becomes a property of the *group* rather than of the pair, so
 *   one unmeasured member silences the criterion for everybody it is still
 *   tied with rather than only for the pairs containing it;
 * - epsilon becomes *anchored* rather than pairwise, so a bucket holds the
 *   readings within epsilon of that bucket's own first reading and the chain
 *   above splits into {100, 104} and {108} every time.
 *
 * ## What is here and what is not
 *
 * This module holds the construction. Which criteria there are, what they
 * read, and what the epsilons are, are product decisions and stay with the
 * product -- this takes them as a list and a lookup.
 *
 * Framework-neutral: no imports at all, no globals beyond the language, no
 * clock and no network.
 */

/** One ordered group of items. */
export type Bucket<T> = readonly T[];

/**
 * Splits one group into ordered buckets, best first.
 *
 * Returning `[group]` unchanged is how a criterion abstains: it could not
 * speak for every member, so it leaves the group to the next criterion.
 */
export type Partitioner<T> = (group: Bucket<T>) => Bucket<T>[];

/**
 * Splits by a measured number, with the epsilon anchored to each bucket.
 *
 * Abstains -- returns the group whole -- unless every member has a finite
 * reading. Finite rather than merely defined, because the bucketing groups by
 * comparison and `NaN` compares false against everything, so a member carrying
 * one would land in no bucket at all and leave with a shorter rank key than
 * everybody else.
 *
 * Equal readings are ordered by `tieKeyFor` before bucketing, so the partition
 * does not depend on the order the items arrived in.
 *
 * `relative` compares the difference against the larger magnitude rather than
 * against a flat amount, because a cent between two cheap options is not a
 * cent between two expensive ones.
 */
export const partitionByMetric = <T>(
    group: Bucket<T>,
    readingFor: (item: T) => number | undefined,
    {
        epsilon,
        lowerWins,
        relative,
    }: { epsilon: number; lowerWins: boolean; relative: boolean },
    tieKeyFor: (item: T) => string
): Bucket<T>[] => {
    const readings = new Map<T, number>();
    for (const item of group) {
        const reading = readingFor(item);
        if (typeof reading !== "number" || !Number.isFinite(reading)) {
            return [group];
        }
        readings.set(item, reading);
    }
    const read = (item: T) => readings.get(item) as number;

    const sorted = [...group].sort((left, right) => {
        const a = read(left);
        const b = read(right);
        if (a !== b) return lowerWins ? a - b : b - a;
        const leftKey = tieKeyFor(left);
        const rightKey = tieKeyFor(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

    const withinEpsilon = (reading: number, anchor: number) => {
        if (!relative) return Math.abs(reading - anchor) <= epsilon;
        const larger = Math.max(Math.abs(reading), Math.abs(anchor));
        if (larger === 0) return true;
        return Math.abs(reading - anchor) / larger <= epsilon;
    };

    const buckets: T[][] = [];
    let current: T[] = [];
    let anchor = 0;
    for (const item of sorted) {
        const reading = read(item);
        if (current.length === 0) {
            anchor = reading;
            current.push(item);
            continue;
        }
        if (withinEpsilon(reading, anchor)) {
            current.push(item);
            continue;
        }
        buckets.push(current);
        current = [item];
        anchor = reading;
    }
    if (current.length > 0) buckets.push(current);
    return buckets;
};

/**
 * Splits by a string key, in ascending key order.
 *
 * Total on its own, which is what a last criterion has to be: what it buys is
 * that two runs over the same inputs answer the same way.
 */
export const partitionByKey = <T>(
    group: Bucket<T>,
    keyFor: (item: T) => string
): Bucket<T>[] =>
    [...new Set(group.map(keyFor))]
        .sort()
        .map((key) => group.filter((item) => keyFor(item) === key));

/**
 * Whether `buckets` is a partition of `group`: every member once, nothing
 * else.
 *
 * Identity rather than value, because two items can carry the same key and
 * they are still two entries in the ranking.
 *
 * Counting is not enough. A split that dropped one member and repeated another
 * has the right total and the wrong keys.
 */
export const partitions = <T>(
    buckets: readonly Bucket<T>[],
    group: Bucket<T>
): boolean => {
    const remaining = new Set(group);
    if (remaining.size !== group.length) {
        // The group itself holds the same object twice, which this check
        // cannot reason about. Abstain rather than guess.
        return false;
    }
    for (const bucket of buckets) {
        if (bucket.length === 0) return false;
        for (const item of bucket) {
            if (!remaining.delete(item)) return false;
        }
    }
    return remaining.size === 0;
};

/**
 * Applies the criteria in order and reports which one decided each pair.
 *
 * One pass rather than a ranking plus a separate explanation, so the order a
 * decision is explained by cannot drift from the order it was made in: the
 * criterion named is the position at which two rank keys first differ.
 *
 * `criteria` must not be empty -- with no criteria there is no ranking and
 * nothing to name as the decider. An empty list returns the input order and
 * names nothing, which is the only honest answer available.
 */
export const refineToRanking = <T, C extends string>(
    items: Bucket<T>,
    criteria: readonly C[],
    partitionerFor: (criterion: C) => Partitioner<T>
): {
    ranked: T[];
    decidedBy: (left: T, right: T) => C | null;
} => {
    const keys = new Map<T, number[]>();
    for (const item of items) keys.set(item, []);

    let groups: Bucket<T>[] = [items];
    for (const criterion of criteria) {
        const refined: Bucket<T>[] = [];
        for (const group of groups) {
            // A group of one is already decided. Skipping the partition keeps
            // every rank key the same length, which is what makes the
            // lexicographic comparison below well defined.
            const split =
                group.length <= 1 ? [group] : partitionerFor(criterion)(group);
            // Equal key lengths are the whole basis of that comparison, so
            // they are checked rather than assumed. A partitioner that lost a
            // member would give that item a shorter key, and the final sort
            // would fall back to input order for it: the exact failure this
            // construction exists to remove.
            //
            // Losing the criterion is the safe direction, so a split that is
            // not a partition is treated as an abstention rather than thrown
            // on. A caller that could still answer should not fail over a
            // ranking refinement.
            const buckets = partitions(split, group) ? split : [group];
            buckets.forEach((bucket, index) => {
                for (const item of bucket) keys.get(item)?.push(index);
                refined.push(bucket);
            });
        }
        groups = refined;
    }

    const keyOf = (item: T) => keys.get(item) ?? [];
    const firstDifference = (left: T, right: T) => {
        const a = keyOf(left);
        const b = keyOf(right);
        for (let index = 0; index < a.length; index += 1) {
            if (a[index] !== b[index]) return index;
        }
        return -1;
    };

    return {
        ranked: [...items].sort((left, right) => {
            const index = firstDifference(left, right);
            return index === -1 ? 0 : keyOf(left)[index] - keyOf(right)[index];
        }),
        // Null when nothing separated them: identical rank keys. A caller that
        // wants to name its last criterion there may, but this cannot -- it
        // would be reporting a criterion that did not in fact decide.
        decidedBy: (left, right) => {
            const index = firstDifference(left, right);
            return index === -1 ? null : (criteria[index] ?? null);
        },
    };
};
