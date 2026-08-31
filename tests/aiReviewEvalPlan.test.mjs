import assert from "node:assert/strict";
import test from "node:test";

import {
  coverageGap,
  datasetManifest,
  duplicateQuestions,
  emptyExhaustiveClaims,
  evalCoveragePlan,
} from "../lib/aiReviewEvalPlan.ts";
import {
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_MIN_CASES,
  AI_REVIEW_EVAL_TASK_TYPES,
} from "../lib/aiReviewEvalCore.ts";
import { datasetProblems } from "../lib/aiReviewEvalRun.ts";

const testCase = (overrides = {}) => ({
  id: "c1",
  language: "ko",
  taskType: "safety_sensitive",
  phenomenon: "direct_contradiction",
  mode: "balanced",
  question: "질문",
  responses: [
    { label: "a", modelId: "m", provider: "p", content: "가" },
    { label: "b", modelId: "m2", provider: "p2", content: "나" },
  ],
  gold: { contradictions: [{ id: "g", anyOf: ["x"], description: "d" }] },
  goldCompleteness: { contradictions: true },
  ...overrides,
});

test("the plan is derived from the axes, not written out beside them", () => {
  const plan = evalCoveragePlan();
  assert.equal(
    plan.length,
    AI_REVIEW_EVAL_LANGUAGES.length * AI_REVIEW_EVAL_TASK_TYPES.length
  );
  assert.equal(
    plan.reduce((sum, cell) => sum + cell.required, 0),
    AI_REVIEW_EVAL_MIN_CASES.aggregate
  );
});

test("the gap names each short cell and totals what is left to write", () => {
  const cases = [
    ...Array.from({ length: 100 }, (_, index) =>
      testCase({ id: `ko-${index}` })
    ),
    testCase({ id: "en-1", language: "en" }),
  ];
  const gap = coverageGap(cases);
  const filled = gap.cells.find(
    (cell) => cell.language === "ko" && cell.taskType === "safety_sensitive"
  );
  assert.equal(filled.missing, 0);
  const short = gap.cells.find(
    (cell) => cell.language === "en" && cell.taskType === "safety_sensitive"
  );
  assert.equal(short.present, 1);
  assert.equal(short.missing, 99);
  assert.equal(gap.missingCases, AI_REVIEW_EVAL_MIN_CASES.aggregate - 101);
});

test("a phenomenon nothing plants is named before the set is frozen", () => {
  const gap = coverageGap([testCase()]);
  assert.ok(gap.unplantedPhenomena.includes("prompt_injection"));
  assert.ok(!gap.unplantedPhenomena.includes("direct_contradiction"));
});

test("a cell filled by paraphrase is reported, not deleted", () => {
  // Repeating a question across modes is a real comparison, so this reports
  // rather than decides. What it must not do is stay silent: a hundred
  // rephrasings of one question count as a full cell everywhere else.
  const duplicates = duplicateQuestions([
    { id: "a", question: "  How LONG is the canal? ", mode: "balanced" },
    { id: "b", question: "how long is the canal", mode: "evidence" },
    { id: "c", question: "Something else entirely", mode: "balanced" },
  ]);
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].ids, ["a", "b"]);
});

test("an exhaustive claim that plants nothing is surfaced for a person to confirm", () => {
  // Legitimate for a no-issue case and an accident everywhere else, and the
  // file cannot tell them apart -- so it lists rather than judges.
  const found = emptyExhaustiveClaims([
    testCase({ id: "x", gold: {}, goldCompleteness: { contradictions: true } }),
    testCase({ id: "y" }),
  ]);
  assert.deepEqual(found, [{ id: "x", kind: "contradictions" }]);
});

test("the manifest counts every axis the set is judged on", () => {
  const manifest = datasetManifest([
    testCase({ id: "a" }),
    testCase({ id: "b", mode: "evidence", phenomenon: "omission" }),
  ]);
  assert.equal(manifest.cases, 2);
  assert.equal(manifest.byMode.balanced, 1);
  assert.equal(manifest.byPhenomenon.omission, 1);
  assert.equal(manifest.exhaustiveGoldCases.contradictions, 2);
});

test("a decision set may hold only cases a person adopted", () => {
  const dataset = (cases) => ({
    version: "v1",
    schemaVersion: 1,
    purpose: "decision",
    frozenAt: null,
    frozenBy: null,
    frozenDigest: null,
    cases,
  });

  // A drafted case, exactly as the drafting script writes it.
  const drafted = testCase({ status: "candidate", adoptedBy: null });
  assert.ok(
    datasetProblems(dataset([drafted])).some((problem) =>
      /status is candidate/.test(problem)
    )
  );

  // Absence is candidate, not adopted: a case that arrives without the field
  // must not slip through.
  assert.ok(
    datasetProblems(dataset([testCase()])).some((problem) =>
      /status is candidate/.test(problem)
    )
  );

  // Adopted, but by nobody.
  assert.ok(
    datasetProblems(dataset([testCase({ status: "adopted", adoptedBy: "  " })])).some(
      (problem) => /nobody is named as the adopter/.test(problem)
    )
  );

  assert.deepEqual(
    datasetProblems(
      dataset([testCase({ status: "adopted", adoptedBy: "@mposition" })])
    ),
    []
  );
});

test("a development set is not asked about adoption", () => {
  // It exists to iterate on the harness and is never evidence, which
  // artifactAdmissibilityProblems() refuses separately.
  assert.deepEqual(
    datasetProblems({
      version: "dev",
      schemaVersion: 1,
      purpose: "development",
      frozenAt: null,
      frozenBy: null,
      frozenDigest: null,
      cases: [testCase()],
    }),
    []
  );
});
