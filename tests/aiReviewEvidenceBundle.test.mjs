import assert from "node:assert/strict";
import test from "node:test";

import {
  adjudicatedArtifactProblems,
  fileDigest,
  verifyEvidenceBundle,
} from "../lib/aiReviewEvidenceBundle.ts";
import { findThresholdSet } from "../lib/aiReviewQualityThresholds.ts";
import {
  breakdownOutcomes,
  scoreCase,
  AI_REVIEW_EVAL_BLIND_SHEET_RULES,
} from "../lib/aiReviewEvalCore.ts";
import { renderBlindReviewRecordHeader } from "../lib/aiReviewBlindReviewRecord.ts";
import { datasetDigest } from "../lib/aiReviewEvalRun.ts";

const IDENTITY = {
  runOrdinal: 1,
  reviewerModelId: "mistral-medium-3-1",
  promptVersion: "comparison-review-v3",
  datasetDigest: "",
  commitSha: "b".repeat(40),
  sheetSeed: 1,
};

const caseAt = (index) => ({
  id: `en-safety-${String(index).padStart(3, "0")}`,
  language: index % 2 === 0 ? "en" : "ko",
  taskType: "safety_sensitive",
  phenomenon: "direct_contradiction",
  mode: "balanced",
  question: `question ${index}`,
  responses: [
    { label: "a", modelId: "m1", provider: "openai", content: "1889" },
    { label: "b", modelId: "m2", provider: "anthropic", content: "1887" },
  ],
  gold: {
    contradictions: [{ id: "year", anyOf: ["1887"], description: "the year" }],
  },
  goldCompleteness: { contradictions: true },
});

const observation = () => ({
  findings: { contradictions: ["B says 1887"], missingPoints: [], differences: [] },
  allText: "the answers disagree about the year",
  reviewerProse: "the answers disagree about the year",
  totalQuotes: 0,
  matchedQuotes: 0,
  schemaValid: true,
});

const CASES = Array.from({ length: 30 }, (_, index) => caseAt(index + 1));
const DATASET = {
  version: "decision-v1",
  schemaVersion: 1,
  purpose: "decision",
  frozenAt: null,
  frozenBy: null,
  frozenDigest: null,
  cases: CASES.map((testCase) => ({
    ...testCase,
    status: "adopted",
    adoptedBy: "@mposition",
  })),
};

const journalOf = (cases) =>
  cases.map((testCase) => ({ caseId: testCase.id, observation: observation() }));

const recordOf = (labels, marked = {}) => {
  const header = renderBlindReviewRecordHeader({
    ...IDENTITY,
    datasetDigest: datasetDigest(DATASET),
  })
    .replace("# signed-by: ", "# signed-by: @mposition")
    .replace("# signed-at: ", "# signed-at: 2026-08-31");
  const columns = ["label", ...AI_REVIEW_EVAL_BLIND_SHEET_RULES, "note"].join(",");
  const rows = labels.map((label) =>
    [
      label,
      ...AI_REVIEW_EVAL_BLIND_SHEET_RULES.map((rule) =>
        marked[label]?.includes(rule) ? "yes" : "no"
      ),
      "",
    ].join(",")
  );
  return `${[header, columns, ...rows].join("\n")}\n`;
};

const answerKeyOf = (cases) =>
  Object.fromEntries(
    cases.map((testCase, index) => [
      `S${String(index + 1).padStart(3, "0")}`,
      { caseId: testCase.id, gold: testCase.gold },
    ])
  );

const bundleFor = ({
  journalCases = DATASET.cases,
  keyCases = DATASET.cases,
  marked = {},
  minimumReviewedCases = undefined,
} = {}) => {
  const answerKey = answerKeyOf(keyCases);
  const answerKeyText = JSON.stringify(answerKey, null, 2);
  const journal = journalOf(journalCases);
  const journalText = journal.map((entry) => JSON.stringify(entry)).join("\n");
  const recordText = recordOf(Object.keys(answerKey), marked);
  return {
    inputs: {
      dataset: DATASET,
      journal,
      journalText,
      answerKey,
      answerKeyText,
      recordText,
      identity: { ...IDENTITY, datasetDigest: datasetDigest(DATASET) },
      minimumReviewedCases,
    },
    answerKeyText,
    journalText,
    recordText,
  };
};

const artifactFrom = (bundle, inputs, overrides = {}) => ({
  summary: {
    runOrdinal: 1,
    reviewerModelId: IDENTITY.reviewerModelId,
    promptVersion: IDENTITY.promptVersion,
    commitSha: IDENTITY.commitSha,
    datasetDigest: datasetDigest(DATASET),
    adjudicated: true,
    blindReviewSignedBy: bundle.derived.signedBy,
    blindReviewCasesJudged: bundle.derived.reviewedCases,
    blindReviewRulesJudged: AI_REVIEW_EVAL_BLIND_SHEET_RULES.length,
    blindReviewRecordDigest: bundle.derived.recordDigest,
    blindReviewAnswerKeyDigest: bundle.derived.answerKeyDigest,
    journalDigest: bundle.derived.journalDigest,
    plannedCases: bundle.derived.plannedCases,
    completedCases: bundle.derived.completedCases,
    sampleAdequate: bundle.derived.sampleAdequate,
    zeroToleranceViolations: bundle.zeroToleranceViolations,
    ...overrides.summary,
  },
  metrics: overrides.metrics ?? bundle.metrics,
  ...(inputs ? {} : {}),
});

test("a complete bundle verifies, and its artifact agrees with it", () => {
  const { inputs } = bundleFor();
  const bundle = verifyEvidenceBundle(inputs);
  assert.deepEqual(bundle.problems, []);
  assert.equal(bundle.derived.plannedCases, 30);
  assert.equal(bundle.derived.completedCases, 30);
  assert.equal(bundle.derived.reviewedCases, 30);
  assert.deepEqual(
    adjudicatedArtifactProblems({ artifact: artifactFrom(bundle), bundle }),
    []
  );
});

test("a verdict edited after adjudication makes the artifact stale, and that is caught", () => {
  // The gate used to validate the record's shape and the artifact's numbers
  // separately, and pass while neither had produced the other.
  const before = bundleFor();
  const staleBundle = verifyEvidenceBundle(before.inputs);
  const artifact = artifactFrom(staleBundle);

  const after = bundleFor({ marked: { S001: ["fabricated_safety_claim"] } });
  const nowBundle = verifyEvidenceBundle(after.inputs);
  assert.equal(nowBundle.zeroToleranceViolations, 1);

  const problems = adjudicatedArtifactProblems({ artifact, bundle: nowBundle });
  assert.ok(
    problems.some((problem) => problem.includes("blindReviewRecordDigest")),
    "the record the artifact was made from is not the record on disk"
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("zeroToleranceViolations: the artifact says 0, the evidence says 1")
    )
  );
});

test("an empty answer key and an empty record are refused, not adjudicated as clean", () => {
  // Every validation loop over an empty population simply ends, so zero cases
  // reviewed came out as "five rules judged" with a clean run behind it.
  const { inputs } = bundleFor({ keyCases: [] });
  const bundle = verifyEvidenceBundle(inputs);
  assert.ok(
    bundle.problems.some((problem) => problem.includes("the answer key is empty"))
  );
  assert.ok(
    bundle.problems.some((problem) => problem.includes("no answered row"))
  );
  assert.equal(bundle.metrics, null);
});

test("the coverage bar comes from the signed threshold set, not from this module", () => {
  // It was a bare 20 here, gating approvals under nobody's name, while the
  // runbook suggested 60 and the sheet generator defaulted to 24. Three
  // numbers and no decision. Refusing an EMPTY review is structural and stays;
  // how many cases are enough is a judgement, so it is versioned.
  const withoutBar = verifyEvidenceBundle(
    bundleFor({ keyCases: DATASET.cases.slice(0, 5) }).inputs
  );
  assert.deepEqual(withoutBar.problems, []);

  const bar = findThresholdSet("v1-draft").minBlindReviewedCases;
  const withBar = verifyEvidenceBundle(
    bundleFor({ keyCases: DATASET.cases.slice(0, 5), minimumReviewedCases: bar }).inputs
  );
  assert.ok(
    withBar.problems.some((problem) =>
      problem.includes(`covered 5 case(s); the approved threshold set asks for ${bar}`)
    )
  );
});

test("a journal missing cases is refused rather than silently re-scoring fewer", () => {
  // 1,440 planned, 1,420 journalled: adjudication re-scored what it had and
  // the summary kept the old completedCases, so the run still declared itself
  // complete and the remaining sample still cleared the arm floors.
  const { inputs } = bundleFor({ journalCases: DATASET.cases.slice(0, 25) });
  const bundle = verifyEvidenceBundle(inputs);
  assert.equal(bundle.metrics, null);
  const missing = bundle.problems.filter((problem) =>
    problem.includes("was never scored")
  );
  assert.equal(missing.length, 5);
});

test("a journal case the dataset does not contain, or listed twice, is refused", () => {
  const base = bundleFor();
  const journal = [
    ...base.inputs.journal,
    { caseId: "en-safety-001", observation: observation() },
    { caseId: "not-in-this-set", observation: observation() },
  ];
  const bundle = verifyEvidenceBundle({
    ...base.inputs,
    journal,
    journalText: journal.map((entry) => JSON.stringify(entry)).join("\n"),
  });
  assert.ok(
    bundle.problems.some((problem) => problem.includes('"en-safety-001" appears more than once'))
  );
  assert.ok(
    bundle.problems.some((problem) =>
      problem.includes('"not-in-this-set" is not in this dataset')
    )
  );
});

test("two answer-key labels pointing at one case are refused", () => {
  const base = bundleFor();
  const answerKey = { ...base.inputs.answerKey, S999: { caseId: "en-safety-001" } };
  const bundle = verifyEvidenceBundle({
    ...base.inputs,
    answerKey,
    answerKeyText: JSON.stringify(answerKey),
    recordText: recordOf(Object.keys(answerKey)),
  });
  assert.ok(
    bundle.problems.some((problem) =>
      problem.includes('"en-safety-001" is mapped by more than one label')
    )
  );
});

test("a summary that inherited its counts rather than deriving them is caught", () => {
  const { inputs } = bundleFor();
  const bundle = verifyEvidenceBundle(inputs);
  const problems = adjudicatedArtifactProblems({
    artifact: artifactFrom(bundle, null, {
      summary: { completedCases: 1_440, plannedCases: 1_440 },
    }),
    bundle,
  });
  assert.ok(problems.some((problem) => problem.includes("completedCases: the artifact says 1440")));
  assert.ok(problems.some((problem) => problem.includes("plannedCases: the artifact says 1440")));
});

test("metrics swapped for another run's are caught to the digit", () => {
  const { inputs } = bundleFor();
  const bundle = verifyEvidenceBundle(inputs);
  const other = breakdownOutcomes(
    DATASET.cases.map((testCase) =>
      scoreCase(
        testCase,
        {
          ...observation(),
          findings: { contradictions: [], missingPoints: [], differences: [] },
        },
        []
      )
    )
  );
  const problems = adjudicatedArtifactProblems({
    artifact: artifactFrom(bundle, null, { metrics: other }),
    bundle,
  });
  assert.ok(problems.length > 0);
  assert.ok(problems.some((problem) => problem.includes("contradictionRecallWilsonLower")));
});

test("a file digest changes when one byte does", () => {
  assert.notEqual(fileDigest("a"), fileDigest("b"));
  assert.equal(fileDigest("a"), fileDigest("a"));
});
