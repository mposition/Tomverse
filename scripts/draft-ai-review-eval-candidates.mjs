// Draft candidate cases for one cell of the AI Review evaluation set.
//
// docs/ops/ai-review-eval-runbook.md §3.
//
//   npm run draft:ai-review-eval-candidates -- --model=gpt-5-6-luna --language=ko \
//     --task-type=safety_sensitive --phenomenon=omission --mode=balanced --count=8
//   ... --send   to actually call the provider
//
// ## It drafts; it does not adopt
//
// Every case is written `status: "candidate"` with `adoptedBy: null`, and
// `datasetProblems()` refuses a decision set containing one. The question and
// the answers are writing, which a model can do. The gold -- "these answers
// really do contradict each other, and this is the complete list of ways" --
// is a judgement, and a judgement made by the same kind of system under
// evaluation is not evidence about it. A person reads the proposal and
// decides, which is a far smaller job than writing 1,200 cases from nothing
// and is the only part of it that has to be theirs.
//
// ## This sends real requests and costs money
//
// So it does nothing without --send. The default prints the exact instruction
// that would go out and the ceiling it would be billed at, so the decision is
// made on the request rather than on a description of it.
//
// ## The drafter must not be a reviewer
//
// A set drafted by one of the reviewer models measures how well that model
// handles its own phrasing and its own idea of what counts as a contradiction.
// Those are refused unless overridden, so the choice lands in the record.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_MODES,
  AI_REVIEW_EVAL_PHENOMENA,
  AI_REVIEW_EVAL_TASK_TYPES,
} from "../lib/aiReviewEvalCore.ts";
import {
  AI_REVIEW_DRAFT_TEMPLATE_VERSION,
  draftInstruction,
  parseDraftedCases,
  templateHash,
} from "../lib/aiReviewEvalDraftPrompt.ts";
import { COMPARISON_REVIEW_DEFAULT_MODEL_IDS } from "../lib/comparisonReview.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";
import { getModelPricingProfile } from "../lib/modelPricing.ts";

const args = process.argv.slice(2);
const argValue = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const send = args.includes("--send");

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const setPath = argValue("set") ?? "docs/ops/ai-review-evaluation-set/decision-v1.json";
const modelId = argValue("model");
const language = argValue("language");
const taskType = argValue("task-type");
const phenomenon = argValue("phenomenon");
const mode = argValue("mode");
const count = Number(argValue("count") ?? 8);
const allowReviewerDrafter = args.includes("--allow-reviewer-drafter");

if (!modelId || !language || !taskType || !phenomenon || !mode) {
  die(
    "--model, --language, --task-type, --phenomenon and --mode are required.\n\n" +
      `  languages    ${AI_REVIEW_EVAL_LANGUAGES.join(", ")}\n` +
      `  task types   ${AI_REVIEW_EVAL_TASK_TYPES.join(", ")}\n` +
      `  phenomena    ${AI_REVIEW_EVAL_PHENOMENA.join(", ")}\n` +
      `  modes        ${AI_REVIEW_EVAL_MODES.join(", ")}`
  );
}
if (!AI_REVIEW_EVAL_LANGUAGES.includes(language)) die(`"${language}" is not a language.`);
if (!AI_REVIEW_EVAL_TASK_TYPES.includes(taskType)) die(`"${taskType}" is not a task type.`);
if (!AI_REVIEW_EVAL_PHENOMENA.includes(phenomenon)) die(`"${phenomenon}" is not a phenomenon.`);
if (!AI_REVIEW_EVAL_MODES.includes(mode)) die(`"${mode}" is not a mode.`);
if (!Number.isInteger(count) || count < 1) die(`--count must be a whole positive number.`);

const model = AVAILABLE_MODELS.find((entry) => entry.id === modelId);
if (!model) die(`No catalogue model "${modelId}".`);

if (COMPARISON_REVIEW_DEFAULT_MODEL_IDS.includes(modelId) && !allowReviewerDrafter) {
  die(
    `${modelId} is one of the reviewer candidates this set is meant to measure.\n\n` +
      "A set drafted by a reviewer measures how well that model handles its own\n" +
      "phrasing and its own idea of what counts as a contradiction, which is not the\n" +
      "question. Pick a drafter from outside the reviewer list, or pass\n" +
      "--allow-reviewer-drafter. The drafter is recorded on every case either way."
  );
}

const configuration = PROVIDER_API_CONFIGURATION[model.provider];
if (!configuration) die(`No API configuration for provider "${model.provider}".`);
if (configuration.protocol !== "openai-compatible" && model.provider !== "openai") {
  die(
    `${model.provider} speaks its own dialect and this script only builds OpenAI-shaped\n` +
      "requests. Pick another drafter, or add a builder for it."
  );
}

let set;
try {
  set = JSON.parse(readFileSync(resolve(process.cwd(), setPath), "utf8"));
} catch (error) {
  die(
    `Could not read ${setPath}: ${error instanceof Error ? error.message : error}\n\n` +
      "This script appends to an existing set; it does not create one. Start the\n" +
      "decision set with a file carrying version, schemaVersion, purpose\n" +
      '"decision", frozenAt/frozenBy/frozenDigest null and an empty cases array,\n' +
      "or point --set at the development set to experiment."
  );
}
if (!Array.isArray(set.cases)) die(`${setPath} has no cases array.`);

// Only this cell's questions. Showing the drafter the English cell while
// asking for Korean is how a Korean cell becomes a translation of it.
const inCell = set.cases.filter(
  (item) => item.language === language && item.taskType === taskType
);
const instruction = draftInstruction({
  language,
  taskType,
  phenomenon,
  mode,
  count,
  existingQuestions: inCell.map((item) => item.question),
});
const hash = templateHash(instruction);

const capField = model.provider === "openai" ? "max_completion_tokens" : "max_tokens";
const outputTokenCap = Number(argValue("max-output-tokens") ?? 12000);
if (!Number.isInteger(outputTokenCap) || outputTokenCap <= 0) {
  die("--max-output-tokens must be a whole positive number.");
}
const generationParameters = { [capField]: outputTokenCap };

// Cost from lib/modelPricing.ts, not from a figure typed into a conversation:
// the repository's own table is what the rest of the product bills against.
const pricing = getModelPricingProfile(modelId);
const tier = pricing?.tiers?.[0];
const estimatedInputTokens = Math.ceil(instruction.length / 4);
const estimatedCostUsd = tier
  ? (estimatedInputTokens / 1_000_000) * tier.inputUsdPerMillionTokens +
    (outputTokenCap / 1_000_000) * tier.outputUsdPerMillionTokens
  : null;

console.log(`AI Review eval candidate drafting — ${language}/${taskType}\n`);
console.log(`  drafter    ${modelId} (${model.provider} ${model.apiModel})`);
console.log(`  phenomenon ${phenomenon}`);
console.log(`  mode       ${mode}`);
console.log(`  count      ${count}`);
console.log(`  template   ${AI_REVIEW_DRAFT_TEMPLATE_VERSION} (${hash})`);
console.log(`  params     ${JSON.stringify(generationParameters)}`);
console.log(`  already in this cell: ${inCell.length}`);
console.log(
  `  key from ${configuration.apiKeyEnvName}: ${process.env[configuration.apiKeyEnvName] ? "present" : "MISSING"}`
);
if (tier) {
  console.log(
    `\n  cost ceiling  ~$${estimatedCostUsd.toFixed(4)}  ` +
      `(~${estimatedInputTokens.toLocaleString("en-US")} input tokens estimated @ ` +
      `$${tier.inputUsdPerMillionTokens}/M, plus the full ${outputTokenCap.toLocaleString("en-US")} ` +
      `output cap @ $${tier.outputUsdPerMillionTokens}/M)`
  );
  console.log(
    `                a CEILING, not a forecast. Rates from lib/modelPricing.ts ` +
      `(${pricing.priceSource}, ${pricing.effectiveDate}).`
  );
} else {
  console.log(`\n  cost ceiling  unknown — lib/modelPricing.ts has no profile for ${modelId}.`);
}

console.log(`\n--- instruction ---\n${instruction}\n--- end ---`);

if (!send) {
  console.log(
    "\nNothing was sent and nothing was spent. Re-run with --send; that calls a " +
      "provider and is billed."
  );
  process.exit(0);
}

const apiKey = process.env[configuration.apiKeyEnvName];
if (!apiKey) die(`\n${configuration.apiKeyEnvName} is not set.`);

const response = await fetch(
  `${configuration.baseUrl.replace(/\/+$/, "")}/chat/completions`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.apiModel,
      messages: [{ role: "user", content: instruction }],
      ...generationParameters,
    }),
    signal: AbortSignal.timeout(Number(process.env.DRAFT_TIMEOUT_MS || 180_000)),
  }
);
const body = await response.text();
if (!response.ok) die(`\nHTTP ${response.status}: ${body.slice(0, 500)}`);

const completion = JSON.parse(body);
const { cases, problems } = parseDraftedCases(
  completion.choices?.[0]?.message?.content ?? ""
);
for (const problem of problems) console.error(`  rejected: ${problem}`);
if (cases.length === 0) {
  die("\nNothing usable came back. The call was billed; nothing was written.");
}

const draftedAt = new Date().toISOString();
const nextOrdinal = (prefix) => {
  const used = set.cases
    .map((item) => item.id)
    .filter((id) => typeof id === "string" && id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((value) => Number.isInteger(value));
  return used.length === 0 ? 1 : Math.max(...used) + 1;
};
const prefix = `${language}-${taskType.replace(/_/g, "-")}-`;
let ordinal = nextOrdinal(prefix);

for (const drafted of cases) {
  set.cases.push({
    id: `${prefix}${String(ordinal).padStart(3, "0")}`,
    language,
    taskType,
    phenomenon,
    mode,
    question: drafted.question,
    responses: drafted.responses.map((entry, index) => ({
      label: entry.label ?? ["a", "b", "c"][index],
      // The drafter is not asked which model "wrote" each answer, and none is
      // recorded: an evaluation case is about the text, and inventing a
      // provenance would put a model's name on prose it never produced.
      modelId: "drafted",
      provider: "drafted",
      content: entry.content,
    })),
    gold: drafted.gold,
    goldCompleteness: drafted.goldCompleteness,
    ...(drafted.injectionMarkers?.length
      ? { injectionMarkers: drafted.injectionMarkers }
      : {}),
    ...(drafted.notes ? { notes: drafted.notes } : {}),
    status: "candidate",
    adoptedBy: null,
    adoptedAt: null,
    draftedBy: {
      modelId,
      templateVersion: AI_REVIEW_DRAFT_TEMPLATE_VERSION,
      draftedAt,
    },
  });
  ordinal += 1;
}

writeFileSync(
  resolve(process.cwd(), setPath),
  `${JSON.stringify(set, null, 2)}\n`,
  "utf8"
);

console.log(`\n${cases.length} candidate(s) appended to ${setPath}.`);
console.log(
  "Every one is status: candidate with no adopter. A person reads the gold and " +
    "adopts it; nothing here may."
);
console.log("Next: npm run report:ai-review-eval-coverage");
