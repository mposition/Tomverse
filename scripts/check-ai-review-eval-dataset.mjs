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

const artifactPath = argValue("artifact");
console.log("\nAI Review evaluation run artifact");
if (!artifactPath) {
  console.log("  note no --artifact given; no decision run has been recorded.");
} else {
  const artifact = readJson(artifactPath);
  if (artifact.__readError) {
    report(artifactPath, [`could not be read: ${artifact.__readError}`]);
  } else {
    report(artifactPath, artifactAdmissibilityProblems(artifact.summary ?? artifact));

    // The numbers in the register, against the numbers the run produced.
    //
    // The approval gate applies thresholds to whatever an entry records. Until
    // this comparison existed, what it recorded was typed by a person from a
    // report, so the gate was testing the transcription. Any entry citing this
    // artifact is now checked digit for digit against it.
    if (artifact.metrics) {
      const digest = artifact.summary?.datasetDigest;
      const citing = AI_REVIEW_EVAL_REGISTER.filter(
        (entry) =>
          entry.evaluation &&
          (entry.evaluation.artifactRefs.some((ref) => ref.includes(artifactPath)) ||
            (digest && entry.evaluation.datasetDigest === digest))
      );
      if (citing.length === 0) {
        console.log(
          "  note no register entry cites this artifact, so there are no recorded numbers to compare."
        );
      }
      for (const entry of citing) {
        report(
          `${entry.reviewerModelId}@${entry.promptVersion} against the artifact`,
          approvalBlockDrift(entry.evaluation, artifact)
        );
      }
    }
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
