import {
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_TASK_TYPES,
  AI_REVIEW_EVAL_MIN_CASES,
  type AiReviewArmMetrics,
} from "./aiReviewEvalCore";
import type { AiReviewEvidenceBundle } from "./aiReviewEvidenceBundle";
import type { AiReviewJudgedRunReport } from "./aiReviewJudgedReportTypes";
import type { AiReviewJudgedRunMetrics } from "./aiReviewJudgedRunAggregate";
import {
  AI_REVIEW_JUDGED_CEILINGS,
  AI_REVIEW_JUDGED_FLOORS,
  judgedThresholdDraftSchema,
  judgedThresholdProblems,
} from "./aiReviewJudgedThresholds";

export type AiReviewJudgedGateResult = {
  passed: boolean;
  problems: string[];
  metricSource: "judged-v3";
};

/** Six existing floors, two judged ceilings. No keyword error-rate fallback. */
export function evaluateAiReviewJudgedGate(input: {
  thresholds: unknown;
  report: AiReviewJudgedRunReport;
  evidence: AiReviewEvidenceBundle;
}): AiReviewJudgedGateResult {
  const problems = judgedThresholdProblems(input.thresholds);
  const { report, evidence } = input;
  problems.push(...evidence.problems.map((problem) => `evidence: ${problem}`));
  if (!report.result.aggregable)
    problems.push(
      ...report.result.blockers.map(
        (problem) => `insufficient_evidence: ${problem}`,
      ),
    );
  if (!evidence.metrics)
    problems.push("insufficient_evidence: no verified floor metrics");
  if (evidence.derived.datasetDigest !== report.datasetDigest)
    problems.push("the floor and judged evidence name different datasets");
  if (evidence.derived.completedCases !== report.completedCases)
    problems.push(
      "the floor and judged evidence describe different run populations",
    );
  const finish = (): AiReviewJudgedGateResult => ({
    passed: problems.length === 0,
    problems,
    metricSource: "judged-v3",
  });
  if (problems.length || !report.result.aggregable || !evidence.metrics)
    return finish();
  const thresholds = judgedThresholdDraftSchema.parse(input.thresholds);
  if (evidence.derived.reviewedCases < thresholds.minBlindReviewedCases!)
    problems.push(
      "insufficient_evidence: blind review coverage is below the selected minimum",
    );
  if (!evidence.derived.sampleAdequate)
    problems.push(
      "insufficient_evidence: the sample is below the decision-set minimum",
    );
  if (evidence.zeroToleranceViolations > thresholds.maxZeroToleranceViolations)
    problems.push(
      `${evidence.zeroToleranceViolations} zero-tolerance violation(s)`,
    );
  const measured = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
  const values = (
    floor: AiReviewArmMetrics | undefined,
    judged: AiReviewJudgedRunMetrics | undefined,
  ) => ({
    ...Object.fromEntries(
      AI_REVIEW_JUDGED_FLOORS.map((key) => [key, floor?.[key]?.wilsonLower]),
    ),
    ...Object.fromEntries(
      AI_REVIEW_JUDGED_CEILINGS.map((key) => [key, judged?.[key]?.wilsonUpper]),
    ),
  });
  const compare = (
    name: string,
    floor: AiReviewArmMetrics | undefined,
    judged: AiReviewJudgedRunMetrics | undefined,
    allowance: number,
  ) => {
    const observed = values(floor, judged);
    for (const key of AI_REVIEW_JUDGED_FLOORS) {
      const value = observed[key];
      if (!measured(value))
        problems.push(`${name} ${key}: insufficient_evidence`);
      else if (value < thresholds.minWilsonLower[key]! - allowance)
        problems.push(
          `${name} ${key} lower bound ${value} is below ${thresholds.minWilsonLower[key]! - allowance}`,
        );
    }
    for (const key of AI_REVIEW_JUDGED_CEILINGS) {
      const value = observed[key];
      if (!measured(value))
        problems.push(`${name} ${key}: insufficient_evidence`);
      else if (value > thresholds.maxWilsonUpper[key]! + allowance)
        problems.push(
          `${name} ${key} upper bound ${value} exceeds ${thresholds.maxWilsonUpper[key]! + allowance}`,
        );
    }
    return observed;
  };
  compare("aggregate", evidence.metrics.aggregate, report.result.metrics, 0);
  for (const [kind, required, minimum, oldArms, newArms] of [
    [
      "language",
      AI_REVIEW_EVAL_LANGUAGES,
      AI_REVIEW_EVAL_MIN_CASES.perLanguage,
      evidence.metrics.byLanguage,
      report.result.byLanguage,
    ],
    [
      "task-type",
      AI_REVIEW_EVAL_TASK_TYPES,
      AI_REVIEW_EVAL_MIN_CASES.perLanguageTaskTypeCell *
        AI_REVIEW_EVAL_LANGUAGES.length,
      evidence.metrics.byTaskType,
      report.result.byTaskType,
    ],
  ] as const) {
    const seen = new Set<string>();
    for (const arm of newArms) {
      if (
        seen.has(arm.arm) ||
        !(required as readonly string[]).includes(arm.arm)
      )
        problems.push(`${kind}: duplicate or unknown arm ${arm.arm}`);
      seen.add(arm.arm);
      const floor = oldArms[arm.arm];
      if (arm.cases < minimum || floor?.cases !== arm.cases)
        problems.push(
          `${kind} ${arm.arm}: insufficient or mismatched case count`,
        );
      if (kind === "task-type")
        compare(
          arm.arm,
          floor,
          arm.metrics,
          thresholds.maxTaskTypeArmShortfall!,
        );
      else
        for (const [key, value] of Object.entries(values(floor, arm.metrics)))
          if (!measured(value))
            problems.push(`${arm.arm} ${key}: insufficient_evidence`);
    }
    for (const arm of required)
      if (!seen.has(arm)) problems.push(`${kind}: no arm for ${arm}`);
    for (const arm of Object.keys(oldArms))
      if (!seen.has(arm)) problems.push(`${kind}: no judged arm for ${arm}`);
  }
  for (const key of [
    ...AI_REVIEW_JUDGED_FLOORS,
    ...AI_REVIEW_JUDGED_CEILINGS,
  ]) {
    const armValues = report.result.byLanguage.map(
      (arm) => values(evidence.metrics!.byLanguage[arm.arm], arm.metrics)[key],
    );
    if (
      armValues.length >= 2 &&
      armValues.every(measured) &&
      Math.max(...armValues) - Math.min(...armValues) >
        thresholds.maxLanguageArmGap!
    )
      problems.push(
        `${key}: language gap exceeds ${thresholds.maxLanguageArmGap}`,
      );
  }
  if (thresholds.negativeSubset.policy === "gate") {
    const value =
      report.result.metrics.inventedFindingRateNegativeSubset.wilsonUpper;
    if (!measured(value))
      problems.push("negative subset: insufficient_evidence");
    else if (value > thresholds.negativeSubset.maxWilsonUpper!)
      problems.push(
        "negative subset: upper bound exceeds the selected ceiling",
      );
  }
  return finish();
}
