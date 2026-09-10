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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { observationRefFor } from "../lib/aiReviewEvalJudgement.ts";
import { aggregateJudgedRun } from "../lib/aiReviewJudgedRunAggregate.ts";

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

/** Read a JSON file, or stop with the path that could not be read. */
const readJson = (path, what) => {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) die(`${what} does not exist: ${path}`);
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    die(`${what} is not valid JSON (${path}): ${error.message}`);
  }
  return undefined;
};

const run = readJson(runPath, "the run artifact");
const dataset = readJson(datasetPath, "the frozen dataset");

const journalResolved = resolve(process.cwd(), journalPath);
if (!existsSync(journalResolved)) die(`the run journal does not exist: ${journalPath}`);
const journal = readFileSync(journalResolved, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      die(`the run journal line ${index + 1} is not valid JSON: ${error.message}`);
      return null;
    }
  });

// ---------------------------------------------------------------------------
// The two inputs whose PROVENANCE is the point
// ---------------------------------------------------------------------------

const blockers = [];

/**
 * The digest the run recorded, read from the run's own artifact.
 *
 * Never `datasetDigest(dataset)`. The aggregator compares this against the set
 * it is handed, and computing it here from that same set would make the
 * comparison trivially true -- which is exactly the hole it was added to close.
 */
const manifest = { datasetDigest: run?.summary?.datasetDigest };
if (typeof manifest.datasetDigest !== "string" || manifest.datasetDigest === "") {
  blockers.push(
    "the run artifact records no summary.datasetDigest, so nothing says which " +
      "frozen set this run measured"
  );
}

/**
 * The run's plan, reconstructed from the run's own record.
 *
 * Three sources have to agree, and none of them is the set of judgements that
 * happen to be on disk:
 *
 *   * the frozen set says which cases existed,
 *   * `summary.plannedCases` says how many the run set out to measure,
 *   * the journal says which output each case produced.
 *
 * A case the journal cannot account for is a refusal rather than a row left
 * out. The run that stopped early is the case this protects: its judgements
 * may all be sound, and aggregating them would report a partial run as a
 * whole one.
 */
const planned = Array.isArray(dataset?.cases)
  ? dataset.cases.filter((item) => typeof item?.id === "string").map((item) => item.id)
  : [];
if (planned.length === 0) {
  blockers.push("the frozen dataset names no cases, so there is no plan to read");
}
if (typeof run?.summary?.plannedCases !== "number") {
  blockers.push("the run artifact records no summary.plannedCases, so its plan cannot be checked");
} else if (run.summary.plannedCases !== planned.length) {
  blockers.push(
    `the run planned ${run.summary.plannedCases} case(s) and this frozen set holds ` +
      `${planned.length}; the plan cannot be reconstructed from a set the run did not measure`
  );
}
if (typeof run?.summary?.completedCases !== "number") {
  blockers.push("the run artifact records no summary.completedCases");
} else if (run.summary.completedCases !== journal.length) {
  blockers.push(
    `the run recorded ${run.summary.completedCases} completed case(s) and its journal holds ` +
      `${journal.length}; the record disagrees with itself`
  );
}

const plan = [];
for (const caseId of planned) {
  const entries = journal.filter((entry) => entry?.caseId === caseId);
  if (entries.length === 0) {
    blockers.push(
      `${caseId}: planned in the run and its journal holds no output, so the plan ` +
        `cannot be completed from what the run recorded`
    );
    continue;
  }
  if (entries.length > 1) {
    blockers.push(
      `${caseId}: the run's journal holds ${entries.length} outputs, so which one the ` +
        `plan names is ambiguous`
    );
    continue;
  }
  plan.push({ caseId, observationRef: observationRefFor(entries[0].observation) });
}

// ---------------------------------------------------------------------------
// The judged bundles, as the scoring CLI writes them
// ---------------------------------------------------------------------------

const judgementsRoot = resolve(process.cwd(), judgementsPath);
if (!existsSync(judgementsRoot) || !statSync(judgementsRoot).isDirectory()) {
  die(`the judgements directory does not exist: ${judgementsPath}`);
}

/**
 * Every bundle directory, not only the planned ones.
 *
 * A bundle the plan does not name is its own refusal in the aggregator, and
 * filtering to the planned ids here would hide it.
 */
const entries = [];
for (const name of readdirSync(judgementsRoot).sort()) {
  const directory = join(judgementsRoot, name);
  if (!statSync(directory).isDirectory()) continue;
  const bundle = {};
  let readable = true;
  for (const [key, file] of [
    ["testCase", "case.json"],
    ["observation", "observation.json"],
    ["record", "record.json"],
    ["artifact", "artifact.json"],
  ]) {
    const path = join(directory, file);
    if (!existsSync(path)) {
      blockers.push(`${name}: the bundle has no ${file}`);
      readable = false;
      continue;
    }
    try {
      bundle[key] = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      blockers.push(`${name}: ${file} is not valid JSON: ${error.message}`);
      readable = false;
    }
  }
  if (readable) entries.push(bundle);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const heading = (text) => console.log(`\n=== ${text} ===`);
const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

heading("inputs");
line("run artifact", runPath);
line("journal", `${journalPath} (${journal.length} entr${journal.length === 1 ? "y" : "ies"})`);
line("frozen dataset", datasetPath);
line("judgement bundles", `${judgementsPath} (${entries.length})`);
line("manifest datasetDigest", manifest.datasetDigest ?? "(absent)");
line("plan", `${plan.length} case(s), read from the run's record`);

// The input checks above can already refuse. Run them first rather than
// handing a half-built plan to the aggregator, which would then report the
// missing rows as "planned and never judged" -- true, but about the wrong
// file.
const result =
  blockers.length > 0
    ? { aggregable: false, blockers }
    : aggregateJudgedRun({ plan, entries, runInputs: { journal, dataset }, manifest });

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

console.log(
  "\nReport only. These metrics are not wired to any approval gate, no threshold\n" +
    "is applied here, and nothing was written. `check:ai-review-eval` still reads\n" +
    "the keyword metrics: docs/ops/ai-review-eval-scoring-contract.md."
);
