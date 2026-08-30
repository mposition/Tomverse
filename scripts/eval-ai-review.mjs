// AI Review (comparison-review) quality evaluation harness.
//
// docs/policy/ai-review-m5-quality-contract.md §5, and the runbook in
// docs/ops/ai-review-eval-runbook.md.
//
// This is NOT scripts/evalComparisonReview.mjs. That one asks three English
// scenarios whether a planted keyword appeared anywhere in the output, which
// answers "did the prompt obviously break". This one runs a versioned dataset
// with per-case gold, scores it with denominators and Wilson bounds, splits
// the result by language, task type and mode, and writes an artifact that
// scripts/check-ai-review-eval-dataset.mjs can accept or refuse as evidence.
//
// It is fail-closed about spending money. Without --live it calls nothing at
// all; with --live it still refuses unless the reviewer pair carries a
// human-approved budget in lib/aiReviewEvalRegister.ts, the dataset is frozen
// (decision sets), the commit is nameable and clean, and the run names an
// ordinal that has not been used before.
//
// Usage:
//   npm run eval:ai-review -- --dry-run
//   npm run eval:ai-review -- --dataset=<path> --reviewer=<modelId> --dry-run
//   npm run eval:ai-review -- --live --run-ordinal=1 --reviewer=<modelId>
//   npm run eval:ai-review -- --live --run-ordinal=1 --reviewer=<modelId> --resume
//
// Flags:
//   --dataset=<path>        default docs/ops/ai-review-evaluation-set/development-v0.json
//   --reviewer=<modelId>    required
//   --prompt-version=<v>    default: the product's COMPARISON_REVIEW_PROMPT_VERSION
//   --run-ordinal=<n>       which independent run this is; required for --live
//   --seed=<n>              recorded in the artifact; the reviewer prompt
//                           shuffles response order with the process CSPRNG,
//                           so this pins the CASE order only
//   --max-cost-usd=<n>      narrows (never widens) the approved ceiling
//   --max-output-tokens=<n> default 2000
//   --out-dir=<path>        default docs/ops/ai-review-evaluation-records
//   --live                  the explicit paid-run confirmation
//   --dry-run               print the plan and the cost ceiling, call nothing
//   --resume                continue an interrupted run from its journal

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  assessSampleAdequacy,
  breakdownOutcomes,
  scoreCase,
  AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES,
} from "../lib/aiReviewEvalCore.ts";
import {
  datasetDigest,
  datasetProblems,
  decideAiReviewEvalRunMode,
  freezeDrift,
} from "../lib/aiReviewEvalRun.ts";
import { findAiReviewEvalEntry } from "../lib/aiReviewEvalRegister.ts";
import { COMPARISON_REVIEW_PROMPT_VERSION } from "../lib/comparisonReview.ts";

const DEFAULT_DATASET = "docs/ops/ai-review-evaluation-set/development-v0.json";
const DEFAULT_OUT_DIR = "docs/ops/ai-review-evaluation-records";

const argValue = (name, fallback = "") => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const datasetPath = argValue("dataset", DEFAULT_DATASET);
const reviewerModelId = argValue("reviewer");
const promptVersion = argValue("prompt-version", COMPARISON_REVIEW_PROMPT_VERSION);
const live = hasFlag("live");
const dryRun = hasFlag("dry-run") || !live;
const resume = hasFlag("resume");
const outDir = argValue("out-dir", DEFAULT_OUT_DIR);
const maxOutputTokens = Number(argValue("max-output-tokens", "2000"));
const rawOrdinal = argValue("run-ordinal", "");
const runOrdinal = rawOrdinal === "" ? null : Number(rawOrdinal);
const rawSeed = argValue("seed", "");
const seed = rawSeed === "" ? 0 : Number(rawSeed);
const rawMaxCost = argValue("max-cost-usd", "");
const maxCostUsd = rawMaxCost === "" ? null : Number(rawMaxCost);

if (!reviewerModelId) {
  fail("--reviewer=<modelId> is required. Nothing is defaulted: a run that quietly\nreviewed with another model would report that model's quality under this name.");
  process.exit(1);
}
if (maxCostUsd !== null && !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
  fail(`--max-cost-usd must be a positive number (got "${rawMaxCost}").`);
  process.exit(1);
}
if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
  fail(`--max-output-tokens must be a positive integer (got "${maxOutputTokens}").`);
  process.exit(1);
}

if (!existsSync(datasetPath)) {
  fail(`dataset not found: ${datasetPath}`);
  process.exit(1);
}
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const structuralProblems = datasetProblems(dataset);
if (structuralProblems.length > 0) {
  console.error(`The dataset at ${datasetPath} is not valid:`);
  for (const problem of structuralProblems) console.error(`  - ${problem}`);
  console.error("\nRun `npm run check:ai-review-eval` for the full report.");
  process.exit(1);
}

const digest = datasetDigest(dataset);
const datasetFrozen = dataset.purpose !== "decision" || freezeDrift(dataset) === null;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const commitSha = git(["rev-parse", "HEAD"]);
const workingTreeDirty = (() => {
  const status = git(["status", "--porcelain"]);
  return status === null ? true : status.length > 0;
})();

// ---------------------------------------------------------------------------
// Journal (resume + duplicate-ordinal refusal)
// ---------------------------------------------------------------------------

const runKey = `${dataset.version}--${reviewerModelId.replace(/[^A-Za-z0-9._-]/g, "_")}--${promptVersion}`;
const journalPath = join(outDir, `${runKey}--ordinal-${runOrdinal ?? "none"}.journal.jsonl`);
const artifactPath = join(outDir, `${runKey}--ordinal-${runOrdinal ?? "none"}.json`);

const readJournal = () => {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

/**
 * Which ordinals this dataset/reviewer/prompt combination has already been
 * run under. Read from the journals on disk rather than from a claim in the
 * artifact, so "we ran it twice" cannot be satisfied by editing a number.
 */
const usedRunOrdinals = () => {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => name.startsWith(`${runKey}--ordinal-`) && name.endsWith(".journal.jsonl"))
    .map((name) => Number(name.slice(`${runKey}--ordinal-`.length, -".journal.jsonl".length)))
    .filter((value) => Number.isSafeInteger(value));
};

const priorOrdinals = (() => {
  if (!existsSync(outDir)) return [];
  try {
    return usedRunOrdinals();
  } catch {
    return [];
  }
})();

// A resumed run is continuing the ordinal it already owns, so its own journal
// must not be read as somebody else having used that number.
const conflictingOrdinals = resume
  ? priorOrdinals.filter((value) => value !== runOrdinal)
  : priorOrdinals;

const registerEntry = findAiReviewEvalEntry(reviewerModelId, promptVersion);

const providerKeyPresent = (() => {
  // Deliberately coarse: whether ANY provider key is configured. Which key the
  // reviewer needs is the adapter's business, and asking here would mean
  // importing the catalogue into the admission path.
  return Object.keys(process.env).some(
    (key) => /_API_KEY$/.test(key) && (process.env[key] ?? "").trim().length > 0
  );
})();

const runMode = decideAiReviewEvalRunMode({
  live,
  registerEntry,
  hasApiKey: providerKeyPresent,
  datasetFrozen,
  datasetPurpose: dataset.purpose,
  datasetSchemaVersion: dataset.schemaVersion,
  commitKnown: Boolean(commitSha),
  workingTreeDirty,
  runOrdinal,
  usedRunOrdinals: conflictingOrdinals,
  requestedRunCapUsd: maxCostUsd,
});

// ---------------------------------------------------------------------------
// Plan, printed before anything can be spent
// ---------------------------------------------------------------------------

const cases = dataset.cases;
const adequacy = assessSampleAdequacy(cases);
const journal = resume ? readJournal() : [];
const completedIds = new Set(journal.map((entry) => entry.caseId));
const remaining = cases.filter((testCase) => !completedIds.has(testCase.id));

const estimatePlannedCost = async () => {
  const { getEnabledModel } = await import("../lib/models.ts");
  const { resolveModelPricing } = await import("../lib/modelPricing.ts");
  const model = getEnabledModel(reviewerModelId);
  if (!model) return null;
  // Worst case per call: the whole case text as input (4 chars/token is the
  // repo's own coarse estimate) plus the full output cap. Deliberately an
  // over-estimate -- a ceiling that under-predicts is not a ceiling.
  let inputTokens = 0;
  for (const testCase of remaining) {
    const characters =
      testCase.question.length +
      testCase.responses.reduce((sum, response) => sum + response.content.length, 0);
    inputTokens += Math.ceil(characters / 4) + 1_200;
  }
  try {
    const pricing = resolveModelPricing(model, {
      estimatedPromptTokens: Math.ceil(inputTokens / Math.max(remaining.length, 1)),
    });
    return (
      (inputTokens * pricing.inputUsdPerMillionTokens +
        remaining.length * maxOutputTokens * pricing.outputUsdPerMillionTokens) /
      1_000_000
    );
  } catch {
    return null;
  }
};

const plannedCostUsd = await estimatePlannedCost();

const line = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);

console.log("AI Review evaluation run plan\n");
line("dataset", `${dataset.version} (${dataset.purpose})`);
line("dataset digest", digest);
line("dataset schema", dataset.schemaVersion);
line("reviewer model", reviewerModelId);
line("prompt version", promptVersion);
line("register status", registerEntry ? registerEntry.status : "NOT REGISTERED");
line("run ordinal", runOrdinal ?? "(none given)");
line("seed", seed);
line("commit", commitSha ?? "unknown");
line("working tree", workingTreeDirty ? "DIRTY" : "clean");
line("cases in dataset", cases.length);
line("cases already journalled", journal.length);
line("model calls this run", remaining.length);
line("max output tokens/call", maxOutputTokens);
line(
  "estimated max cost (USD)",
  plannedCostUsd === null ? "unavailable (pricing did not resolve)" : plannedCostUsd.toFixed(4)
);
line(
  "approved ceiling (USD)",
  registerEntry?.evalBudget ? registerEntry.evalBudget.maxUsd : "none"
);
line("sample adequate", adequacy.adequate ? "yes" : `no (${adequacy.shortfalls.length} shortfall(s))`);
console.log();

if (runMode.mode === "refused") {
  const explain = {
    unknown_pair:
      `(${reviewerModelId}, ${promptVersion}) is not in lib/aiReviewEvalRegister.ts. Add it as a candidate first.`,
    pair_not_runnable: "the register entry is revoked; a revoked pair keeps its budget but must not be run.",
    no_eval_budget:
      "the pair carries no human-approved eval budget. Add evalBudget (approvedBy, maxUsd, ticket, approvedAt) to lib/aiReviewEvalRegister.ts. That is a person's decision, not an agent's.",
    no_api_key: "no provider API key is configured in this environment.",
    dataset_not_frozen:
      "a decision dataset must be frozen (frozenAt/frozenBy/frozenDigest matching its contents) before a run against it can be cited.",
    legacy_dataset_schema: "the dataset is written in an older schema than the scorer reads.",
    unknown_commit: "this checkout cannot name its commit, so the artifact could not be tied to code.",
    dirty_working_tree:
      "the working tree has uncommitted changes, so the named commit is not the code that would run.",
    missing_run_ordinal:
      "--run-ordinal=<n> is required for a live run. Two independent runs cannot be told from one run reported twice without it.",
    duplicate_run_ordinal:
      `ordinal ${runOrdinal} already has a journal for this dataset/reviewer/prompt. Use the next ordinal, or --resume to continue that run.`,
    run_cap_above_approved_ceiling:
      `--max-cost-usd=${maxCostUsd} is above the approved ceiling (US$${registerEntry?.evalBudget?.maxUsd}). A flag may narrow an approval, never widen it.`,
  }[runMode.reason];
  console.error(`REFUSED (${runMode.reason})\n  ${explain}`);
  console.error("\nNothing was called and nothing was spent.");
  process.exitCode = 1;
  process.exit();
}

if (runMode.mode === "smoke" || dryRun) {
  console.log(
    live
      ? "DRY RUN — --dry-run was given, so nothing is called."
      : "DRY RUN — --live was not given, so nothing is called.\n" +
          "This is the default. Add --live (and a run ordinal, and an approved budget) to spend."
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const { createAiReviewEvalAdapter } = await import("../lib/aiReviewEvalLiveAdapter.ts");
let pricingFailures = 0;
const call = createAiReviewEvalAdapter({
  reviewerModelId,
  maxOutputTokens,
  onPricingFailure: () => {
    pricingFailures += 1;
  },
});

let accruedCostUsd = journal.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
let consecutiveFailures = 0;
let costStopped = false;
let brokenStopped = false;

for (const testCase of remaining) {
  if (accruedCostUsd >= runMode.ceilingUsd) {
    costStopped = true;
    break;
  }
  const outcome = await call(testCase);
  accruedCostUsd += outcome.costUsd;

  const record = {
    caseId: testCase.id,
    failure: outcome.failure,
    costUsd: outcome.costUsd,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    durationMs: outcome.durationMs,
    observation: outcome.observation,
  };
  appendFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf8");
  journal.push(record);

  if (outcome.failure) {
    consecutiveFailures += 1;
    process.stdout.write(`  ${testCase.id}: FAILED (${outcome.failure})\n`);
  } else {
    consecutiveFailures = 0;
    process.stdout.write(`  ${testCase.id}: ok\n`);
  }
  // "Broken, not unlucky." A pair that fails five cases in a row is not
  // producing a quality number, it is producing an outage, and continuing to
  // pay for the rest of the dataset buys nothing. The run stops rather than
  // starting again: a second run after a clear failure is a decision for a
  // person, and the journal is here so resuming is one command.
  if (consecutiveFailures >= 5) {
    brokenStopped = true;
    break;
  }
}

// ---------------------------------------------------------------------------
// Scoring and artifact
// ---------------------------------------------------------------------------

const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
const outcomes = [];
let providerFailures = 0;
for (const record of journal) {
  const testCase = caseById.get(record.caseId);
  if (!testCase) continue;
  if (!record.observation) {
    providerFailures += 1;
    continue;
  }
  // No human verdicts: this harness cannot judge `fabricated_safety_claim` or
  // `false_consensus_safety`, and inventing a zero for them would report an
  // unexamined rule as passed. The artifact says so, and
  // check-ai-review-eval-dataset.mjs refuses an artifact with no blind-review
  // reference.
  outcomes.push(scoreCase(testCase, record.observation, []));
}

const breakdown = breakdownOutcomes(outcomes);
const summary = {
  decisionGrade:
    dataset.purpose === "decision" &&
    !workingTreeDirty &&
    Boolean(commitSha) &&
    outcomes.length === cases.length &&
    adequacy.adequate,
  datasetPurpose: dataset.purpose,
  datasetVersion: dataset.version,
  datasetDigest: digest,
  datasetSchemaVersion: dataset.schemaVersion,
  commitSha: commitSha ?? "unknown",
  workingTreeDirty,
  reviewerModelId,
  promptVersion,
  runOrdinal,
  seed,
  plannedCases: cases.length,
  completedCases: outcomes.length,
  providerFailures,
  sampleAdequate: adequacy.adequate,
  sampleShortfalls: adequacy.shortfalls,
  // Never filled in by this script. A person records the blind-review
  // reference after reviewing the sheet; until then the artifact is
  // inadmissible, which is correct.
  humanBlindReviewRef: null,
  humanJudgedRules: AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES.filter(
    (rule) => rule === "fabricated_safety_claim" || rule === "false_consensus_safety"
  ),
  zeroToleranceViolations: Object.values(
    breakdown.aggregate.zeroToleranceViolations
  ).reduce((sum, count) => sum + count, 0),
  accruedCostUsd,
  ceilingUsd: runMode.ceilingUsd,
  pricingFailures,
  truncatedByCostCeiling: costStopped,
  stoppedOnConsecutiveFailures: brokenStopped,
  generatedAt: new Date().toISOString(),
};

writeFileSync(
  artifactPath,
  `${JSON.stringify({ summary, metrics: breakdown }, null, 2)}\n`,
  "utf8"
);

console.log("\n--- result ---");
line("cases scored", `${outcomes.length}/${cases.length}`);
line("provider failures", providerFailures);
line("accrued cost (USD, estimate)", accruedCostUsd.toFixed(4));
if (pricingFailures > 0) {
  line("pricing resolution failures", `${pricingFailures} (accrued cost UNDER-reports)`);
}
const point = (metric) =>
  metric.point === null
    ? "n/a (empty denominator)"
    : `${(metric.point * 100).toFixed(1)}% [${(metric.wilsonLower * 100).toFixed(1)}, ${(metric.wilsonUpper * 100).toFixed(1)}] n=${metric.denominator}`;
line("contradiction recall", point(breakdown.aggregate.contradictionRecall));
line("contradiction precision", point(breakdown.aggregate.contradictionPrecision));
line("omission recall", point(breakdown.aggregate.omissionRecall));
line("omission precision", point(breakdown.aggregate.omissionPrecision));
line("false-consensus rate", point(breakdown.aggregate.falseConsensusRate));
line("invented-issue rate", point(breakdown.aggregate.inventedIssueRate));
line("exact-quote match rate", point(breakdown.aggregate.exactQuoteMatchRate));
line("zero-tolerance violations", summary.zeroToleranceViolations);
console.log(`\nartifact: ${artifactPath}`);
if (costStopped) {
  console.log("TRUNCATED at the cost ceiling; the artifact is not decision-grade.");
}
if (brokenStopped) {
  console.log(
    "STOPPED after 5 consecutive failures. This is an outage, not a quality result.\n" +
      "Diagnose before resuming; nothing here starts a second run on its own."
  );
}
if (!summary.decisionGrade) {
  console.log(
    "\nNOT decision-grade. `npm run check:ai-review-eval -- --artifact=<path>` lists why."
  );
}
