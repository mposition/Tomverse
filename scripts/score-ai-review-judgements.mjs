// Score a judged AI Review case from files, and check a stored score is still
// about them.
//
// docs/ops/ai-review-eval-scoring-contract.md.
//
//   npm run score:ai-review-judgements -- --dir <directory>
//   npm run score:ai-review-judgements -- --dir <directory> --verify
//     ... --journal=<run journal .jsonl>   also check the output is one the run recorded
//     ... --dataset=<frozen set .json>     also check the case is one the set contains
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
  observationRefFor,
  observationShapeProblems,
  scoringArtifactShapeProblems,
  validateJudgedCase,
  verifyJudgedScoringEvidence,
  verifyJudgementRecord,
  verifyRecordAgainstObservation,
} from "../lib/aiReviewEvalJudgement.ts";

/**
 * A named argument, in either form the header documents.
 *
 * `--dir=<path>` and `--dir <path>` both work. Only the first was accepted,
 * while every usage line in this repository writes the second -- so the
 * documented command failed with "--dir=<directory> is required", which reads
 * as the argument being absent rather than being spelled the other way.
 * A following token starting with `--` is the next flag, never this value.
 */
const argValue = (name) => {
  const args = process.argv.slice(2);
  const inline = args.find((argument) => argument.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const next = args[at + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
};
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

// The run's journal and the frozen dataset, when the caller names them.
//
// Three files in a directory can agree perfectly and be about an output this
// run never produced, or a case the frozen set does not contain -- a
// consistent statement about nothing. These are how that is caught, and they
// are optional only because a judgement can be checked before a run exists.
const readOptional = (flag) => {
  const path = argValue(flag);
  if (!path) return undefined;
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) die(`--${flag}=${path} does not exist.`);
  return readFileSync(resolved, "utf8");
};
const readJournal = () => {
  const text = readOptional("journal");
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        // Parsed only. Whether an entry is an object with a usable caseId is
        // the shared entry point's question -- a `null` line used to reach it
        // and throw on `.caseId`.
        return JSON.parse(line);
      } catch (error) {
        die(`--journal line ${index + 1} is not valid JSON: ${error.message}`);
        return null;
      }
    });
};
const readDataset = () => {
  const text = readOptional("dataset");
  if (text === undefined) return undefined;
  try {
    // Handed over as it was parsed. Its shape is checked in the shared entry
    // point, which is where a `cases: false` has to become a problem rather
    // than a skipped comparison.
    return JSON.parse(text);
  } catch (error) {
    die(`--dataset is not valid JSON: ${error.message}`);
    return undefined;
  }
};

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
  // One entry point. The order of these checks lives in the library, so the
  // evidence bundle and this script cannot drift into remembering different
  // sequences -- which is how the old evidence checks grew their gaps.
  const evidence = verifyJudgedScoringEvidence({
    testCase,
    observation,
    record,
    artifact,
    journal: readJournal(),
    dataset: readDataset(),
  });
  failed = report("stored score, against the files beside it", evidence.problems) || failed;
  if (failed) {
    die(
      "\nThe stored score is not about these files. Re-run without --verify to " +
        "score them as they are now."
    );
  }
  console.log("\nThe stored score is about these files.");
  // Sound evidence and usable evidence are different things. A correctly
  // recorded refusal verifies -- it is a true statement that nobody finished
  // judging this case -- and it must not be counted or cited.
  if (evidence.eligibleForAggregation) {
    console.log("It may be counted in a score.");
  } else {
    console.log("\nIt may NOT be counted in a score or cited as promotion evidence:");
    for (const reason of evidence.ineligibleReasons) console.log(`  - ${reason}`);
  }
  process.exit(0);
}

// The derived reference is passed here, not only inside the scorer. Without
// it this section printed `ok` for a record the very next step refused on
// exactly that ground -- the same defect the draft tool had, where a checker
// passes what the real check fails.
failed =
  report(
    "judgement record",
    verifyJudgementRecord(testCase, record, {
      observationRef: observationRefFor(observation),
    })
  ) || failed;
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
      outcome.goldGaps === 0 &&
      outcome.supportClaims === 0 &&
      outcome.insufficientFindings === 0;
    if (empty) continue;
    console.log(
      `  ${kind.padEnd(16)} TP ${outcome.truePositives}  FN ${outcome.falseNegatives}  ` +
        `FP ${outcome.falsePositives}  gaps ${outcome.goldGaps}  ` +
        `precision ${outcome.precisionCounted ? "counted" : "excluded"}`
    );
    // The two diagnostics, printed rather than folded into the numbers above.
    // `supportClaims` is the exclusion an extractor could abuse, and
    // `insufficientFindings` is the part of `falsePositives` that is a real
    // problem named too vaguely rather than a problem invented -- nothing
    // measuring invention may be derived from the false-positive count.
    if (outcome.supportClaims > 0 || outcome.insufficientFindings > 0) {
      console.log(
        `  ${"".padEnd(16)} support ${outcome.supportClaims}  ` +
          `insufficient ${outcome.insufficientFindings} (inside FP)`
      );
    }
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
