// Aggregate a judged AI Review run from the files a run left behind.
//
// docs/ops/ai-review-eval-scoring-contract.md -- the two metrics approved on
// 2026-09-09, and the run-level admission rules they sit behind.
//
//   npm run report:ai-review-judged-run -- \
//     --run=<run artifact .json> \
//     --journal=<run journal .jsonl> \
//     --dataset=<frozen evaluation set .json> \
//     --judgements=<directory of per-case bundles>
//
// ## What this is
//
// **A report, not a gate.** It prints the two approved metrics when the run can
// be aggregated and the reasons when it cannot, and it exits 0 either way: a
// refusal is a true statement about the run, not a build failure, and
// `check:ai-review-eval` remains the only thing an approval reads. It makes no
// approval or promotion judgement, and it does not write to any input.
//
// ## Why a file-reading caller at all
//
// `aggregateJudgedRun()` has regressions over objects built in memory. That
// shows the arithmetic and the refusals are right; it cannot show that a caller
// reading files supplies the inputs the contract requires. The two ways a
// caller quietly breaks those requirements are both about where an input comes
// from:
//
//   * **The manifest digest.** It exists so the aggregate is bound to the
//     dataset the run measured, and re-frozen edits of another set do not pass.
//     A caller that computes it from the dataset it was handed has written a
//     comparison that cannot fail. So it is read from the stored run record and
//     nowhere else.
//   * **The plan.** Building it from the judgements that happen to exist makes
//     "this case was never judged" impossible to say -- deleting a bundle would
//     shrink the run instead of blocking it. So the plan is built from the run's
//     own record: the frozen set says which cases there were, the run's journal
//     says which output each produced, and the run's recorded counts have to
//     agree with both. Anything the stored record cannot account for is a
//     refusal.
//
// Nothing here calls a provider, and nothing here writes a file.

import { resolve } from "node:path";
import { readAiReviewJudgedRunReport } from "../lib/aiReviewJudgedRunReport.ts";

const argValue = (name) => {
  const args = process.argv.slice(2);
  const inline = args.find((argument) => argument.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const next = args[at + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
};

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const USAGE =
  "usage: npm run report:ai-review-judged-run -- --run=<run .json> " +
  "--journal=<journal .jsonl> --dataset=<set .json> --judgements=<directory>";

const runPath = argValue("run");
const journalPath = argValue("journal");
const datasetPath = argValue("dataset");
const judgementsPath = argValue("judgements");
if (!runPath || !journalPath || !datasetPath || !judgementsPath) die(USAGE);

let report;
try {
  report = readAiReviewJudgedRunReport({
    run: resolve(runPath), journal: resolve(journalPath),
    dataset: resolve(datasetPath), judgements: resolve(judgementsPath),
  });
} catch (error) { die(error.message); }
const { result } = report;

const heading = (text) => console.log(`\n=== ${text} ===`);
const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

heading("inputs");
line("run artifact", runPath);
line("journal", `${journalPath} (${report.journalEntries} entr${report.journalEntries === 1 ? "y" : "ies"})`);
line("frozen dataset", datasetPath);
line("judgement bundles", `${judgementsPath} (${report.bundleCount})`);
line("manifest datasetDigest", report.datasetDigest ?? "(absent)");
line("plan", `${report.planCount} case(s), read from the run's record`);

if (!result.aggregable) {
  heading("not aggregable");
  for (const blocker of result.blockers) console.log(`  - ${blocker}`);
  console.log(
    "\nNo metric is printed. A rate computed over the cases that happen to " +
      "survive\nwould report an unfinished run as a finished one."
  );
  process.exit(0);
}

const rate = (metric) =>
  metric.rate === null
    ? `insufficient evidence (${metric.numerator}/${metric.denominator}): ${metric.insufficientEvidence}`
    : `${metric.numerator}/${metric.denominator} = ${metric.rate.toFixed(3)}  ` +
      `Wilson [${metric.wilsonLower.toFixed(3)}, ${metric.wilsonUpper.toFixed(3)}]`;

heading("aggregated");
line("contract", result.contractVersion);
line("cases", result.cases);
console.log("");
line("missedEveryPlantedIssueRate", rate(result.metrics.missedEveryPlantedIssueRate));
line("  ... of which aimed and vague", result.metrics.missedEveryPlantedIssueAimedAt);
line("inventedFindingRate", rate(result.metrics.inventedFindingRate));
line("  ... negative subset", rate(result.metrics.inventedFindingRateNegativeSubset));
line("  ... findings, not cases", result.metrics.inventedFindingCount);

// Per arm, because the gate's language-gap and task-type rules read every
// metric per arm. No gap and no shortfall is computed here: those numbers are
// not approved, and an unapproved comparison printed beside real ones reads as
// a verdict.
const armSection = (title, arms) => {
  heading(title);
  if (arms.length === 0) {
    console.log("  (none — this run holds no case in any arm of this kind)");
    return;
  }
  for (const arm of arms) {
    console.log(`  ${arm.arm}  (${arm.cases} case(s))`);
    line("  missedEveryPlantedIssueRate", rate(arm.metrics.missedEveryPlantedIssueRate));
    line("    ... aimed and vague", arm.metrics.missedEveryPlantedIssueAimedAt);
    line("  inventedFindingRate", rate(arm.metrics.inventedFindingRate));
    line("    ... negative subset", rate(arm.metrics.inventedFindingRateNegativeSubset));
    line("    ... findings, not cases", arm.metrics.inventedFindingCount);
  }
};
armSection("by language", result.byLanguage);
armSection("by task type", result.byTaskType);
console.log(
  "\n  Arms are computed over their own cases, not split out of the aggregate. No\n" +
    "  gap or shortfall is applied: those thresholds are not approved."
);

console.log(
  "\nReport only. These metrics are not wired to any approval gate, no threshold\n" +
    "is applied here, and nothing was written. `check:ai-review-eval` still reads\n" +
    "the keyword metrics: docs/ops/ai-review-eval-scoring-contract.md."
);
