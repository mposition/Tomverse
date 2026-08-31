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

import {
  aggregateOutcomes,
  breakdownOutcomes,
  scoreCase,
  AI_REVIEW_EVAL_BLIND_SHEET_RULES,
} from "../lib/aiReviewEvalCore.ts";
import {
  blindReviewRecordProblems,
  humanVerdictsByCase,
  parseBlindReviewRecord,
} from "../lib/aiReviewBlindReviewRecord.ts";
import { datasetDigest, datasetProblems } from "../lib/aiReviewEvalRun.ts";

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

const answerKey = JSON.parse(read(answerKeyPath));
const { record, problems: parseProblems } = parseBlindReviewRecord(read(recordPath));
const identityProblems = blindReviewRecordProblems({
  record,
  sheetLabels: Object.keys(answerKey),
  identity: {
    runOrdinal: summary.runOrdinal ?? 0,
    reviewerModelId: summary.reviewerModelId ?? "",
    promptVersion: summary.promptVersion ?? "",
    datasetDigest: summary.datasetDigest ?? treeDigest,
    commitSha: summary.commitSha ?? "",
    sheetSeed: Number(argValue("seed", "1")),
  },
});
const problems = [...parseProblems, ...identityProblems];
if (problems.length > 0) {
  console.error("The blind review record cannot be used:\n");
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  console.error(
    "\nNothing was written. A half-filled or mis-identified form is not a verdict, " +
      "and treating it as one is how five rules quietly become three."
  );
  process.exit(1);
}

const verdicts = humanVerdictsByCase(record, answerKey);
const byId = new Map(dataset.cases.map((testCase) => [testCase.id, testCase]));
const journal = readFileSync(journalPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const outcomes = [];
for (const entry of journal) {
  const testCase = byId.get(entry.caseId);
  if (!testCase || !entry.observation) continue;
  outcomes.push(scoreCase(testCase, entry.observation, verdicts.get(entry.caseId) ?? []));
}

const breakdown = breakdownOutcomes(outcomes);
const aggregate = aggregateOutcomes(outcomes);
const total = Object.values(aggregate.zeroToleranceViolations).reduce(
  (sum, count) => sum + count,
  0
);

const humanOnly = [];
for (const [caseId, rules] of verdicts) {
  for (const rule of rules) humanOnly.push(`${caseId}: ${rule}`);
}

const adjudicated = {
  ...artifact,
  summary: {
    ...summary,
    adjudicated: true,
    humanBlindReviewRef: recordPath,
    blindReviewSignedBy: record.signedBy,
    blindReviewSignedAt: record.signedAt,
    blindReviewCasesJudged: record.rows.length,
    blindReviewRulesJudged: AI_REVIEW_EVAL_BLIND_SHEET_RULES.length,
    zeroToleranceViolations: total,
    adjudicatedAt: new Date().toISOString(),
  },
  metrics: breakdown,
};

const outputPath = join(directory, `${stem}--adjudicated.json`);
writeFileSync(outputPath, `${JSON.stringify(adjudicated, null, 2)}\n`, "utf8");

console.log(`AI Review adjudication — ${stem}\n`);
console.log(`  record signed by  ${record.signedBy} on ${record.signedAt}`);
console.log(`  cases judged      ${record.rows.length}`);
console.log(`  rules per case    ${AI_REVIEW_EVAL_BLIND_SHEET_RULES.length}`);
console.log(`  cases re-scored   ${outcomes.length}`);
console.log(
  `\n  zero-tolerance violations  before ${summary.zeroToleranceViolations ?? "?"}  ` +
    `after ${total}`
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
