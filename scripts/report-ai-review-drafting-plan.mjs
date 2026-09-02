// What it would take to draft the decision set, and what it would cost.
//
// docs/ops/ai-review-eval-runbook.md §1.1a, §3.
//
//   npm run report:ai-review-drafting-plan
//   npm run report:ai-review-drafting-plan -- --batch-size=8 --show-instruction
//
// ## Calls nothing and spends nothing
//
// Every number here is derived: the batch schedule from the coverage plan and
// the runbook's phenomenon mix, the request text from the same
// `draftInstruction()` the drafter sends, the token estimate from that text's
// own length, and the rates from lib/modelPricing.ts -- the table the rest of
// the product bills against. A drafting estimate that disagreed with it would
// be wrong somewhere that matters.
//
// The cost is a CEILING: it charges every call the full output cap, and a
// reply is far shorter than the cap. Understating it would be the worse error,
// because the figure exists for somebody to approve a budget against.

import { existsSync, readFileSync } from "node:fs";

import {
  CELL_PHENOMENON_MIX,
  INJECTION_QUOTA_PER_LANGUAGE,
  draftingBatches,
  draftingCostCeilingUsd,
  draftingInputTokenCeiling,
  evalCoveragePlan,
} from "../lib/aiReviewEvalPlan.ts";

/**
 * How long an unwritten question is assumed to be, for the growth estimate.
 *
 * The instruction for a later batch contains questions that do not exist yet,
 * so their length has to be assumed. 220 characters is a little above the
 * development set's own average, which keeps the estimate on the high side --
 * the direction a budget figure should err in.
 */
const ASSUMED_QUESTION_CHARS = 220;

/**
 * Providers whose pricing profile in this repository is under question, and
 * why.
 *
 * NOT a correction. `lib/modelPricing.ts` is what the product bills users
 * against, and changing a number there is a pricing decision with a
 * `pricingVersion` and an effective date behind it -- not something to adjust
 * so a drafting estimate comes out nicer. What belongs here is the warning,
 * so nobody approves a budget against a rate that may be stale.
 */
const DRAFTER_PRICE_HOLDS = {
  deepseek:
    "the repository prices Flash at $0.14/$0.28 per million; DeepSeek's current " +
    "published pricing is time-of-day banded and higher (cache-miss input " +
    "$0.22-$0.44, output $0.66-$1.32). Until lib/modelPricing.ts is verified " +
    "and updated by a person, a ceiling computed from it is not one. The wider " +
    "risk is provider cost accounting, not user charging: an understated rate " +
    "understates settled provider spend and the operational cost guardrails " +
    "derived from it. What a user may spend is credits, a separate layer " +
    "(docs/policy/credit-and-cost-limits.md), and the two must not be conflated.",
};
import { draftInstruction } from "../lib/aiReviewEvalDraftPrompt.ts";
import { AI_REVIEW_EVAL_MIN_CASES } from "../lib/aiReviewEvalCore.ts";
import { COMPARISON_REVIEW_DEFAULT_MODEL_IDS } from "../lib/comparisonReview.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";
import { getModelPricingProfile } from "../lib/modelPricing.ts";

const SET_PATH = "docs/ops/ai-review-evaluation-set/decision-v1.json";
const DEVELOPMENT_SET = "docs/ops/ai-review-evaluation-set/development-v0.json";

const argValue = (name, fallback = "") => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const setPath = argValue("set", SET_PATH);
const batchSize = Number(argValue("batch-size", "10"));
const outputTokenCap = Number(argValue("max-output-tokens", "12000"));
if (!Number.isInteger(batchSize) || batchSize < 1) {
  console.error("--batch-size must be a whole positive number.");
  process.exit(1);
}

const set = existsSync(setPath)
  ? JSON.parse(readFileSync(setPath, "utf8"))
  : { cases: [] };
const existing = Array.isArray(set.cases) ? set.cases : [];

const batches = draftingBatches({ existing, batchSize });

console.log("AI Review decision set — drafting plan\n");
console.log(`  set              ${setPath}`);
console.log(`  cases present    ${existing.length} / ${AI_REVIEW_EVAL_MIN_CASES.aggregate}`);
console.log(`  cases to draft   ${batches.reduce((sum, batch) => sum + batch.count, 0)}`);
console.log(`  batch size       ${batchSize}`);
console.log(`  drafting calls   ${batches.length}`);

// The development set is not a source. It was used to iterate on the harness
// and on the reviewer prompt, so scoring the prompt against it would report
// how well the prompt fits its own test set.
if (existsSync(DEVELOPMENT_SET)) {
  const development = JSON.parse(readFileSync(DEVELOPMENT_SET, "utf8"));
  console.log(
    `\n  ${development.cases?.length ?? 0} development case(s) exist and are NOT reused:` +
      " the reviewer prompt was tuned against them, so scoring it on them would\n" +
      "  report how well it fits its own test set."
  );
}

console.log("\ncell plan (each cell is judged on its own; a short one blocks the whole set)");
for (const cell of evalCoveragePlan()) {
  const mine = batches.filter(
    (batch) => batch.language === cell.language && batch.taskType === cell.taskType
  );
  const have = existing.filter(
    (item) => item.language === cell.language && item.taskType === cell.taskType
  ).length;
  console.log(
    `  ${cell.language}/${cell.taskType.padEnd(28)} ` +
      `have ${String(have).padStart(3)}  draft ${String(
        mine.reduce((sum, batch) => sum + batch.count, 0)
      ).padStart(3)}  in ${String(mine.length).padStart(2)} call(s)`
  );
}

console.log("\nphenomenon mix per cell (runbook §1.2)");
for (const [phenomenon, count] of Object.entries(CELL_PHENOMENON_MIX)) {
  console.log(`  ${phenomenon.padEnd(24)} ${count}`);
}
console.log(
  `  prompt_injection         ${INJECTION_QUOTA_PER_LANGUAGE} per language, in safety_sensitive only`
);
// A reading the runbook leaves open, made explicit rather than chosen quietly.
//
// The mix above sums to 100 and a cell's floor is 100, so putting the
// injection quota INSIDE the safety cell would mean taking 20 cases away from
// the other phenomena there. This plan adds them instead: the safety cells
// come to 120 and the set to 1,240. Floors are minimums, so nothing is short
// either way -- but one reading shrinks the phenomena the safety cell is
// otherwise measuring, and that is a decision, not arithmetic.
console.log(
  "\n  note the mix sums to 100 and a cell's floor is 100, so the injection quota is\n" +
    "       ADDED to the two safety cells (120 each, 1,240 in the set) rather than taken\n" +
    "       out of their other phenomena. Both readings clear every floor; this one does\n" +
    "       not shrink what the safety cell otherwise measures. Say so if you want the\n" +
    "       other."
);

// ---------------------------------------------------------------------------
// Drafters
// ---------------------------------------------------------------------------
//
// A set drafted by a reviewer measures how well that model handles its own
// phrasing and its own idea of what counts as a contradiction. The three
// reviewer candidates are therefore excluded, and the script that does the
// drafting refuses them too.

const eligible = AVAILABLE_MODELS.filter((model) => {
  if (!model.enabled) return false;
  if (COMPARISON_REVIEW_DEFAULT_MODEL_IDS.includes(model.id)) return false;
  const configuration = PROVIDER_API_CONFIGURATION[model.provider];
  if (!configuration) return false;
  return configuration.protocol === "openai-compatible" || model.provider === "openai";
});

// The real instruction for EVERY batch, built as it will actually be sent.
//
// A batch is shown the questions already written for its cell, so the request
// grows through the plan: ~685 tokens with an empty cell, ~2,028 by the time
// ninety questions are in front of it. Pricing the whole plan at the first
// request understated the last ones threefold, and a figure called a ceiling
// that is not one is worse than none -- it is what somebody approves a budget
// against.
const questionsPerCell = new Map();
for (const item of existing) {
  const key = `${item.language}:${item.taskType}`;
  questionsPerCell.set(key, [...(questionsPerCell.get(key) ?? []), item.question ?? ""]);
}
const inputTokensPerCall = [];
let sampleInstruction = "";
for (const batch of batches) {
  const key = `${batch.language}:${batch.taskType}`;
  const seen = questionsPerCell.get(key) ?? [];
  const instruction = draftInstruction({
    language: batch.language,
    taskType: batch.taskType,
    phenomenon: batch.phenomenon,
    mode: batch.mode,
    count: batch.count,
    existingQuestions: seen,
  });
  if (!sampleInstruction) sampleInstruction = instruction;
  inputTokensPerCall.push(draftingInputTokenCeiling(instruction));
  // What the next batch in this cell will be shown. A placeholder of typical
  // length rather than the real text, which does not exist yet -- and named as
  // an assumption in the output below.
  questionsPerCell.set(key, [
    ...seen,
    ...Array.from({ length: batch.count }, () => "x".repeat(ASSUMED_QUESTION_CHARS)),
  ]);
}
const firstCallTokens = inputTokensPerCall[0] ?? 0;
const lastCallTokens = inputTokensPerCall[inputTokensPerCall.length - 1] ?? 0;

console.log(
  `\ndrafter candidates (reviewer models excluded: ${COMPARISON_REVIEW_DEFAULT_MODEL_IDS.join(", ")})`
);
console.log(
  `  input tokens grow through the plan: ~${firstCallTokens.toLocaleString("en-US")} on the\n` +
    `  first call, ~${lastCallTokens.toLocaleString("en-US")} on the last, because each call is shown its cell's\n` +
    `  existing questions. Unwritten questions are assumed ${ASSUMED_QUESTION_CHARS} characters.\n` +
    `  Every call is charged the full ${outputTokenCap.toLocaleString("en-US")}-token output cap.\n`
);
const rows = [];
for (const model of eligible) {
  const pricing = getModelPricingProfile(model.id);
  const tier = pricing?.tiers?.[0];
  if (!tier) {
    rows.push({ id: model.id, provider: model.provider, ceiling: null });
    continue;
  }
  rows.push({
    id: model.id,
    provider: model.provider,
    ceiling: draftingCostCeilingUsd({
      inputTokensPerCall,
      outputTokenCapPerCall: outputTokenCap,
      inputUsdPerMillionTokens: tier.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: tier.outputUsdPerMillionTokens,
    }),
    source: `${pricing.priceSource}, ${pricing.effectiveDate}`,
    held: DRAFTER_PRICE_HOLDS[model.provider] ?? null,
  });
}
rows.sort((left, right) => (left.ceiling ?? Infinity) - (right.ceiling ?? Infinity));
for (const row of rows) {
  console.log(
    `  ${row.held ? "HOLD" : "    "} ${row.id.padEnd(24)} ${row.provider.padEnd(12)} ` +
      (row.ceiling === null
        ? "no pricing profile"
        : `~$${row.ceiling.toFixed(2)}   (${row.source})`)
  );
}
const holds = [...new Set(rows.filter((row) => row.held).map((row) => row.held))];
for (const hold of holds) {
  console.log(`\n  HOLD  ${hold}`);
}

if (process.argv.includes("--show-instruction") && batches[0]) {
  const first = batches[0];
  console.log(
    `\n--- the first request, for ${first.language}/${first.taskType} ` +
      `${first.phenomenon} ${first.mode} x${first.count} ---\n`
  );
  console.log(sampleInstruction);
  console.log("\n--- end ---");
}

console.log(
  "\nThese set totals are a PLAN ESTIMATE, not a guaranteed total. Each call is\n" +
    "shown its cell's existing questions, so the later calls' input size depends on\n" +
    "text nobody has written yet -- assumed here at 220 characters per question. Write\n" +
    "longer questions and the total rises with them.\n" +
    "\n" +
    "What IS exact is the per-call bound the drafter enforces: it prices the actual\n" +
    "instruction that is about to be sent, against the full output cap, and refuses\n" +
    "before calling if the running ledger plus that call would pass the approved\n" +
    "--max-total-cost-usd. The approved total is what holds; this table only says\n" +
    "which drafter is worth approving one for.\n" +
    "\n" +
    "Rates from lib/modelPricing.ts, the table the product bills against.\n" +
    "Nothing was called and nothing was spent. `npm run draft:ai-review-eval-candidates`\n" +
    "sends one batch, and only with --send."
);
