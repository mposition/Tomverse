/**
 * Builds the register's approval block out of an evaluation artifact, and
 * checks a recorded block against the artifact it cites.
 *
 * docs/policy/ai-review-m5-quality-contract.md §6.
 *
 * ## Why this exists
 *
 * `approvalMetricsFromArm()` was written as the one place a run's numbers meet
 * the approval shape, so a digit could not be dropped moving between them. It
 * was then called by nothing except its own test. The register's `evaluation`
 * block was still assembled by hand, which means the gate was checking numbers
 * a person typed from a report -- and a gate applied to transcribed numbers
 * tests the transcription, not the run.
 *
 * So there are two directions here and both matter:
 *
 *   * `approvalBlockFromArtifact()` generates the block, so nobody types it;
 *   * `approvalBlockDrift()` compares a block already in the register against
 *     the artifact it names, so a block that WAS typed, or one whose artifact
 *     was re-run afterwards, is caught rather than trusted.
 *
 * Neither writes to the register. An approval is a person's act recorded in a
 * commit, and a tool that edited its own subject would remove the audit trail
 * the register exists to be.
 */

import {
    approvalMetricsFromArm,
    type AiReviewApprovalArmMetrics,
    type AiReviewApprovalMetrics,
} from "@/lib/aiReviewQualityThresholds";
import type { AiReviewArmBreakdown, AiReviewArmMetrics } from "@/lib/aiReviewEvalCore";

/** The half of an artifact this module reads. */
export type AiReviewEvalArtifact = {
    summary: {
        datasetDigest?: string;
        datasetVersion?: string;
        commitSha?: string;
        runOrdinal?: number | null;
        reviewerModelId?: string;
        promptVersion?: string;
        zeroToleranceViolations?: number;
        decisionGrade?: boolean;
    };
    metrics: AiReviewArmBreakdown;
};

/** The measured half of a register `evaluation` block. */
export type AiReviewApprovalBlock = {
    metrics: AiReviewApprovalMetrics;
    byLanguage: readonly AiReviewApprovalArmMetrics[];
    byTaskType: readonly AiReviewApprovalArmMetrics[];
    zeroToleranceViolations: number;
};

const armsFrom = (
    group: Readonly<Record<string, AiReviewArmMetrics>>
): readonly AiReviewApprovalArmMetrics[] =>
    Object.entries(group)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([arm, metrics]) => ({
            arm,
            cases: metrics.cases,
            ...approvalMetricsFromArm(metrics),
        }));

/**
 * The measured half of an approval, derived from what the run actually
 * produced.
 *
 * Only the measured half. The approver, the deadline, the blind-review
 * reference and the threshold version are decisions, and a decision is not
 * something an artifact can carry.
 */
export const approvalBlockFromArtifact = (
    artifact: AiReviewEvalArtifact
): AiReviewApprovalBlock => ({
    metrics: approvalMetricsFromArm(artifact.metrics.aggregate),
    byLanguage: armsFrom(artifact.metrics.byLanguage),
    byTaskType: armsFrom(artifact.metrics.byTaskType),
    zeroToleranceViolations: artifact.summary.zeroToleranceViolations ?? 0,
});

/**
 * How far apart these numbers are, to the digit.
 *
 * Exact comparison rather than a tolerance. Both sides come from the same
 * function over the same artifact, so any difference at all is a transcription
 * or a re-run -- and both of those are exactly what this is for. A tolerance
 * would let a hand-typed 0.83 stand in for a measured 0.834 and call the
 * approval checked.
 */
export const approvalBlockDrift = (
    recorded: AiReviewApprovalBlock,
    artifact: AiReviewEvalArtifact
): readonly string[] => {
    const expected = approvalBlockFromArtifact(artifact);
    const problems: string[] = [];

    for (const key of Object.keys(expected.metrics) as (keyof AiReviewApprovalMetrics)[]) {
        if (recorded.metrics[key] !== expected.metrics[key]) {
            problems.push(
                `aggregate ${key}: register ${String(recorded.metrics[key])}, ` +
                    `artifact ${String(expected.metrics[key])}`
            );
        }
    }

    const compareArms = (
        recordedArms: readonly AiReviewApprovalArmMetrics[],
        expectedArms: readonly AiReviewApprovalArmMetrics[],
        kind: string
    ) => {
        const byName = new Map(recordedArms.map((arm) => [arm.arm, arm]));
        for (const arm of expectedArms) {
            const found = byName.get(arm.arm);
            if (!found) {
                problems.push(`${kind} arm "${arm.arm}" is in the artifact and not the register`);
                continue;
            }
            byName.delete(arm.arm);
            if (found.cases !== arm.cases) {
                problems.push(
                    `${kind} arm "${arm.arm}" cases: register ${found.cases}, artifact ${arm.cases}`
                );
            }
            for (const key of Object.keys(arm).filter(
                (name) => name !== "arm" && name !== "cases"
            ) as (keyof AiReviewApprovalMetrics)[]) {
                if (found[key] !== arm[key]) {
                    problems.push(
                        `${kind} arm "${arm.arm}" ${key}: register ${String(found[key])}, ` +
                            `artifact ${String(arm[key])}`
                    );
                }
            }
        }
        for (const name of byName.keys()) {
            problems.push(`${kind} arm "${name}" is in the register and not the artifact`);
        }
    };

    compareArms(recorded.byLanguage, expected.byLanguage, "language");
    compareArms(recorded.byTaskType, expected.byTaskType, "task-type");

    if (recorded.zeroToleranceViolations !== expected.zeroToleranceViolations) {
        problems.push(
            `zeroToleranceViolations: register ${recorded.zeroToleranceViolations}, ` +
                `artifact ${expected.zeroToleranceViolations}`
        );
    }
    return problems;
};
