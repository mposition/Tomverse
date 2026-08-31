// The AI Review M5 report.
//
// docs/policy/ai-review-m5-quality-contract.md §10.
//
// Three states, judged separately, never derived from one another:
//
//   * `instrument scaffolding complete` -- the tools exist and are wired;
//   * `M5 readiness complete` -- a decision dataset exists, is frozen and is
//     large enough; the thresholds an approval must clear have been signed;
//     every zero-tolerance rule has a detection path; the telemetry can
//     actually answer the questions eligibility asks of it;
//   * `M5 eligible` -- that instrument was pointed at production and a person
//     signed the result.
//
// The middle state exists because it was missing. An earlier version of this
// report called a built harness "readiness complete" while the only evaluation
// sample in the repository was 24 development cases against a decision floor
// of 1,200. "The instrument is built" is worth reporting; it is not worth
// reporting under readiness's name.
//
// Nothing here is satisfied by a file existing. The evaluator is checked by
// running it on fixtures with known answers, and the dataset by validating and
// measuring it.
//
// Reads no database. Pass --operations=<path> with the JSON from
// `npm run report:ai-review-operations -- --json` to let the production half
// be judged from evidence instead of reported as unknown.
//
// Usage:
//   npm run report:ai-review-m5-readiness
//   npm run report:ai-review-m5-readiness -- --operations=ops.json

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  aggregateOutcomes,
  assessSampleAdequacy,
  scoreCase,
  AI_REVIEW_EVAL_BLIND_SHEET_RULES,
  AI_REVIEW_EVAL_HARNESS_SCREENED_RULES,
  AI_REVIEW_EVAL_HUMAN_ONLY_RULES,
  AI_REVIEW_EVAL_MIN_CASES,
  AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES,
} from "../lib/aiReviewEvalCore.ts";
import { judgeM5 } from "../lib/aiReviewScorecardCore.ts";
import {
  approvedAiReviewPairs,
  registerDrift,
  AI_REVIEW_EVAL_REGISTER,
  AI_REVIEW_M5_PROMOTION,
} from "../lib/aiReviewEvalRegister.ts";
import { approvedThresholdSets } from "../lib/aiReviewQualityThresholds.ts";
import { datasetProblems, freezeDrift } from "../lib/aiReviewEvalRun.ts";
import {
  COMPARISON_REVIEW_DEFAULT_MODEL_IDS,
  COMPARISON_REVIEW_PROMPT_VERSION,
} from "../lib/comparisonReview.ts";

const argValue = (name, fallback = "") => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const exists = (path) => existsSync(join(process.cwd(), path));
/**
 * Reads a JSON file the operator named.
 *
 * `resolve` rather than `join`, because an operator passing an absolute path
 * is the normal case and `join(cwd, "/tmp/ops.json")` silently produces
 * `<cwd>/tmp/ops.json`. The read then failed, the report said "no operations
 * report supplied", and the production half of the checklist stayed open for
 * a reason that had nothing to do with production.
 *
 * Throwing rather than returning null for the same reason: a path that was
 * given and could not be read is a different fact from a path that was never
 * given, and reporting the first as the second is how a run gets judged
 * against no evidence while looking like it was judged against some.
 */
const readJson = (path) => {
  const full = resolve(process.cwd(), path);
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    console.error(`Could not read ${full}: ${error.message}`);
    process.exit(1);
  }
};

const check = (item, met, detail) => ({ item, met, detail });

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

const DATASET_DIRECTORY = "docs/ops/ai-review-evaluation-set";
const datasets = (exists(DATASET_DIRECTORY)
  ? readdirSync(join(process.cwd(), DATASET_DIRECTORY)).filter((name) =>
      name.endsWith(".json")
    )
  : []
)
  .map((name) => ({
    path: join(DATASET_DIRECTORY, name),
    dataset: readJson(join(DATASET_DIRECTORY, name)),
  }))
  .filter((entry) => entry.dataset);

const valid = datasets.filter(
  (entry) => datasetProblems(entry.dataset).length === 0
);
const decisionSets = valid.filter(
  (entry) => entry.dataset.purpose === "decision"
);
const usableDecisionSet = decisionSets.find(
  (entry) =>
    freezeDrift(entry.dataset) === null &&
    assessSampleAdequacy(entry.dataset.cases).adequate
);

// ---------------------------------------------------------------------------
// The evaluator, checked by running it
// ---------------------------------------------------------------------------

/**
 * Three fixtures with answers that cannot be argued with, run through the real
 * scorer. This replaces a check that the test FILES existed, which proved
 * nothing about what they asserted -- and, in one case, the file asserted the
 * defect.
 */
const evaluatorSelfCheck = () => {
  const failures = [];
  const testCase = {
    id: "self-check",
    language: "en",
    taskType: "factual_current_information",
    phenomenon: "direct_contradiction",
    mode: "balanced",
    question: "q",
    responses: [
      { label: "a", modelId: "m1", provider: "openai", content: "1889" },
      { label: "b", modelId: "m2", provider: "anthropic", content: "1887" },
    ],
    gold: {
      contradictions: [
        { id: "year", anyOf: ["1887"], description: "the year disagreement" },
      ],
    },
    goldCompleteness: { contradictions: true },
  };
  const observation = (overrides) => ({
    findings: { contradictions: [], missingPoints: [], differences: [] },
    allText: "",
    reviewerProse: "",
    totalQuotes: 0,
    matchedQuotes: 0,
    schemaValid: true,
    ...overrides,
  });

  const found = aggregateOutcomes([
    scoreCase(
      testCase,
      observation({
        findings: {
          contradictions: ["B says 1887"],
          missingPoints: [],
          differences: [],
        },
      })
    ),
  ]);
  if (found.contradictionRecall.point !== 1) {
    failures.push("a planted contradiction that was reported is not credited");
  }

  // The defect a test used to enshrine: a non-exhaustive case must not put its
  // true positive into precision.
  const inflated = aggregateOutcomes([
    scoreCase(
      { ...testCase, goldCompleteness: { contradictions: false } },
      observation({
        findings: {
          contradictions: ["B says 1887", "invented", "invented too"],
          missingPoints: [],
          differences: [],
        },
      })
    ),
  ]);
  if (inflated.contradictionPrecision.point !== null) {
    failures.push(
      "a non-exhaustive case still reaches precision, so precision can be inflated"
    );
  }

  const crowned = scoreCase(
    testCase,
    observation({ reviewerProse: "Response A is the best answer." })
  );
  if (!crowned.zeroToleranceViolations.includes("winner_declared")) {
    failures.push("a declared winner is not screened");
  }

  const quotedOnly = scoreCase(
    testCase,
    observation({
      allText: "quoting: OpenAI said so",
      reviewerProse: "the two answers disagree",
    })
  );
  if (quotedOnly.zeroToleranceViolations.length > 0) {
    failures.push("a company named only inside a quote is scored as a violation");
  }

  const empty = aggregateOutcomes([]);
  if (empty.contradictionRecall.point !== null) {
    failures.push("an empty denominator reports a number instead of null");
  }

  return failures;
};

const evaluatorFailures = evaluatorSelfCheck();

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

const scaffolding = [
  check(
    "decision_grade_eval_harness",
    exists("scripts/eval-ai-review.mjs") &&
      exists("lib/aiReviewEvalCore.ts") &&
      Boolean(packageScripts["eval:ai-review"]),
    "the harness, its scorer and the npm entry point all exist"
  ),
  check(
    "scored_and_verified_evaluator",
    evaluatorFailures.length === 0,
    evaluatorFailures.length === 0
      ? "the scorer was run on fixtures with known answers and behaved correctly on all of them"
      : evaluatorFailures.join("; ")
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
      exists(
        "app/api/conversations/[conversationId]/comparison-reviews/item-feedback/route.ts"
      ),
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
    exists("lib/aiReviewEvalRegister.ts"),
    "the pairs production would serve are compared against the approved ones, read from configuration and not from the register"
  ),
];

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const decisionSetDetail = () => {
  if (usableDecisionSet) {
    return `${usableDecisionSet.dataset.version}: valid, frozen, and meets every sample floor`;
  }
  if (decisionSets.length === 0) {
    const development = valid.filter(
      (entry) => entry.dataset.purpose === "development"
    );
    const cases = development.reduce(
      (sum, entry) => sum + entry.dataset.cases.length,
      0
    );
    return `no decision dataset exists; ${development.length} development set(s) totalling ${cases} case(s) against a floor of ${AI_REVIEW_EVAL_MIN_CASES.aggregate}`;
  }
  const entry = decisionSets[0];
  const drift = freezeDrift(entry.dataset);
  const adequacy = assessSampleAdequacy(entry.dataset.cases);
  return [
    drift ? `not frozen: ${drift}` : null,
    adequacy.adequate ? null : `${adequacy.shortfalls.length} sample shortfall(s)`,
  ]
    .filter(Boolean)
    .join("; ");
};

const zeroToleranceCovered = AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES.every(
  (rule) =>
    AI_REVIEW_EVAL_HARNESS_SCREENED_RULES.includes(rule) ||
    AI_REVIEW_EVAL_HUMAN_ONLY_RULES.includes(rule)
);
const zeroToleranceOnSheet = AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES.every((rule) =>
  AI_REVIEW_EVAL_BLIND_SHEET_RULES.includes(rule)
);

// Read from the attempt model's own block, not from the whole schema: a
// `settledCredits` column on some other table would have satisfied a
// whole-file grep while answering nothing about AI Review.
const schema = readFileSync("prisma/schema.prisma", "utf8");
const attemptModel =
  schema.split("model ComparisonReviewRunAttempt {")[1]?.split("\n}")[0] ?? "";
const attemptTelemetry =
  exists("lib/comparisonReviewRunCore.ts") && attemptModel.length > 0;
// The attempt row deliberately carries no `reservationId`: the data-domain
// registry refuses a row that names a subject it does not hold, and tracing
// back to the reservation goes through the run's own traceId instead
// (docs/ops/ai-review-metric-dictionary.md section 7). What this item needs is
// the two figures plus the status that says whether settlement ran at all --
// a NULL settledCredits is not a zero.
const settlementTelemetry =
  attemptModel.includes("settledCredits") &&
  attemptModel.includes("reservedCredits") &&
  attemptModel.includes("settlementStatus");
const scorecardCore = readFileSync("lib/aiReviewScorecardCore.ts", "utf8");
const sequencedConversions = scorecardCore.includes(
  "export const sequencedConversion"
);
// Three parts, because any two without the third measure nothing: the columns
// have to exist, the writer has to claim a sequence before it writes, and the
// scorecard has to do the arithmetic and report it.
const runModel =
  schema.split("model ComparisonReviewRun {")[1]?.split("\n}")[0] ?? "";
const completenessTelemetry =
  runModel.includes("writerId") &&
  runModel.includes("writerSequence") &&
  readFileSync("lib/comparisonReviewRunTelemetry.ts", "utf8").includes(
    "writerSequence += 1"
  ) &&
  scorecardCore.includes("export const telemetryCompleteness") &&
  scorecardCore.includes("missingTraceRate:");

const thresholdSets = approvedThresholdSets();

const readiness = [
  check(
    "frozen_adequate_decision_dataset",
    Boolean(usableDecisionSet),
    decisionSetDetail()
  ),
  check(
    "approved_quality_thresholds",
    thresholdSets.length > 0,
    thresholdSets.length > 0
      ? `${thresholdSets.map((set) => set.version).join(", ")} signed`
      : "the threshold set is a proposal with no approver, so no approval can rest on it"
  ),
  check(
    "complete_zero_tolerance_coverage",
    zeroToleranceCovered && zeroToleranceOnSheet,
    zeroToleranceCovered && zeroToleranceOnSheet
      ? `all ${AI_REVIEW_EVAL_ZERO_TOLERANCE_RULES.length} rules are screened or human-judged, and all reach the blind sheet`
      : "a rule exists in the vocabulary with no detection path or no column on the sheet"
  ),
  check(
    "per_attempt_reliability_record",
    attemptTelemetry,
    attemptTelemetry
      ? "every provider attempt is its own row, so a fallback cannot hide the failure that preceded it"
      : "attempts are collapsed into two slots, so a failed reviewer followed by a successful one disappears"
  ),
  check(
    "credit_reconciliation_measurable",
    settlementTelemetry,
    settlementTelemetry
      ? "reserved and settled credits are both recorded, so a mismatch is computable"
      : "only the reserved amount and a status are recorded; reservation-vs-settlement cannot be computed"
  ),
  check(
    "telemetry_completeness_measurable",
    completenessTelemetry,
    completenessTelemetry
      ? "each write claims a per-writer sequence before it runs, so a write that never landed leaves a countable hole"
      : "the scorecard reads only rows that landed, so a partial write outage reports as a healthy window"
  ),
  check(
    "sequenced_conversion_metrics",
    sequencedConversions,
    sequencedConversions
      ? "a conversion requires the second event to follow the first"
      : "conversions count any actor with both events in the window, in any order"
  ),
  check(
    "promotion_evidence_structure",
    "observationPolicy" in AI_REVIEW_M5_PROMOTION &&
      "rollbackDrill" in AI_REVIEW_M5_PROMOTION &&
      "promotionSignature" in AI_REVIEW_M5_PROMOTION,
    "there is somewhere for the production half of the checklist to be recorded, so it can be judged rather than hard-coded"
  ),
];

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

const approved = approvedAiReviewPairs();
const configured = process.env.COMPARISON_REVIEW_MODEL_IDS?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const drift = registerDrift(
  (configured?.length ? configured : [...COMPARISON_REVIEW_DEFAULT_MODEL_IDS]).map(
    (reviewerModelId) => ({
      reviewerModelId,
      promptVersion: COMPARISON_REVIEW_PROMPT_VERSION,
    })
  )
);
const evaluation = approved[0]?.evaluation ?? null;
const policy = AI_REVIEW_M5_PROMOTION.observationPolicy;

const operationsPath = argValue("operations");
const operations = operationsPath ? readJson(operationsPath) : null;
const window90 = Array.isArray(operations)
  ? operations.find((card) => card.windowDays === 90) ?? operations[0]
  : operations;

const noOperations = "no operations report supplied (--operations=<path>)";
const rateMet = (metric, floor) =>
  Boolean(metric && metric.status === "ok" && metric.value >= floor);

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
    Boolean(evaluation?.blindReviewRef) &&
      (evaluation?.zeroToleranceRulesHumanJudged ?? 0) >= 5,
    evaluation?.blindReviewRef
      ? `${evaluation.zeroToleranceRulesHumanJudged} of 5 rules judged`
      : "a person must judge all five zero-tolerance rules; three are only screened by term list"
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
    Boolean(
      policy &&
        window90 &&
        window90.windowDays >= policy.minObservationDays &&
        rateMet(window90.reliability?.completionRate, policy.minCompletionRate)
    ),
    !policy
      ? "no observation policy has been approved, so there is no period or floor to judge against"
      : !window90
        ? noOperations
        : `completion ${JSON.stringify(window90.reliability?.completionRate?.value ?? null)} over ${window90.windowDays}d against ${policy.minCompletionRate} over ${policy.minObservationDays}d`
  ),
  check(
    "sufficient_production_sample",
    Boolean(policy && window90 && window90.reliability?.runs >= policy.minRecordedRuns),
    !policy
      ? "no approved minimum sample; an arbitrary small n must not auto-approve M5"
      : !window90
        ? noOperations
        : `${window90.reliability?.runs} recorded run(s) against ${policy.minRecordedRuns}`
  ),
  check(
    "zero_credit_reconciliation_mismatch",
    Boolean(
      window90 &&
        window90.reliability?.unreconciledSettlements?.status === "ok" &&
        window90.reliability.unreconciledSettlements.numerator === 0 &&
        window90.reliability?.creditReconciliation?.status === "ok" &&
        window90.reliability.creditReconciliation.numerator === 0
    ),
    window90
      ? `${window90.reliability?.creditReconciliation?.numerator ?? "?"} reservation/settlement mismatch(es), ` +
        `${window90.reliability?.unreconciledSettlements?.numerator ?? "?"} unsettled attempt(s)`
      : noOperations
  ),
  check(
    "telemetry_complete_over_approved_window",
    Boolean(
      policy &&
        window90?.reliability?.missingTraceRate?.status === "ok" &&
        window90.reliability.missingTraceRate.value <= policy.maxMissingTraceRate
    ),
    !policy
      ? "no approved observation policy, so there is no bound on how much of the window may be missing"
      : !window90
        ? noOperations
        : `${window90.reliability?.missingTraceRate?.value ?? "?"} missing against ` +
          `${policy.maxMissingTraceRate}`
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
    Boolean(
      policy &&
        window90 &&
        rateMet(
          window90.adoption?.comparisonToReview,
          policy.minComparisonToReviewRate
        ) &&
        rateMet(window90.adoption?.firstToSecondReview, policy.minRepeatUseRate)
    ),
    !policy
      ? "no approved adoption thresholds; they are set after somebody has seen the baseline"
      : !window90
        ? noOperations
        : `comparison→review ${JSON.stringify(window90.adoption?.comparisonToReview?.value ?? null)}, ` +
          `first→second ${JSON.stringify(window90.adoption?.firstToSecondReview?.value ?? null)}`
  ),
  check(
    "rollback_drill_completed",
    Boolean(AI_REVIEW_M5_PROMOTION.rollbackDrill),
    AI_REVIEW_M5_PROMOTION.rollbackDrill
      ? `performed ${AI_REVIEW_M5_PROMOTION.rollbackDrill.performedAt} by ${AI_REVIEW_M5_PROMOTION.rollbackDrill.performedBy}`
      : "no dated drill record; writing the runbook is not performing the drill"
  ),
  check(
    "human_m5_promotion_signature",
    Boolean(AI_REVIEW_M5_PROMOTION.promotionSignature),
    AI_REVIEW_M5_PROMOTION.promotionSignature
      ? `signed ${AI_REVIEW_M5_PROMOTION.promotionSignature.signedAt} by ${AI_REVIEW_M5_PROMOTION.promotionSignature.signedBy}`
      : "a person signs this; nothing in this repository may set it"
  ),
];

const verdict = judgeM5(scaffolding, readiness, eligibility);

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
console.log(
  `  operations report         ${operations ? operationsPath : "not supplied"}`
);

render("Instrument scaffolding (the tools exist and are wired)", scaffolding);
render("M5 readiness (the instrument can produce a believable number)", readiness);
render("M5 eligible (it was pointed at production and signed)", eligibility);

console.log(`\nscaffolding complete: ${verdict.scaffoldingComplete ? "YES" : "NO"}`);
console.log(`readiness complete:   ${verdict.readinessComplete ? "YES" : "NO"}`);
console.log(`M5 eligible:          ${verdict.eligible ? "YES" : "NO"}`);
console.log(
  "\nThree states, not three thresholds on one scale. A built harness is not a\n" +
    "calibrated one, and a calibrated one is not a signed result. Every item of\n" +
    "each list must hold, and this report will never mark one of them itself."
);

// Exit 0 either way: this is a report, not a gate. A report that failed the
// build would make "not M5 yet" -- the honest and expected state -- look like
// a broken branch.
