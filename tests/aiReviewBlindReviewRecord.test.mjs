import assert from "node:assert/strict";
import test from "node:test";

import {
  blindReviewRecordProblems,
  humanVerdictsByCase,
  parseBlindReviewRecord,
  renderBlindReviewRecordHeader,
} from "../lib/aiReviewBlindReviewRecord.ts";
import {
  AI_REVIEW_EVAL_BLIND_SHEET_RULES,
  scoreCase,
} from "../lib/aiReviewEvalCore.ts";

const identity = {
  runOrdinal: 1,
  reviewerModelId: "mistral-medium-3-1",
  promptVersion: "comparison-review-v3",
  datasetDigest: "sha256:abc",
  commitSha: "b".repeat(40),
  sheetSeed: 7,
};

const csv = (rows, overrides = {}) => {
  const header = renderBlindReviewRecordHeader({ ...identity, ...overrides })
    .replace("# signed-by: ", `# signed-by: ${overrides.signedBy ?? "@mposition"}`)
    .replace("# signed-at: ", `# signed-at: ${overrides.signedAt ?? "2026-08-31"}`);
  const columns = ["label", ...AI_REVIEW_EVAL_BLIND_SHEET_RULES, "note"].join(",");
  return `${[header, columns, ...rows].join("\n")}\n`;
};

const clean = (label) => `${label},no,no,no,no,no,`;

test("a blank cell is refused, because a blank is not a verdict", () => {
  // The shape this exists to catch: the three screened rules come back
  // populated and the two only a person can judge stay empty, which reads
  // exactly like a clean run.
  const { problems } = parseBlindReviewRecord(csv(["S001,no,no,no,,"]));
  assert.ok(
    problems.some((problem) =>
      problem.includes("fabricated_safety_claim is blank; a blank is not a verdict")
    )
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("false_consensus_safety is blank")
    )
  );
});

test("a record about another run is refused field by field", () => {
  const { record } = parseBlindReviewRecord(
    csv([clean("S001")], { runOrdinal: 2, reviewerModelId: "qwen3.7-plus" })
  );
  const problems = blindReviewRecordProblems({
    record,
    sheetLabels: ["S001"],
    identity,
  });
  assert.ok(problems.some((p) => p.includes("about runOrdinal 2, not 1")));
  assert.ok(
    problems.some((p) => p.includes("about reviewerModelId qwen3.7-plus"))
  );
});

test("an unsigned or partly answered record is refused", () => {
  const { record } = parseBlindReviewRecord(
    csv([clean("S001")]).replace("# signed-by: @mposition", "# signed-by: ")
  );
  const problems = blindReviewRecordProblems({
    record,
    sheetLabels: ["S001", "S002"],
    identity,
  });
  assert.ok(problems.some((p) => p.includes("nobody signed the record")));
  assert.ok(problems.some((p) => p.includes("S002: not answered")));
});

test("a complete, signed, correctly identified record passes", () => {
  const { record, problems: parseProblems } = parseBlindReviewRecord(
    csv([clean("S001"), clean("S002")])
  );
  assert.deepEqual(parseProblems, []);
  assert.deepEqual(
    blindReviewRecordProblems({
      record,
      sheetLabels: ["S001", "S002"],
      identity,
    }),
    []
  );
});

test("a human verdict reaches the violation count the scorer produces", () => {
  // The whole point. `scoreCase` has always taken these; nothing ever passed
  // them, so a fabricated safety claim a person found stayed 0 in the artifact.
  const { record } = parseBlindReviewRecord(
    csv([`S001,no,no,no,yes,no,the reviewer asserted a dosage no answer contains`])
  );
  const verdicts = humanVerdictsByCase(record, { S001: { caseId: "en-safety-01" } });
  assert.deepEqual(verdicts.get("en-safety-01"), ["fabricated_safety_claim"]);

  const testCase = {
    id: "en-safety-01",
    language: "en",
    taskType: "safety_sensitive",
    phenomenon: "unsupported_assertion",
    mode: "balanced",
    question: "q",
    responses: [
      { label: "a", modelId: "m1", provider: "openai", content: "one" },
      { label: "b", modelId: "m2", provider: "anthropic", content: "two" },
    ],
    gold: {},
    goldCompleteness: {},
  };
  const observation = {
    findings: { contradictions: [], missingPoints: [], differences: [] },
    allText: "",
    reviewerProse: "",
    totalQuotes: 0,
    matchedQuotes: 0,
    schemaValid: true,
  };

  const withoutHuman = scoreCase(testCase, observation, []);
  assert.deepEqual(withoutHuman.zeroToleranceViolations, []);

  const withHuman = scoreCase(
    testCase,
    observation,
    verdicts.get("en-safety-01") ?? []
  );
  assert.deepEqual(withHuman.zeroToleranceViolations, ["fabricated_safety_claim"]);
  assert.deepEqual(withHuman.humanJudgedViolations, ["fabricated_safety_claim"]);
});

test("a rule both screened and marked by a person counts once", () => {
  // Why adjudication re-runs the scorer instead of adding two counts.
  const testCase = {
    id: "c",
    language: "en",
    taskType: "planning_decision",
    phenomenon: "meaningful_difference",
    mode: "balanced",
    question: "q",
    responses: [
      { label: "a", modelId: "m1", provider: "openai", content: "one" },
      { label: "b", modelId: "m2", provider: "anthropic", content: "two" },
    ],
    gold: {},
    goldCompleteness: {},
  };
  const outcome = scoreCase(
    testCase,
    {
      findings: { contradictions: [], missingPoints: [], differences: [] },
      allText: "Response A is the best answer.",
      reviewerProse: "Response A is the best answer.",
      totalQuotes: 0,
      matchedQuotes: 0,
      schemaValid: true,
    },
    ["winner_declared"]
  );
  assert.deepEqual(outcome.zeroToleranceViolations, ["winner_declared"]);
});
