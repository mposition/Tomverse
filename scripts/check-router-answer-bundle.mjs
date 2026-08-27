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
// Usage:
//   node --import tsx scripts/check-router-answer-bundle.mjs \
//     --bundle=<answer-bundle.jsonl> --set=<evaluation set JSON>
//
// It reads two files and exits. No provider is called.

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

const problems = [...answerBundleProblems(bundle)];
const coverage = bundleCoverage(bundle, plannedPerCell);
problems.push(...bundleCoverageProblems(coverage));

console.log(`Answer bundle gate — ${bundlePath}`);
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
    "\nNothing was sent and nothing was billed. A calibration over a short bundle is a\n" +
      "calibration over the pairs that happened to survive."
  );
  process.exit(1);
}

console.log(`\nOK — ${bundle.entries.length} pair(s), every cell above its floor, no bundle problems.`);
