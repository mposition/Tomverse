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

import {
    AI_REVIEW_EVAL_LANGUAGES,
    AI_REVIEW_EVAL_MIN_CASES,
    AI_REVIEW_EVAL_TASK_TYPES,
    type AiReviewArmMetrics,
} from "@/lib/aiReviewEvalCore";

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
    /**
     * How many cases a blind human review must cover.
     *
     * Here rather than as a constant beside the reader, because it is a
     * judgement about how much human reading an approval rests on, and every
     * other such judgement in this file is versioned and signed. It was a bare
     * 20 in the evidence reader for a while, gating approvals under nobody's
     * name, while the runbook suggested 60 and the sheet generator defaulted
     * to 24 -- three numbers and no decision.
     */
    minBlindReviewedCases: number;
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
        // The runbook's own worked example. Part of the proposal, like every
        // number here, and unsigned until somebody signs the set.
        minBlindReviewedCases: 60,
    },
];

export const findThresholdSet = (version: string) =>
    AI_REVIEW_THRESHOLD_SETS.find((set) => set.version === version) ?? null;

/**
 * Why a threshold set is not an approved bar, if it is not.
 *
 * One predicate, because there were two places asking the question and both
 * asked only about `approvedBy`. A set carrying an approver and
 * `approvedAt: null` counted as approved in both -- so a name with no date
 * could bless every pair that cited it, and readiness would read the bar as
 * signed. An approval is an act somebody performed at a moment; without the
 * moment there is nothing to audit, and "who" alone is a claim rather than a
 * record.
 *
 * The date is parsed, not merely present: a string nobody can turn into a day
 * is the same as no day.
 */
export const thresholdSetApprovalProblems = (
    set: AiReviewThresholdSet
): readonly string[] => {
    const problems: string[] = [];
    const hasApprover = Boolean(set.approvedBy && set.approvedBy.trim() !== "");
    if (!hasApprover) {
        problems.push(
            `threshold set "${set.version}" is a proposal and has no approver; ` +
                "a quality approval cannot rest on an unapproved bar"
        );
        // No second complaint about the date. A set nobody approved is not
        // also guilty of not saying when; saying both would report one absence
        // twice, and the second sentence would claim an approver it just said
        // was missing.
        return problems;
    }
    if (!set.approvedAt || set.approvedAt.trim() === "") {
        problems.push(
            `threshold set "${set.version}" names an approver but no date; ` +
                "an approval is an act performed at a moment, and without one there is " +
                "nothing to audit"
        );
    } else if (Number.isNaN(Date.parse(set.approvedAt))) {
        problems.push(
            `threshold set "${set.version}" has an unreadable approval date ` +
                `"${set.approvedAt}"`
        );
    }
    return problems;
};

export const isApprovedThresholdSet = (set: AiReviewThresholdSet): boolean =>
    thresholdSetApprovalProblems(set).length === 0;

export const approvedThresholdSets = () =>
    AI_REVIEW_THRESHOLD_SETS.filter(isApprovedThresholdSet);

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
 * The arms an approval has to carry, and how many cases each needs.
 *
 * ## Why "two or more" was not enough
 *
 * The language rule used to be `byLanguage.length < 2`. Two arms both labelled
 * `en` satisfied it, and so did two arms of one case each. The task-type rule
 * was weaker still: the loop walked whatever arms it was handed, so an
 * approval carrying `byTaskType: []` had every task-type bar applied to
 * nothing and passed. Both were reproduced against `v1-draft` with a perfect
 * aggregate and no shortfall was reported.
 *
 * That mattered because of what the arms are FOR. The aggregate is the number
 * that hides a collapsed arm; the arms are how the gate sees past it. An
 * approval that may omit them is an approval judged on the aggregate alone,
 * which is the failure the arm rules exist to prevent -- and the omission is
 * invisible, because a missing arm produces no message.
 *
 * So the required set is named here, out of the axes the evaluation set is
 * built on, and an approval is refused for a missing arm, a duplicated one, an
 * unrecognised one, or one too small to support the rate it reports.
 */
const armProblems = (
    arms: readonly AiReviewApprovalArmMetrics[],
    required: readonly string[],
    minimumCases: number,
    kind: string
): readonly string[] => {
    const problems: string[] = [];
    const seen = new Map<string, number>();
    for (const arm of arms) seen.set(arm.arm, (seen.get(arm.arm) ?? 0) + 1);

    for (const name of required) {
        if (!seen.has(name)) problems.push(`no ${kind} arm for "${name}"`);
    }
    for (const [name, count] of seen) {
        if (!required.includes(name)) {
            problems.push(
                `${kind} arm "${name}" is not one of ${required.join(", ")}`
            );
        }
        if (count > 1) {
            problems.push(`${kind} arm "${name}" appears ${count} times`);
        }
    }
    for (const arm of arms) {
        if (!(typeof arm.cases === "number" && arm.cases >= minimumCases)) {
            problems.push(
                `${kind} arm "${arm.arm}" reports ${String(arm.cases)} case(s); ` +
                    `${minimumCases} needed`
            );
        }
    }
    return problems;
};

/**
 * A task-type arm spans both languages, so its floor is the per-cell floor
 * times the number of languages. Derived rather than added as a fourth
 * constant: a floor that can drift away from the cell it is made of is a floor
 * that will.
 */
const MIN_TASK_TYPE_ARM_CASES =
    AI_REVIEW_EVAL_MIN_CASES.perLanguageTaskTypeCell *
    AI_REVIEW_EVAL_LANGUAGES.length;

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
    problems.push(
        ...armProblems(
            input.byLanguage,
            AI_REVIEW_EVAL_LANGUAGES,
            AI_REVIEW_EVAL_MIN_CASES.perLanguage,
            "language"
        )
    );
    problems.push(
        ...armProblems(
            input.byTaskType,
            AI_REVIEW_EVAL_TASK_TYPES,
            MIN_TASK_TYPE_ARM_CASES,
            "task-type"
        )
    );

    const distinctLanguages = new Set(input.byLanguage.map((arm) => arm.arm));
    if (distinctLanguages.size < 2) {
        problems.push(
            `${distinctLanguages.size} distinct language arm(s) recorded; the gap rule needs both`
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
    /**
     * Tolerates a missing or partial arm rather than throwing.
     *
     * The evaluation runner writes `metrics: {}` before adjudication, which is
     * the shape an operator naturally hands to `--artifact` to check a fresh
     * run. Reading `.wilsonLower` off an absent arm threw a TypeError, and the
     * gate died with a stack trace on the first such entry -- so no other
     * approved entry was checked and the operator got no reason, only a trace.
     * A gate that crashes cannot be told apart from a broken tool.
     *
     * Absent is treated exactly as `null` already is: an unmeasured rate is not
     * evidence, so it becomes the sentinel that fails every bar.
     */
    metrics: Partial<AiReviewArmMetrics> | null | undefined
): AiReviewApprovalMetrics => {
    // -1 fails every floor and 2 fails every ceiling. An empty denominator is
    // not evidence that a rate is good, and neither is a missing arm.
    const lower = (rate: { wilsonLower?: number | null } | undefined) =>
        rate?.wilsonLower ?? -1;
    const upper = (rate: { wilsonUpper?: number | null } | undefined) =>
        rate?.wilsonUpper ?? 2;
    return {
        contradictionRecallWilsonLower: lower(metrics?.contradictionRecall),
        contradictionPrecisionWilsonLower: lower(metrics?.contradictionPrecision),
        omissionRecallWilsonLower: lower(metrics?.omissionRecall),
        omissionPrecisionWilsonLower: lower(metrics?.omissionPrecision),
        exactQuoteMatchRateWilsonLower: lower(metrics?.exactQuoteMatchRate),
        schemaValidRateWilsonLower: lower(metrics?.schemaValidRate),
        falseConsensusRateWilsonUpper: upper(metrics?.falseConsensusRate),
        inventedIssueRateWilsonUpper: upper(metrics?.inventedIssueRate),
    };
};
