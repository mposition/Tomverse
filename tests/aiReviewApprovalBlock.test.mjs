import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalBlockDrift,
  approvalBlockFromArtifact,
} from "../lib/aiReviewApprovalBlock.ts";
import {
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_TASK_TYPES,
} from "../lib/aiReviewEvalCore.ts";

const rate = (numerator, denominator) => ({
  numerator,
  denominator,
  point: numerator / denominator,
  wilsonLower: Number((numerator / denominator - 0.05).toFixed(4)),
  wilsonUpper: Number((numerator / denominator + 0.05).toFixed(4)),
});

const armMetrics = (cases) => ({
  cases,
  contradictionPrecision: rate(87, 100),
  contradictionRecall: rate(84, 100),
  omissionPrecision: rate(82, 100),
  omissionRecall: rate(75, 100),
  falseConsensusRate: rate(1, 100),
  inventedIssueRate: rate(2, 100),
  exactQuoteMatchRate: rate(91, 100),
  schemaValidRate: rate(100, 100),
  zeroToleranceViolations: {},
});

const artifact = () => ({
  summary: { zeroToleranceViolations: 0, datasetDigest: "sha256:abc" },
  metrics: {
    aggregate: armMetrics(1200),
    byLanguage: Object.fromEntries(
      AI_REVIEW_EVAL_LANGUAGES.map((name) => [name, armMetrics(600)])
    ),
    byTaskType: Object.fromEntries(
      AI_REVIEW_EVAL_TASK_TYPES.map((name) => [name, armMetrics(200)])
    ),
    byMode: {},
    byLanguageTaskType: {},
  },
});

test("the approval block is generated from the run, not typed from a report", () => {
  const block = approvalBlockFromArtifact(artifact());
  assert.equal(block.byLanguage.length, AI_REVIEW_EVAL_LANGUAGES.length);
  assert.equal(block.byTaskType.length, AI_REVIEW_EVAL_TASK_TYPES.length);
  // Read through approvalMetricsFromArm, which is where the Wilson bound the
  // gate compares actually comes from.
  assert.equal(block.metrics.contradictionRecallWilsonLower, 0.79);
  assert.deepEqual(approvalBlockDrift(block, artifact()), []);
});

test("a rounded digit is caught, and it is the digit that decides the approval", () => {
  // 0.79 is under the v1-draft contradictionRecall floor of 0.8. A person
  // reading "0.79" off a report and writing 0.8 turns a failing run into a
  // passing one, and the threshold gate cannot tell -- it only ever sees what
  // the register records.
  const typed = approvalBlockFromArtifact(artifact());
  const drift = approvalBlockDrift(
    { ...typed, metrics: { ...typed.metrics, contradictionRecallWilsonLower: 0.8 } },
    artifact()
  );
  assert.deepEqual(drift, [
    "aggregate contradictionRecallWilsonLower: register 0.8, artifact 0.79",
  ]);
});

test("an arm the register invented, and one it dropped, are both named", () => {
  const block = approvalBlockFromArtifact(artifact());
  const drift = approvalBlockDrift(
    {
      ...block,
      byTaskType: [
        ...block.byTaskType.filter((arm) => arm.arm !== "safety_sensitive"),
        { ...block.byTaskType[0], arm: "vibes" },
      ],
    },
    artifact()
  );
  assert.ok(
    drift.some((problem) =>
      problem.includes('task-type arm "safety_sensitive" is in the artifact and not the register')
    )
  );
  assert.ok(
    drift.some((problem) =>
      problem.includes('task-type arm "vibes" is in the register and not the artifact')
    )
  );
});

test("a case count that does not match the run is caught", () => {
  const block = approvalBlockFromArtifact(artifact());
  const drift = approvalBlockDrift(
    {
      ...block,
      byLanguage: block.byLanguage.map((arm) =>
        arm.arm === "ko" ? { ...arm, cases: 601 } : arm
      ),
    },
    artifact()
  );
  assert.deepEqual(drift, [
    'language arm "ko" cases: register 601, artifact 600',
  ]);
});

test("a zero-tolerance count the register lowered is caught", () => {
  const source = artifact();
  source.summary.zeroToleranceViolations = 3;
  const drift = approvalBlockDrift(approvalBlockFromArtifact(artifact()), source);
  assert.deepEqual(drift, [
    "zeroToleranceViolations: register 0, artifact 3",
  ]);
});
