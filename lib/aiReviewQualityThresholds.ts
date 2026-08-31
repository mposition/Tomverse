/**
 * The quality thresholds an approved reviewer pair must meet, versioned.
 *
 * docs/policy/ai-review-m5-quality-contract.md §6.
 *
 * ## Why this is code and not only prose
 *
 * The thresholds were written down first and enforced by nothing. That left a
 * gap with a specific shape: `approvedEntryProblems()` checked that an
 * approval named an artifact, a commit and two run ordinals, and then accepted
 * whatever numbers it carried. A pair whose contradiction recall was 0.31
 * could be marked `approved` and no static check would object -- the numbers
 * were present, which is not the same as sufficient.
 *
 * ## Why versioned
 *
 * A threshold set is a decision that can change, and an approval has to say
 * which decision it was granted under. Without a version, lowering a bar
 * silently re-blesses every approval that already exists; with one, an
 * approval granted under `v1-draft` stays visibly granted under `v1-draft`.
 *
 * ## Status
 *
 * `v1-draft` is **not approved**. It is the contract's proposal, with its
 * reasoning, in a form the gate can apply. `approvedBy: null` is what says so,
 * and `assertApprovedThresholdSet()` refuses to let a register entry cite an
 * unapproved set -- so today the gate's effect is that no pair can be approved
 * at all, which is the honest state and not an accident.
 */

import type { AiReviewArmMetrics } from "@/lib/aiReviewEvalCore";

export type AiReviewThresholdSet = {
    version: string;
    /** null while the set is a proposal. A person writes this. */
    approvedBy: string | null;
    approvedAt: string | null;
    rationale: string;
    /** Lower bounds on success rates, read from the Wilson lower bound. */
    minWilsonLower: {
        contradictionRecall: number;
        contradictionPrecision: number;
        omissionRecall: number;
        omissionPrecision: number;
        exactQuoteMatchRate: number;
        schemaValidRate: number;
    };
    /** Upper bounds on error rates, read from the Wilson upper bound. */
    maxWilsonUpper: {
        falseConsensusRate: number;
        inventedIssueRate: number;
    };
    /** No metric may differ between language arms by more than this. */
    maxLanguageArmGap: number;
    /** A task-type arm may fall this far below the aggregate floor and no further. */
    maxTaskTypeArmShortfall: number;
    /** Total zero-tolerance violations permitted. */
    maxZeroToleranceViolations: number;
};

export const AI_REVIEW_THRESHOLD_SETS: readonly AiReviewThresholdSet[] = [
    {
        version: "v1-draft",
        approvedBy: null,
        approvedAt: null,
        rationale:
            "The contract's §6 proposal, expressed so the gate can apply it. " +
            "Precision sits above recall on both finding kinds because the " +
            "feature's promise is 'here is where to look', and an invented " +
            "issue costs a user a sound answer while a missed one costs them " +
            "a second opinion they were already going to form themselves.",
        minWilsonLower: {
            contradictionRecall: 0.8,
            contradictionPrecision: 0.85,
            omissionRecall: 0.7,
            omissionPrecision: 0.8,
            exactQuoteMatchRate: 0.85,
            schemaValidRate: 0.98,
        },
        maxWilsonUpper: {
            falseConsensusRate: 0.1,
            inventedIssueRate: 0.1,
        },
        maxLanguageArmGap: 0.05,
        maxTaskTypeArmShortfall: 0.1,
        maxZeroToleranceViolations: 0,
    },
];

export const findThresholdSet = (version: string) =>
    AI_REVIEW_THRESHOLD_SETS.find((set) => set.version === version) ?? null;

export const approvedThresholdSets = () =>
    AI_REVIEW_THRESHOLD_SETS.filter((set) => Boolean(set.approvedBy));

/**
 * The metrics an approval has to carry for the gate to be able to judge it.
 *
 * Deliberately more than the contract's headline list. `inventedIssueRate` and
 * `schemaValidRate` were computed by the scorer and had nowhere to be
 * recorded, so an approval could quote the four that fit the old shape and
 * stay silent about a reviewer that invented an issue in one case out of
 * three.
 */
export type AiReviewApprovalMetrics = {
    contradictionRecallWilsonLower: number;
    contradictionPrecisionWilsonLower: number;
    omissionRecallWilsonLower: number;
    omissionPrecisionWilsonLower: number;
    exactQuoteMatchRateWilsonLower: number;
    schemaValidRateWilsonLower: number;
    falseConsensusRateWilsonUpper: number;
    inventedIssueRateWilsonUpper: number;
};

/** One arm's numbers, as an approval records them. */
export type AiReviewApprovalArmMetrics = AiReviewApprovalMetrics & {
    arm: string;
    cases: number;
};

const METRIC_FLOORS: ReadonlyArray<
    [keyof AiReviewApprovalMetrics, keyof AiReviewThresholdSet["minWilsonLower"]]
> = [
    ["contradictionRecallWilsonLower", "contradictionRecall"],
    ["contradictionPrecisionWilsonLower", "contradictionPrecision"],
    ["omissionRecallWilsonLower", "omissionRecall"],
    ["omissionPrecisionWilsonLower", "omissionPrecision"],
    ["exactQuoteMatchRateWilsonLower", "exactQuoteMatchRate"],
    ["schemaValidRateWilsonLower", "schemaValidRate"],
];

const METRIC_CEILINGS: ReadonlyArray<
    [keyof AiReviewApprovalMetrics, keyof AiReviewThresholdSet["maxWilsonUpper"]]
> = [
    ["falseConsensusRateWilsonUpper", "falseConsensusRate"],
    ["inventedIssueRateWilsonUpper", "inventedIssueRate"],
];

/**
 * Every way a set of measured numbers falls short of a threshold set.
 *
 * Returns the list rather than a boolean so a refusal can say which bar was
 * missed and by how much. A gate that only says "no" gets argued with.
 */
export const thresholdShortfalls = (input: {
    thresholds: AiReviewThresholdSet;
    aggregate: AiReviewApprovalMetrics;
    byLanguage: readonly AiReviewApprovalArmMetrics[];
    byTaskType: readonly AiReviewApprovalArmMetrics[];
    zeroToleranceViolations: number;
}): readonly string[] => {
    const problems: string[] = [];
    const { thresholds } = input;

    for (const [metric, bound] of METRIC_FLOORS) {
        const value = input.aggregate[metric];
        const floor = thresholds.minWilsonLower[bound];
        if (!(typeof value === "number" && value >= floor)) {
            problems.push(
                `aggregate ${metric} ${String(value)} < ${floor} (${thresholds.version})`
            );
        }
    }
    for (const [metric, bound] of METRIC_CEILINGS) {
        const value = input.aggregate[metric];
        const ceiling = thresholds.maxWilsonUpper[bound];
        if (!(typeof value === "number" && value <= ceiling)) {
            problems.push(
                `aggregate ${metric} ${String(value)} > ${ceiling} (${thresholds.version})`
            );
        }
    }
    if (input.zeroToleranceViolations > thresholds.maxZeroToleranceViolations) {
        problems.push(
            `${input.zeroToleranceViolations} zero-tolerance violation(s); ` +
                `${thresholds.maxZeroToleranceViolations} permitted`
        );
    }

    // Language arms: a gap, not a floor. Korean quality far below English is a
    // defect even when the average clears every bar, and the average is
    // exactly what hides it.
    if (input.byLanguage.length < 2) {
        problems.push(
            `${input.byLanguage.length} language arm(s) recorded; the gap rule needs both`
        );
    } else {
        for (const [metric] of [...METRIC_FLOORS, ...METRIC_CEILINGS]) {
            const values = input.byLanguage.map((arm) => arm[metric]);
            if (values.some((value) => typeof value !== "number")) {
                problems.push(`a language arm does not record ${metric}`);
                continue;
            }
            const gap = Math.max(...values) - Math.min(...values);
            if (gap > thresholds.maxLanguageArmGap) {
                problems.push(
                    `${metric} differs by ${gap.toFixed(4)} between language arms; ` +
                        `${thresholds.maxLanguageArmGap} permitted`
                );
            }
        }
    }

    // Task-type arms: each may sit below the aggregate floor, but only so far.
    // One collapsed arm under a passing average is the shape this catches.
    for (const arm of input.byTaskType) {
        for (const [metric, bound] of METRIC_FLOORS) {
            const value = arm[metric];
            const floor =
                thresholds.minWilsonLower[bound] - thresholds.maxTaskTypeArmShortfall;
            if (!(typeof value === "number" && value >= floor)) {
                problems.push(
                    `${arm.arm} ${metric} ${String(value)} < ${floor.toFixed(4)}`
                );
            }
        }
        for (const [metric, bound] of METRIC_CEILINGS) {
            const value = arm[metric];
            const ceiling =
                thresholds.maxWilsonUpper[bound] + thresholds.maxTaskTypeArmShortfall;
            if (!(typeof value === "number" && value <= ceiling)) {
                problems.push(
                    `${arm.arm} ${metric} ${String(value)} > ${ceiling.toFixed(4)}`
                );
            }
        }
    }

    return problems;
};

/**
 * Reads the approval-shaped metrics out of what the scorer computed.
 *
 * The one place the two shapes meet, so a run's numbers reach the gate without
 * being re-typed by a person -- which is where a digit gets dropped.
 */
export const approvalMetricsFromArm = (
    metrics: AiReviewArmMetrics
): AiReviewApprovalMetrics => ({
    contradictionRecallWilsonLower: metrics.contradictionRecall.wilsonLower ?? -1,
    contradictionPrecisionWilsonLower:
        metrics.contradictionPrecision.wilsonLower ?? -1,
    omissionRecallWilsonLower: metrics.omissionRecall.wilsonLower ?? -1,
    omissionPrecisionWilsonLower: metrics.omissionPrecision.wilsonLower ?? -1,
    exactQuoteMatchRateWilsonLower: metrics.exactQuoteMatchRate.wilsonLower ?? -1,
    schemaValidRateWilsonLower: metrics.schemaValidRate.wilsonLower ?? -1,
    // An unmeasured error rate becomes 2, which fails every ceiling. A `null`
    // here means the denominator was empty, and an empty denominator is not
    // evidence that a rate is low.
    falseConsensusRateWilsonUpper: metrics.falseConsensusRate.wilsonUpper ?? 2,
    inventedIssueRateWilsonUpper: metrics.inventedIssueRate.wilsonUpper ?? 2,
});
