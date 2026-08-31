import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_REVIEW_THRESHOLD_SETS,
  approvalMetricsFromArm,
  approvedThresholdSets,
  findThresholdSet,
  thresholdShortfalls,
} from "../lib/aiReviewQualityThresholds.ts";
import {
  aggregateOutcomes,
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_TASK_TYPES,
} from "../lib/aiReviewEvalCore.ts";
import { approvedEntryProblems } from "../lib/aiReviewEvalRegister.ts";

const thresholds = findThresholdSet("v1-draft");

const passingMetrics = () => ({
  contradictionRecallWilsonLower: 0.9,
  contradictionPrecisionWilsonLower: 0.9,
  omissionRecallWilsonLower: 0.8,
  omissionPrecisionWilsonLower: 0.85,
  exactQuoteMatchRateWilsonLower: 0.9,
  schemaValidRateWilsonLower: 0.99,
  falseConsensusRateWilsonUpper: 0.05,
  inventedIssueRateWilsonUpper: 0.05,
});

const arm = (name, overrides = {}) => ({
  arm: name,
  cases: 600,
  ...passingMetrics(),
  ...overrides,
});

// The full required sets, because a partial one is now itself a shortfall.
// The fixtures used to carry two task-type arms out of six and produced no
// complaint about the other four -- which was the defect, not the fixture.
const languageArms = (overrides = {}) =>
  AI_REVIEW_EVAL_LANGUAGES.map((name) => arm(name, overrides));
const taskTypeArms = (overrides = {}) =>
  AI_REVIEW_EVAL_TASK_TYPES.map((name) => arm(name, { cases: 200, ...overrides }));

const check = (overrides = {}) =>
  thresholdShortfalls({
    thresholds,
    aggregate: passingMetrics(),
    byLanguage: languageArms(),
    byTaskType: taskTypeArms(),
    zeroToleranceViolations: 0,
    ...overrides,
  });

test("no threshold set is approved, so no pair can be approved on quality", () => {
  // The state this is meant to describe: the bars are written down as a
  // proposal, and a proposal cannot bless anything.
  assert.deepEqual(approvedThresholdSets(), []);
  assert.equal(thresholds.approvedBy, null);
  assert.ok(AI_REVIEW_THRESHOLD_SETS.length > 0);
});

test("numbers that clear every bar produce no shortfall", () => {
  assert.deepEqual(check(), []);
});

test("a metric below its floor is named, with the bar it missed", () => {
  const problems = check({
    aggregate: { ...passingMetrics(), contradictionRecallWilsonLower: 0.31 },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /contradictionRecallWilsonLower 0\.31 < 0\.8/);
});

test("an error rate above its ceiling is named", () => {
  const problems = check({
    aggregate: { ...passingMetrics(), inventedIssueRateWilsonUpper: 0.4 },
  });
  assert.match(problems[0], /inventedIssueRateWilsonUpper 0\.4 > 0\.1/);
});

test("an unmeasured rate fails rather than passing as zero", () => {
  // `approvalMetricsFromArm` turns a null upper bound into 2. An empty
  // denominator is not evidence that a rate is low, and a gate that treated it
  // as 0 would approve a pair nobody measured.
  const empty = approvalMetricsFromArm(aggregateOutcomes([]));
  assert.equal(empty.falseConsensusRateWilsonUpper, 2);
  assert.equal(empty.contradictionRecallWilsonLower, -1);
  const problems = check({ aggregate: empty });
  assert.ok(problems.length >= 8, "every bar should be missed");
});

test("a language gap fails even when both arms clear the floor", () => {
  // Both 0.86 and 0.96 pass the 0.85 precision floor; a ten-point gap between
  // Korean and English does not, and the aggregate is exactly what hides it.
  const problems = check({
    byLanguage: [
      arm("ko", { contradictionPrecisionWilsonLower: 0.86 }),
      arm("en", { contradictionPrecisionWilsonLower: 0.96 }),
    ],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /contradictionPrecisionWilsonLower differs by 0\.1000/);
});

test("one language arm is not enough to judge the gap rule", () => {
  const problems = check({ byLanguage: [arm("en")] });
  assert.ok(problems.some((problem) => /no language arm for "ko"/.test(problem)));
  assert.ok(
    problems.some((problem) => /1 distinct language arm\(s\) recorded/.test(problem))
  );
});

test("two arms of the same language do not satisfy the gap rule", () => {
  // The hole this closes: the rule was `byLanguage.length < 2`, so two arms
  // both labelled `en` passed it and the Korean arm was never asked for.
  const problems = check({ byLanguage: [arm("en"), arm("en")] });
  assert.ok(problems.some((problem) => /no language arm for "ko"/.test(problem)));
  assert.ok(problems.some((problem) => /"en" appears 2 times/.test(problem)));
});

test("an approval carrying no task-type arms is refused", () => {
  // Reproduced against v1-draft with a perfect aggregate: `byTaskType: []`
  // produced no shortfall at all, because the rule walked the arms it was
  // handed and was handed none. The aggregate is what hides a collapsed arm,
  // so an approval judged on the aggregate alone is the failure the arm rules
  // exist to prevent.
  const problems = check({ byTaskType: [] });
  for (const taskType of AI_REVIEW_EVAL_TASK_TYPES) {
    assert.ok(
      problems.some((problem) => problem.includes(`no task-type arm for "${taskType}"`)),
      `${taskType} was not required`
    );
  }
});

test("an arm too small to support its own rate is refused", () => {
  const problems = check({ byLanguage: [arm("ko", { cases: 12 }), arm("en")] });
  assert.ok(
    problems.some((problem) => /language arm "ko" reports 12 case\(s\); 600 needed/.test(problem))
  );
});

test("an arm nobody recognises is refused rather than ignored", () => {
  const problems = check({
    byTaskType: [...taskTypeArms(), arm("vibes", { cases: 200 })],
  });
  assert.ok(problems.some((problem) => /"vibes" is not one of/.test(problem)));
});

test("a collapsed task-type arm fails under a passing average", () => {
  const problems = check({
    byTaskType: taskTypeArms().map((entry) =>
      entry.arm === "safety_sensitive"
        ? { ...entry, contradictionRecallWilsonLower: 0.2 }
        : entry
    ),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /safety_sensitive contradictionRecallWilsonLower 0\.2 < 0\.7000/);
});

test("a task-type arm may sit below the aggregate floor, but only so far", () => {
  // 0.75 is under the 0.8 aggregate floor and inside the 0.1 allowance.
  const withBusinessWriting = (value) =>
    check({
      byTaskType: taskTypeArms().map((entry) =>
        entry.arm === "business_writing"
          ? { ...entry, contradictionRecallWilsonLower: value }
          : entry
      ),
    });
  assert.deepEqual(withBusinessWriting(0.75), []);
  assert.equal(withBusinessWriting(0.69).length, 1);
});

test("a zero-tolerance violation fails", () => {
  const problems = check({ zeroToleranceViolations: 1 });
  assert.match(problems[0], /1 zero-tolerance violation/);
});

const approvedEntry = (evaluationOverrides = {}) => ({
  reviewerModelId: "m",
  promptVersion: "p",
  status: "approved",
  owner: "o",
  registeredAt: "2026-01-01",
  evalBudget: null,
  evaluation: {
    artifactRefs: ["a", "b"],
    runOrdinals: [1, 2],
    evaluatedCommit: "deadbeef",
    datasetVersion: "decision-v1",
    datasetSchemaVersion: 1,
    datasetDigest: "sha256:abc",
    languages: ["ko", "en"],
    sampleCounts: {},
    thresholdVersion: "v1-draft",
    metrics: passingMetrics(),
    byLanguage: [arm("ko"), arm("en")],
    byTaskType: [arm("planning_decision")],
    zeroToleranceViolations: 0,
    zeroToleranceRulesHumanJudged: 5,
    blindReviewRef: "docs/.../record.csv",
    approver: "mposition",
    approvedAt: "2026-01-01",
    expiresAt: "2026-07-01",
    knownLimitations: "",
    ...evaluationOverrides,
  },
});

test("an approval resting on an unapproved threshold set is refused", () => {
  // This is why no pair can be approved today, and it is deliberate: the bars
  // are a proposal until a person signs them.
  const problems = approvedEntryProblems(approvedEntry());
  assert.ok(
    problems.some((problem) => /is a proposal and has no approver/.test(problem))
  );
});

test("an approval naming a threshold set that does not exist is refused", () => {
  const problems = approvedEntryProblems(
    approvedEntry({ thresholdVersion: "v9-imaginary" })
  );
  assert.ok(problems.some((problem) => /does not exist/.test(problem)));
});

test("an approval that screened but never judged the zero-tolerance rules is refused", () => {
  const problems = approvedEntryProblems(
    approvedEntry({ zeroToleranceRulesHumanJudged: 3 })
  );
  assert.ok(
    problems.some((problem) =>
      /3 of 5 zero-tolerance rules were judged by a person/.test(problem)
    )
  );
});
