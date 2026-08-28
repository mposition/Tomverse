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
//   harnessAttributableFailureCount = 0   no empty result was ours
//   costSoFar <= the pilot's ceiling
//   stressCost <= $18.00            the judge stage fits at the probe's p90
//   maxPerRequestWorstCase <= $0.75 one judge call cannot breach the ceiling
//   callLimitManifest frozen and sound    the answers were generated under
//                                   the caps the product applies
//
// The attribution count is the one that is not about coverage. An empty result
// this harness caused is our defect wearing a model's name, and a calibration
// built on it measures the harness. mposition's ruling: any of them voids the
// run and blocks the judge.
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
import { callLimitManifestProblems, resolveCallLimit } from "../lib/routerCallLimits.ts";
import {
  FABLE_PER_REQUEST_MAX_COST_USD,
  FABLE_STAGE_MAX_COST_USD,
  PROBED_JUDGE_OUTPUT_TOKENS,
  fableEntryProblems,
  projectFableEntry,
} from "../lib/routerFableEntry.ts";
import { getModel } from "../lib/models.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";

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

// Not a coverage question. An empty result this harness caused is our defect
// reported as a model's behaviour, and a judge graded on it measures the
// harness. Any of them voids the run.
const failureSummary = record.generationFailureSummary;
if (!failureSummary || typeof failureSummary.harnessAttributableFailureCount !== "number") {
  problems.push(
    "the pilot recorded no generation-failure summary, so whether this harness caused an " +
      "empty result cannot be established — and an unestablished zero is not a zero"
  );
} else if (failureSummary.harnessAttributableFailureCount > 0) {
  const reasons = Object.entries(failureSummary.byReason ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  problems.push(
    `${failureSummary.harnessAttributableFailureCount} empty result(s) are attributable to this ` +
      `harness (${reasons || "no reason recorded"}), which makes the run a measurement of the ` +
      "harness rather than of the models"
  );
}

// What the run was allowed to ask for, frozen before it started. A bundle
// whose answers were generated under a cap the product never applies is not a
// measurement of the product, however complete its coverage.
const manifestTrouble = callLimitManifestProblems(record.callLimitManifest);
if (manifestTrouble.length > 0) problems.push(...manifestTrouble);

// What the independent judge would cost on THIS bundle, not on the one the
// probe measured. The input side is counted exactly -- every pair the judge
// would read, rendered -- because it is roughly half the cost and it grows
// with the answers. Only the output side is projected, from the probe's own
// distribution, and the ceiling has to fit the stress case rather than the
// expected one.
let fableEntry = null;
const judgeModelId = set.independentJudge?.modelId;
if (!judgeModelId) {
  problems.push(`${setPath} pre-registers no independentJudge, so the judge stage cannot be priced`);
} else {
  const judgeModel = getModel(judgeModelId);
  if (!judgeModel) {
    problems.push(`${setPath} pre-registers judge "${judgeModelId}", which is not in the catalogue`);
  } else {
    const pricing = resolveModelPricing(judgeModel);
    fableEntry = projectFableEntry(bundle, {
      inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
      requestedMaxOutputTokens: resolveCallLimit(judgeModel, "judge").requestedMaxOutputTokens,
    });
    problems.push(
      ...fableEntryProblems(fableEntry, {
        stageMaxCostUsd: FABLE_STAGE_MAX_COST_USD,
        perRequestMaxCostUsd: FABLE_PER_REQUEST_MAX_COST_USD,
      })
    );
  }
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
  console.log(
    `  empties    ${failureSummary.total ?? 0} empty-text result(s) after normalization — ` +
      `${failureSummary.harnessAttributableFailureCount ?? "?"} attributable to this harness`
  );
  const byReason = Object.entries(failureSummary.byReason ?? {}).filter(([, n]) => n > 0);
  if (byReason.length > 0) {
    console.log(`  by reason  ${byReason.map(([r, n]) => `${r} ${n}`).join(", ")}`);
  }
  for (const failure of [
    ...(failureSummary.harnessAttributable ?? []),
    ...(failureSummary.undetermined ?? []),
  ]) {
    console.log(
      `    ${failure.attribution ?? "?"} ${failure.arm}/${failure.callRole ?? "?"} ` +
        `${failure.provider}/${failure.apiModel} ${failure.emptinessReason ?? "?"} ` +
        `finishReason=${failure.normalizedFinishReason ?? "none"} ` +
        `billed=${failure.billedOutputTokens ?? "none"}/${failure.requestedMaxOutputTokens ?? "none"} ` +
        `traceId=${failure.traceId ?? "none"}`
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

if (fableEntry) {
  console.log(
    `  judge cost exact input ${fableEntry.exactInputTokens} token(s) = $${fableEntry.exactInputCostUsd.toFixed(4)}` +
      `; expected $${fableEntry.expectedCostUsd.toFixed(2)} (${PROBED_JUDGE_OUTPUT_TOKENS.expected} out/pair),` +
      ` stress $${fableEntry.stressCostUsd.toFixed(2)} (${PROBED_JUDGE_OUTPUT_TOKENS.stress} out/pair)` +
      ` against a $${FABLE_STAGE_MAX_COST_USD.toFixed(2)} stage ceiling`
  );
  console.log(
    `  worst request $${fableEntry.maxPerRequestWorstCaseUsd.toFixed(4)} of ` +
      `$${FABLE_PER_REQUEST_MAX_COST_USD.toFixed(2)} allowed` +
      ` (largest rendered input ${fableEntry.maxRenderedInputTokens} token(s))`
  );
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
    "no empty result attributable to this harness, and the pilot finished inside its\n" +
    "ceiling under a frozen call-limit manifest. The independent judge may be called."
);
