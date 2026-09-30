/**
 * What an eval budget was approved *for*, and how a run proves it is that run.
 *
 * ## The problem
 *
 * A budget approval (docs/policy/external-conversation-import-and-memory.md
 * §12.5) names a ceiling and a pair. That was enough while
 * the pair was the whole identity of a run, and it stopped being enough the
 * day a dataset and a scoring contract could be corrected: the same
 * `gpt-5-6-luna::mem-extract-v6` can be run against two datasets, under two
 * contracts, and produce two different verdicts — one of which nobody
 * approved paying for.
 *
 * The 2026-08-28 re-approval therefore names an immutable tuple, and says
 * that if any part of it differs the approval "loses effect immediately". A
 * sentence cannot do that. This module is the sentence made checkable: the
 * budget records the tuple, the run computes it, and a difference refuses the
 * run before a provider is reached.
 *
 * ## Why the commit binding is an ancestry test
 *
 * The approval binds an `approvedImplementationSha` — the merge commit of the
 * change that produced these digests — and requires the run's own commit to
 * be a descendant of it.
 *
 * It cannot be an equality. A registration PR cannot contain its own merge
 * SHA: the value would have to be written before the commit that carries it
 * exists. And it should not be, either — a run from a later commit that still
 * computes the same three digests is running the same instrument, and
 * demanding equality would forbid every commit after the approval including
 * the one that records the run.
 *
 * Ancestry plus digest equality is the honest pair of conditions: the run
 * descends from the approved implementation, and the instrument it actually
 * assembled is the approved one. The ancestry half needs git and so is
 * computed by the caller; everything here is pure.
 */

/** The instrument a budget was approved against, as recorded. */
export type EvalBudgetTuple = {
    datasetVersion: string;
    datasetDigest: string;
    datasetManifestDigest: string;
    scoringContractVersion: string;
    scoringContractDigest: string;
    promptVersion: string;
    promptDigest: string;
};

/** The same seven values, as the tree computes them now. */
export type EvalBudgetActuals = EvalBudgetTuple;

/**
 * Every recorded value the run does not reproduce.
 *
 * Empty means the run is the run that was approved. Each difference is
 * reported rather than the first, because a mismatch usually comes in pairs —
 * a dataset and its manifest, a contract and its version — and a reader
 * chasing one at a time would go round the loop once per field.
 */
export function evalBudgetTupleFailures(
    approved: EvalBudgetTuple,
    actual: EvalBudgetActuals
): readonly string[] {
    const fields: readonly (keyof EvalBudgetTuple)[] = [
        "datasetVersion",
        "datasetDigest",
        "datasetManifestDigest",
        "scoringContractVersion",
        "scoringContractDigest",
        "promptVersion",
        "promptDigest",
    ];
    return fields
        .filter((field) => approved[field] !== actual[field])
        .map(
            (field) =>
                `${field}: approved ${approved[field]}, this run would use ${actual[field]}`
        );
}

/** A 40-character lowercase hex commit SHA, and nothing shorter. */
export const isFullCommitSha = (value: string): boolean =>
    /^[0-9a-f]{40}$/.test(value);

/**
 * Whether a budget is bound tightly enough to authorise a paid run.
 *
 * A budget recorded before this binding existed carries neither a tuple nor an
 * implementation SHA. Those stay on the register as history — `mem-extract-v1`
 * through v5 were really approved and really spent against — and they cannot
 * authorise a run: an unbound budget is a ceiling attached to nothing in
 * particular, which is what the re-approval was written to stop.
 */
export function evalBudgetBindingProblems(budget: {
    approvedImplementationSha?: string;
    boundTuple?: EvalBudgetTuple;
    maxProviderDispatchedRuns?: number;
}): readonly string[] {
    const problems: string[] = [];
    if (!budget.boundTuple) {
        problems.push(
            "the budget records no instrument: a ceiling with no dataset, contract " +
                "or prompt digest authorises a run nobody approved the shape of."
        );
    }
    if (
        !budget.approvedImplementationSha ||
        !isFullCommitSha(budget.approvedImplementationSha)
    ) {
        problems.push(
            "the budget records no full 40-character approvedImplementationSha, so " +
                "there is nothing for the run's own commit to descend from."
        );
    }
    if (
        budget.maxProviderDispatchedRuns !== undefined &&
        !(
            Number.isInteger(budget.maxProviderDispatchedRuns) &&
            budget.maxProviderDispatchedRuns > 0
        )
    ) {
        problems.push(
            `maxProviderDispatchedRuns is ${String(budget.maxProviderDispatchedRuns)}, ` +
                "which is not a positive whole number of runs."
        );
    }
    return problems;
}
