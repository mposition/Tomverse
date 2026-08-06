/**
 * Router Pass 1's choice — step 3 of the rollout order in the delivery plan §6.
 *
 * The filters decided who may be considered; this decides who wins. It is
 * deliberately the smallest thing that can be called a decision: a preference
 * lookup, a deterministic tie-break, and the stickiness rule the routing
 * policy already specifies. Nothing here dispatches, prices or persists.
 *
 * **What the preference is, and what it is not.** Scores come from
 * `TASK_SCORES` in `lib/modelFinder.ts` — the curated table the model finder
 * already uses to answer "which model suits this kind of work". Reused rather
 * than reinvented so the repository holds one opinion; a second table would
 * drift, and the second would be the one nobody remembered to update. It is
 * *curation*, not measurement. `ROUTE-01` ("Auto Router quality is
 * non-inferior to the fixed-model baseline") is what turns this into a claim
 * about quality, and it has not run. Until it does, this is a rule that can be
 * observed in shadow mode, not a rule that is known to be good.
 *
 * **The margin is in the table's own units.** It is a difference between two
 * curated integers, so the switch threshold below is versioned configuration
 * rather than a probability, exactly as the routing policy says ("Exact values
 * are versioned Router configuration, not client behavior").
 *
 * **Stickiness never overrides a filter.** A previous selection that is no
 * longer eligible is not kept; it lost on a hard rule, and hard rules do not
 * lose to continuity.
 */

import { STANDARD_CANDIDATE_ORDER, TASK_SCORES } from "@/lib/modelFinder";
import type { RouterCandidate } from "@/lib/routerCandidates";
import type { TaskProfile } from "@/lib/taskProfileCore";

/** Bump with any change to the rule, the tie-break, or the configuration. */
export const ROUTER_SELECTION_VERSION = "router-selection-v1";

/**
 * How much better a challenger must look before Auto changes model mid
 * conversation, in `TASK_SCORES` units.
 *
 * Switching on a hair's difference is the failure the policy's "confidence
 * margin plus hysteresis" exists to prevent: the user sees the model change
 * between two turns that felt the same to them, and neither answer explains
 * why.
 */
export const ROUTER_STICKY_SWITCH_MARGIN = 2;

/**
 * And how many consecutive turns must favour the challenger by that margin.
 *
 * One turn is not a trend. A single question of a different shape inside a
 * long conversation should not move the model, because the next turn is
 * usually back to the original subject.
 */
export const ROUTER_STICKY_HYSTERESIS_TURNS = 2;

export const SELECTION_REASONS = [
    /** Nothing survived the filters. The caller must not invent a model. */
    "no_candidate",
    /** Exactly one candidate; no preference was consulted. */
    "only_candidate",
    /** The curated table preferred this model for the profile's task. */
    "task_preference",
    /** No preference distinguished the candidates; catalogue order decided. */
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
    /** Null only when nothing was eligible. */
    selectedModelId: string | null;
    reason: SelectionReason;
    /** Score difference between the top two candidates, in table units. */
    margin: number;
    /** The model that would have been chosen without stickiness. */
    challengerModelId: string | null;
    /**
     * The streak to carry into the next turn. Reset to zero whenever the
     * challenger fails to clear the margin, so a switch needs consecutive
     * turns rather than an accumulation of unrelated ones.
     */
    turnsFavouringChallenger: number;
};

const orderIndex = (modelId: string) => {
    const index = (STANDARD_CANDIDATE_ORDER as readonly string[]).indexOf(
        modelId
    );
    // A model outside the curated order sorts last, and by id among itself, so
    // the result stays deterministic for a catalogue this table has not caught
    // up with yet.
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

export function selectRouterModel(input: {
    profile: TaskProfile;
    eligible: readonly RouterCandidate[];
    sticky?: RouterStickyState | null;
}): RouterSelectionResult {
    const base = {
        version: ROUTER_SELECTION_VERSION,
        turnsFavouringChallenger: 0,
    };

    if (input.eligible.length === 0) {
        return {
            ...base,
            selectedModelId: null,
            reason: "no_candidate",
            margin: 0,
            challengerModelId: null,
        };
    }

    const preference = TASK_SCORES[input.profile.kind] ?? {};
    const ranked = [...input.eligible]
        .map((candidate) => ({
            modelId: candidate.modelId,
            score: preference[candidate.modelId] ?? 0,
        }))
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            const byOrder = orderIndex(left.modelId) - orderIndex(right.modelId);
            if (byOrder !== 0) return byOrder;
            return left.modelId < right.modelId ? -1 : 1;
        });

    const winner = ranked[0];
    const runnerUp = ranked[1];
    const margin = runnerUp ? winner.score - runnerUp.score : 0;

    const naturalReason: SelectionReason = !runnerUp
        ? "only_candidate"
        : winner.score > runnerUp.score
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
            challengerModelId: winner.modelId,
        };
    }

    // The challenger is measured against the model actually in use, not
    // against the runner-up: what decides a switch is how much better the
    // alternative is than what the user is already getting.
    const stickyScore = preference[sticky.modelId] ?? 0;
    const challengerMargin = winner.score - stickyScore;
    const streak =
        challengerMargin >= ROUTER_STICKY_SWITCH_MARGIN
            ? sticky.turnsFavouringChallenger + 1
            : 0;

    if (streak >= ROUTER_STICKY_HYSTERESIS_TURNS) {
        return {
            version: ROUTER_SELECTION_VERSION,
            selectedModelId: winner.modelId,
            reason: naturalReason,
            margin: challengerMargin,
            challengerModelId: winner.modelId,
            // The switch happened, so the streak has done its job and starts
            // again for the next comparison.
            turnsFavouringChallenger: 0,
        };
    }

    return {
        version: ROUTER_SELECTION_VERSION,
        selectedModelId: sticky.modelId,
        reason: "sticky",
        margin: challengerMargin,
        challengerModelId: winner.modelId,
        turnsFavouringChallenger: streak,
    };
}
