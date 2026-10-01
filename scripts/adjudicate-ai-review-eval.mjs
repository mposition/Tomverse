// Fold a person's blind verdicts into an evaluation run's numbers.
//
// docs/ops/ai-review-eval-runbook.md §6.
//
//   npm run adjudicate:ai-review-eval -- --artifact=<run.json> --record=<blind-review-record.csv>
//
// ## Why this step has to exist
//
// `scoreCase()` takes the zero-tolerance rules a person judged, and the
// evaluation runner passes none: it cannot, because the blind review happens
// after the run. The sheet was generated, a person filled it in, and nothing
// read it back. So a reviewer that fabricated a safety claim -- one of the two
// rules no term list can screen -- was caught by a person, written on the
// form, and recorded in the artifact as zero violations.
//
// This re-runs the REAL scorer over the run's journal with those verdicts
// attached and writes an adjudicated artifact. Re-running the scorer rather
// than adding the human count to the machine count is deliberate: a case where
// the harness screened `winner_declared` and the person also marked it is one
// violation, not two, and `scoreCase()` already knows that. A second
// arithmetic here would eventually disagree with the first.
//
// Calls no model and spends nothing. It reads a journal that already exists.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { AI_REVIEW_EVAL_BLIND_SHEET_RULES } from "../lib/aiReviewEvalCore.ts";
import {
  humanVerdictsByCase,
  parseBlindReviewRecord,
} from "../lib/aiReviewBlindReviewRecord.ts";
import { datasetDigest, datasetProblems } from "../lib/aiReviewEvalRun.ts";
import {
  fileDigest,
  verifyEvidenceBundle,
} from "../lib/aiReviewEvidenceBundle.ts";
import {
  findThresholdSet,
  AI_REVIEW_THRESHOLD_SETS,
} from "../lib/aiReviewQualityThresholds.ts";

/**
 * The seed the SHEET was built with, read from the record's own header.
 *
 * Not the run's seed. The evaluation runner defaults to 0 and the sheet
 * generator to 1, so an ordinary pair of defaults produced a record the gate
 * refused with "sheetSeed 1, not 0". The two are separate decisions and the
 * record is where the sheet's is written down.
 */
const sheetSeedFromRecord = (text) => {
  const match = text.match(/^#\s*sheet-seed:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : Number.NaN;
};

/**
 * The threshold version the sheet was sized for, from the record's own header.
 *
 * Carried into the artifact so a check made before the run reaches a register
 * has a version to look the coverage bar up in. Without it, that check has no
 * bar and has to say so rather than passing quietly.
 */
const thresholdVersionFromRecord = (text) => {
  const match = text.match(/^#\s*threshold-version:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
};

const argValue = (name, fallback = "") => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const read = (path) => {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) die(`${full} does not exist.`);
  return readFileSync(full, "utf8");
};

const artifactPath = argValue("artifact");
const recordPath = argValue("record");
if (!artifactPath || !recordPath) {
  die("--artifact=<run.json> and --record=<blind-review-record.csv> are required.");
}

const artifact = JSON.parse(read(artifactPath));
const summary = artifact.summary ?? {};

// The journal and the answer key sit beside the artifact, named after the same
// run. Derived rather than asked for, so the three cannot be mismatched by a
// typo on the command line.
const directory = dirname(resolve(process.cwd(), artifactPath));
const stem = basename(artifactPath).replace(/\.json$/, "");
const journalPath = join(directory, `${stem}.journal.jsonl`);
const answerKeyPath = join(directory, `${stem}--answer-key.json`);
if (!existsSync(journalPath)) {
  die(
    `${journalPath} does not exist. Adjudication re-scores the run, so it needs the ` +
      "journal the run wrote beside its artifact."
  );
}
if (!existsSync(answerKeyPath)) {
  die(
    `${answerKeyPath} does not exist. The record labels cases as S001, S002 ...; ` +
      "the answer key is what maps those back to case ids."
  );
}

const datasetPath = argValue(
  "dataset",
  `docs/ops/ai-review-evaluation-set/${summary.datasetVersion ?? ""}.json`
);
const dataset = JSON.parse(read(datasetPath));
const datasetIssues = datasetProblems(dataset);
if (datasetIssues.length > 0) {
  die(
    `${datasetPath} is not a valid dataset:\n  - ${datasetIssues.slice(0, 10).join("\n  - ")}`
  );
}
const treeDigest = datasetDigest(dataset);
if (summary.datasetDigest && summary.datasetDigest !== treeDigest) {
  die(
    `The artifact scored ${summary.datasetDigest} and ${datasetPath} fingerprints to ` +
      `${treeDigest}. Adjudication would be re-scoring a different test paper.`
  );
}

const answerKeyText = read(answerKeyPath);
const recordText = read(recordPath);
const journalText = read(journalPath);
// The sheet a person read, beside the rest. Null when it is not there, which
// the bundle reports rather than passing over: verdicts that name a reading
// nobody can check are verdicts attached to nothing.
const sheetPath = join(directory, `${stem}--blind-sheet.md`);
const blindSheetText = existsSync(sheetPath) ? readFileSync(sheetPath, "utf8") : null;

// One verification for both commands.
//
// Everything below is derived from these files -- never inherited from the
// artifact's own summary, which is the thing being replaced. A journal missing
// twenty cases used to re-score 1,420 and leave `completedCases: 1,440`
// standing, because the new summary was spread from the old one.
// A version that does not exist is refused before anything is written. The
// artifact would otherwise carry a bar nobody can look up, and the gate would
// be left to discover it after the fact.
const recordThresholdVersion = thresholdVersionFromRecord(recordText);
if (recordThresholdVersion && !findThresholdSet(recordThresholdVersion)) {
  die(
    `The record names threshold version "${recordThresholdVersion}", which does not ` +
      `exist. Known: ${AI_REVIEW_THRESHOLD_SETS.map((set) => set.version).join(", ")}.`
  );
}

const bundle = verifyEvidenceBundle({
  dataset,
  journalText,
  answerKeyText,
  recordText,
  blindSheetText,
  sheetMeta: {
    runOrdinal: summary.runOrdinal ?? null,
    reviewerModelId: summary.reviewerModelId ?? "",
    promptVersion: summary.promptVersion ?? "",
    datasetVersion: dataset.version,
    seed: sheetSeedFromRecord(recordText),
    thresholdVersion: thresholdVersionFromRecord(recordText) ?? undefined,
  },
  identity: {
    runOrdinal: summary.runOrdinal ?? 0,
    reviewerModelId: summary.reviewerModelId ?? "",
    promptVersion: summary.promptVersion ?? "",
    datasetDigest: summary.datasetDigest ?? treeDigest,
    commitSha: summary.commitSha ?? "",
    // The SHEET's seed, which is not the run's. The evaluation runner defaults
    // to 0 and the sheet generator to 1, so reading one for the other refused
    // an ordinary pair of defaults. The sheet wrote its own seed into the
    // record header; that is the value, and it is carried into the artifact so
    // the gate reads it rather than guessing again.
    sheetSeed: sheetSeedFromRecord(recordText),
    thresholdVersion: thresholdVersionFromRecord(recordText),
    // From the sheet on disk, so a record naming a different one is a
    // mismatch rather than an unchecked claim.
    blindSheetDigest: blindSheetText ? fileDigest(blindSheetText) : undefined,
  },
  // No coverage bar here. Adjudication is not an approval: it has to refuse an
  // EMPTY review, which the bundle does structurally, but how many cases are
  // enough is a signed threshold and the gate applies it from the set the
  // register entry names.
  minimumReviewedCases: undefined,
});

if (bundle.problems.length > 0) {
  console.error("The evidence cannot be adjudicated:\n");
  for (const problem of bundle.problems.slice(0, 40)) console.error(`  - ${problem}`);
  if (bundle.problems.length > 40) {
    console.error(`  ... and ${bundle.problems.length - 40} more`);
  }
  console.error(
    "\nNothing was written. A half-filled form, a journal missing cases, or an " +
      "answer key covering nothing is not evidence, and treating any of them as " +
      "evidence is how a clean number gets produced from an incomplete run."
  );
  process.exit(1);
}

const humanOnly = [];
{
  const { record } = parseBlindReviewRecord(recordText);
  const verdicts = humanVerdictsByCase(record, JSON.parse(answerKeyText));
  for (const [caseId, rules] of verdicts) {
    for (const rule of rules) humanOnly.push(`${caseId}: ${rule}`);
  }
}

const adjudicated = {
  ...artifact,
  summary: {
    ...summary,
    adjudicated: true,
    humanBlindReviewRef: recordPath,
    blindReviewSignedBy: bundle.derived.signedBy,
    blindReviewSignedAt: bundle.derived.signedAt,
    blindReviewCasesJudged: bundle.derived.reviewedCases,
    blindReviewRulesJudged: AI_REVIEW_EVAL_BLIND_SHEET_RULES.length,
    blindReviewSheetSeed: sheetSeedFromRecord(recordText),
    blindReviewThresholdVersion: thresholdVersionFromRecord(recordText),
    blindSheetDigest: bundle.derived.blindSheetDigest,
    // Bound by digest, so a record swapped for another of the same shape --
    // or a verdict edited after this ran -- is a mismatch rather than a file
    // nobody re-read.
    blindReviewRecordDigest: bundle.derived.recordDigest,
    blindReviewAnswerKeyDigest: bundle.derived.answerKeyDigest,
    journalDigest: bundle.derived.journalDigest,
    // Recomputed, not inherited.
    plannedCases: bundle.derived.plannedCases,
    completedCases: bundle.derived.completedCases,
    sampleAdequate: bundle.derived.sampleAdequate,
    zeroToleranceViolations: bundle.zeroToleranceViolations,
    decisionGrade:
      dataset.purpose === "decision" &&
      summary.workingTreeDirty !== true &&
      Boolean(summary.commitSha) &&
      summary.commitSha !== "unknown" &&
      bundle.derived.completedCases === bundle.derived.plannedCases &&
      bundle.derived.sampleAdequate,
    adjudicatedAt: new Date().toISOString(),
  },
  metrics: bundle.metrics,
};

const outputPath = join(directory, `${stem}--adjudicated.json`);
writeFileSync(outputPath, `${JSON.stringify(adjudicated, null, 2)}\n`, "utf8");

console.log(`AI Review adjudication — ${stem}\n`);
console.log(
  `  record signed by  ${bundle.derived.signedBy} on ${bundle.derived.signedAt}`
);
console.log(`  cases judged      ${bundle.derived.reviewedCases}`);
console.log(`  rules per case    ${AI_REVIEW_EVAL_BLIND_SHEET_RULES.length}`);
console.log(
  `  cases re-scored   ${bundle.derived.completedCases} / ${bundle.derived.plannedCases}`
);
console.log(
  `\n  zero-tolerance violations  before ${summary.zeroToleranceViolations ?? "?"}  ` +
    `after ${bundle.zeroToleranceViolations}`
);
if (humanOnly.length > 0) {
  console.log("\n  marked by the person:");
  for (const line of humanOnly) console.log(`    ${line}`);
}
console.log(`\nwritten: ${outputPath}`);
console.log(
  "This artifact is the one an approval cites. The un-adjudicated one carries " +
    "only what a term list could screen, and check:ai-review-eval refuses it."
);
