// Whether an answer bundle may be sent to the independent judge.
//
// This is the cheap check that stands in front of the expensive one. The
// independent judge costs roughly ten times the run that produced the answers,
// so a bundle that is short of pairs buys a calibration over whatever
// survived -- and "whatever survived" is not a population anybody chose.
//
// It exists because the 2026-08-27 run found out too late. The pilot spent 91
// minutes and $0.39, wrote a bundle holding 62 empty answer slots, and the
// rejudge refused it one second later. Nothing was billed for the refusal, and
// nothing was learned either.
//
// mposition approved one job under a total ceiling of $4.50, of which the
// pilot may spend $0.50 and the independent judge $4.00. This is what decides
// whether the second $4.00 is allowed to start, and it is a hard gate: every
// condition below must hold, and any one of them failing means the judge is
// not called at all.
//
//   pilot.completed = true          the pilot ran to the end
//   pilot.pairsAttempted = 210      over the whole set, not a truncated slice
//   bundleProblems = 0              every stored answer is judgeable
//   pairedCoverage >= 200/210       overall floor
//   eachCellPairedCoverage >= 13/14 per-cell floor
//   lostByThisCode = 0              no answer was lost by this harness
//   costSoFar <= 0.50               the pilot stayed inside its own ceiling
//
// `lostByThisCode` is the one that is not about coverage. An answer this code
// lost is our defect wearing a model's name, and a calibration built on it
// measures the harness. mposition's ruling: any of them voids the run and
// blocks the judge.
//
// Usage:
//   node --import tsx scripts/check-router-answer-bundle.mjs \
//     --bundle=<answer-bundle.jsonl> --set=<evaluation set JSON> \
//     --record=<pilot json> --max-cost-usd=0.50
//
// It reads files and exits. No provider is called.

import { readFileSync } from "node:fs";

import { answerBundleProblems, parseAnswerBundle } from "../lib/routerAnswerBundle.ts";
import {
  CELL_PAIRED_COVERAGE_FLOOR,
  PAIRED_COVERAGE_FLOOR,
  bundleCoverage,
  bundleCoverageProblems,
} from "../lib/routerBundleCoverage.ts";

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const flag = (name) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

const bundlePath = flag("bundle") ?? die("--bundle=<answer-bundle.jsonl> is required.");
const setPath = flag("set") ?? die("--set=<evaluation set JSON> is required.");
// Required, not optional. The bundle alone cannot say whether the pilot
// finished, what it spent, or whether this code lost an answer -- and a gate
// that silently skips the checks it has no input for is not a gate.
const recordPath = flag("record") ?? die("--record=<pilot json> is required.");
const rawMaxCost = flag("max-cost-usd") ?? die("--max-cost-usd=<usd> is required.");
const maxCostUsd = Number(rawMaxCost);
if (!(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
  die(`--max-cost-usd must be a positive number (got "${rawMaxCost}").`);
}
// The whole set, per the approval. A pilot that attempted fewer pairs did not
// run the measurement this ceiling was approved for.
const REQUIRED_PAIRS_ATTEMPTED = 210;

const bundle = parseAnswerBundle(readFileSync(bundlePath, "utf8"));
const set = JSON.parse(readFileSync(setPath, "utf8"));

// Planned per cell is the adopted fill of the set the run drew from, which is
// what "the run set out to grade" means. Candidates are not planned: a run
// never asks them.
const plannedPerCell = {};
for (const item of set.items ?? []) {
  if (item.status !== "adopted") continue;
  const cell = `${item.stratum}/${item.cell}`;
  plannedPerCell[cell] = (plannedPerCell[cell] ?? 0) + 1;
}

const record = JSON.parse(readFileSync(recordPath, "utf8"));

const problems = [...answerBundleProblems(bundle)];
const coverage = bundleCoverage(bundle, plannedPerCell);
problems.push(...bundleCoverageProblems(coverage));

// The run's own account of itself. Read as three separate questions because
// they fail for different reasons and an operator needs to know which.
const completed = record.stoppedReason === "completed" && record.truncatedByCost !== true;
if (!completed) {
  problems.push(
    `the pilot did not run to the end — stoppedReason=${record.stoppedReason ?? "unrecorded"}` +
      (record.truncatedByCost === true ? ", truncated by its cost ceiling" : "")
  );
}

const pairsAttempted = Array.isArray(record.pairs) ? record.pairs.length : null;
if (pairsAttempted !== REQUIRED_PAIRS_ATTEMPTED) {
  problems.push(
    `the pilot attempted ${pairsAttempted ?? "an unrecorded number of"} pair(s), not the ` +
      `${REQUIRED_PAIRS_ATTEMPTED} this ceiling was approved for`
  );
}

// Not a coverage question. An answer this code lost is this harness's defect
// reported as a model's behaviour, and a judge graded on it measures the
// harness. Any of them voids the run.
const failureSummary = record.generationFailureSummary;
if (!failureSummary || typeof failureSummary.harnessLostText !== "number") {
  problems.push(
    "the pilot recorded no generation-failure summary, so whether this harness lost an " +
      "answer cannot be established — and an unestablished zero is not a zero"
  );
} else if (failureSummary.harnessLostText > 0) {
  problems.push(
    `this harness lost the text of ${failureSummary.harnessLostText} answer(s) that existed, ` +
      "which makes the run a measurement of the harness rather than of the models"
  );
}

const costSoFar = typeof record.providerCostUsd === "number" ? record.providerCostUsd : null;
if (costSoFar === null) {
  problems.push("the pilot recorded no provider cost, so its ceiling cannot be checked");
} else if (costSoFar > maxCostUsd) {
  problems.push(
    `the pilot spent $${costSoFar.toFixed(4)}, over its own $${maxCostUsd.toFixed(2)} ceiling`
  );
}

console.log(`Answer bundle gate — ${bundlePath}`);
console.log(`  pilot      ${record.stoppedReason ?? "unrecorded"}, ${pairsAttempted ?? "?"} pair(s) attempted`);
console.log(
  `  cost       $${costSoFar === null ? "?" : costSoFar.toFixed(4)} of $${maxCostUsd.toFixed(2)} allowed`
);
if (failureSummary) {
  const byClass = failureSummary.byClassification ?? {};
  console.log(
    `  empties    ${failureSummary.total ?? 0} failed generation(s) — ` +
      `${byClass.harness_lost_text ?? 0} lost by this harness, ` +
      `${byClass.observed_empty_at_adapter_boundary ?? 0} empty at the adapter boundary, ` +
      `${byClass.provider_confirmed_empty ?? 0} confirmed empty by the provider`
  );
  for (const failure of failureSummary.undetermined ?? []) {
    console.log(
      `    undetermined ${failure.arm} ${failure.provider}/${failure.apiModel} ` +
        `finishReason=${failure.finishReason ?? "none"} traceId=${failure.traceId ?? "none"}`
    );
  }
}
console.log(
  `  coverage   ${coverage.covered} of ${coverage.planned} planned pair(s)` +
    `  (floor ${PAIRED_COVERAGE_FLOOR.covered}/${PAIRED_COVERAGE_FLOOR.planned})`
);
console.log(`  per cell   floor ${CELL_PAIRED_COVERAGE_FLOOR.covered}/${CELL_PAIRED_COVERAGE_FLOOR.planned}`);
for (const cell of coverage.cells) {
  const short = cell.planned > 0 && cell.covered < cell.planned;
  console.log(`    ${cell.cell.padEnd(38)} ${cell.covered}/${cell.planned}${short ? "  short" : ""}`);
}

if (problems.length > 0) {
  console.error(`\n${bundlePath} may not be sent to the independent judge:\n`);
  for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
  if (problems.length > 20) console.error(`  ... and ${problems.length - 20} more`);
  console.error(
    "\nNothing was sent and nothing was billed, and the independent judge will not be\n" +
      "called. A calibration over a short bundle is a calibration over the pairs that\n" +
      "happened to survive, and one over answers this harness mangled is a measurement\n" +
      "of this harness. Re-running must start a new pilot: regenerating the pairs that\n" +
      "already completed is not allowed."
  );
  process.exit(1);
}

console.log(
  `\nOK — ${bundle.entries.length} pair(s), every cell above its floor, no bundle problems,\n` +
    "no answer lost by this harness, and the pilot finished inside its ceiling. The\n" +
    "independent judge may be called."
);
