/**
 * The cost-efficiency diagnostic's report (objective chat_cost_efficiency).
 *
 * Pure: it reads a finished cycle's comparisons, cases and cost coverage and
 * says what was measured -- price-blind quality outcomes, credit change,
 * observed answer and partial serving cost, the experiment's own spend, and
 * why the result is not (yet) applicable. It never decides a promotion: the
 * objective is diagnostic only (optimizerPromotionEligibility refuses it).
 *
 * Observed cost is reported usage x configured prices, not a provider
 * invoice. Unknown cost is counted as unknown, never as zero. Equal quality
 * stays equal; order disagreement, insufficient evidence and missing answers
 * are separate outcomes. A credit ratio is not a saving.
 */
import type { OptimizerCallKind, OptimizerCostCoverage } from "@/lib/autoOptimizerCost";
import type {
    AnswerCostView, OptimizerCase, OptimizerComparison, OptimizerFailure, OptimizerSummary, QualityObservation,
} from "@/lib/autoRouterOptimizerCore";

export const COST_EFFICIENCY_REPORT_VERSION = "auto-cost-efficiency-report-v1";

/**
 * The acceptance criteria a paid run is read against. Fixed before the run
 * and stored with it; a result never changes them. A set is a proposal until
 * the owner confirms it (`status`), and the report says so: an unconfirmed
 * set can describe a run, never qualify it. A changed value is a new version.
 */
export type CostEfficiencyCriteria = {
    version: string;
    status: "proposed_unconfirmed" | "confirmed";
    /** The day the owner confirmed this set, when confirmed. */
    confirmedOn?: string;
    /** Fewest direct comparisons against a cheaper candidate worth reading. */
    minSavingsSamples: number;
    /** A cheaper answer failing an explicit requirement the current one met. */
    maxCriticalRegressions: number;
    /** Share of judged savings samples the current pick won. */
    maxQualityLossShare: number;
    /** Share of savings samples that were insufficient, disagreed or unjudged. */
    maxUndecidedShare: number;
    /** Share of savings samples where the cheaper model gave no answer. */
    maxAnswerFailureShare: number;
    latency: "report_only";
    judgeDisagreement: "never_counted_as_equal";
    scope: "tool_free_text_answers";
};

export const COST_EFFICIENCY_CRITERIA: CostEfficiencyCriteria = {
    version: "auto-cost-efficiency-criteria-v1",
    // Confirmed by the owner in chat on 2026-11-23, before any paid run.
    status: "confirmed",
    confirmedOn: "2026-11-23",
    minSavingsSamples: 10,
    maxCriticalRegressions: 0,
    maxQualityLossShare: 0.1,
    maxUndecidedShare: 0.2,
    maxAnswerFailureShare: 0.1,
    latency: "report_only",
    judgeDisagreement: "never_counted_as_equal",
    scope: "tool_free_text_answers",
};

export type QualityTally = {
    challengerBetter: number; incumbentBetter: number; equal: number;
    insufficient: number; orderDisagreement: number; undecided: number;
};

export type ObservedPairCost = {
    /** Pairs whose two answers both have a known cost. */
    pairsKnown: number;
    /** Pairs where either answer's cost is unknown or never started. */
    pairsUnknown: number;
    /** Pairs where either side gave no answer: nothing was compared, so no cost pair. */
    pairsUnanswered: number;
    incumbentMicroUsd: number;
    challengerMicroUsd: number;
    /** lower_observed_provider_cost: the cheaper side's own measured answer cost. */
    challengerLower: number;
    challengerHigher: number;
    same: number;
};

export type CostEfficiencyApplicabilityReason =
    | "diagnostic_only"
    | "criteria_unconfirmed"
    | "cycle_incomplete"
    | "cost_coverage_incomplete"
    | "savings_samples_below_minimum"
    | "critical_regression_observed"
    | "quality_loss_above_tolerance"
    | "undecided_above_tolerance"
    | "answer_failures_above_tolerance"
    | "no_observed_saving"
    | "guidance_not_cheaper"
    | "tool_free_scope_only";

export type CostEfficiencyReport = ReturnType<typeof costEfficiencyReport>;

const tally = (items: readonly Pick<QualityObservation, "quality">[]): QualityTally => ({
    challengerBetter: items.filter(item => item.quality === "b").length,
    incumbentBetter: items.filter(item => item.quality === "a").length,
    equal: items.filter(item => item.quality === "equal").length,
    insufficient: items.filter(item => item.quality === "insufficient").length,
    orderDisagreement: items.filter(item => item.quality === "order_disagreement").length,
    undecided: items.filter(item => item.quality === "undecided").length,
});

/** The cheaper (b) side broke a requirement the current (a) side met, by the judge or the exact grader. */
const criticalRegression = (item: QualityObservation) =>
    (item.constraintFailure.b === true && item.constraintFailure.a === false) ||
    (item.exact?.a === true && item.exact.b === false);

/** Every try of an answer failed, or none was started: no answer to judge. */
const answerMissing = (cost: AnswerCostView) => cost.attempts === 0 || cost.failedAttempts === cost.attempts;

const pairCost = (items: readonly { answerCost: { a: AnswerCostView; b: AnswerCostView } }[]): ObservedPairCost => {
    const result: ObservedPairCost = { pairsKnown: 0, pairsUnknown: 0, pairsUnanswered: 0, incumbentMicroUsd: 0, challengerMicroUsd: 0, challengerLower: 0, challengerHigher: 0, same: 0 };
    for (const { answerCost: { a, b } } of items) {
        if (answerMissing(a) || answerMissing(b)) {
            result.pairsUnanswered += 1;
            continue;
        }
        if (a.state !== "known" || b.state !== "known" || a.microUsd === null || b.microUsd === null) {
            result.pairsUnknown += 1;
            continue;
        }
        result.pairsKnown += 1;
        result.incumbentMicroUsd += a.microUsd;
        result.challengerMicroUsd += b.microUsd;
        if (b.microUsd < a.microUsd) result.challengerLower += 1;
        else if (b.microUsd > a.microUsd) result.challengerHigher += 1;
        else result.same += 1;
    }
    return result;
};

const median = (values: readonly number[]) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) / 2)];
};

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Route spend per guidance arm, from the identity each evaluation route call carries. */
const routerArm = (coverage: OptimizerCostCoverage, arm: string) => {
    const calls = coverage.calls.filter(call => call.kind === "route" && call.identity?.arm === arm);
    return {
        calls: calls.length,
        knownMicroUsd: calls.reduce((sum, call) => sum + (call.state === "known" ? call.amountMicroUsd : 0), 0),
        unknownCalls: calls.filter(call => call.state === "unknown").length,
    };
};

export const costEfficiencyReport = (input: {
    comparisons: readonly OptimizerComparison[];
    cases: readonly OptimizerCase[];
    summary?: OptimizerSummary;
    coverage: OptimizerCostCoverage;
    spentByKind: Record<OptimizerCallKind, number>;
    criteria: CostEfficiencyCriteria;
    failure: OptimizerFailure | null;
}) => {
    const { comparisons, cases, coverage, criteria } = input;
    // 1. Candidate diagnosis: the current pick against a cheaper candidate.
    const direct = comparisons.flatMap(item => item.costEfficiency ? [{ ...item, ce: item.costEfficiency }] : []);
    const savings = direct.filter(item => item.ce.basis !== "quality_comparison").map(item => ({ ...item.ce, answerMs: item.answerMs }));
    const judgedSavings = savings.filter(item => item.quality === "a" || item.quality === "b" || item.quality === "equal");
    const savingsQuality = tally(savings);
    const savingsUndecided = savingsQuality.insufficient + savingsQuality.orderDisagreement + savingsQuality.undecided;
    const savingsCost = pairCost(savings);
    const exactGraded = savings.filter(item => item.exact);
    const latencyPairs = savings.filter(item => item.answerMs?.a != null && item.answerMs.b != null);
    const candidateDiagnosis = {
        compared: direct.length,
        noAlternative: comparisons.filter(item => item.verdict === "no_alternative").length,
        unrouted: comparisons.filter(item => item.verdict === "unrouted").length,
        byBasis: {
            lower_credit: direct.filter(item => item.ce.basis === "lower_credit").length,
            lower_estimated_provider_cost: direct.filter(item => item.ce.basis === "lower_estimated_provider_cost").length,
            quality_comparison: direct.filter(item => item.ce.basis === "quality_comparison").length,
        },
        /** Comparisons against a cheaper candidate only; quality_comparison is never one. */
        savingsSamples: savings.length,
        quality: savingsQuality,
        /** Quality of the existing same/next-higher draws, kept apart from savings. */
        qualityComparison: tally(direct.filter(item => item.ce.basis === "quality_comparison").map(item => item.ce)),
        criticalRegressions: savings.filter(criticalRegression).length,
        answerMissing: {
            incumbent: savings.filter(item => answerMissing(item.answerCost.a)).length,
            challenger: savings.filter(item => answerMissing(item.answerCost.b)).length,
        },
        truncatedAnswers: savings.filter(item => item.truncated.a || item.truncated.b).length,
        exact: {
            graded: exactGraded.length,
            incumbentPassed: exactGraded.filter(item => item.exact?.a === true).length,
            challengerPassed: exactGraded.filter(item => item.exact?.b === true).length,
        },
        credits: savings.reduce((sum, item) => item.credits.a !== null && item.credits.b !== null
            ? { pairs: sum.pairs + 1, incumbent: sum.incumbent + item.credits.a, challenger: sum.challenger + item.credits.b }
            : sum, { pairs: 0, incumbent: 0, challenger: 0 }),
        observedAnswerCost: savingsCost,
        answerLatencyMs: {
            pairs: latencyPairs.length,
            incumbentMedian: median(latencyPairs.map(item => item.answerMs!.a!)),
            challengerMedian: median(latencyPairs.map(item => item.answerMs!.b!)),
        },
    };

    // 2. Guidance comparison: the frozen baseline and candidate guidance on the same holdout.
    const routed = cases.filter(item => item.incumbentPick && item.candidatePick);
    const changed = cases.filter(item => item.costEfficiency);
    const changedObservations = changed.map(item => item.costEfficiency!);
    const changedCost = pairCost(changedObservations);
    const router = { baseline: routerArm(coverage, "baseline_guidance"), candidate: routerArm(coverage, "candidate_guidance") };
    const guidanceComparison = {
        evaluated: cases.length,
        unchanged: cases.filter(item => item.verdict === "unchanged").length,
        unrouted: cases.filter(item => item.verdict === "unrouted").length,
        changed: changed.length,
        quality: tally(changedObservations),
        criticalRegressions: changedObservations.filter(criticalRegression).length,
        credits: { routedCases: routed.length, baseline: input.summary?.incumbentCredits ?? null, candidate: input.summary?.candidateCredits ?? null },
        /** Changed picks only: an unchanged pick is the same model on the same request, not a second observation. */
        observedAnswerCost: changedCost,
        reusedAnswers: changed.filter(item => item.costEfficiency!.reusedAnswers.a || item.costEfficiency!.reusedAnswers.b).length,
    };

    // 3. Serving cost of each arm, as far as this tool-free cycle can attribute it.
    // Complete only for a finished cycle whose two arms were both routed: zero calls is unmeasured, not free.
    const servingComplete = input.failure === null && router.baseline.calls > 0 && router.candidate.calls > 0 &&
        router.baseline.unknownCalls === 0 && router.candidate.unknownCalls === 0 && changedCost.pairsUnknown === 0;
    const servingCost = {
        coverage: "partial_serving_cost" as const,
        includes: ["router", "answer_changed_picks"] as const,
        excludes: ["prompt_refiner", "app_managed_search", "tools", "attachments", "memory", "unchanged_picks"] as const,
        complete: servingComplete,
        baselineKnownMicroUsd: router.baseline.knownMicroUsd + changedCost.incumbentMicroUsd,
        candidateKnownMicroUsd: router.candidate.knownMicroUsd + changedCost.challengerMicroUsd,
        router,
    };

    // 4. What finding this out cost: every call, failed and retried ones included.
    const experimentCost = {
        complete: coverage.complete,
        knownMicroUsd: coverage.knownMicroUsd,
        byKind: { ...input.spentByKind },
        started: coverage.started,
        completed: coverage.completed,
        failed: coverage.failed,
        notStarted: coverage.notStarted,
        unknownCalls: coverage.unknownCalls,
        noDispatchCalls: coverage.noDispatchCalls,
        answerRetries: coverage.calls.filter(call => call.kind === "answer" && (call.identity?.attempt ?? 1) > 1).length,
    };

    const reasons: CostEfficiencyApplicabilityReason[] = ["diagnostic_only"];
    if (criteria.status !== "confirmed") reasons.push("criteria_unconfirmed");
    if (input.failure) reasons.push("cycle_incomplete");
    if (!coverage.complete) reasons.push("cost_coverage_incomplete");
    if (savings.length < criteria.minSavingsSamples) reasons.push("savings_samples_below_minimum");
    if (candidateDiagnosis.criticalRegressions + guidanceComparison.criticalRegressions > criteria.maxCriticalRegressions)
        reasons.push("critical_regression_observed");
    if (share(savingsQuality.incumbentBetter, judgedSavings.length) > criteria.maxQualityLossShare) reasons.push("quality_loss_above_tolerance");
    if (share(savingsUndecided, savings.length) > criteria.maxUndecidedShare) reasons.push("undecided_above_tolerance");
    if (share(candidateDiagnosis.answerMissing.challenger, savings.length) > criteria.maxAnswerFailureShare)
        reasons.push("answer_failures_above_tolerance");
    if (savingsCost.pairsKnown === 0 || savingsCost.challengerMicroUsd >= savingsCost.incumbentMicroUsd) reasons.push("no_observed_saving");
    const { baseline, candidate } = guidanceComparison.credits;
    if (baseline === null || candidate === null || candidate >= baseline) reasons.push("guidance_not_cheaper");
    reasons.push("tool_free_scope_only");
    const scopeOnly = new Set<CostEfficiencyApplicabilityReason>(["diagnostic_only", "criteria_unconfirmed", "tool_free_scope_only"]);

    return {
        version: COST_EFFICIENCY_REPORT_VERSION,
        basis: "reported_usage_configured_prices" as const,
        criteria,
        candidateDiagnosis,
        guidanceComparison,
        servingCost,
        experimentCost,
        /** A tool-free cycle links no regenerate or follow-up to a task; task cost needs a fixture episode. */
        taskCost: { status: "unlinked" as const },
        applicability: {
            applicable: false as const,
            /** Every data-based reason absent: the sample met the criteria, within its scope. */
            measuredWithinCriteria: reasons.every(reason => scopeOnly.has(reason)),
            reasons,
        },
    };
};
