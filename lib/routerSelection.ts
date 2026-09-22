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

type ScoredCandidate = {
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
 * none, and costs C < B < A: quality says A beats B, cost says B beats C (they
 * abstained on quality), and cost says C beats A (likewise). A > B > C > A.
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
        // cell in that band carries one. The band stays a strict primary key:
        // an interval never reaches across bands, because that would make the
        // comparison non-transitive on a partly-measured snapshot.
        if (
            inBand.length > 1 &&
            inBand.every((entry) => entry.cell.qualityCi95Lower !== null)
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
 * Splits by a measured number, with the epsilon anchored to each bucket.
 *
 * Returns the group whole -- abstains -- unless every member has a finite
 * reading. Equal readings are ordered by model id before bucketing, so the
 * partition does not depend on the order the candidates arrived in.
 */
const partitionByMetric = (
    group: Bucket,
    readingFor: (candidate: ScoredCandidate) => number | undefined,
    {
        epsilon,
        lowerWins,
        relative,
    }: { epsilon: number; lowerWins: boolean; relative: boolean }
): Bucket[] => {
    const readings = new Map<ScoredCandidate, number>();
    for (const candidate of group) {
        const reading = readingFor(candidate);
        if (typeof reading !== "number" || !Number.isFinite(reading)) {
            return [group];
        }
        readings.set(candidate, reading);
    }
    const read = (candidate: ScoredCandidate) =>
        readings.get(candidate) as number;

    const sorted = [...group].sort((left, right) => {
        const a = read(left);
        const b = read(right);
        if (a !== b) return lowerWins ? a - b : b - a;
        return left.modelId < right.modelId
            ? -1
            : left.modelId > right.modelId
              ? 1
              : 0;
    });

    const withinEpsilon = (reading: number, anchor: number) => {
        if (!relative) return Math.abs(reading - anchor) <= epsilon;
        // Relative, because a cent between two cheap models is not a cent
        // between two expensive ones.
        const larger = Math.max(Math.abs(reading), Math.abs(anchor));
        if (larger === 0) return true;
        return Math.abs(reading - anchor) / larger <= epsilon;
    };

    const buckets: ScoredCandidate[][] = [];
    let current: ScoredCandidate[] = [];
    let anchor = 0;
    for (const candidate of sorted) {
        const reading = read(candidate);
        if (current.length === 0) {
            anchor = reading;
            current.push(candidate);
            continue;
        }
        if (withinEpsilon(reading, anchor)) {
            current.push(candidate);
            continue;
        }
        buckets.push(current);
        current = [candidate];
        anchor = reading;
    }
    if (current.length > 0) buckets.push(current);
    return buckets;
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
    [...new Set(group.map((entry) => entry.modelId))]
        .sort()
        .map((modelId) => group.filter((entry) => entry.modelId === modelId));

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
                }
            );
        case "recent_success_rate":
            return partitionByMetric(
                group,
                (entry) => signals.recentSuccessRateByModelId?.[entry.modelId],
                {
                    epsilon: ROUTER_SUCCESS_RATE_TIE_EPSILON,
                    lowerWins: false,
                    relative: false,
                }
            );
        case "ttft_p95":
            return partitionByMetric(
                group,
                (entry) => signals.ttftP95MsByModelId?.[entry.modelId],
                {
                    epsilon: ROUTER_TTFT_TIE_EPSILON_MS,
                    lowerWins: true,
                    relative: false,
                }
            );
        case "model_id":
            return partitionByModelId(group);
    }
};

/**
 * Applies `ROUTER_TIE_BREAK_ORDER` and reports which entry decided.
 *
 * One pass rather than a ranking plus a separate explanation, so the order a
 * decision is explained by cannot drift from the order it was made in: the
 * criterion named is the position at which two rank keys first differ.
 */
const rankCandidates = (
    candidates: readonly ScoredCandidate[],
    signals: RouterTieBreakSignals
): {
    ranked: ScoredCandidate[];
    decidedBy: (
        left: ScoredCandidate,
        right: ScoredCandidate
    ) => RouterTieBreakCriterion;
} => {
    const keys = new Map<ScoredCandidate, number[]>();
    for (const candidate of candidates) keys.set(candidate, []);

    let groups: Bucket[] = [candidates];
    for (const criterion of ROUTER_TIE_BREAK_ORDER) {
        const refined: Bucket[] = [];
        for (const group of groups) {
            // A group of one is already decided. Skipping the partition keeps
            // every rank key the same length, which is what makes the
            // lexicographic comparison below well defined.
            const buckets =
                group.length <= 1
                    ? [group]
                    : partitionFor(criterion, group, signals);
            buckets.forEach((bucket, index) => {
                for (const candidate of bucket) keys.get(candidate)?.push(index);
                refined.push(bucket);
            });
        }
        groups = refined;
    }

    const keyOf = (candidate: ScoredCandidate) => keys.get(candidate) ?? [];
    const firstDifference = (left: ScoredCandidate, right: ScoredCandidate) => {
        const a = keyOf(left);
        const b = keyOf(right);
        for (let index = 0; index < a.length; index += 1) {
            if (a[index] !== b[index]) return index;
        }
        return -1;
    };

    return {
        ranked: [...candidates].sort((left, right) => {
            const index = firstDifference(left, right);
            return index === -1 ? 0 : keyOf(left)[index] - keyOf(right)[index];
        }),
        decidedBy: (left, right) => {
            const index = firstDifference(left, right);
            // Identical keys means the same model id twice. Nothing separated
            // them, and the last criterion is the honest thing to name.
            return index === -1 ? "model_id" : ROUTER_TIE_BREAK_ORDER[index];
        },
    };
};

export function selectRouterModel(input: {
    profile: TaskProfile;
    eligible: readonly RouterCandidate[];
    sticky?: RouterStickyState | null;
    /** Measured inputs for tie-break criteria 2 to 4. See the policy module. */
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
