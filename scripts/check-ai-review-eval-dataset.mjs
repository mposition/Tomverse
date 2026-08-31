// Whether an AI Review evaluation dataset, and the artifact a run produced,
// may be cited as M5 quality evidence.
//
// docs/policy/ai-review-m5-quality-contract.md §3-§5.
//
// Two independent checks, because a perfect number computed over a sample
// that was still being edited passes neither alone:
//
//   - the dataset, against the schema, the axis vocabulary, the gold
//     completeness rule and (for a decision set) the freeze record;
//   - a run artifact, against the admissibility list.
//
// With no arguments it validates every dataset committed under
// docs/ops/ai-review-evaluation-set/ and says plainly that no decision
// dataset and no decision run exist yet, rather than passing silently and
// reading as approval.
//
// Usage:
//   npm run check:ai-review-eval
//   npm run check:ai-review-eval -- --dataset=<path>
//   npm run check:ai-review-eval -- --artifact=<path>

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  assessSampleAdequacy,
  AI_REVIEW_EVAL_MIN_CASES,
} from "../lib/aiReviewEvalCore.ts";
import {
  artifactAdmissibilityProblems,
  artifactRunProblems,
  datasetDigest,
  datasetProblems,
  freezeDrift,
} from "../lib/aiReviewEvalRun.ts";
import {
  AI_REVIEW_EVAL_REGISTER,
  approvedEntryProblems,
} from "../lib/aiReviewEvalRegister.ts";
import {
  approvalBlockDrift,
  approvalBlockFromArtifact,
} from "../lib/aiReviewApprovalBlock.ts";
import {
  adjudicatedArtifactProblems,
  decisionDatasetProblems,
  verifyEvidenceBundle,
} from "../lib/aiReviewEvidenceBundle.ts";
import {
  findThresholdSet,
  isApprovedThresholdSet,
} from "../lib/aiReviewQualityThresholds.ts";

const argValue = (name) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : "";
};

/**
 * Where the register and the evaluation sets come from.
 *
 * The defaults are the real ones, and CI passes nothing, so the run that gates
 * a pull request always reads the committed register. `--register` and
 * `--dataset-dir` exist so this script can be run against an isolated fixture
 * -- which is how tests/aiReviewEvalCliFlow.test.mjs checks that THIS command,
 * and not a function it happens to import, still refuses stale evidence.
 *
 * They are announced loudly and they only ever narrow: pointing at a fixture
 * register checks that register, and cannot make the default run check less.
 * Both are required together, so a half-override cannot mix a fixture's
 * artifacts with the real register's expectations.
 */
const registerOverride = argValue("register");
const datasetDirectoryOverride = argValue("dataset-dir");
if (Boolean(registerOverride) !== Boolean(datasetDirectoryOverride)) {
  console.error(
    "--register and --dataset-dir must be given together: a fixture register " +
      "read against the real evaluation sets, or the reverse, checks neither."
  );
  process.exit(1);
}

const DATASET_DIRECTORY = datasetDirectoryOverride || "docs/ops/ai-review-evaluation-set";
const REGISTER = registerOverride
  ? JSON.parse(readFileSync(registerOverride, "utf8"))
  : AI_REVIEW_EVAL_REGISTER;
if (registerOverride) {
  console.log(
    `NOT the committed register: --register=${registerOverride} ` +
      `--dataset-dir=${DATASET_DIRECTORY}\n` +
      "This run says nothing about what is approved in this repository.\n"
  );
}

let failures = 0;

const report = (label, problems, notes = []) => {
  if (problems.length === 0) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`);
    for (const problem of problems) console.log(`         - ${problem}`);
  }
  // Notes are printed either way. They say what this check did NOT judge,
  // which is not a defect in the thing being checked and must not be reported
  // as one -- but is exactly what a person needs to know before relying on an
  // "ok".
  for (const note of notes) console.log(`         note ${note}`);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { __readError: error instanceof Error ? error.message : String(error) };
  }
};

const checkDataset = (path) => {
  const dataset = readJson(path);
  if (dataset.__readError) {
    report(path, [`could not be read: ${dataset.__readError}`]);
    return;
  }
  const problems = [...datasetProblems(dataset)];
  if (problems.length === 0) {
    // Only meaningful once the shape is known good: adequacy and freeze both
    // read fields the structural check has just proven exist.
    const adequacy = assessSampleAdequacy(dataset.cases);
    if (dataset.purpose === "decision") {
      const drift = freezeDrift(dataset);
      if (drift) problems.push(drift);
      if (!adequacy.adequate) problems.push(...adequacy.shortfalls);
    } else {
      // A development set is expected to be small and still moving. Saying so
      // is not the same as passing it as evidence: `--artifact` refuses any
      // run against it, and this line is what tells a reader which it is.
      console.log(
        `  note ${path}: development set, ${dataset.cases.length} case(s); ` +
          `a decision set needs ${AI_REVIEW_EVAL_MIN_CASES.aggregate} ` +
          `(${adequacy.shortfalls.length} shortfall(s) against the decision rule)`
      );
      console.log(`       current digest ${datasetDigest(dataset)}`);
    }
  }
  report(path, problems);
};

console.log("AI Review evaluation dataset");
const explicitDataset = argValue("dataset");
if (explicitDataset) {
  checkDataset(explicitDataset);
} else if (!existsSync(DATASET_DIRECTORY)) {
  report(DATASET_DIRECTORY, ["the evaluation-set directory does not exist"]);
} else {
  const files = readdirSync(DATASET_DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    report(DATASET_DIRECTORY, ["no dataset files"]);
  }
  for (const file of files) checkDataset(join(DATASET_DIRECTORY, file));

  const decisionSets = files.filter((file) => {
    const dataset = readJson(join(DATASET_DIRECTORY, file));
    return dataset?.purpose === "decision";
  });
  if (decisionSets.length === 0) {
    console.log(
      "  note no decision dataset exists yet, so no run can produce M5 quality evidence."
    );
  }
}

console.log("\nAI Review reviewer-pair register");
for (const entry of REGISTER) {
  report(
    `${entry.reviewerModelId}@${entry.promptVersion} (${entry.status})`,
    approvedEntryProblems(entry)
  );
}
if (!REGISTER.some((entry) => entry.status === "approved")) {
  console.log(
    "  note no pair is approved. `M5 eligible` is therefore false by construction, " +
      "which is the honest state and not a failure of this check."
  );
}

// ---------------------------------------------------------------------------
// Every approved entry's artifacts, read from the entry itself
// ---------------------------------------------------------------------------
//
// This runs on the DEFAULT invocation, with no arguments, which is how PR Fast
// Gate calls this script.
//
// The comparison used to happen only when `--artifact=<path>` was passed, and
// nothing passes it. An approved entry citing two artifacts that do not exist,
// under an approved threshold set, came out of `npm run check:ai-review-eval`
// as "All checks passed" -- the gate verified the shape of an approval and
// never once opened the evidence it named. An approval's artifacts are named
// BY the approval, so the check has no reason to wait to be told where they
// are.
//
// Four things are required of each run, and a failure in any of them fails the
// gate:
//
//   1. the artifact file exists and parses;
//   2. it is admissible as decision evidence (decision-grade, clean commit,
//      complete run, adequate sample);
//   3. its own summary agrees with the run's recorded identity -- reviewer,
//      prompt version, commit, ordinal, dataset digest;
//   4. its numbers equal the recorded numbers, digit for digit.
//
// (3) is why identity is five fields rather than the dataset digest. A dataset
// is a test paper every reviewer sits, so matching on its digest attributed one
// reviewer's artifact to another and reported the second reviewer's honest
// numbers as the first one's transcription error.

// Every decision set in the tree, by the digest it actually fingerprints to.
//
// Computed here rather than read from the file, because a digest a file states
// about itself is not evidence about the file.
const decisionSetsByDigest = new Map();
if (existsSync(DATASET_DIRECTORY)) {
  for (const file of readdirSync(DATASET_DIRECTORY).filter((name) => name.endsWith(".json"))) {
    const path = join(DATASET_DIRECTORY, file);
    const dataset = readJson(path);
    if (dataset.__readError || dataset.purpose !== "decision") continue;
    if (datasetProblems(dataset).length > 0) continue;
    decisionSetsByDigest.set(datasetDigest(dataset), { path, dataset });
  }
}

console.log("\nAI Review approved-entry evidence");
const approvedEntries = REGISTER.filter(
  (entry) => entry.status === "approved"
);
if (approvedEntries.length === 0) {
  console.log(
    "  note no pair is approved, so there is no evidence to open. An entry that " +
      "becomes approved is checked here without anything being passed to this script."
  );
}
/**
 * Everything an artifact must survive, whether or not a register cites it yet.
 *
 * One function for both callers. The `--artifact` branch used to check only
 * the summary, so the same stale evidence the approved-entry path refused --
 * a verdict edited after adjudication -- passed here. That is not a bypass of
 * CI, which reads the register, but it is a wrong answer at exactly the moment
 * a person is deciding whether a run is worth citing, and the second check
 * existing at all was what made it look answered.
 *
 * `expected` is the register's record of the run, or null when nothing cites
 * this artifact yet. Identity is compared against it when it is there; the
 * evidence bundle is verified either way.
 */
const verifyRunArtifact = ({ artifactPath, expected, decisionSets, thresholdVersion, stage = "evidence" }) => {
  const problems = [];
  const notes = [];
  if (!artifactPath) return { problems: ["names no artifact"], notes };

  const artifact = readJson(artifactPath);
  if (!artifact || artifact.__readError) {
    return {
      problems: [`${artifactPath} could not be read: ${artifact?.__readError ?? "missing"}`],
      notes,
    };
  }
  const summary = artifact.summary ?? {};
  // A run that has just finished is not defective for lacking a blind review
  // that happens afterwards. `stage: "run"` asks only what is answerable now.
  problems.push(
    ...(stage === "run"
      ? artifactRunProblems(summary)
      : artifactAdmissibilityProblems(summary))
  );

  if (expected) {
    const identical = (key, stated, recorded) => {
      if (stated !== recorded) {
        problems.push(`artifact ${key} is ${String(stated)}, recorded as ${String(recorded)}`);
      }
    };
    identical("reviewerModelId", summary.reviewerModelId, expected.reviewerModelId);
    identical("promptVersion", summary.promptVersion, expected.promptVersion);
    identical("commitSha", summary.commitSha, expected.evaluatedCommit);
    identical("runOrdinal", summary.runOrdinal, expected.runOrdinal);
    identical("datasetDigest", summary.datasetDigest, expected.datasetDigest);
    if (!artifact.metrics) {
      problems.push("artifact carries no metrics, so nothing can be compared");
    } else {
      problems.push(...approvalBlockDrift(expected, artifact));
    }
  }

  // The dataset, resolved from the digest to a file in this tree.
  //
  // Readiness finds an adequate decision set A. The approval check asks that
  // the artifact and the register agree on a digest B. Nothing asked whether A
  // and B are the same set -- so a reviewer could be approved on an artifact
  // whose dataset was never committed, or was deleted, while readiness stayed
  // satisfied by an unrelated one. The digest is the handle, so it has to
  // resolve.
  const digest = expected?.datasetDigest ?? summary.datasetDigest;
  const matchingSet = decisionSets.get(digest);
  if (!matchingSet) {
    problems.push(
      `no dataset in ${DATASET_DIRECTORY} fingerprints to ${String(digest)}; ` +
        "the set this run scored is not in the tree" +
        (decisionSets.size > 0
          ? ` (found: ${[...decisionSets.keys()].join(", ")})`
          : " (no valid decision set exists)")
    );
    return { problems, notes };
  }
  if (matchingSet.dataset.version !== summary.datasetVersion) {
    problems.push(
      `artifact names dataset version ${String(summary.datasetVersion)}, but ` +
        `${matchingSet.path} is ${matchingSet.dataset.version}`
    );
  }
  if (matchingSet.dataset.schemaVersion !== summary.datasetSchemaVersion) {
    problems.push(
      `artifact names schema ${String(summary.datasetSchemaVersion)}, but ` +
        `${matchingSet.path} is ${matchingSet.dataset.schemaVersion}`
    );
  }
  problems.push(
    ...decisionDatasetProblems(matchingSet.dataset).map(
      (problem) => `${matchingSet.path}: ${problem}`
    )
  );

  // The bundle: record, answer key and journal, verified together and
  // recomputed, then compared with what the artifact says about them.
  const recordRef = summary.humanBlindReviewRef;
  if (stage === "run") return { problems, notes };
  const artifactDirectory = dirname(artifactPath);
  const artifactStem = basename(artifactPath).replace(/(--adjudicated)?\.json$/, "");
  const answerKeyPath = join(artifactDirectory, `${artifactStem}--answer-key.json`);
  const journalPath = join(artifactDirectory, `${artifactStem}.journal.jsonl`);

  if (!recordRef) {
    problems.push("no blind review record to open");
  } else if (!existsSync(recordRef)) {
    problems.push(`blind review record ${recordRef} does not exist`);
  } else if (!existsSync(answerKeyPath)) {
    problems.push(`no answer key beside the artifact (${answerKeyPath})`);
  } else if (!existsSync(journalPath)) {
    problems.push(
      `no journal beside the artifact (${journalPath}); the numbers cannot be recomputed`
    );
  } else {
    const effectiveThresholdVersion =
      thresholdVersion ?? summary.blindReviewThresholdVersion ?? null;
    const namedSet = effectiveThresholdVersion
      ? findThresholdSet(effectiveThresholdVersion)
      : null;
    const approvedBar =
      namedSet && isApprovedThresholdSet(namedSet)
        ? namedSet.minBlindReviewedCases
        : undefined;
    // Scope, not a defect. How many cases a blind review had to cover is a
    // signed number, and while no set is signed there is no bar -- so this
    // check has not judged coverage, and says so instead of letting an "ok"
    // imply it did. The refusal for resting on an unsigned set already lives
    // in the register check, where an approval is what is being refused.
    if (approvedBar === undefined) {
      notes.push(
        effectiveThresholdVersion
          ? `coverage not judged: threshold set "${effectiveThresholdVersion}" is not approved, ` +
            "so it supplies no bar for how many cases the blind review had to cover"
          : "coverage not judged: nothing names a threshold version, so there is no bar " +
            "for how many cases the blind review had to cover"
      );
    }
    const journalText = readFileSync(journalPath, "utf8");
    const answerKeyText = readFileSync(answerKeyPath, "utf8");
    const recordText = readFileSync(recordRef, "utf8");
    const bundle = verifyEvidenceBundle({
      dataset: matchingSet.dataset,
      journalText,
      answerKeyText,
      recordText,
      identity: {
        runOrdinal: expected?.runOrdinal ?? summary.runOrdinal,
        reviewerModelId: expected?.reviewerModelId ?? summary.reviewerModelId,
        promptVersion: expected?.promptVersion ?? summary.promptVersion,
        datasetDigest: expected?.datasetDigest ?? summary.datasetDigest,
        commitSha: expected?.evaluatedCommit ?? summary.commitSha,
        // The sheet's seed as the artifact recorded it, not the run's.
        sheetSeed: summary.blindReviewSheetSeed,
        thresholdVersion: effectiveThresholdVersion,
      },
      // The signed bar, when the entry names a set that has one. An entry
      // resting on an unsigned set is already refused by the register check;
      // here it means the coverage bar simply is not applied, rather than an
      // unapproved number being applied in its place.
      // The bar, from the version the entry names or -- before an entry names
      // one -- from the version the sheet was built for. An unapproved version
      // supplies no bar, and the caller says so rather than passing quietly.
      minimumReviewedCases: approvedBar,
    });
    problems.push(...adjudicatedArtifactProblems({ artifact, bundle }));
  }
  return { problems, notes };
};

for (const entry of approvedEntries) {
  const runs = entry.evaluation?.runs ?? [];
  if (runs.length === 0) {
    report(`${entry.reviewerModelId}@${entry.promptVersion}`, [
      "approved with no run evidence to open",
    ]);
    continue;
  }
  for (const run of runs) {
    const label = `${entry.reviewerModelId}@${entry.promptVersion} run ${run.runOrdinal}`;
    // A backstop, not a substitute for the safe parsers below it.
    //
    // Everything this loop reads is evidence somebody else wrote, and twice
    // now a malformed one has taken the process down on the first entry so
    // that later entries were never checked. The named guards handle the
    // shapes we know about; this makes any future one a reported failure on
    // its own run rather than a stack trace that ends the report.
    try {
      const outcome = verifyRunArtifact({
        artifactPath: run.artifactRef,
        expected: run,
        decisionSets: decisionSetsByDigest,
        thresholdVersion: entry.evaluation?.thresholdVersion,
      });
      report(label, outcome.problems, outcome.notes);
    } catch (error) {
      report(label, [
        `checking this run threw: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
}

// A run not yet cited by any entry, checked on request.
//
// Through the same evidence path. It used to check the artifact's summary and
// stop, so a verdict edited after adjudication passed here while the
// approved-entry path refused it -- a wrong answer at exactly the moment a
// person is deciding whether a run is worth citing.
const artifactPath = argValue("artifact");
console.log("\nAI Review evaluation run artifact");
if (!artifactPath) {
  console.log(
    "  note no --artifact given. Approved entries are checked against their own " +
      "artifacts above; this is for a run not yet recorded anywhere."
  );
} else {
  // Which question this artifact can answer yet.
  //
  // An adjudicated one is checked in full, including the record it names. One
  // that has only been run is checked on what a run can be judged on, and the
  // next step is stated rather than reported as four defects -- a fresh run is
  // not broken for lacking a review nobody has done.
  const loose = readJson(artifactPath);
  const adjudicated = loose?.summary?.adjudicated === true;
  if (!adjudicated) {
    console.log(
      "  note this artifact has not been adjudicated, so it is checked on what a run\n" +
        "       can be judged on now. Its violation count is still only what a term list\n" +
        "       screened; `npm run adjudicate:ai-review-eval` folds in the blind review,\n" +
        "       and only the adjudicated artifact may be cited by an approval."
    );
  }
  const outcome = verifyRunArtifact({
    artifactPath,
    expected: null,
    decisionSets: decisionSetsByDigest,
    stage: adjudicated ? "evidence" : "run",
  });
  report(artifactPath, outcome.problems, outcome.notes);
}

// The block a person would otherwise retype. Printing rather than writing: an
// approval is recorded by a human in a commit, and a tool that edited the
// register would remove the audit trail the register exists to be.
if (process.argv.includes("--print-approval-block")) {
  const artifact = artifactPath ? readJson(artifactPath) : null;
  if (!artifact || artifact.__readError || !artifact.metrics) {
    console.error(
      "\n--print-approval-block needs --artifact=<path> pointing at a run artifact."
    );
    process.exitCode = 1;
  } else {
    console.log("\nApproval block generated from the artifact:");
    console.log(JSON.stringify(approvalBlockFromArtifact(artifact), null, 4));
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed.");
}
