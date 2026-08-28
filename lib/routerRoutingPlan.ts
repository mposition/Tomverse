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
 * this can be settled for nothing, before the first provider call.
 *
 * ## What counts as an answer author
 *
 * mposition's ruling, after the first version of this refused a run on models
 * that could not have been called. The test is a **call path**, not a
 * candidate list: an author is a model this harness would actually send a
 * prompt to.
 *
 * Today that is the baseline plus the frozen primary selections, and nothing
 * else, because `scripts/eval-router-quality.mjs` calls only the selected
 * model -- a failure is recorded as `provider_error` and the pair is excluded,
 * never retried down the ranking. The rest of the Router's ranking is recorded
 * as `rankedAlternatesNonExecutable` rather than "fallbacks", because calling
 * them fallbacks invited exactly the confusion that blocked a run: they are
 * what the *product* would fall back to, not what this harness will call.
 *
 * `FALLBACK_EXECUTION_MODE` is the hinge. The day this harness gains a
 * fallback path, that constant changes and the alternates come into scope
 * automatically -- the scoping is one value rather than an assumption spread
 * across the checks.
 *
 * ## Why it aborts rather than re-routes
 *
 * Dropping the judge from the candidate set and routing again would measure a
 * Router the product does not have: the product would have chosen the model
 * this run refused. And swapping the judge is not a local fix either --
 * `claude-opus-4-8` is an Auto candidate too. The conflict is between the
 * pre-registration and the catalogue, and that is a decision to take
 * deliberately rather than route around at dispatch time.
 */

import { canonicalIdentity } from "./routerAnswerBundle";
import type { ResolvedCallLimit } from "./routerCallLimits";

/**
 * Whether this harness ever calls a model other than the one it selected.
 *
 * `none` is a statement about `scripts/eval-router-quality.mjs`, checked by
 * tests/routerRoutingPlan.test.mjs against the shape of the plan it builds. If
 * a fallback path is added, set this to `ranked` and the alternates become
 * answer authors everywhere at once.
 */
export const FALLBACK_EXECUTION_MODE = "none" as const;

export type PlannedAnswerAuthor = {
    modelId: string;
    /** `provider/apiModel`, which is what "the same model" actually means. */
    identity: string;
    role: "selected" | "baseline";
    itemId: string;
};

export type RoutingPlanEntry = {
    itemId: string;
    outcome: string;
    selectedModelId: string | null;
    /**
     * The rest of the Router's ranking for this item.
     *
     * Recorded for audit and named for what it is: this harness will not call
     * these. The product would; this run does not.
     */
    rankedAlternatesNonExecutable: readonly string[];
};

export type RoutingPlan = {
    frozenAt: string;
    plannedItems: number;
    fallbackExecutionMode: typeof FALLBACK_EXECUTION_MODE;
    entries: readonly RoutingPlanEntry[];
    /** Only models this run will actually send a prompt to. */
    executableAnswerAuthors: readonly PlannedAnswerAuthor[];
    /**
     * Every enabled model the Router considered, for audit only.
     *
     * Deliberately separate from the executable manifest: one answers "what
     * could the Router have picked", the other "what will this run call". The
     * cost and independence gates read only the second, because a model that
     * is never called costs nothing and grades nothing.
     */
    catalogueCapabilitySnapshot: readonly { modelId: string; identity: string }[];
};

export type IdentityOf = (modelId: string) => { provider: string; apiModel: string } | null;

const identityFor = (modelId: string, identityOf: IdentityOf) => {
    const identity = identityOf(modelId);
    // An unknown model gets a name that cannot collide with a real canonical
    // identity, so it fails the checks below rather than silently matching
    // nothing.
    return identity ? canonicalIdentity({ ...identity, modelId }) : `unknown/${modelId}`;
};

export const freezeRoutingPlan = (
    entries: readonly RoutingPlanEntry[],
    baselineModelId: string,
    identityOf: IdentityOf,
    catalogueModelIds: readonly string[] = [],
    now: () => Date = () => new Date()
): RoutingPlan => {
    const executableAnswerAuthors: PlannedAnswerAuthor[] = [];
    for (const entry of entries) {
        if (entry.selectedModelId) {
            executableAnswerAuthors.push({
                modelId: entry.selectedModelId,
                identity: identityFor(entry.selectedModelId, identityOf),
                role: "selected",
                itemId: entry.itemId,
            });
        }
        executableAnswerAuthors.push({
            modelId: baselineModelId,
            identity: identityFor(baselineModelId, identityOf),
            role: "baseline",
            itemId: entry.itemId,
        });
    }
    return {
        frozenAt: now().toISOString(),
        plannedItems: entries.length,
        fallbackExecutionMode: FALLBACK_EXECUTION_MODE,
        entries,
        executableAnswerAuthors,
        catalogueCapabilitySnapshot: catalogueModelIds.map((modelId) => ({
            modelId,
            identity: identityFor(modelId, identityOf),
        })),
    };
};

const costOf = (limit: ResolvedCallLimit, promptTokens: number) =>
    (promptTokens * limit.inputUsdPerMillionTokens) / 1_000_000 +
    (limit.requestedMaxOutputTokens * limit.outputUsdPerMillionTokens) / 1_000_000;

/**
 * Why this plan may not be run. Empty means it may.
 *
 * Reported per model rather than per item: "claude-fable-5 is selected for 32
 * items" is what somebody has to decide about, and 210 copies of one finding
 * is not 210 findings.
 */
export const routingPlanProblems = (
    plan: RoutingPlan,
    options: {
        expectedItems: number;
        independentJudge: { provider: string; apiModel: string; modelId: string };
        perRequestMaxCostUsd: number;
        limitFor: (modelId: string) => ResolvedCallLimit | null;
        worstPromptTokens: number;
    }
): readonly string[] => {
    const problems: string[] = [];
    if (plan.fallbackExecutionMode !== FALLBACK_EXECUTION_MODE) {
        problems.push(
            `the plan was frozen under fallbackExecutionMode=${plan.fallbackExecutionMode}, but this ` +
                `harness now runs ${FALLBACK_EXECUTION_MODE}; which models can answer has changed`
        );
    }
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

    // Compared on canonical identity rather than catalogue id, because two
    // rows can resolve to the same upstream model and it is the upstream model
    // that would be grading its own answer.
    const judgeIdentity = canonicalIdentity(options.independentJudge);
    const conflicting = new Map<string, { selected: number; baseline: number }>();
    for (const author of plan.executableAnswerAuthors) {
        if (author.identity !== judgeIdentity) continue;
        const counts = conflicting.get(author.modelId) ?? { selected: 0, baseline: 0 };
        counts[author.role] += 1;
        conflicting.set(author.modelId, counts);
    }
    for (const [modelId, counts] of conflicting) {
        problems.push(
            `${modelId} resolves to ${judgeIdentity}, which is the pre-registered independent judge ` +
                `(${options.independentJudge.modelId}). This run would call it as an answer author on ` +
                `${counts.selected} item(s) and as the baseline on ${counts.baseline}. The judge would ` +
                "grade its own answers, so this run stops here — re-routing without it would measure a " +
                "Router the product does not have"
        );
    }

    // The most expensive request this plan can produce, over the calls this
    // run will actually make. An alternate it never sends a prompt to costs
    // nothing and cannot breach a ceiling.
    let worstCost = 0;
    let worstModelId: string | null = null;
    const unpriced = new Set<string>();
    for (const author of plan.executableAnswerAuthors) {
        const limit = options.limitFor(author.modelId);
        if (!limit) {
            unpriced.add(author.modelId);
            continue;
        }
        const cost = costOf(limit, options.worstPromptTokens);
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
    for (const author of plan.executableAnswerAuthors) {
        const limit = limitFor(author.modelId);
        if (!limit) continue;
        const cost = costOf(limit, worstPromptTokens);
        if (cost > worst) worst = cost;
    }
    return worst;
};

/** Which models the plan will actually call, once each. For the record. */
export const executableCallManifest = (plan: RoutingPlan) => {
    const counts = new Map<string, { modelId: string; identity: string; calls: number }>();
    for (const author of plan.executableAnswerAuthors) {
        const row = counts.get(author.modelId) ?? {
            modelId: author.modelId,
            identity: author.identity,
            calls: 0,
        };
        row.calls += 1;
        counts.set(author.modelId, row);
    }
    return [...counts.values()].sort((a, b) => b.calls - a.calls || a.modelId.localeCompare(b.modelId));
};
