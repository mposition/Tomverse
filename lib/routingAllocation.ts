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
 * Whether this allocation could have moved a conversation off the placement
 * holding its prefix.
 *
 * `null` where nothing was recorded -- the honest answer for a run that
 * predates the allocator, and not `false`.
 *
 * This says the allocation *could* have moved it, not that it did. Whether it
 * actually did is `DeploymentCacheAffinity`, which records where turns landed;
 * an exploration seeded per request may still have re-picked the same
 * placement.
 */
export const mayBreakCacheAffinity = (
    input: RoutingAllocationInput
): boolean | null => {
    const mode = input.allocationMode ?? null;
    if (mode === null) return null;
    if (mode === "deterministic") return false;
    return (input.allocationSeedGrain ?? null) === "request";
};
