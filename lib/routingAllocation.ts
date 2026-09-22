/**
 * How a candidate was picked, and what the pick was seeded on.
 *
 * Dark. Both columns exist on `RoutingRun`, nothing writes them, and
 * `npm run check:dark-tables` holds that.
 *
 * ## Why this is not `RoutingRun.mode`
 *
 * `mode` answers "was this decision acted on" -- its only value is `shadow`,
 * meaning the router computed a ranking and the person's own selection stayed
 * authoritative. Allocation answers a different question: given that a ranking
 * was computed, was the top of it taken, or was something else taken on
 * purpose.
 *
 * The two are independent. A shadow run can be deterministic or exploratory,
 * and a live run can be either. Folding them into one column would produce a
 * value like `shadow_explore` whose two halves have to be pulled apart again
 * by every reader, and the first reader to get that wrong would report
 * exploration rate over the wrong denominator.
 *
 * ## Why the seed grain is recorded beside it
 *
 * The routing ADR's own first risk is that a per-request seed breaks cache
 * affinity: a conversation that re-rolls its allocation every turn never
 * returns to the placement holding its prefix, and the saving disappears
 * without anything reporting a failure.
 *
 * `DeploymentCacheAffinity` records where turns landed. This records what the
 * allocator was seeded on. Neither alone can say whether affinity was being
 * broken on purpose or by accident; together they can.
 *
 * So an exploratory allocation must name its grain. A deterministic one has no
 * seed at all, and a run from before the allocator existed has neither -- that
 * last case is null rather than `deterministic`, because reading a missing
 * record as "we chose the top candidate" is inventing a decision nobody made.
 *
 * Pure: no database, no clock, no network.
 */

/**
 * Whether the ranking's top candidate was taken.
 *
 * Two values, and no third for "we do not know": not knowing is the null
 * column, which is a different thing from a recorded allocation.
 */
export const ROUTING_ALLOCATION_MODES = [
    /** The top of the ranking, with nothing random in the choice. */
    "deterministic",
    /** Something other than the top, chosen inside an approved bound. */
    "explore_bounded",
] as const;

export type RoutingAllocationMode = (typeof ROUTING_ALLOCATION_MODES)[number];

/**
 * What an exploratory pick was seeded on.
 *
 * `request` re-rolls every turn, which is correct for a stateless workload and
 * is the thing that silently breaks cache affinity on a stateful one.
 * `session` holds a conversation on one placement across turns, so the prefix
 * it built up is still there to be read back.
 */
export const ROUTING_ALLOCATION_SEED_GRAINS = ["request", "session"] as const;

export type RoutingAllocationSeedGrain =
    (typeof ROUTING_ALLOCATION_SEED_GRAINS)[number];

export type RoutingAllocationInput = {
    allocationMode?: string | null;
    allocationSeedGrain?: string | null;
};

/**
 * Why an allocation record is not well formed, or an empty list.
 *
 * The database holds the same rules. Here so a caller can say which part is
 * wrong rather than only that the write failed.
 */
export const routingAllocationProblems = (
    input: RoutingAllocationInput
): readonly string[] => {
    const problems: string[] = [];
    const mode = input.allocationMode ?? null;
    const grain = input.allocationSeedGrain ?? null;

    if (mode !== null && !(ROUTING_ALLOCATION_MODES as readonly string[]).includes(mode)) {
        problems.push(`unknown allocation mode ${JSON.stringify(mode)}`);
    }
    if (
        grain !== null &&
        !(ROUTING_ALLOCATION_SEED_GRAINS as readonly string[]).includes(grain)
    ) {
        problems.push(`unknown allocation seed grain ${JSON.stringify(grain)}`);
    }
    if (problems.length > 0) return problems;

    // A run from before the allocator existed. Null rather than
    // `deterministic`, because reading a missing record as "we took the top
    // candidate" is inventing a decision nobody made.
    if (mode === null) {
        if (grain !== null) {
            problems.push("a seed grain belongs to an allocation that was recorded");
        }
        return problems;
    }

    // Deterministic means nothing was rolled, so there was no seed to name.
    if (mode === "deterministic" && grain !== null) {
        problems.push("a deterministic allocation has no seed");
    }
    // An exploration whose seed grain went unrecorded cannot be replayed, and
    // nothing can say afterwards whether it was breaking cache affinity.
    if (mode === "explore_bounded" && grain === null) {
        problems.push("an exploration names what it was seeded on");
    }

    return problems;
};

/**
 * How often this allocation could move a conversation off the placement
 * holding its prefix.
 *
 * Four answers rather than a boolean, because a boolean was conflating two
 * different exposures. An earlier version answered `false` for a
 * session-seeded exploration, and that is wrong: a session seed re-picks once
 * when the session starts, and that one pick can land somewhere other than
 * where the conversation had been going. What it does not do is re-pick every
 * turn, which is the request-seeded case and a different size of problem.
 *
 * `unknown` covers both a run that recorded no allocation and an exploration
 * that recorded no grain. The second is a row the constraint refuses, so
 * reaching it means reading something written before the constraint; either
 * way the honest answer is that nothing can be said, not `never`.
 *
 * Says what the allocation *could* do, never what it did. What it did is
 * `DeploymentCacheAffinity`, which records where turns actually landed -- a
 * per-request exploration may re-pick the same placement every time.
 */
export const CACHE_AFFINITY_EXPOSURES = [
    "unknown",
    "never",
    "once_per_session",
    "every_turn",
] as const;

export type CacheAffinityExposure = (typeof CACHE_AFFINITY_EXPOSURES)[number];

export const cacheAffinityExposure = (
    input: RoutingAllocationInput
): CacheAffinityExposure => {
    const mode = input.allocationMode ?? null;
    if (mode === null) return "unknown";
    if (mode === "deterministic") return "never";
    if (mode !== "explore_bounded") return "unknown";
    switch (input.allocationSeedGrain ?? null) {
        case "request":
            return "every_turn";
        case "session":
            return "once_per_session";
        default:
            return "unknown";
    }
};
/**
 * The exploration the router is allowed to do, and what it was told to do it
 * with.
 *
 * `enabled` has no default anywhere. The caller passes it or exploration does
 * not happen, which is the fail-closed direction: an allocator that explored
 * because a configuration key was missing would be changing which model
 * answers a person's turn on the strength of an omission.
 */
export type TieExplorationPolicy = {
    enabled: boolean;
    /** What the pick is seeded on. Recorded on the run beside the mode. */
    seedGrain: RoutingAllocationSeedGrain;
    /**
     * The seed itself. A string, hashed here, so the caller decides what it is
     * derived from -- a conversation id for `session`, a request id for
     * `request` -- and this module never reaches for one.
     */
    seed: string;
};

export type TieAllocation<T> = {
    chosen: T;
    /** The candidates the ranking could not separate, in ranked order. */
    tied: readonly T[];
    allocationMode: RoutingAllocationMode;
    /** Null exactly when the mode is `deterministic`. */
    allocationSeedGrain: RoutingAllocationSeedGrain | null;
};

/**
 * A 32-bit FNV-1a hash, written out rather than imported.
 *
 * Not a security primitive and not asked to be one: what it has to do is turn
 * a seed into the same bucket every time, including in a replay months later.
 * Written here so this module keeps no imports at all, which is what lets it
 * be read as the pure thing it claims to be.
 */
const hash32 = (value: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        // The FNV prime, as shifts, because `hash * 16777619` loses precision
        // once the product passes 2^53.
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash >>> 0;
};

/**
 * Picks one candidate, optionally spreading across the ones the ranking could
 * not separate.
 *
 * ## Why the tie and not a near-best set
 *
 * The routing ADR allocates with a softmax over a `routing_penalty`: a single
 * scalar the criteria are folded into, with a temperature deciding how far
 * from the best the traffic spreads. This does not do that, and the reason is
 * not implementation effort.
 *
 * Folding the criteria into one number is a change to the objective function,
 * which is lexicographic by decision. Making it a weighted sum means stating
 * how much quality a dollar is worth, and that trade has not been decided by
 * anyone. A softmax over it would be that decision arriving as a temperature
 * constant.
 *
 * What a lexicographic ranking gives instead is a set that needs no such
 * trade: the candidates its real criteria could not separate. Under partition
 * refinement those land in one bucket and are told apart only by the last
 * criterion, which the policy describes as arbitrary. Spreading across them
 * costs nothing the policy can name, because the policy has already said they
 * are equivalent.
 *
 * So this explores inside a tie and never outside one. Exploring outside would
 * need the trade.
 *
 * ## What it still is not
 *
 * Spreading across a tie is a change to which model answers a turn, so it is
 * off unless a caller says otherwise. A tie of one is deterministic whatever
 * the policy says -- there is nothing to spread across.
 *
 * The pick is a hash of the seed, so a replay of the same run picks the same
 * candidate. Ordering the tie by `keyFor` before the modulo is what makes that
 * true: the ranked order within a bucket already comes from the last
 * criterion, but a caller that re-ranked with one more candidate would shift
 * every index after it.
 */
export const allocateWithinTie = <T>(
    ranked: readonly T[],
    isTiedWithTop: (candidate: T) => boolean,
    keyFor: (candidate: T) => string,
    exploration: TieExplorationPolicy | null
): TieAllocation<T> | null => {
    if (ranked.length === 0) return null;

    const tied = ranked.filter(isTiedWithTop);
    // The top is tied with itself. A predicate that excludes it has been given
    // the wrong comparison, and taking its word would drop the winner.
    const candidates = tied.includes(ranked[0]) ? tied : [ranked[0], ...tied];

    const deterministic: TieAllocation<T> = {
        chosen: ranked[0],
        tied: candidates,
        allocationMode: "deterministic",
        allocationSeedGrain: null,
    };

    if (!exploration?.enabled) return deterministic;
    if (candidates.length <= 1) return deterministic;
    // A seed nobody supplied is not a seed. Refusing rather than reaching for
    // a clock or a random source is what keeps a replay honest.
    if (!exploration.seed.trim()) return deterministic;

    const ordered = [...candidates].sort((left, right) => {
        const a = keyFor(left);
        const b = keyFor(right);
        return a < b ? -1 : a > b ? 1 : 0;
    });

    return {
        chosen: ordered[hash32(exploration.seed) % ordered.length],
        tied: candidates,
        allocationMode: "explore_bounded",
        allocationSeedGrain: exploration.seedGrain,
    };
};
