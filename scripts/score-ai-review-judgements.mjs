// Score a judged AI Review case from files, and check a stored score is still
// about them.
//
// docs/ops/ai-review-eval-scoring-contract.md.
//
//   npm run score:ai-review-judgements -- --dir <directory>
//   npm run score:ai-review-judgements -- --dir <directory> --verify
//
// The directory holds three inputs and one output:
//
//   case.json         the case, its requirement catalogue and its gold
//   observation.json  the reviewer output that was read
//   record.json       the judgement record made from it, signed
//   artifact.json     the score, written by this script
//
// ## Why a file flow at all
//
// Because the failure this contract exists to prevent is a number that has
// come loose from what it was computed from, and files are where that happens:
// a gold is edited, a judgement is revised, and a stored score goes on saying
// what it said. `--verify` is the question a later reader has to be able to
// ask -- is this still about these files -- and it is answered by recomputing
// the digests, not by trusting a timestamp.
//
// Nothing here calls a provider. It reads local files and writes one.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildScoringArtifact,
  judgedCaseShapeProblems,
  judgementRecordShapeProblems,
  observationShapeProblems,
  scoringArtifactShapeProblems,
  validateJudgedCase,
  verifyJudgementRecord,
  verifyRecordAgainstObservation,
  verifyScoringArtifact,
} from "../lib/aiReviewEvalJudgement.ts";

const argValue = (name) =>
  process.argv
    .slice(2)
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const hasFlag = (name) => process.argv.slice(2).includes(`--${name}`);

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const directory = argValue("dir");
if (!directory) die("--dir=<directory> is required.");
const root = resolve(process.cwd(), directory);

const readJson = (name) => {
  const path = join(root, name);
  if (!existsSync(path)) die(`${join(directory, name)} does not exist.`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    die(`${join(directory, name)} is not valid JSON: ${error.message}`);
  }
  return undefined;
};

const testCase = readJson("case.json");
const observation = readJson("observation.json");
const record = readJson("record.json");

const report = (heading, problems) => {
  console.log(`\n${heading}`);
  if (problems.length === 0) {
    console.log("  ok");
    return false;
  }
  for (const problem of problems) console.log(`  - ${problem}`);
  return true;
};

// Shape before meaning. TypeScript says nothing about JSON somebody wrote:
// `"true"` where a boolean belongs quietly produced a wrong score rather than
// an error, and a mistyped `submittedAs` printed two sections of `ok` before
// throwing. Every problem names its file and field path.
// The mode is the FLAG, never the value read.
//
// `--verify` used to be inferred from the truthiness of the artifact, so an
// `artifact.json` holding `null`, `false`, `0` or `""` skipped its own shape
// check, fell through to the scoring path, and was OVERWRITTEN with a fresh
// score -- a request to verify evidence replacing it instead of refusing it.
const verifyMode = hasFlag("verify");
const artifact = verifyMode ? readJson("artifact.json") : null;
const shape = [
  ...judgedCaseShapeProblems(testCase),
  ...observationShapeProblems(observation),
  ...judgementRecordShapeProblems(record),
  ...(verifyMode ? scoringArtifactShapeProblems(artifact) : []),
];
if (report("file shapes", shape)) die("\nNothing was read further.");

// The case's own registration. A gold naming a requirement the case never
// registered would produce a miss nothing could ever satisfy, and the miss
// would be recorded against the reviewer.
//
// This checks the CASE. It never rejects a claim: a finding about something
// unregistered is a finding outside the gold, which is a judgement and not a
// registration error.
let failed = report("case registration", validateJudgedCase(testCase));

if (verifyMode) {
  failed =
    report(
      "stored score, against the files beside it",
      verifyScoringArtifact({ testCase, record, observation, artifact })
    ) || failed;
  if (failed) {
    die(
      "\nThe stored score is not about these files. Re-run without --verify to " +
        "score them as they are now."
    );
  }
  console.log("\nThe stored score is about these files.");
  process.exit(0);
}

failed = report("judgement record", verifyJudgementRecord(testCase, record)) || failed;
// And that the record actually read THIS output: indexes in range, quotes
// present, every submitted finding accounted for. The digest says the same
// bytes were there and nothing more.
failed =
  report("record against the output", verifyRecordAgainstObservation(observation, record)) ||
  failed;
if (failed) die("\nNothing was scored.");

const scored = buildScoringArtifact({
  testCase,
  record,
  observation,
  scoredAt: new Date().toISOString(),
});

writeFileSync(
  join(root, "artifact.json"),
  `${JSON.stringify(scored, null, 2)}\n`,
  "utf8"
);

console.log(`\nobservation  ${scored.observationRef}`);
console.log(`case         ${scored.caseDigest}`);
console.log(`record       ${scored.recordDigest}`);

if (scored.outcome.scored) {
  console.log("\nscored");
  for (const [kind, outcome] of Object.entries(scored.outcome.byKind)) {
    const empty =
      outcome.truePositives === 0 &&
      outcome.falseNegatives === 0 &&
      outcome.falsePositives === 0 &&
      outcome.goldGaps === 0;
    if (empty) continue;
    console.log(
      `  ${kind.padEnd(16)} TP ${outcome.truePositives}  FN ${outcome.falseNegatives}  ` +
        `FP ${outcome.falsePositives}  gaps ${outcome.goldGaps}  ` +
        `precision ${outcome.precisionCounted ? "counted" : "excluded"}`
    );
  }
} else {
  // A refusal is a report. It is written to the artifact rather than thrown
  // away, because what it says -- which judgements are missing, which gold is
  // disproved -- is what the case has to be corrected with.
  console.log(`\nnot scored\n${scored.outcome.reason}`);
  if (scored.outcome.goldGaps) {
    const gaps = Object.entries(scored.outcome.goldGaps).filter(([, count]) => count > 0);
    for (const [kind, count] of gaps) {
      console.log(`  confirmed gold gap: ${kind} ${count}`);
    }
  }
}

console.log(`\nWritten to ${join(directory, "artifact.json")}. No provider was called.`);
