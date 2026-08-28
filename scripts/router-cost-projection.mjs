// What the ROUTE-01 pilot and its independent judge can cost, in four numbers.
//
// It calls no provider. It reads the evaluation set, resolves each call's
// output budget through the same resolver the run uses, and prints the range a
// ceiling has to survive.
//
// The observations it starts from are censored: every usage figure available
// comes from runs that asked for 2,048 output tokens, and 60 of those calls
// stopped at that ceiling. So the observed column is a floor and is labelled
// as one -- it records where answers were cut off, not how long they were.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/router-cost-projection.mjs \
//     --set=docs/ops/router-evaluation-set/development-v0.json \
//     --pilot-ceiling=0.50 --judge-ceiling=4.00

import { readFileSync } from "node:fs";

import { estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { AVAILABLE_MODELS, getModel } from "../lib/models.ts";
import { JUDGE_MAX_OUTPUT_TOKENS, resolveCallLimit } from "../lib/routerCallLimits.ts";
import { ceilingProblems, projectCallCost, sumProjections } from "../lib/routerCostProjection.ts";
import { judgePrompt } from "../lib/routerJudgeRubric.ts";

const die = (message) => {
  console.error(message);
  process.exit(1);
};
const flag = (name, fallback = null) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const setPath = flag("set") ?? die("--set=<evaluation set JSON> is required.");
const pilotCeiling = Number(flag("pilot-ceiling", "0.50"));
const judgeCeiling = Number(flag("judge-ceiling", "4.00"));

const set = JSON.parse(readFileSync(setPath, "utf8"));
const items = (set.items ?? []).filter((item) => item.status === "adopted");
if (items.length === 0) die(`${setPath} holds no adopted items.`);

const tokensOf = (text) => estimateRawTextTokens(text ?? "");
const promptTokens = items.map((item) => tokensOf(item.prompt));
const meanPromptTokens = promptTokens.reduce((a, b) => a + b, 0) / promptTokens.length;
const maxPromptTokens = Math.max(...promptTokens);

// Measured from the 2026-08-28 run: 210 items, $0.3687, and its own usage.
// Both arms answered under a 2,048 cap, so these are the censored figures.
const OBSERVED = {
  maxOutputTokens: 2_048,
  observationsAtCap: 60,
  // Mean output tokens per answer call in that run, back-fitted from its total.
  answerOutputTokens: 470,
};

// An uncensored answer length cannot come from the censored runs, so these are
// assumptions. They are flags rather than constants because that is what they
// are: the table's job is to show what follows from them, not to hide them.
//
// The judge figures are the dominant uncertainty and the least evidenced.
// docs/ops/tomverse-chat-router-calibration-cost.md priced the judge pass at a
// 3-token verdict -- one word -- which is what luna actually emitted. But
// `claude-fable-5` runs at effort `high` with adaptive thinking and bills
// reasoning as output, so its verdict call is not three tokens and nobody has
// measured what it is. Treat the judge column as a projection over an
// unmeasured quantity until a run measures it.
const num = (name, fallback) => {
  const raw = flag(name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!(Number.isFinite(value) && value >= 0)) die(`--${name} must be a non-negative number.`);
  return value;
};
const EXPECTED_ANSWER_OUTPUT_TOKENS = num("answer-output-expected", 700);
const P95_ANSWER_OUTPUT_TOKENS = num("answer-output-p95", 2_500);
const EXPECTED_JUDGE_OUTPUT_TOKENS = num("judge-output-expected", 400);
const P95_JUDGE_OUTPUT_TOKENS = num("judge-output-p95", 1_500);

const modelOrDie = (id) => getModel(id) ?? die(`Unknown model "${id}".`);
const baseline = modelOrDie(set.baseline?.modelId);
const independentJudge = modelOrDie(set.independentJudge?.modelId);
const targetJudge = modelOrDie(set.judge?.modelId);

// The auto arm routes per item, so its cost is bounded by the most expensive
// model the Router could pick rather than by the one it usually picks. Anything
// enabled is reachable, so the worst case is over all of them -- a projection
// built on the model the last run happened to choose is not a bound.
const routableAnswerLimits = AVAILABLE_MODELS.filter((model) => model.enabled).map((model) =>
  resolveCallLimit(model, "answer")
);
const autoLimit = routableAnswerLimits.reduce((worst, limit) =>
  limit.outputUsdPerMillionTokens * limit.requestedMaxOutputTokens >
  worst.outputUsdPerMillionTokens * worst.requestedMaxOutputTokens
    ? limit
    : worst
);
// What the auto arm actually picked last time, for the observed floor.
const observedAutoLimit = resolveCallLimit(modelOrDie("deepseek-v4-flash"), "answer");

const n = items.length;
const stage = (label, projection, ceiling) => ({ label, projection, ceiling });

const pilot = sumProjections([
  // Expected and P95 priced on the model the Router actually favours; the
  // theoretical ceiling and the worst single request priced on the most
  // expensive model it could reach, because those two are bounds.
  {
    ...projectCallCost({
      limit: observedAutoLimit,
      calls: n,
      promptTokens: meanPromptTokens,
      expectedOutputTokens: EXPECTED_ANSWER_OUTPUT_TOKENS,
      p95OutputTokens: P95_ANSWER_OUTPUT_TOKENS,
      observedOutputTokens: OBSERVED.answerOutputTokens,
    }),
    ...(() => {
      const worst = projectCallCost({
        limit: autoLimit,
        calls: n,
        promptTokens: meanPromptTokens,
        expectedOutputTokens: EXPECTED_ANSWER_OUTPUT_TOKENS,
        p95OutputTokens: P95_ANSWER_OUTPUT_TOKENS,
      });
      return {
        theoreticalCeilingUsd: worst.theoreticalCeilingUsd,
        perRequestWorstCaseUsd: worst.perRequestWorstCaseUsd,
      };
    })(),
  },
  projectCallCost({
    limit: resolveCallLimit(baseline, "answer"),
    calls: n,
    promptTokens: meanPromptTokens,
    expectedOutputTokens: EXPECTED_ANSWER_OUTPUT_TOKENS,
    p95OutputTokens: P95_ANSWER_OUTPUT_TOKENS,
    observedOutputTokens: OBSERVED.answerOutputTokens,
  }),
  projectCallCost({
    limit: resolveCallLimit(targetJudge, "judge"),
    calls: n,
    // A judge prompt carries the rubric and both answers.
    promptTokens: tokensOf(judgePrompt("x".repeat(4 * meanPromptTokens), "", "")) + 2 * EXPECTED_ANSWER_OUTPUT_TOKENS,
    expectedOutputTokens: EXPECTED_JUDGE_OUTPUT_TOKENS,
    p95OutputTokens: P95_JUDGE_OUTPUT_TOKENS,
    observedOutputTokens: 120,
  }),
]);

const judge = projectCallCost({
  limit: resolveCallLimit(independentJudge, "judge"),
  calls: n,
  promptTokens: tokensOf(judgePrompt("x".repeat(4 * meanPromptTokens), "", "")) + 2 * EXPECTED_ANSWER_OUTPUT_TOKENS,
  expectedOutputTokens: EXPECTED_JUDGE_OUTPUT_TOKENS,
  p95OutputTokens: P95_JUDGE_OUTPUT_TOKENS,
});

const money = (value) => (value === null ? "     —" : `$${value.toFixed(4)}`);

console.log(`ROUTE-01 cost projection — ${setPath}`);
console.log(`  ${n} adopted item(s); prompt tokens mean ${Math.round(meanPromptTokens)}, max ${maxPromptTokens}`);
console.log("");
console.log("  CENSORED OBSERVATIONS. Every usage figure below the `observed` column comes from");
console.log(`  runs that asked for ${OBSERVED.maxOutputTokens} output tokens, and ${OBSERVED.observationsAtCap} calls stopped at that`);
console.log("  ceiling. Those numbers record where answers were cut off, not how long they were,");
console.log("  so `observed` is a floor and must not be read as an estimate.");
console.log("");
console.log("  ASSUMED ANSWER LENGTHS (override with the flags of the same name):");
console.log(`    answer-output-expected ${EXPECTED_ANSWER_OUTPUT_TOKENS}, answer-output-p95 ${P95_ANSWER_OUTPUT_TOKENS}`);
console.log(`    judge-output-expected  ${EXPECTED_JUDGE_OUTPUT_TOKENS}, judge-output-p95  ${P95_JUDGE_OUTPUT_TOKENS}`);
console.log("    The judge figures are unmeasured. The earlier costing assumed a 3-token verdict,");
console.log("    which is what luna emitted; claude-fable-5 reasons at effort `high` and bills");
console.log("    reasoning as output, so its verdict call is larger by an unknown factor.");
console.log("");
console.log("  stage                observed(floor)   expected  conservative(P95)   theoretical ceiling   worst single request");
for (const { label, projection } of [stage("pilot", pilot), stage("independent judge", judge)]) {
  console.log(
    `  ${label.padEnd(20)} ${money(projection.observedLowerBoundUsd).padStart(13)}` +
      `  ${money(projection.expectedUsd).padStart(9)}` +
      `  ${money(projection.conservativeUsd).padStart(17)}` +
      `  ${money(projection.theoreticalCeilingUsd).padStart(19)}` +
      `  ${money(projection.perRequestWorstCaseUsd).padStart(20)}`
  );
}
const total = sumProjections([pilot, judge]);
console.log(
  `  ${"TOTAL".padEnd(20)} ${money(total.observedLowerBoundUsd).padStart(13)}` +
    `  ${money(total.expectedUsd).padStart(9)}` +
    `  ${money(total.conservativeUsd).padStart(17)}` +
    `  ${money(total.theoreticalCeilingUsd).padStart(19)}` +
    `  ${money(total.perRequestWorstCaseUsd).padStart(20)}`
);

console.log("");
console.log("  Output budgets this projection resolved:");
for (const limit of [autoLimit, resolveCallLimit(baseline, "answer"), resolveCallLimit(independentJudge, "judge")]) {
  console.log(
    `    ${`${limit.modelId}/${limit.callRole}`.padEnd(34)} ${String(limit.requestedMaxOutputTokens).padStart(7)}` +
      `  (product cap ${limit.resolvedProductOutputCap}, ${limit.limitSource}, ${limit.pricingVersion})`
  );
}
console.log(`    judge budget constant: ${JUDGE_MAX_OUTPUT_TOKENS}`);

console.log("");
let blocked = false;
for (const { label, projection, ceiling } of [
  stage("pilot", pilot, pilotCeiling),
  stage("independent judge", judge, judgeCeiling),
]) {
  const problems = ceilingProblems(projection, ceiling);
  if (problems.length === 0) {
    console.log(`  OK — ${label} fits its $${ceiling.toFixed(2)} ceiling on the expected case.`);
    continue;
  }
  blocked = true;
  console.log(`  ${label} against $${ceiling.toFixed(2)}:`);
  for (const problem of problems) console.log(`    - ${problem}`);
}
if (blocked) {
  console.log("");
  console.log("  A ceiling that one request can breach is not a ceiling. Either raise it above the");
  console.log("  worst single request, or lower the output budget for that call role.");
}
