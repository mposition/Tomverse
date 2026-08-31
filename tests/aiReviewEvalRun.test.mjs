import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  artifactAdmissibilityProblems,
  datasetDigest,
  datasetProblems,
  decideAiReviewEvalRunMode,
  freezeDrift,
} from "../lib/aiReviewEvalRun.ts";
import {
  AI_REVIEW_EVAL_REGISTER,
  approvedEntryProblems,
  findAiReviewEvalEntry,
  registerDrift,
} from "../lib/aiReviewEvalRegister.ts";

const admitted = {
  live: true,
  registerEntry: { status: "candidate", evalBudget: { maxUsd: 20 } },
  hasApiKey: true,
  datasetFrozen: true,
  datasetPurpose: "decision",
  datasetSchemaVersion: 1,
  commitKnown: true,
  workingTreeDirty: false,
  runOrdinal: 1,
  usedRunOrdinals: [],
};

test("no --live means nothing can be called, whatever else is true", () => {
  assert.deepEqual(
    decideAiReviewEvalRunMode({ ...admitted, live: false }),
    { mode: "smoke" }
  );
});

test("a fully admitted run reports the approved ceiling", () => {
  assert.deepEqual(decideAiReviewEvalRunMode(admitted), {
    mode: "live",
    ceilingUsd: 20,
  });
});

test("every missing precondition refuses by its own name", () => {
  const cases = [
    [{ registerEntry: null }, "unknown_pair"],
    [
      { registerEntry: { status: "revoked", evalBudget: { maxUsd: 20 } } },
      "pair_not_runnable",
    ],
    [{ registerEntry: { status: "candidate", evalBudget: null } }, "no_eval_budget"],
    [{ hasApiKey: false }, "no_api_key"],
    [{ datasetFrozen: false }, "dataset_not_frozen"],
    [{ datasetSchemaVersion: 0 }, "legacy_dataset_schema"],
    [{ commitKnown: false }, "unknown_commit"],
    [{ workingTreeDirty: true }, "dirty_working_tree"],
    [{ runOrdinal: null }, "missing_run_ordinal"],
    [{ runOrdinal: 0 }, "missing_run_ordinal"],
    [{ usedRunOrdinals: [1] }, "duplicate_run_ordinal"],
    [{ requestedRunCapUsd: 40 }, "run_cap_above_approved_ceiling"],
  ];
  for (const [override, reason] of cases) {
    assert.deepEqual(
      decideAiReviewEvalRunMode({ ...admitted, ...override }),
      { mode: "refused", reason },
      `expected ${reason}`
    );
  }
});

test("a development dataset is exempt from the freeze rule and nothing else", () => {
  assert.deepEqual(
    decideAiReviewEvalRunMode({
      ...admitted,
      datasetFrozen: false,
      datasetPurpose: "development",
    }),
    { mode: "live", ceilingUsd: 20 }
  );
  assert.deepEqual(
    decideAiReviewEvalRunMode({
      ...admitted,
      datasetFrozen: false,
      datasetPurpose: "development",
      registerEntry: { status: "candidate", evalBudget: null },
    }),
    { mode: "refused", reason: "no_eval_budget" }
  );
});

test("a run cap may narrow the approved ceiling but never widen it", () => {
  assert.deepEqual(
    decideAiReviewEvalRunMode({ ...admitted, requestedRunCapUsd: 5 }),
    { mode: "live", ceilingUsd: 5 }
  );
});

test("the committed development dataset is structurally valid", () => {
  const dataset = JSON.parse(
    readFileSync("docs/ops/ai-review-evaluation-set/development-v0.json", "utf8")
  );
  assert.deepEqual(datasetProblems(dataset), []);
  assert.equal(dataset.purpose, "development");
  assert.ok(dataset.cases.length > 0);
  assert.ok(datasetDigest(dataset).startsWith("sha256:"));
});

test("the digest covers the cases and not the freeze record", () => {
  const dataset = JSON.parse(
    readFileSync("docs/ops/ai-review-evaluation-set/development-v0.json", "utf8")
  );
  const before = datasetDigest(dataset);
  const stamped = { ...dataset, frozenAt: "2026-08-30T00:00:00Z", frozenBy: "x" };
  assert.equal(datasetDigest(stamped), before);

  const edited = {
    ...dataset,
    cases: [
      { ...dataset.cases[0], question: `${dataset.cases[0].question} (edited)` },
      ...dataset.cases.slice(1),
    ],
  };
  assert.notEqual(datasetDigest(edited), before);
});

test("freeze drift names what changed rather than returning a boolean", () => {
  const dataset = JSON.parse(
    readFileSync("docs/ops/ai-review-evaluation-set/development-v0.json", "utf8")
  );
  assert.match(freezeDrift(dataset), /no freeze record/);

  const frozen = {
    ...dataset,
    frozenAt: "2026-08-30T00:00:00Z",
    frozenBy: "mposition",
    frozenDigest: datasetDigest(dataset),
  };
  assert.equal(freezeDrift(frozen), null);

  const drifted = {
    ...frozen,
    cases: dataset.cases.slice(1),
  };
  assert.match(freezeDrift(drifted), /has changed since it was frozen/);
});

test("gold with no stated completeness is a defect, not a default", () => {
  const problems = datasetProblems({
    version: "v",
    schemaVersion: 1,
    purpose: "development",
    cases: [
      {
        id: "x",
        language: "en",
        taskType: "planning_decision",
        phenomenon: "omission",
        mode: "balanced",
        question: "q",
        responses: [
          { label: "a", modelId: "m", provider: "openai", content: "one" },
          { label: "b", modelId: "n", provider: "anthropic", content: "two" },
        ],
        gold: { missingPoints: [{ id: "g", anyOf: ["x"], description: "d" }] },
        goldCompleteness: {},
      },
    ],
  });
  assert.ok(
    problems.some((problem) => problem.includes("goldCompleteness.missingPoints is not stated"))
  );
});

test("a prompt_injection case without markers cannot detect compliance and is refused", () => {
  const problems = datasetProblems({
    version: "v",
    schemaVersion: 1,
    purpose: "development",
    cases: [
      {
        id: "x",
        language: "en",
        taskType: "safety_sensitive",
        phenomenon: "prompt_injection",
        mode: "balanced",
        question: "q",
        responses: [
          { label: "a", modelId: "m", provider: "openai", content: "one" },
          { label: "b", modelId: "n", provider: "anthropic", content: "two" },
        ],
        gold: {},
        goldCompleteness: {},
      },
    ],
  });
  assert.ok(problems.some((problem) => problem.includes("needs injectionMarkers")));
});

test("artifact admissibility refuses a partial, dirty, development or unreviewed run", () => {
  assert.deepEqual(artifactAdmissibilityProblems(null), ["no artifact"]);

  const admissible = {
    decisionGrade: true,
    datasetPurpose: "decision",
    datasetSchemaVersion: 1,
    datasetDigest: "sha256:abc",
    commitSha: "deadbeef",
    workingTreeDirty: false,
    runOrdinal: 1,
    completedCases: 1_200,
    plannedCases: 1_200,
    sampleAdequate: true,
    humanBlindReviewRef: "docs/ops/.../record.csv",
  };
  assert.deepEqual(artifactAdmissibilityProblems(admissible), []);

  const partial = { ...admissible, completedCases: 1_100 };
  assert.ok(artifactAdmissibilityProblems(partial).some((p) => p.startsWith("partial run")));

  const development = { ...admissible, datasetPurpose: "development" };
  assert.ok(
    artifactAdmissibilityProblems(development).some((p) =>
      p.includes("a development set cannot produce evidence")
    )
  );

  const dirty = { ...admissible, workingTreeDirty: true };
  assert.ok(artifactAdmissibilityProblems(dirty).some((p) => p.includes("working tree was dirty")));

  const unreviewed = { ...admissible, humanBlindReviewRef: null };
  assert.ok(
    artifactAdmissibilityProblems(unreviewed).some((p) => p.includes("blind human review"))
  );
});

test("no reviewer pair is approved, so M5 eligibility is false by construction", () => {
  assert.equal(
    AI_REVIEW_EVAL_REGISTER.some((entry) => entry.status === "approved"),
    false
  );
  for (const entry of AI_REVIEW_EVAL_REGISTER) {
    assert.deepEqual(approvedEntryProblems(entry), []);
  }
});

test("an approved entry missing its evidence is reported item by item", () => {
  const problems = approvedEntryProblems({
    reviewerModelId: "m",
    promptVersion: "p",
    status: "approved",
    owner: "o",
    registeredAt: "2026-01-01",
    evalBudget: null,
    evaluation: {
      artifactRefs: [],
      runOrdinals: [1],
      evaluatedCommit: "unknown",
      datasetVersion: "v",
      datasetSchemaVersion: 1,
      datasetDigest: "not-a-digest",
      languages: ["ko"],
      sampleCounts: {},
      thresholdVersion: "v1-draft",
      metrics: {
        contradictionRecallWilsonLower: 0.8,
        contradictionPrecisionWilsonLower: 0.8,
        omissionRecallWilsonLower: 0.8,
        omissionPrecisionWilsonLower: 0.8,
        exactQuoteMatchRateWilsonLower: 0.9,
        schemaValidRateWilsonLower: 0.99,
        falseConsensusRateWilsonUpper: 0.05,
        inventedIssueRateWilsonUpper: 0.05,
      },
      byLanguage: [],
      byTaskType: [],
      zeroToleranceViolations: 2,
      zeroToleranceRulesHumanJudged: 2,
      blindReviewRef: "",
      approver: "",
      approvedAt: "2026-01-01",
      expiresAt: "",
      knownLimitations: "",
    },
  });
  assert.ok(problems.some((p) => p.includes("no evaluation artifact reference")));
  assert.ok(problems.some((p) => p.includes("1 distinct run ordinal")));
  assert.ok(problems.some((p) => p.includes("evaluated commit is not named")));
  assert.ok(problems.some((p) => p.includes("dataset digest")));
  assert.ok(problems.some((p) => p.includes("blind human review")));
  assert.ok(problems.some((p) => p.includes("no approver")));
  assert.ok(problems.some((p) => p.includes("no re-evaluation deadline")));
  // Three of five rules were only screened by a term list, which is not the
  // same as five having been examined.
  assert.ok(
    problems.some((p) => p.includes("2 of 5 zero-tolerance rules were judged"))
  );
  // And the numbers themselves are refused, because the bar they name is a
  // proposal nobody has signed. Until this existed, an approval that carried
  // an artifact, a commit and two ordinals was accepted whatever it measured.
  assert.ok(problems.some((p) => p.includes("is a proposal and has no approver")));
});

test("register drift reads production's served pairs, never the register itself", () => {
  const drift = registerDrift([
    { reviewerModelId: "mistral-medium-3-1", promptVersion: "comparison-review-v3" },
  ]);
  assert.equal(drift.inSync, false);
  assert.deepEqual(drift.approvedPairs, []);
  assert.deepEqual(drift.servedButNotApproved, [
    "mistral-medium-3-1@comparison-review-v3",
  ]);
});

test("the register can be looked up by the pair the product actually runs", () => {
  assert.ok(findAiReviewEvalEntry("mistral-medium-3-1", "comparison-review-v3"));
  assert.equal(findAiReviewEvalEntry("mistral-medium-3-1", "comparison-review-v99"), null);
});
