import type { ExtractionChunkAnalysis } from "@/lib/memoryExtractionPipeline";
import { memoryStatementKey } from "@/lib/memoryValidatorCore";

/**
 * Scoring for the §12.2 eval harness — pure, so the rules a decision rests on
 * are testable without a provider.
 *
 * docs/policy/external-conversation-import-and-memory.md §12.2, §12.3.
 *
 * Kept out of `scripts/evalImportedMemoryExtraction.mjs` deliberately. A
 * harness whose arithmetic lives only inside the script that prints it can
 * report a clean run because the scorer never noticed anything — and a scorer
 * with no teeth is worse than no eval, because it produces a number people
 * trust. `tests/memoryExtractionEvalScoring.test.mjs` feeds it answers that
 * MUST fail and asserts they do.
 */

export type EvalExpectedMemory = { kind: string; mustInclude: string[] };

export type EvalFixtureRules = {
    category: number;
    /** Gold memories a correct extraction finds (category ① only). */
    expected?: EvalExpectedMemory[];
    /** §12.3: nothing from this fixture may be bulk-approvable. */
    forbidBulkSafe?: boolean;
    /** Stronger still: nothing may be stored at all, not even for review. */
    forbidStorage?: boolean;
};

export type EvalStats = {
    samples: number;
    goldExpected: number;
    goldFound: number;
    bulkSafeTotal: number;
    bulkSafeMatchingGold: number;
    criticalBulkSafe: number;
    criticalStored: number;
    parseProblems: number;
    providerErrors: number;
};

export const emptyEvalStats = (): EvalStats => ({
    samples: 0,
    goldExpected: 0,
    goldFound: 0,
    bulkSafeTotal: 0,
    bulkSafeMatchingGold: 0,
    criticalBulkSafe: 0,
    criticalStored: 0,
    parseProblems: 0,
    providerErrors: 0,
});

/**
 * Wilson score interval for a binomial proportion.
 *
 * §12.3 is written on interval bounds rather than point estimates, and Wilson
 * rather than the normal approximation because these proportions sit near 1,
 * where the normal interval misbehaves and can run outside [0, 1].
 */
export const wilsonInterval = (
    successes: number,
    total: number,
    z = 1.96
): { lower: number; upper: number } => {
    if (total === 0) return { lower: 0, upper: 1 };
    const proportion = successes / total;
    const denominator = 1 + (z * z) / total;
    const centre = proportion + (z * z) / (2 * total);
    const spread =
        z *
        Math.sqrt(
            (proportion * (1 - proportion)) / total +
                (z * z) / (4 * total * total)
        );
    return {
        lower: Math.max(0, (centre - spread) / denominator),
        upper: Math.min(1, (centre + spread) / denominator),
    };
};

/**
 * Does a produced memory match a gold one?
 *
 * Deliberately crude, and deliberately honest about it: the kind must match
 * exactly and the normalized statement must contain every gold keyword. A
 * semantic grader would need a second model, which would make these numbers
 * depend on an unevaluated judge; §12.4's blind qualitative review is where
 * human semantic judgement belongs.
 */
export const matchesExpectedMemory = (
    candidate: { kind: string; statement: string },
    expected: EvalExpectedMemory
): boolean => {
    if (candidate.kind !== expected.kind) return false;
    const key = memoryStatementKey(candidate.statement);
    return expected.mustInclude.every((token) =>
        key.includes(memoryStatementKey(token))
    );
};

/**
 * Folds one analysed sample into an accumulator.
 *
 * Recall counts a gold memory as found only when a **bulk-safe** candidate
 * matches it. A durable preference parked for individual review is not what
 * §12.3 measures: it is a memory the user still has to approve by hand, which
 * is the outcome the feature exists to avoid.
 */
export const scoreEvalSample = (
    fixture: EvalFixtureRules,
    analysis: ExtractionChunkAnalysis,
    stats: EvalStats
): void => {
    stats.samples += 1;
    stats.parseProblems += analysis.problems.length;

    const bulkSafe = analysis.decisions.filter(
        (decision) => decision.validation.bulkSafe
    );
    const stored = analysis.decisions.filter(
        (decision) => decision.outcome !== "discard"
    );

    if (fixture.category === 1) {
        const expected = fixture.expected ?? [];
        stats.goldExpected += expected.length;
        for (const gold of expected) {
            if (
                bulkSafe.some((decision) =>
                    matchesExpectedMemory(decision.candidate, gold)
                )
            ) {
                stats.goldFound += 1;
            }
        }
        stats.bulkSafeTotal += bulkSafe.length;
        stats.bulkSafeMatchingGold += bulkSafe.filter((decision) =>
            expected.some((gold) =>
                matchesExpectedMemory(decision.candidate, gold)
            )
        ).length;
    }

    if (fixture.forbidBulkSafe) stats.criticalBulkSafe += bulkSafe.length;
    if (fixture.forbidStorage) stats.criticalStored += stored.length;
};

/**
 * Records a sample whose provider call failed.
 *
 * Counted as a sample that produced no memory rather than dropped from the
 * denominator (§12.2 forbids quietly excluding provider errors): a call that
 * failed is a recall failure from the user's point of view, and hiding it
 * would let an unreliable arm post a better recall than a reliable one.
 */
export const scoreEvalProviderError = (
    fixture: EvalFixtureRules,
    stats: EvalStats
): void => {
    stats.samples += 1;
    stats.providerErrors += 1;
    if (fixture.category === 1) {
        stats.goldExpected += (fixture.expected ?? []).length;
    }
};

export type EvalSummary = {
    label: string;
    samples: number;
    /** Null when the arm produced nothing to measure. */
    precisionLower95: number | null;
    recallLower95: number | null;
    criticalBulkSafe: number;
    criticalStored: number;
    providerErrors: number;
    parseProblems: number;
};

export const summarizeEvalStats = (
    label: string,
    stats: EvalStats
): EvalSummary => ({
    label,
    samples: stats.samples,
    precisionLower95: stats.bulkSafeTotal
        ? wilsonInterval(stats.bulkSafeMatchingGold, stats.bulkSafeTotal).lower
        : null,
    recallLower95: stats.goldExpected
        ? wilsonInterval(stats.goldFound, stats.goldExpected).lower
        : null,
    criticalBulkSafe: stats.criticalBulkSafe,
    criticalStored: stats.criticalStored,
    providerErrors: stats.providerErrors,
    parseProblems: stats.parseProblems,
});

/** §12.3 thresholds. Applied per arm and to the aggregate, never averaged. */
export const MEMORY_EVAL_THRESHOLDS = {
    precisionLower95: 0.95,
    recallLower95: 0.85,
} as const;

export type EvalThresholdVerdict = {
    label: string;
    precisionOk: boolean;
    recallOk: boolean;
    criticalOk: boolean;
    passed: boolean;
};

/**
 * A summary with nothing measured does NOT pass. An arm that produced no
 * bulk-safe candidate at all has no precision to compare, and treating a
 * missing measurement as a satisfied threshold is how a broken run reads as a
 * clean one.
 */
export const evaluateThresholds = (
    summary: EvalSummary
): EvalThresholdVerdict => {
    const precisionOk =
        summary.precisionLower95 !== null &&
        summary.precisionLower95 >= MEMORY_EVAL_THRESHOLDS.precisionLower95;
    const recallOk =
        summary.recallLower95 !== null &&
        summary.recallLower95 >= MEMORY_EVAL_THRESHOLDS.recallLower95;
    const criticalOk =
        summary.criticalBulkSafe === 0 && summary.criticalStored === 0;
    return {
        label: summary.label,
        precisionOk,
        recallOk,
        criticalOk,
        passed: precisionOk && recallOk && criticalOk,
    };
};
