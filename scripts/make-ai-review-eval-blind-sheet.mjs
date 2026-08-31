// Builds the blind human review sheet, its answer key and the record form for
// an AI Review evaluation run.
//
// docs/policy/ai-review-m5-quality-contract.md §4. Two zero-tolerance rules
// (`fabricated_safety_claim`, `false_consensus_safety`) can only be decided by
// a person; this produces everything that person needs so the only thing left
// to them is the judgement and the signature.
//
// Usage:
//   npm run make:ai-review-blind-sheet -- --journal=<path> [--dataset=<path>]
//                                        [--sample=<threshold set default>] [--seed=1]
//                                        [--task-types=safety_sensitive,...]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  buildBlindSheet,
  renderBlindReviewRecord,
  renderBlindSheet,
} from "../lib/aiReviewEvalBlindSheet.ts";
import { datasetDigest } from "../lib/aiReviewEvalRun.ts";
import {
  findThresholdSet,
  AI_REVIEW_THRESHOLD_SETS,
} from "../lib/aiReviewQualityThresholds.ts";

/**
 * The commit the sheet is about. Empty rather than a guess when git cannot
 * answer: an identity field that quietly says "unknown" would match another
 * run whose commit is also unknown.
 */
const currentCommitSha = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const argValue = (name, fallback = "") => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const journalPath = argValue("journal");
if (!journalPath) {
  console.error("--journal=<path to a *.journal.jsonl written by eval-ai-review.mjs> is required.");
  process.exit(1);
}
if (!existsSync(journalPath)) {
  console.error(`journal not found: ${journalPath}`);
  process.exit(1);
}

const datasetPath = argValue(
  "dataset",
  "docs/ops/ai-review-evaluation-set/development-v0.json"
);
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));

const records = readFileSync(journalPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const observations = new Map();
for (const record of records) {
  if (record.observation) observations.set(record.caseId, record.observation);
}
if (observations.size === 0) {
  console.error(
    "The journal contains no successful case. There is nothing for a person to review."
  );
  process.exit(1);
}

const seed = Number(argValue("seed", "1"));
// The sheet is built for a named threshold version, and its size defaults to
// that version's coverage bar -- so the sheet a person is handed is the size
// the approval will be judged against. It was pinned to `v1-draft` here, which
// meant adding a `v2` with a different bar would have kept producing sheets of
// the old size, silently.
const thresholdVersion = argValue("threshold-version", "v1-draft");
const thresholdSet = findThresholdSet(thresholdVersion);
if (!thresholdSet) {
  console.error(
    `No threshold set "${thresholdVersion}". Known: ` +
      `${AI_REVIEW_THRESHOLD_SETS.map((set) => set.version).join(", ")}.`
  );
  process.exit(1);
}
const sampleSize = Number(
  argValue("sample", String(thresholdSet.minBlindReviewedCases))
);
if (sampleSize < thresholdSet.minBlindReviewedCases) {
  console.warn(
    `WARNING: --sample=${sampleSize} is below "${thresholdVersion}"'s own bar of ` +
      `${thresholdSet.minBlindReviewedCases}. A review this size cannot satisfy an ` +
      "approval granted under that version.\n"
  );
}
const taskTypes = argValue("task-types", "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const sheet = buildBlindSheet({
  cases: dataset.cases,
  observations,
  seed,
  sampleSize,
  taskTypes,
});

const stem = basename(journalPath).replace(/\.journal\.jsonl$/, "");
const directory = dirname(journalPath);
const ordinalMatch = stem.match(/--ordinal-(\d+)$/);

const meta = {
  runOrdinal: ordinalMatch ? Number(ordinalMatch[1]) : null,
  reviewerModelId: argValue("reviewer", stem.split("--")[1] ?? "unknown"),
  promptVersion: argValue("prompt-version", stem.split("--")[2] ?? "unknown"),
  datasetVersion: dataset.version,
  seed,
};

const sheetPath = join(directory, `${stem}--blind-sheet.md`);
const keyPath = join(directory, `${stem}--answer-key.json`);
const recordPath = join(directory, `${stem}--blind-review-record.csv`);

writeFileSync(sheetPath, renderBlindSheet(sheet, meta), "utf8");
writeFileSync(keyPath, `${JSON.stringify(sheet.answerKey, null, 2)}\n`, "utf8");
// The record carries the run's identity, because its verdicts are read back
// into that run's violation count. A form filled in for one run and applied to
// another would move somebody else's numbers, so adjudication compares every
// field of this header against the run it is adjudicating.
const commitSha = argValue("commit", "");
const datasetDigestValue = argValue("dataset-digest", datasetDigest(dataset));
writeFileSync(
  recordPath,
  renderBlindReviewRecord(sheet, {
    runOrdinal: meta.runOrdinal ?? 0,
    reviewerModelId: meta.reviewerModelId,
    promptVersion: meta.promptVersion,
    datasetDigest: datasetDigestValue,
    commitSha: commitSha || currentCommitSha(),
    sheetSeed: seed,
    thresholdVersion,
  }),
  "utf8"
);

console.log(`sheet        ${sheetPath}   (${sheet.entries.length} item(s))`);
console.log(`answer key   ${keyPath}   — open only after judging`);
console.log(`record form  ${recordPath}`);
console.log(
  "\nThe two rules on the sheet are the ones no script can decide. Everything\n" +
    "else in the run was already scored; nothing here asks a person to re-count."
);
