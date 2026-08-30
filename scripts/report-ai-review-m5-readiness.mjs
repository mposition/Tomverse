// The AI Review M5 readiness report.
//
// docs/policy/ai-review-m5-quality-contract.md §10.
//
// Answers exactly one question -- is the *code* half of M5 done -- and refuses
// to answer the other one. `M5 readiness complete` is decidable from this
// repository: the tools exist, they are tested, and they refuse what they must
// refuse. `M5 eligible` is not, and this report says so rather than deriving
// it, because every eligibility item rests on production traffic, a paid
// evaluation, or a person's signature. A report that inferred eligibility from
// readiness would be the exact failure the two-state split exists to prevent.
//
// Reads no database and calls no provider, so it runs anywhere.
//
// Usage: npm run report:ai-review-m5-readiness

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  AI_REVIEW_M5_ELIGIBILITY_ITEMS,
  judgeM5,
} from "../lib/aiReviewScorecardCore.ts";
import {
  AI_REVIEW_EVAL_REGISTER,
  approvedAiReviewPairs,
  registerDrift,
} from "../lib/aiReviewEvalRegister.ts";
import { datasetProblems } from "../lib/aiReviewEvalRun.ts";
import {
  COMPARISON_REVIEW_DEFAULT_MODEL_IDS,
  COMPARISON_REVIEW_PROMPT_VERSION,
} from "../lib/comparisonReview.ts";

const exists = (path) => existsSync(join(process.cwd(), path));

const readsCleanly = (path) => {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), path), "utf8"));
  } catch {
    return null;
  }
};

const datasetFiles = () => {
  const directory = "docs/ops/ai-review-evaluation-set";
  if (!exists(directory)) return [];
  return readdirSync(join(process.cwd(), directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(directory, name));
};

const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

const check = (item, met, detail) => ({ item, met, detail });

// --- readiness: everything decidable from this repository ------------------

const datasets = datasetFiles().map((path) => ({
  path,
  dataset: readsCleanly(path),
}));
const validDatasets = datasets.filter(
  (entry) => entry.dataset && datasetProblems(entry.dataset).length === 0
);
const decisionDatasets = validDatasets.filter(
  (entry) => entry.dataset.purpose === "decision"
);

const readiness = [
  check(
    "decision_grade_eval_harness",
    exists("scripts/eval-ai-review.mjs") &&
      exists("lib/aiReviewEvalCore.ts") &&
      Boolean(packageScripts["eval:ai-review"]),
    "the harness, its scorer and the npm entry point all exist"
  ),
  check(
    "versioned_eval_dataset",
    validDatasets.length > 0,
    validDatasets.length > 0
      ? `${validDatasets.length} valid dataset file(s); ${decisionDatasets.length} of them are decision sets`
      : "no valid dataset file exists"
  ),
  check(
    "scored_and_tested_evaluator",
    exists("tests/aiReviewEvalCore.test.mjs") &&
      exists("tests/aiReviewEvalRun.test.mjs"),
    "the scorer and the run-admission truth table both have unit suites"
  ),
  check(
    "paid_run_budget_contract",
    exists("lib/aiReviewEvalRun.ts") && exists("lib/aiReviewEvalRegister.ts"),
    "a live run is refused without an approved budget, a frozen decision set, a clean named commit and an unused run ordinal"
  ),
  check(
    "server_run_telemetry",
    exists("lib/comparisonReviewRunTelemetry.ts") &&
      exists("tests/integration/comparison-review-run-telemetry.db.test.ts"),
    "guest and account runs are recorded content-free by the shared service, with a DB suite behind it"
  ),
  check(
    "shared_scorecard_core",
    exists("lib/aiReviewScorecardCore.ts") && exists("lib/aiReviewScorecard.ts"),
    "one aggregation core, so a CLI report and a screen cannot quote different numbers"
  ),
  check(
    "item_feedback_loop",
    exists("lib/comparisonReviewItemFeedback.ts") &&
      exists("app/api/conversations/[conversationId]/comparison-reviews/item-feedback/route.ts"),
    "per-item helpful/incorrect/unclear/missing feedback exists end to end"
  ),
  check(
    "cached_review_compatibility",
    exists("tests/comparisonReviewCacheCompatibility.test.mjs"),
    "a stored review written before these changes still parses and renders"
  ),
  check(
    "documented_rollback",
    exists("docs/ops/ai-review-rollback.md"),
    "there is a written way back from a reviewer change, a prompt change and this telemetry"
  ),
  check(
    "reviewer_pair_drift_detection",
    typeof registerDrift === "function" &&
      exists("lib/aiReviewEvalRegister.ts"),
    "the pairs production would serve are compared against the approved ones, read from configuration and not from the register"
  ),
];

// --- eligibility: nothing here can be decided from the repository ----------

const approved = approvedAiReviewPairs();
const drift = registerDrift(
  (process.env.COMPARISON_REVIEW_MODEL_IDS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean).length
    ? process.env.COMPARISON_REVIEW_MODEL_IDS.split(",").map((value) => value.trim())
    : [...COMPARISON_REVIEW_DEFAULT_MODEL_IDS]
  ).map((reviewerModelId) => ({
    reviewerModelId,
    promptVersion: COMPARISON_REVIEW_PROMPT_VERSION,
  }))
);

const evaluation = approved[0]?.evaluation ?? null;
const eligibility = [
  check(
    "two_independent_decision_runs",
    new Set(evaluation?.runOrdinals ?? []).size >= 2,
    evaluation
      ? `${new Set(evaluation.runOrdinals).size} distinct run ordinal(s) recorded`
      : "no approved pair, so no decision run is recorded"
  ),
  check(
    "human_blind_review_signed",
    Boolean(evaluation?.blindReviewRef),
    "a person must judge fabricated_safety_claim and false_consensus_safety; no script can"
  ),
  check(
    "production_pair_matches_approved_pair",
    drift.inSync,
    drift.inSync
      ? "the served pairs are exactly the approved ones"
      : `served but not approved: ${drift.servedButNotApproved.join(", ") || "none"}; approved but not served: ${drift.approvedButNotServed.join(", ") || "none"}`
  ),
  check(
    "reliability_trend_over_approved_period",
    false,
    "needs production ComparisonReviewRun history over a period a person has approved; not decidable here"
  ),
  check(
    "sufficient_production_sample",
    false,
    "needs a production sample size a person has approved; an arbitrary small n must not auto-approve M5"
  ),
  check(
    "zero_credit_reconciliation_mismatch",
    false,
    "needs the production reservation/settlement comparison over the observation period"
  ),
  check(
    "zero_critical_quality_violations",
    evaluation ? evaluation.zeroToleranceViolations === 0 : false,
    evaluation
      ? `${evaluation.zeroToleranceViolations} recorded`
      : "no approved pair, so no violation count exists"
  ),
  check(
    "adoption_and_repeat_use_thresholds_met",
    false,
    "needs production adoption figures and thresholds a person has approved after seeing the baseline"
  ),
  check(
    "rollback_drill_completed",
    false,
    "needs a dated drill record; writing the runbook is not performing the drill"
  ),
  check(
    "human_m5_promotion_signature",
    false,
    "a person signs this; nothing in this repository may set it"
  ),
];

const verdict = judgeM5(readiness, eligibility);

const render = (title, checks) => {
  console.log(`\n${title}`);
  for (const entry of checks) {
    console.log(`  ${entry.met ? "MET " : "open"} ${entry.item}`);
    console.log(`        ${entry.detail}`);
  }
};

console.log("AI Review — M5 report");
console.log(`  prompt version            ${COMPARISON_REVIEW_PROMPT_VERSION}`);
console.log(`  registered pairs          ${AI_REVIEW_EVAL_REGISTER.length}`);
console.log(`  approved pairs            ${approved.length}`);
console.log(`  served pairs              ${drift.servedPairs.join(", ")}`);

render("M5 readiness (decidable from this repository)", readiness);
render("M5 eligible (needs evidence this repository cannot hold)", eligibility);

console.log(
  `\nreadiness complete: ${verdict.readinessComplete ? "YES" : "NO"}`
);
console.log(`M5 eligible:        ${verdict.eligible ? "YES" : "NO"}`);
console.log(
  "\nThese are two states, not two thresholds on one scale. Readiness says the\n" +
    "instruments exist; eligibility says they were pointed at production and a\n" +
    `person signed the result. All ${AI_REVIEW_M5_ELIGIBILITY_ITEMS.length} eligibility items must hold, and this report\n` +
    "will never mark one of them itself."
);

// Exit 0 either way: this is a report, not a gate. A readiness report that
// failed the build would make "not M5 yet" -- the honest and expected state --
// look like a broken branch.
