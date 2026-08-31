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
import { join } from "node:path";

import {
  assessSampleAdequacy,
  AI_REVIEW_EVAL_MIN_CASES,
} from "../lib/aiReviewEvalCore.ts";
import {
  artifactAdmissibilityProblems,
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

const DATASET_DIRECTORY = "docs/ops/ai-review-evaluation-set";

const argValue = (name) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : "";
};

let failures = 0;

const report = (label, problems) => {
  if (problems.length === 0) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}`);
  for (const problem of problems) console.log(`         - ${problem}`);
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
for (const entry of AI_REVIEW_EVAL_REGISTER) {
  report(
    `${entry.reviewerModelId}@${entry.promptVersion} (${entry.status})`,
    approvedEntryProblems(entry)
  );
}
if (!AI_REVIEW_EVAL_REGISTER.some((entry) => entry.status === "approved")) {
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

console.log("\nAI Review approved-entry evidence");
const approvedEntries = AI_REVIEW_EVAL_REGISTER.filter(
  (entry) => entry.status === "approved"
);
if (approvedEntries.length === 0) {
  console.log(
    "  note no pair is approved, so there is no evidence to open. An entry that " +
      "becomes approved is checked here without anything being passed to this script."
  );
}
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
    const problems = [];
    const artifact = run.artifactRef ? readJson(run.artifactRef) : null;
    if (!run.artifactRef) {
      problems.push("names no artifact");
    } else if (!artifact || artifact.__readError) {
      problems.push(
        `${run.artifactRef} could not be read: ${artifact?.__readError ?? "missing"}`
      );
    } else {
      const summary = artifact.summary ?? {};
      problems.push(...artifactAdmissibilityProblems(summary));
      if (summary.reviewerModelId !== run.reviewerModelId) {
        problems.push(
          `artifact was written by ${String(summary.reviewerModelId)}, ` +
            `recorded as ${run.reviewerModelId}`
        );
      }
      if (summary.promptVersion !== run.promptVersion) {
        problems.push(
          `artifact used prompt ${String(summary.promptVersion)}, ` +
            `recorded as ${run.promptVersion}`
        );
      }
      if (summary.commitSha !== run.evaluatedCommit) {
        problems.push(
          `artifact ran at ${String(summary.commitSha)}, recorded as ${run.evaluatedCommit}`
        );
      }
      if (summary.runOrdinal !== run.runOrdinal) {
        problems.push(
          `artifact is ordinal ${String(summary.runOrdinal)}, recorded as ${run.runOrdinal}`
        );
      }
      if (summary.datasetDigest !== run.datasetDigest) {
        problems.push(
          `artifact scored ${String(summary.datasetDigest)}, recorded as ${run.datasetDigest}`
        );
      }
      if (!artifact.metrics) {
        problems.push("artifact carries no metrics, so nothing can be compared");
      } else {
        problems.push(...approvalBlockDrift(run, artifact));
      }
    }
    report(label, problems);
  }
}

// A loose artifact, checked on request. Separate from the block above and no
// longer the only path to a comparison: this answers "is the run I just made
// admissible", which is a question asked before any entry cites it.
const artifactPath = argValue("artifact");
console.log("\nAI Review evaluation run artifact");
if (!artifactPath) {
  console.log(
    "  note no --artifact given. Approved entries are checked against their own " +
      "artifacts above; this is for a run not yet recorded anywhere."
  );
} else {
  const artifact = readJson(artifactPath);
  if (artifact.__readError) {
    report(artifactPath, [`could not be read: ${artifact.__readError}`]);
  } else {
    report(artifactPath, artifactAdmissibilityProblems(artifact.summary ?? artifact));
  }
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
