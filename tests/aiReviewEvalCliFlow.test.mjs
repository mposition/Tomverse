// The two commands, run as commands, over a synthetic run.
//
// The unit tests cover the core's arithmetic. This covers the wiring: that
// `adjudicate:ai-review-eval` writes an artifact `check:ai-review-eval` accepts,
// and that editing the record afterwards makes the gate refuse it. Every defect
// found in this layer so far has been a seam between two scripts rather than a
// wrong calculation inside one, and a unit test on either side sees neither.
//
// Calls no model and touches no register.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AI_REVIEW_EVAL_BLIND_SHEET_RULES } from "../lib/aiReviewEvalCore.ts";
import { renderBlindReviewRecordHeader } from "../lib/aiReviewBlindReviewRecord.ts";
import { datasetDigest } from "../lib/aiReviewEvalRun.ts";

const COMMIT = "b".repeat(40);
const RUN = {
  runOrdinal: 1,
  reviewerModelId: "mistral-medium-3-1",
  promptVersion: "comparison-review-v3",
  sheetSeed: 1,
};

const testCase = (index) => ({
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
  gold: { contradictions: [{ id: "year", anyOf: ["1887"], description: "the year" }] },
  goldCompleteness: { contradictions: true },
  status: "adopted",
  adoptedBy: "@mposition",
});

const observation = {
  findings: { contradictions: ["B says 1887"], missingPoints: [], differences: [] },
  allText: "the answers disagree about the year",
  reviewerProse: "the answers disagree about the year",
  totalQuotes: 0,
  matchedQuotes: 0,
  schemaValid: true,
};

const run = (args) =>
  spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", ...args],
    { encoding: "utf8", cwd: process.cwd() }
  );

const build = () => {
  const root = mkdtempSync(join(tmpdir(), "ai-review-cli-"));
  const setDirectory = join(root, "set");
  const runDirectory = join(root, "runs");
  mkdirSync(setDirectory);
  mkdirSync(runDirectory);

  const cases = Array.from({ length: 30 }, (_, index) => testCase(index + 1));
  const dataset = {
    version: "decision-v1",
    schemaVersion: 1,
    purpose: "decision",
    frozenAt: null,
    frozenBy: null,
    frozenDigest: null,
    cases,
  };
  const datasetPath = join(setDirectory, "decision-v1.json");
  writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);

  const stem = "run";
  const artifactPath = join(runDirectory, `${stem}.json`);
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        summary: {
          decisionGrade: true,
          datasetPurpose: "decision",
          datasetVersion: dataset.version,
          datasetDigest: datasetDigest(dataset),
          datasetSchemaVersion: 1,
          commitSha: COMMIT,
          workingTreeDirty: false,
          ...RUN,
          seed: 0,
          plannedCases: cases.length,
          completedCases: cases.length,
          sampleAdequate: false,
          zeroToleranceViolations: 0,
        },
        metrics: {},
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(runDirectory, `${stem}.journal.jsonl`),
    `${cases.map((item) => JSON.stringify({ caseId: item.id, observation })).join("\n")}\n`
  );

  const answerKey = Object.fromEntries(
    cases.map((item, index) => [
      `S${String(index + 1).padStart(3, "0")}`,
      { caseId: item.id, gold: item.gold },
    ])
  );
  writeFileSync(
    join(runDirectory, `${stem}--answer-key.json`),
    `${JSON.stringify(answerKey, null, 2)}\n`
  );

  const recordPath = join(runDirectory, `${stem}--blind-review-record.csv`);
  const writeRecord = (marked = {}) => {
    const header = renderBlindReviewRecordHeader({
      ...RUN,
      datasetDigest: datasetDigest(dataset),
      commitSha: COMMIT,
    })
      .replace("# signed-by: ", "# signed-by: @mposition")
      .replace("# signed-at: ", "# signed-at: 2026-08-31");
    const columns = ["label", ...AI_REVIEW_EVAL_BLIND_SHEET_RULES, "note"].join(",");
    const rows = Object.keys(answerKey).map((label) =>
      [
        label,
        ...AI_REVIEW_EVAL_BLIND_SHEET_RULES.map((rule) =>
          marked[label]?.includes(rule) ? "yes" : "no"
        ),
        "",
      ].join(",")
    );
    writeFileSync(recordPath, `${[header, columns, ...rows].join("\n")}\n`);
  };
  writeRecord();

  return { root, datasetPath, artifactPath, recordPath, runDirectory, stem, writeRecord };
};

test("adjudication derives its counts from the files, and refuses a record it cannot use", (t) => {
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const first = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(first.status, 0, first.stderr);
  const adjudicated = JSON.parse(
    readFileSync(join(fixture.runDirectory, `${fixture.stem}--adjudicated.json`), "utf8")
  );
  assert.equal(adjudicated.summary.adjudicated, true);
  assert.equal(adjudicated.summary.blindReviewCasesJudged, 30);
  assert.equal(adjudicated.summary.completedCases, 30);
  assert.equal(adjudicated.summary.zeroToleranceViolations, 0);
  // The seed the SHEET used, kept apart from the run's own seed. The runner
  // defaults to 0 and the sheet generator to 1, and reading one for the other
  // refused an ordinary pair of defaults.
  assert.equal(adjudicated.summary.blindReviewSheetSeed, 1);
  assert.equal(adjudicated.summary.seed, 0);
  assert.ok(adjudicated.summary.blindReviewRecordDigest.startsWith("sha256:"));
  assert.ok(adjudicated.summary.journalDigest.startsWith("sha256:"));

  // A person marks a rule only they can judge; the count moves.
  fixture.writeRecord({ S001: ["fabricated_safety_claim"] });
  const second = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(second.status, 0, second.stderr);
  const remade = JSON.parse(
    readFileSync(join(fixture.runDirectory, `${fixture.stem}--adjudicated.json`), "utf8")
  );
  assert.equal(remade.summary.zeroToleranceViolations, 1);
  assert.notEqual(
    remade.summary.blindReviewRecordDigest,
    adjudicated.summary.blindReviewRecordDigest
  );
});

test("adjudication refuses a journal missing cases and writes nothing", (t) => {
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const journalPath = join(fixture.runDirectory, `${fixture.stem}.journal.jsonl`);
  const lines = readFileSync(journalPath, "utf8").trim().split("\n");
  writeFileSync(journalPath, `${lines.slice(0, 25).join("\n")}\n`);

  const result = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /was never scored/);
});

test("adjudication refuses an empty answer key rather than reporting five rules judged over nothing", (t) => {
  const fixture = build();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  writeFileSync(join(fixture.runDirectory, `${fixture.stem}--answer-key.json`), "{}\n");
  const result = run([
    "scripts/adjudicate-ai-review-eval.mjs",
    `--artifact=${fixture.artifactPath}`,
    `--record=${fixture.recordPath}`,
    `--dataset=${fixture.datasetPath}`,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /answer key is empty/);
});
