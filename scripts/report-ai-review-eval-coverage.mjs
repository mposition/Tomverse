// What the AI Review decision set still needs, cell by cell.
//
// docs/ops/ai-review-eval-runbook.md §3.
//
// ## Why this is a script and not a paragraph in the runbook
//
// The decision set is 1,200 cases across twelve cells, three modes and ten
// phenomena, and "write 1,200 cases" was being handed to a person whole. The
// judgement in a case -- this really is a contradiction, and this list of them
// is exhaustive -- is a person's. Counting which of the twelve cells is short,
// by how many, and whether a cell was filled with the same question rephrased
// is arithmetic, and arithmetic handed to a person is a set that never gets
// built or gets built with a cell quietly at forty.
//
// Reads the tree. Calls no model, spends nothing, writes nothing.
//
// Usage:
//   npm run report:ai-review-eval-coverage
//   npm run report:ai-review-eval-coverage -- --set=docs/ops/ai-review-evaluation-set/decision-v1.json

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { datasetManifest } from "../lib/aiReviewEvalPlan.ts";
import {
  DRAFT_DISCARD_FLOOR_CHARACTERS,
  DRAFT_TARGET_RESPONSE_RANGE,
} from "../lib/aiReviewEvalDraftPrompt.ts";
import { partitionDatasetProblems } from "../lib/aiReviewEvalRun.ts";
import { AI_REVIEW_EVAL_MIN_CASES } from "../lib/aiReviewEvalCore.ts";

const DIRECTORY = "docs/ops/ai-review-evaluation-set";

const argValue = (name) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

const read = (path) => {
  const full = resolve(process.cwd(), path);
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    console.error(`Could not read ${full}: ${error.message}`);
    process.exit(1);
  }
};

const chosen = argValue("set");
const paths = chosen
  ? [chosen]
  : existsSync(DIRECTORY)
    ? readdirSync(DIRECTORY)
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(DIRECTORY, name))
    : [];

if (paths.length === 0) {
  console.log(`No evaluation set found under ${DIRECTORY}.`);
  console.log(
    "The decision set does not exist yet; that is the honest state and this " +
      "report has nothing to measure."
  );
  process.exit(0);
}

for (const path of paths) {
  const dataset = read(path);
  // Defects and build state are different things and are printed as such. A
  // decision set holds candidates for the whole of its construction, and
  // listing each one as a validation problem buries the block where a real
  // fault would show.
  const { blocking, buildState } = partitionDatasetProblems(dataset);
  console.log(`\n${path}`);
  console.log(`  purpose ${dataset.purpose}   version ${dataset.version}`);
  if (blocking.length > 0) {
    console.log(`  ${blocking.length} validation problem(s):`);
    for (const problem of blocking.slice(0, 20)) console.log(`    - ${problem}`);
    if (blocking.length > 20) {
      console.log(`    ... and ${blocking.length - 20} more`);
    }
  }
  if (buildState.length > 0) {
    console.log(
      `  ${buildState.length} case(s) not adopted yet — ordinary while the set is ` +
        `being written, and what stops it being frozen or used as evidence.`
    );
  }

  const manifest = datasetManifest(dataset.cases ?? []);
  console.log(
    `  ${manifest.cases} case(s) against a decision floor of ${AI_REVIEW_EVAL_MIN_CASES.aggregate}`
  );

  console.log("\n  cell coverage (language x task type)");
  for (const cell of manifest.byCell) {
    const flag = cell.missing === 0 ? "ok  " : "need";
    console.log(
      `    ${flag} ${cell.language}/${cell.taskType.padEnd(28)} ` +
        `${String(cell.present).padStart(4)} / ${cell.required}` +
        (cell.missing ? `   ${cell.missing} to write` : "")
    );
  }
  console.log(`    ${manifest.gap.missingCases} case(s) still to be written`);

  if (manifest.gap.modeShortfalls.length > 0) {
    console.log("\n  modes below their floor");
    for (const entry of manifest.gap.modeShortfalls) {
      console.log(`    ${entry.mode.padEnd(10)} ${entry.present} / ${entry.required}`);
    }
  }

  if (manifest.gap.unplantedPhenomena.length > 0) {
    console.log("\n  phenomena nothing plants (the evaluation can say nothing about these)");
    for (const phenomenon of manifest.gap.unplantedPhenomena) {
      console.log(`    ${phenomenon}`);
    }
  }

  console.log("\n  exhaustive-gold claims, by finding kind");
  const exhaustive = Object.entries(manifest.exhaustiveGoldCases);
  if (exhaustive.length === 0) {
    console.log("    none -- with no exhaustive case, precision has no denominator at all");
  }
  for (const [kind, count] of exhaustive) {
    console.log(`    ${kind.padEnd(16)} ${count}`);
  }

  if (manifest.duplicates.length > 0) {
    console.log("\n  repeated questions (deliberate across modes, or a cell filled by paraphrase)");
    for (const group of manifest.duplicates) {
      console.log(`    ${group.ids.join(", ")}`);
    }
  }

  if (manifest.emptyExhaustiveClaims.length > 0) {
    console.log("\n  exhaustive gold that plants nothing (a real 'nothing to find' case, or a flag set before the gold was written)");
    for (const claim of manifest.emptyExhaustiveClaims) {
      console.log(`    ${claim.id}: ${claim.kind}`);
    }
  }

  const lengths = manifest.responseLengths;
  if (lengths.count > 0) {
    console.log("\n  answer length in characters");
    console.log(
      `    min ${lengths.min}   median ${lengths.median}   mean ${lengths.mean}   max ${lengths.max}` +
        `   (${lengths.count} answers)`
    );
    console.log(
      `    The drafting target is ${DRAFT_TARGET_RESPONSE_RANGE.min}-${DRAFT_TARGET_RESPONSE_RANGE.max}. ` +
        `Landing in it is not a pass and missing it is not a failure: whether a case is worth ` +
        `adopting is a judgement about the reasoning in its answers, and a person makes that.`
    );
    if (lengths.belowFloor > 0) {
      console.log(
        `    ${lengths.belowFloor} answer(s) are under the ${DRAFT_DISCARD_FLOOR_CHARACTERS}-character ` +
          `discard floor, which new drafting refuses outright. That floor is a check on the ` +
          `shape of a reply, not a quality bar -- these predate it.`
      );
    }
  }

  const planted = manifest.plantedLabels;
  const assigned = Object.entries(planted.assigned).sort((l, r) => r[1] - l[1]);
  if (assigned.length > 0) {
    console.log("\n  where the fault was ASSIGNED (draftedBy.targetLabel, what the drafter was told)");
    for (const [label, count] of assigned) {
      console.log(`    ${label.padEnd(16)} ${count}`);
    }
    const spread = assigned.filter(([label]) => label !== "not assigned");
    const total = spread.reduce((sum, [, count]) => sum + count, 0);
    const top = spread[0];
    if (total >= 5 && top && top[1] / total >= 0.8) {
      console.log(
        `    NOTE ${Math.round((top[1] / total) * 100)}% of ${total} assigned case(s) went to ` +
          `"${top[0]}". A reviewer that always accuses that slot would score as well as one ` +
          `that reads, so position is being measured alongside reasoning.`
      );
    }
  }

  const realized = Object.entries(planted.realized).sort((l, r) => r[1] - l[1]);
  if (realized.length > 0) {
    console.log(
      "\n  where the gold READS as accusing (a heuristic: the first label token in each gold" +
        " item's leading phrase)"
    );
    for (const [label, count] of realized) {
      console.log(`    ${label.padEnd(16)} ${count}`);
    }
    if (planted.realized.unattributed > 0) {
      console.log(
        `    ${planted.realized.unattributed} gold item(s) name no answer by label -- they quote ` +
          `the offending phrase instead. That is not a defect and says nothing about the ` +
          `assignment above, which is recorded per case rather than inferred.`
      );
    }
  }

  if (planted.disagreements.length > 0) {
    console.log("\n  gold that appears to accuse an answer other than the assigned one");
    for (const entry of planted.disagreements) {
      console.log(`    ${entry.id}: assigned ${entry.assigned}, gold reads ${entry.realized}`);
    }
    console.log("    Read these: either the gold points at the wrong answer, or the heuristic did.");
  }
}

console.log(
  "\nThis report counts. It does not adopt a case, write a gold, or decide a " +
    "set is ready -- those are judgements, and they are signed."
);
