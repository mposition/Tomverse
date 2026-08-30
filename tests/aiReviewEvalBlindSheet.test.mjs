import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBlindSheet,
  renderBlindReviewRecord,
  renderBlindSheet,
} from "../lib/aiReviewEvalBlindSheet.ts";

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

const observation = (text) => ({
  findings: { contradictions: [text], missingPoints: [], differences: [] },
  allText: text,
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

test("the record form asks only for the two rules no script can decide", () => {
  const sheet = buildBlindSheet({ cases, observations, seed: 1, sampleSize: 2 });
  const csv = renderBlindReviewRecord(sheet);
  assert.equal(
    csv.split("\n")[0],
    "label,fabricated_safety_claim,false_consensus_safety,note"
  );
  assert.equal(csv.trim().split("\n").length, 3);
});
