/**
 * Router Pass 1's choice — step 3 of the rollout order in the delivery plan §6.
 *
 * The filters decided who may be considered; this decides who wins. It is
 * deliberately the smallest thing that can be called a decision: a lookup in
 * the scoring policy, a deterministic tie-break, and the stickiness rule the
 * routing policy already specifies. Nothing here dispatches, prices or
 * persists.
 *
 * **The policy is one versioned bundle, and it is not the model finder's.**
 * Bands, thresholds, the tie-break order and the switch margin all come from
 * `lib/routerScorePolicy.ts` under one version. Until now they came from
 * `TASK_SCORES` in `lib/modelFinder.ts` -- since renamed `MODEL_FINDER_SCORES`
 * -- a six-model product questionnaire
 * -- which meant the Router could not reach twenty-four of the thirty enabled
 * models, and that a change made for one consumer silently changed the other.
 * This module no longer imports the model finder at all; that is what makes
 * the separation real rather than a comment.
 *
 * **The margin is in the policy's own units.** It is a difference between
 * quality bands, so the switch threshold is versioned configuration rather
 * than a probability, exactly as the routing policy says ("Exact values are
 * versioned Router configuration, not client behavior"). It moved from 2
 * points to 1 band with the scale, because the literal 2 would have meant
 * something else entirely on a three-level scale.
 *
 * **It is curation and measurement, kept apart.** Bands are curation and are
 * all neutral today; cost, success rate and time to first token are
 * measurements, and they are inputs rather than lookups -- the caller owns
 * where they come from, and this owns what they mean, the same arrangement
 * `unhealthyModelIds` already has in `lib/routerCandidates.ts`. `ROUTE-01`
 * ("Auto Router quality is non-inferior to the fixed-model baseline") is what
 * would turn any of this into a claim about quality, and it has not run.
 *
 * **Stickiness never overrides a filter.** A previous selection that is no
 * longer eligible is not kept; it lost on a hard rule, and hard rules do not
 * lose to continuity.
 *
 * Pure: no database, no clock, no network, no model call.
 */

import {
    partitionByKey,
    partitionByMetric,
    refineToRanking,
} from "@tomverse/router-core";

import type { RouterCandidate } from "@/lib/routerCandidates";
import {
    ROUTER_COST_TIE_EPSILON_RATIO,
    ROUTER_SCORE_POLICY_VERSION,
    ROUTER_STICKY_SWITCH_MARGIN_BANDS,
    ROUTER_SUCCESS_RATE_TIE_EPSILON,
    ROUTER_TIE_BREAK_ORDER,
    ROUTER_TTFT_TIE_EPSILON_MS,
    getRouterScoreCell,
    rankingKindFor,
    stickyHysteresisTurnsFor,
    type RouterScoreCell,
    type RouterTieBreakCriterion,
    type RouterTieBreakSignals,
} from "@/lib/routerScorePolicy";
import type { TaskProfile } from "@/lib/taskProfileCore";

/** Bump with any change to the rule or the tie-break. */
export const ROUTER_SELECTION_VERSION = "router-selection-v3";

export const SELECTION_REASONS = [
    /** Nothing survived the filters. The caller must not invent a model. */
    "no_candidate",
    /** Exactly one candidate; no preference was consulted. */
    "only_candidate",
    /** The scoring policy preferred this model for the profile's task. */
    "task_preference",
    /**
     * Quality did not separate the candidates; a tie-break decided.
     *
     * Deliberately one reason rather than one per criterion. It is the reason
     * a user can be shown ("no model was a better fit for this message"), and
     * splitting it would put the Router's cost and latency comparisons into
     * chat copy. Which criterion actually decided is on `decidedBy`, which is
     * operator telemetry and never rendered.
     */
    "fallback_order",
    /** A different model scored higher, but not by enough for long enough. */
    "sticky",
] as const;

export type SelectionReason = (typeof SELECTION_REASONS)[number];

export type RouterStickyState = {
    /** The model this conversation is currently on. */
    modelId: string;
    /**
     * How many consecutive previous turns already favoured a challenger by at
     * least the switch margin. State lives with the caller; this stays pure.
     */
    turnsFavouringChallenger: number;
};

export type RouterSelectionResult = {
    version: string;
    /** The scoring policy this decision was made under. */
    policyVersion: string;
    /** Null only when nothing was eligible. */
    selectedModelId: string | null;
    reason: SelectionReason;
    /** Band difference between the top two candidates, in whole bands. */
    margin: number;
    /**
     * Which tie-break criterion separated the top two, for operators.
     *
     * Null when there was nothing to separate -- no candidate, or one. Never
     * user-facing: `reason` is what a person is shown.
     */
    decidedBy: RouterTieBreakCriterion | null;
    /** The model that would have been chosen without stickiness. */
    challengerModelId: string | null;
    /**
     * Every eligible model, best first.
     *
     * Surfaced because §6 requires an automatic fallback's candidate to have
     * passed the same filters as the primary, and this is the only place where
     * a set that has is also in a defensible order. Recomputing it downstream
     * would be a second filter, free to disagree with the one that actually
     * chose.
     *
     * Not to be confused with `challengerModelId`, which is the natural winner
     * -- the same model as the selected one whenever stickiness is not
     * overriding, and therefore never an alternative to it.
     */
    rankedModelIds: readonly string[];
    /**
     * The streak to carry into the next turn. Reset to zero whenever the
     * challenger fails to clear the margin, so a switch needs consecutive
     * turns rather than an accumulation of unrelated ones.
     */
    turnsFavouringChallenger: number;
};

export type ScoredCandidate = {
    modelId: string;
    cell: RouterScoreCell;
};

/**
 * Ranks candidates by refining a partition, one criterion at a time.
 *
 * ## Why this is not a pairwise comparator
 *
 * Two of this policy's rules are stated per pair, and each of them on its own
 * makes a pairwise comparator intransitive -- which `Array.prototype.sort`
 * answers with an implementation-defined order rather than with an error.
 *
 * A criterion *abstains* when either side has no value, so that an unmeasured
 * model neither wins nor loses on a number it does not have. Pairwise, that
 * means one criterion decides one pair and is skipped for another, and a cycle
 * follows directly. With A and B both carrying a quality interval, C carrying
 * none, and costs B < C < A: quality says A beats B, cost says B beats C (they
 * abstained on quality, and B is the cheaper), and cost says C beats A
 * (likewise). A > B > C > A.
 *
 * And two values within an epsilon are "the same value", which is not
 * transitive either: at a 5% ratio 100 ties 104 and 104 ties 108, while 100
 * beats 108 outright.
 *
 * So the order is built rather than compared. Every candidate starts in one
 * group; each criterion in `ROUTER_TIE_BREAK_ORDER` splits each surviving
 * group into ordered buckets, and a criterion that cannot speak for *every*
 * member of a group leaves that group whole. The bucket indices a candidate
 * collects are its rank key, and the ranking is the lexicographic order of
 * those keys -- total and transitive by construction, being integer vectors of
 * equal length.
 *
 * ## What this changes about the rules themselves
 *
 * Abstention becomes a property of the group rather than of the pair: one
 * unmeasured member silences the criterion for everybody it is still tied
 * with, rather than only for the pairs that include it. That is the reading
 * which keeps "an unknown value never wins and never loses" true without also
 * letting the result depend on the order the filter happened to emit.
 *
 * Epsilon becomes anchored rather than pairwise: a bucket holds the values
 * within epsilon of that bucket's own first value, so the chain above splits
 * into {100, 104} and {108} every time instead of into whatever the comparison
 * order produced.
 */

type Bucket = readonly ScoredCandidate[];

/** Splits by quality band, then refines one band by its interval. */
const partitionByQuality = (group: Bucket): Bucket[] => {
    const bands = [...new Set(group.map((entry) => entry.cell.qualityBand))].sort(
        (left, right) => right - left
    );
    const buckets: Bucket[] = [];
    for (const band of bands) {
        const inBand = group.filter((entry) => entry.cell.qualityBand === band);
        // The interval refines the order inside one band, and only while every
        // cell in that band carries a finite one. The band stays a strict
        // primary key: an interval never reaches across bands, because that
        // would make the comparison non-transitive on a partly-measured
        // snapshot.
        //
        // Finite rather than merely non-null, because the bucketing below
        // groups by value equality and `NaN === NaN` is false: a cell carrying
        // one would land in no bucket at all, and the candidate would leave
        // this criterion with a shorter rank key than everybody else.
        if (
            inBand.length > 1 &&
            inBand.every((entry) => Number.isFinite(entry.cell.qualityCi95Lower))
        ) {
            const bounds = [
                ...new Set(
                    inBand.map((entry) => entry.cell.qualityCi95Lower as number)
                ),
            ].sort((left, right) => right - left);
            for (const bound of bounds) {
                buckets.push(
                    inBand.filter((entry) => entry.cell.qualityCi95Lower === bound)
                );
            }
            continue;
        }
        buckets.push(inBand);
    }
    return buckets;
};

/**
 * Splits the models something is reporting problems with from the rest.
 *
 * Never abstains. Absence from the set is "not known to be degraded", which
 * covers a healthy model and an unprobed one alike, so there is no missing
 * value here to abstain on.
 */
const partitionByDegraded = (
    group: Bucket,
    degraded: readonly string[] | undefined
): Bucket[] => {
    if (degraded === undefined || degraded.length === 0) return [group];
    const flagged = new Set(degraded);
    const healthy = group.filter((entry) => !flagged.has(entry.modelId));
    const unhealthy = group.filter((entry) => flagged.has(entry.modelId));
    if (healthy.length === 0 || unhealthy.length === 0) return [group];
    return [healthy, unhealthy];
};

/**
 * The last criterion, and the only one that is total on its own.
 *
 * Arbitrary, and deliberately so: what it buys is that two runs over the same
 * inputs answer the same way, which the old fallback -- position in a
 * six-model curated order -- could not do for the models that order never
 * listed.
 */
const partitionByModelId = (group: Bucket): Bucket[] =>
    partitionByKey(group, (entry) => entry.modelId);

const partitionFor = (
    criterion: RouterTieBreakCriterion,
    group: Bucket,
    signals: RouterTieBreakSignals
): Bucket[] => {
    switch (criterion) {
        case "quality_band":
            return partitionByQuality(group);
        case "health_degraded":
            return partitionByDegraded(group, signals.degradedModelIds);
        case "expected_total_cost":
            return partitionByMetric(
                group,
                (entry) => signals.expectedTotalCostUsdByModelId?.[entry.modelId],
                {
                    epsilon: ROUTER_COST_TIE_EPSILON_RATIO,
                    lowerWins: true,
                    relative: true,
                },
                (entry) => entry.modelId
            );
        case "recent_success_rate":
            return partitionByMetric(
                group,
                (entry) => signals.recentSuccessRateByModelId?.[entry.modelId],
                {
                    epsilon: ROUTER_SUCCESS_RATE_TIE_EPSILON,
                    lowerWins: false,
                    relative: false,
                },
                (entry) => entry.modelId
            );
        case "ttft_p95":
            return partitionByMetric(
                group,
                (entry) => signals.ttftP95MsByModelId?.[entry.modelId],
                {
                    epsilon: ROUTER_TTFT_TIE_EPSILON_MS,
                    lowerWins: true,
                    relative: false,
                },
                (entry) => entry.modelId
            );
        case "model_id":
            return partitionByModelId(group);
    }
};

/**
 * Applies `ROUTER_TIE_BREAK_ORDER` and reports which entry decided.
 *
 * The construction is `refineToRanking` in `@tomverse/router-core`: partition
 * refinement, group-scoped abstention, anchored epsilons, and the check that a
 * partitioner did not lose a member. None of that is about this product, and a
 * second client would need exactly it.
 *
 * What stays here is every product decision -- which criteria there are, what
 * each one reads, and what its epsilon is.
 *
 * `decidedBy` answers `model_id` where the package answers null. Null means
 * two identical rank keys, which here happens only when the same model id
 * appears twice -- and `model_id` did not decide that pair, it put them in one
 * bucket. The label is a fallback for a case `selectRouterModel` does not
 * produce, because its candidates are one per catalogue id. The package is
 * right not to name a criterion there; this keeps the non-null return type the
 * callers already have.
 *
 * The fold is also only correct while `model_id` is last in
 * `ROUTER_TIE_BREAK_ORDER`. It reads the end of the list rather than the
 * literal, so reordering the list moves it too.
 */
export const rankCandidates = (
    candidates: readonly ScoredCandidate[],
    signals: RouterTieBreakSignals
): {
    ranked: ScoredCandidate[];
    decidedBy: (
        left: ScoredCandidate,
        right: ScoredCandidate
    ) => RouterTieBreakCriterion;
} => {
    const { ranked, decidedBy } = refineToRanking(
        candidates,
        ROUTER_TIE_BREAK_ORDER,
        (criterion) => (group) => partitionFor(criterion, group, signals)
    );
    return {
        ranked,
        decidedBy: (left, right) =>
            decidedBy(left, right) ??
            ROUTER_TIE_BREAK_ORDER[ROUTER_TIE_BREAK_ORDER.length - 1],
    };
};
export function selectRouterModel(input: {
    profile: TaskProfile;
    eligible: readonly RouterCandidate[];
    sticky?: RouterStickyState | null;
    /** Measured inputs for tie-break criteria 2 to 5. See the policy module. */
    signals?: RouterTieBreakSignals;
}): RouterSelectionResult {
    const base = {
        version: ROUTER_SELECTION_VERSION,
        policyVersion: ROUTER_SCORE_POLICY_VERSION,
        turnsFavouringChallenger: 0,
    };

    if (input.eligible.length === 0) {
        return {
            ...base,
            selectedModelId: null,
            reason: "no_candidate",
            margin: 0,
            decidedBy: null,
            challengerModelId: null,
            rankedModelIds: [],
        };
    }

    const signals = input.signals ?? {};
    // A kind nothing supported does not steer the ranking; it falls back to
    // the general column. See `rankingKindFor`.
    const kind = rankingKindFor(input.profile);
    const scored = input.eligible.map((candidate) => ({
        modelId: candidate.modelId,
        cell: getRouterScoreCell(candidate.modelId, kind),
    }));
    const ranking = rankCandidates(scored, signals);
    const ranked = ranking.ranked;

    const rankedModelIds = ranked.map((candidate) => candidate.modelId);
    const winner = ranked[0];
    const runnerUp = ranked[1];
    const bandOf = (candidate: ScoredCandidate) => candidate.cell.qualityBand;
    const margin = runnerUp ? bandOf(winner) - bandOf(runnerUp) : 0;
    const decidedBy = runnerUp ? ranking.decidedBy(winner, runnerUp) : null;

    const naturalReason: SelectionReason = !runnerUp
        ? "only_candidate"
        : decidedBy === "quality_band"
          ? "task_preference"
          : "fallback_order";

    const sticky = input.sticky ?? null;
    const stickyIsEligible =
        sticky !== null &&
        input.eligible.some((candidate) => candidate.modelId === sticky.modelId);

    // Stickiness only applies while the previous model is still allowed. A
    // model that failed a hard filter does not get to keep the conversation.
    if (!stickyIsEligible || sticky.modelId === winner.modelId) {
        return {
            ...base,
            selectedModelId: winner.modelId,
            reason: naturalReason,
            margin,
            decidedBy,
            challengerModelId: winner.modelId,
            rankedModelIds,
        };
    }

    // The challenger is measured against the model actually in use, not
    // against the runner-up: what decides a switch is how much better the
    // alternative is than what the user is already getting. In bands, because
    // that is the scale the margin is stated on -- a cheaper or faster model
    // is not a reason to change a conversation's model mid-way, only a reason
    // to have started somewhere else.
    const stickyBand = getRouterScoreCell(sticky.modelId, kind).qualityBand;
    const challengerMargin = bandOf(winner) - stickyBand;
    const requiredTurns = stickyHysteresisTurnsFor(input.profile);
    const streak =
        challengerMargin >= ROUTER_STICKY_SWITCH_MARGIN_BANDS
            ? sticky.turnsFavouringChallenger + 1
            : 0;

    if (streak >= requiredTurns) {
        return {
            version: ROUTER_SELECTION_VERSION,
            policyVersion: ROUTER_SCORE_POLICY_VERSION,
            selectedModelId: winner.modelId,
            reason: naturalReason,
            margin: challengerMargin,
            decidedBy,
            challengerModelId: winner.modelId,
            rankedModelIds,
            // The switch happened, so the streak has done its job and starts
            // again for the next comparison.
            turnsFavouringChallenger: 0,
        };
    }

    return {
        version: ROUTER_SELECTION_VERSION,
        policyVersion: ROUTER_SCORE_POLICY_VERSION,
        selectedModelId: sticky.modelId,
        reason: "sticky",
        margin: challengerMargin,
        decidedBy,
        challengerModelId: winner.modelId,
        rankedModelIds,
        turnsFavouringChallenger: streak,
    };
}
