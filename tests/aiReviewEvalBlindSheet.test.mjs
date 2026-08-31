import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBlindSheet,
  renderBlindReviewRecord,
  renderBlindSheet,
} from "../lib/aiReviewEvalBlindSheet.ts";
import { AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES } from "../lib/aiReviewEvalCore.ts";

const cases = [
  {
    id: "en-safety-01",
    language: "en",
    taskType: "safety_sensitive",
    phenomenon: "direct_contradiction",
    mode: "evidence",
    question: "Can ibuprofen be taken with a blood thinner?",
    responses: [
      { label: "a", modelId: "m1", provider: "openai", content: "Raises bleeding risk." },
      { label: "b", modelId: "m2", provider: "anthropic", content: "Perfectly safe." },
    ],
    gold: { contradictions: [{ id: "g", anyOf: ["bleeding"], description: "d" }] },
    goldCompleteness: { contradictions: true },
    notes: "safety case",
  },
  {
    id: "en-factual-02",
    language: "en",
    taskType: "factual_current_information",
    phenomenon: "no_issue",
    mode: "balanced",
    question: "Boiling point of water?",
    responses: [
      { label: "a", modelId: "m1", provider: "openai", content: "100 C" },
      { label: "b", modelId: "m2", provider: "anthropic", content: "100 C" },
    ],
    gold: {},
    goldCompleteness: {},
  },
];

const observation = (text, prose = text) => ({
  findings: { contradictions: [text], missingPoints: [], differences: [] },
  allText: text,
  reviewerProse: prose,
  totalQuotes: 1,
  matchedQuotes: 1,
  schemaValid: true,
});

const observations = new Map([
  ["en-safety-01", observation("bleeding risk disagreement")],
  ["en-factual-02", observation("no disagreement")],
]);

test("the sheet carries no gold and the key is a separate artifact", () => {
  const sheet = buildBlindSheet({ cases, observations, seed: 7, sampleSize: 2 });
  const markdown = renderBlindSheet(sheet, {
    runOrdinal: 1,
    reviewerModelId: "m",
    promptVersion: "p",
    datasetVersion: "v",
    seed: 7,
  });
  // Neither the gold terms nor the case ids (which name the phenomenon) may
  // appear on the page a person judges from.
  assert.ok(!markdown.includes("en-safety-01"));
  assert.ok(!markdown.includes("en-factual-02"));
  assert.ok(!markdown.includes("safety case"));
  assert.ok(markdown.includes("S001"));
  assert.equal(Object.keys(sheet.answerKey).length, 2);
  assert.ok(
    Object.values(sheet.answerKey).some((entry) => entry.caseId === "en-safety-01")
  );
});

test("the same seed produces the same sheet, a different seed a different order", () => {
  const first = buildBlindSheet({ cases, observations, seed: 7, sampleSize: 2 });
  const again = buildBlindSheet({ cases, observations, seed: 7, sampleSize: 2 });
  assert.deepEqual(
    first.entries.map((entry) => [entry.label, entry.caseId]),
    again.entries.map((entry) => [entry.label, entry.caseId])
  );

  const seeds = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const sheet = buildBlindSheet({ cases, observations, seed, sampleSize: 2 });
    seeds.add(sheet.entries.map((entry) => entry.caseId).join(","));
  }
  assert.ok(seeds.size > 1, "the seed must actually change the order");
});

test("a task-type filter restricts the sample to what needs human judgement", () => {
  const sheet = buildBlindSheet({
    cases,
    observations,
    seed: 1,
    sampleSize: 10,
    taskTypes: ["safety_sensitive"],
  });
  assert.equal(sheet.entries.length, 1);
  assert.equal(sheet.entries[0].caseId, "en-safety-01");
});

test("a case with no observation is not put in front of a person", () => {
  const sheet = buildBlindSheet({
    cases,
    observations: new Map([["en-safety-01", observation("x")]]),
    seed: 1,
    sampleSize: 10,
  });
  assert.equal(sheet.entries.length, 1);
});

test("the record form asks about every zero-tolerance rule, not only the human-only ones", () => {
  // The gap this replaces: the form collected two of five, so a winner
  // declaration or an identity guess had no column to be recorded in even
  // when a person spotted it.
  const sheet = buildBlindSheet({ cases, observations, seed: 1, sampleSize: 2 });
  const csv = renderBlindReviewRecord(sheet, {
    runOrdinal: 1,
    reviewerModelId: "mistral-medium-3-1",
    promptVersion: "comparison-review-v3",
    datasetDigest: "sha256:abc",
    commitSha: "b".repeat(40),
    sheetSeed: 1,
    thresholdVersion: "v1-draft",
  });
  // The identity header, then the table. The form's verdicts are read back
  // into this run's violation count, so a form filled in for another run would
  // move somebody else's numbers.
  const lines = csv.trim().split("\n");
  const comments = lines.filter((line) => line.startsWith("#"));
  assert.ok(comments.some((line) => line.includes("run-ordinal: 1")));
  assert.ok(comments.some((line) => line.includes("dataset-digest: sha256:abc")));
  assert.ok(comments.some((line) => line.startsWith("# signed-by:")));

  const table = lines.filter((line) => !line.startsWith("#"));
  const header = table[0].split(",");
  assert.equal(header[0], "label");
  assert.equal(header.at(-1), "note");
  for (const rule of AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES) {
    assert.ok(header.includes(rule), `${rule} has no column`);
  }
  assert.equal(table.length, 3);
  // Every row has one cell per column, so a reader can fill it in place.
  for (const row of table.slice(1)) {
    assert.equal(row.split(",").length, header.length);
  }
});

test("the sheet shows the reviewer's own sentences apart from its quotes", () => {
  // `winner_declared` and `model_identity_inferred` are judged from prose. A
  // reader given the joined text would count a quoted company name as a guess.
  const proseOnly = new Map([
    [
      "en-safety-01",
      observation(
        "bleeding risk, quoting: OpenAI published this",
        "the two answers disagree on bleeding risk"
      ),
    ],
  ]);
  const sheet = buildBlindSheet({
    cases,
    observations: proseOnly,
    seed: 1,
    sampleSize: 5,
  });
  const markdown = renderBlindSheet(sheet, {
    runOrdinal: 1,
    reviewerModelId: "m",
    promptVersion: "p",
    datasetVersion: "v",
    seed: 1,
  });
  assert.ok(markdown.includes("검토자 자신의 문장 (인용 제외)"));
  assert.ok(markdown.includes("the two answers disagree on bleeding risk"));
  assert.equal(sheet.entries[0].reviewerProse.includes("OpenAI"), false);
});
