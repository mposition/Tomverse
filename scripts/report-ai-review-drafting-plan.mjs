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
  evalCoveragePlan,
} from "../lib/aiReviewEvalPlan.ts";
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

// The real instruction, for the largest batch this plan asks for. Its length
// is the input-token estimate, so the cost below is priced on the text that
// would actually go out.
const sample = batches[0];
const instruction = sample
  ? draftInstruction({
      language: sample.language,
      taskType: sample.taskType,
      phenomenon: sample.phenomenon,
      mode: sample.mode,
      count: sample.count,
      existingQuestions: [],
    })
  : "";
const estimatedInputTokens = Math.ceil(instruction.length / 4);

console.log(
  `\ndrafter candidates (reviewer models excluded: ${COMPARISON_REVIEW_DEFAULT_MODEL_IDS.join(", ")})`
);
console.log(
  `  cost ceiling per drafter for ${batches.length} call(s), ` +
    `~${estimatedInputTokens.toLocaleString("en-US")} input tokens each plus the full ` +
    `${outputTokenCap.toLocaleString("en-US")}-token output cap:\n`
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
      batches,
      estimatedInputTokensPerCall: estimatedInputTokens,
      outputTokenCapPerCall: outputTokenCap,
      inputUsdPerMillionTokens: tier.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: tier.outputUsdPerMillionTokens,
    }),
    source: `${pricing.priceSource}, ${pricing.effectiveDate}`,
  });
}
rows.sort((left, right) => (left.ceiling ?? Infinity) - (right.ceiling ?? Infinity));
for (const row of rows) {
  console.log(
    `  ${row.id.padEnd(24)} ${row.provider.padEnd(12)} ` +
      (row.ceiling === null
        ? "no pricing profile"
        : `~$${row.ceiling.toFixed(2)}   (${row.source})`)
  );
}

if (process.argv.includes("--show-instruction") && sample) {
  console.log(
    `\n--- the request, for ${sample.language}/${sample.taskType} ` +
      `${sample.phenomenon} ${sample.mode} x${sample.count} ---\n`
  );
  console.log(instruction);
  console.log("\n--- end ---");
}

console.log(
  "\nA CEILING, not a forecast: every call is charged the full output cap and a reply\n" +
    "is far shorter. Rates from lib/modelPricing.ts, the table the product bills against.\n" +
    "Nothing was called and nothing was spent. `npm run draft:ai-review-eval-candidates`\n" +
    "sends one batch, and only with --send."
);
