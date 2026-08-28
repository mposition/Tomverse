/**
 * What the Router would choose for all 210 items, decided before anything is
 * paid for.
 *
 * ## The conflict this exists to catch
 *
 * `claude-fable-5` is the pre-registered independent judge. It is also an Auto
 * candidate. If the Router picks it for even one item, the independent judge
 * grades its own answer on that pair, and a calibration built on that is not a
 * comparison of two judges -- it is one model marking its own work inside a
 * measurement of somebody else's.
 *
 * The routing decision is deterministic given the item and the frozen seed, so
 * this can be settled for nothing, before the first provider call. It is
 * settled that way.
 *
 * ## Why it aborts rather than re-routes
 *
 * mposition's ruling, and the reason is that the alternatives are worse than
 * stopping. Dropping the judge from the candidate set and routing again would
 * measure a Router that does not exist -- the product would have chosen the
 * model this run refused. And swapping the judge is not a local fix either:
 * `claude-opus-4-8` is an Auto candidate too, so the same conflict simply
 * moves. The conflict is between the pre-registration and the catalogue, and
 * that is a decision to be taken deliberately rather than routed around at
 * dispatch time.
 *
 * ## Fallbacks count as answer authors
 *
 * A fallback candidate is a model this run may actually call -- §6 requires it
 * to pass the same compatibility filters as the primary, which is exactly what
 * makes it reachable. A plan whose primaries avoid the judge but whose
 * fallbacks do not is a plan that conflicts as soon as one primary fails.
 */

import { canonicalIdentity } from "./routerAnswerBundle";
import type { ResolvedCallLimit } from "./routerCallLimits";

// The ceilings live in one place. Re-exported here because this module is what
// enforces the per-request one, and a second copy is a second thing to forget.
export { PILOT_PER_REQUEST_MAX_COST_USD } from "./routerFableEntry";

export type PlannedAnswerAuthor = {
    modelId: string;
    /** `provider/apiModel`, which is what "the same model" actually means. */
    identity: string;
    /** Why this run could call it: chosen for an item, or a fallback for one. */
    role: "selected" | "fallback" | "baseline";
    itemId: string;
};

export type RoutingPlanEntry = {
    itemId: string;
    outcome: string;
    selectedModelId: string | null;
    fallbackCandidateModelIds: readonly string[];
};

export type RoutingPlan = {
    frozenAt: string;
    plannedItems: number;
    entries: readonly RoutingPlanEntry[];
    authors: readonly PlannedAnswerAuthor[];
};

export type IdentityOf = (modelId: string) => { provider: string; apiModel: string } | null;

export const freezeRoutingPlan = (
    entries: readonly RoutingPlanEntry[],
    baselineModelId: string,
    identityOf: IdentityOf,
    now: () => Date = () => new Date()
): RoutingPlan => {
    const authors: PlannedAnswerAuthor[] = [];
    const add = (modelId: string, role: PlannedAnswerAuthor["role"], itemId: string) => {
        const identity = identityOf(modelId);
        authors.push({
            modelId,
            // An unknown model gets a name that cannot collide with a real
            // canonical identity, so it fails the checks below rather than
            // silently matching nothing.
            identity: identity ? canonicalIdentity({ ...identity, modelId }) : `unknown/${modelId}`,
            role,
            itemId,
        });
    };
    for (const entry of entries) {
        if (entry.selectedModelId) add(entry.selectedModelId, "selected", entry.itemId);
        for (const fallback of entry.fallbackCandidateModelIds) {
            add(fallback, "fallback", entry.itemId);
        }
        add(baselineModelId, "baseline", entry.itemId);
    }
    return {
        frozenAt: now().toISOString(),
        plannedItems: entries.length,
        entries,
        authors,
    };
};

/**
 * Why this plan may not be run. Empty means it may.
 *
 * Reported per conflicting model rather than per item: "claude-fable-5 is
 * selected for 32 items and a fallback for 178" is what somebody has to
 * decide about, and 210 lines of the same finding is not.
 */
export const routingPlanProblems = (
    plan: RoutingPlan,
    options: {
        expectedItems: number;
        independentJudge: { provider: string; apiModel: string; modelId: string };
        perRequestMaxCostUsd: number;
        /** The resolved answer limit for a model, for the cost bound. */
        limitFor: (modelId: string) => ResolvedCallLimit | null;
        /** The largest prompt any item carries, in tokens. */
        worstPromptTokens: number;
    }
): readonly string[] => {
    const problems: string[] = [];
    if (plan.plannedItems !== options.expectedItems) {
        problems.push(
            `the routing plan covers ${plan.plannedItems} item(s), not the ${options.expectedItems} ` +
                "this run plans, so it is not a plan for this run"
        );
    }
    if (plan.entries.length === 0) {
        problems.push("the routing plan is empty, so nothing was frozen");
        return problems;
    }

    // The conflict. Compared on canonical identity rather than catalogue id,
    // because two catalogue entries can resolve to the same upstream model and
    // it is the upstream model that would be grading its own answer.
    const judgeIdentity = canonicalIdentity(options.independentJudge);
    const conflicting = new Map<string, { selected: number; fallback: number; baseline: number }>();
    for (const author of plan.authors) {
        if (author.identity !== judgeIdentity) continue;
        const counts = conflicting.get(author.modelId) ?? { selected: 0, fallback: 0, baseline: 0 };
        counts[author.role] += 1;
        conflicting.set(author.modelId, counts);
    }
    for (const [modelId, counts] of conflicting) {
        problems.push(
            `${modelId} resolves to ${judgeIdentity}, which is the pre-registered independent judge ` +
                `(${options.independentJudge.modelId}). It is planned as an answer author on ` +
                `${counts.selected} item(s), a fallback on ${counts.fallback}, and the baseline on ` +
                `${counts.baseline}. The judge would grade its own answers, so this run stops here — ` +
                "re-routing without it would measure a Router the product does not have"
        );
    }

    // The most expensive answer request this plan can produce. Reported per
    // model, like the conflict above: an unpriced model appears once per item
    // it is planned for, and 210 copies of one finding is not 210 findings.
    let worstCost = 0;
    let worstModelId = null;
    const unpriced = new Set<string>();
    for (const author of plan.authors) {
        const limit = options.limitFor(author.modelId);
        if (!limit) {
            unpriced.add(author.modelId);
            continue;
        }
        const cost =
            (options.worstPromptTokens * limit.inputUsdPerMillionTokens) / 1_000_000 +
            (limit.requestedMaxOutputTokens * limit.outputUsdPerMillionTokens) / 1_000_000;
        if (cost > worstCost) {
            worstCost = cost;
            worstModelId = author.modelId;
        }
    }
    for (const modelId of [...unpriced].sort()) {
        problems.push(
            `${modelId} is planned as an answer author but has no resolved call limit, so what it ` +
                "could cost is unknown"
        );
    }
    if (worstCost > options.perRequestMaxCostUsd) {
        problems.push(
            `the plan can produce a ${worstModelId} request costing $${worstCost.toFixed(4)}, over the ` +
                `$${options.perRequestMaxCostUsd.toFixed(2)} per-request ceiling — a cost ceiling is ` +
                "tested between calls, so nothing can stop the call that breaches it"
        );
    }
    return problems;
};

/** The number the gate reports even when it passes. */
export const maxPlannedAnswerRequestCostUsd = (
    plan: RoutingPlan,
    limitFor: (modelId: string) => ResolvedCallLimit | null,
    worstPromptTokens: number
): number => {
    let worst = 0;
    for (const author of plan.authors) {
        const limit = limitFor(author.modelId);
        if (!limit) continue;
        const cost =
            (worstPromptTokens * limit.inputUsdPerMillionTokens) / 1_000_000 +
            (limit.requestedMaxOutputTokens * limit.outputUsdPerMillionTokens) / 1_000_000;
        if (cost > worst) worst = cost;
    }
    return worst;
};
