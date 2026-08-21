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
    ROUTER_TTFT_TIE_EPSILON_MS,
    compareRouterScoreCells,
    getRouterScoreCell,
    rankingKindFor,
    stickyHysteresisTurnsFor,
    type RouterScoreCell,
    type RouterTieBreakCriterion,
    type RouterTieBreakSignals,
} from "@/lib/routerScorePolicy";
import type { TaskProfile } from "@/lib/taskProfileCore";

/** Bump with any change to the rule or the tie-break. */
export const ROUTER_SELECTION_VERSION = "router-selection-v2";

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
 * Compares one measured signal, and abstains when it cannot.
 *
 * Two rules, both about not inventing information. A signal absent for either
 * model is unknown rather than zero, so the criterion abstains and the next
 * one decides -- otherwise a model nobody has ever called would outrank one
 * with a measured record. And two values within the policy's epsilon are the
 * same value, so the Router does not reshuffle itself over a rounding
 * difference while reporting a confident reason for it.
 */
const compareSignal = (
    left: number | undefined,
    right: number | undefined,
    { epsilon, lowerWins }: { epsilon: number; lowerWins: boolean }
): number => {
    if (typeof left !== "number" || typeof right !== "number") return 0;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
    if (Math.abs(left - right) <= epsilon) return 0;
    return lowerWins ? left - right : right - left;
};

/** Relative, because a cent between two cheap models is not a cent between two expensive ones. */
const compareCost = (left: number | undefined, right: number | undefined) => {
    if (typeof left !== "number" || typeof right !== "number") return 0;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
    const larger = Math.max(Math.abs(left), Math.abs(right));
    if (larger === 0) return 0;
    if (Math.abs(left - right) / larger <= ROUTER_COST_TIE_EPSILON_RATIO) return 0;
    return left - right;
};

/**
 * Applies `ROUTER_TIE_BREAK_ORDER` and reports which entry decided.
 *
 * One function rather than a comparator plus a separate explanation, so the
 * order a decision is explained by cannot drift from the order it was made in.
 */
const compareCandidates = (
    left: ScoredCandidate,
    right: ScoredCandidate,
    signals: RouterTieBreakSignals
): { order: number; decidedBy: RouterTieBreakCriterion } => {
    const byQuality = compareRouterScoreCells(left.cell, right.cell);
    if (byQuality !== 0) return { order: byQuality, decidedBy: "quality_band" };

    const byCost = compareCost(
        signals.expectedTotalCostUsdByModelId?.[left.modelId],
        signals.expectedTotalCostUsdByModelId?.[right.modelId]
    );
    if (byCost !== 0) return { order: byCost, decidedBy: "expected_total_cost" };

    const bySuccess = compareSignal(
        signals.recentSuccessRateByModelId?.[left.modelId],
        signals.recentSuccessRateByModelId?.[right.modelId],
        { epsilon: ROUTER_SUCCESS_RATE_TIE_EPSILON, lowerWins: false }
    );
    if (bySuccess !== 0) {
        return { order: bySuccess, decidedBy: "recent_success_rate" };
    }

    const byLatency = compareSignal(
        signals.ttftP95MsByModelId?.[left.modelId],
        signals.ttftP95MsByModelId?.[right.modelId],
        { epsilon: ROUTER_TTFT_TIE_EPSILON_MS, lowerWins: true }
    );
    if (byLatency !== 0) return { order: byLatency, decidedBy: "ttft_p95" };

    // Arbitrary, stable, and total. Not a quality judgement: what it buys is
    // that two runs over the same inputs answer the same way, which the old
    // fallback -- position in a six-model curated order -- could not do for
    // the models that order never listed.
    if (left.modelId === right.modelId) return { order: 0, decidedBy: "model_id" };
    return {
        order: left.modelId < right.modelId ? -1 : 1,
        decidedBy: "model_id",
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
    const ranked = [...input.eligible]
        .map((candidate) => ({
            modelId: candidate.modelId,
            cell: getRouterScoreCell(candidate.modelId, kind),
        }))
        .sort((left, right) => compareCandidates(left, right, signals).order);

    const rankedModelIds = ranked.map((candidate) => candidate.modelId);
    const winner = ranked[0];
    const runnerUp = ranked[1];
    const bandOf = (candidate: ScoredCandidate) => candidate.cell.qualityBand;
    const margin = runnerUp ? bandOf(winner) - bandOf(runnerUp) : 0;
    const decidedBy = runnerUp
        ? compareCandidates(winner, runnerUp, signals).decidedBy
        : null;

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
