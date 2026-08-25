// Draft candidate prompts for one cell of the Router evaluation set.
//
//   npm run draft:router-eval-candidates -- --model=gpt-5-5 --stratum=coding --cell=ko --count=14
//   npm run draft:router-eval-candidates -- --model=gpt-5-5 --stratum=coding --cell=ko --count=14 --send
//
// ## Provider-neutral, and deliberately not Claude
//
// The drafter is chosen by model id from the catalogue, so no provider is
// wired in. That matters for one reason, from
// docs/ops/tomverse-chat-router-evaluation-set.md §8: a set drafted by a
// routable model measures how well that model handles its own phrasing, and
// claude-sonnet-5 and claude-haiku-4-5 are routable. An agent of the same
// family drafting the whole set would tilt it toward that family's style.
//
// So a routable model is refused by default and needs --allow-routable-drafter
// to override, which puts the choice in the record rather than in a habit.
//
// ## It drafts; it does not adopt
//
// Every item is written status: candidate with adoptedBy and adoptedAt null.
// docs/ops/tomverse-chat-router-evaluation-set.md §8, §11 reserve adoption
// for a person. Nothing here writes a verdict.
//
// ## This sends real requests and costs money
//
// Which is why it does nothing without --send. The default prints the exact
// instruction that would go out, to which model, so the decision is made on
// the request rather than on a description of it.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { formatShortCommitSha, validateCommitSha } from "../lib/buildInfo.ts";

import {
  DRAFT_TEMPLATE_VERSION,
  draftInstruction,
  parseDraftedPrompts,
  templateHash,
} from "../lib/routerEvalDraftPrompt.ts";
import { EVAL_CELLS } from "../lib/routerQualityEvalSet.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";
import { getModelPricingProfile } from "../lib/modelPricing.ts";

const SET_PATH = "docs/ops/router-evaluation-set/development-v0.json";
/**
 * Families that are themselves routing candidates -- the confound named by
 * docs/ops/tomverse-chat-router-evaluation-set.md §8.
 */
const ROUTABLE_PROVIDERS = [...new Set(AVAILABLE_MODELS.filter((m) => m.enabled).map((m) => m.provider))];

const args = process.argv.slice(2);
const argValue = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const send = args.includes("--send");

const setPath = argValue("set") ?? SET_PATH;
const modelId = argValue("model");
const stratum = argValue("stratum");
const cell = argValue("cell");
const count = Number(argValue("count") ?? 14);
const batchId = argValue("batch");
const allowRoutable = args.includes("--allow-routable-drafter");

const die = (message) => {
  console.error(message);
  process.exit(1);
};

if (!modelId || !stratum || !cell) {
  die(
    "--model, --stratum and --cell are required.\n\n" +
      `Strata and cells:\n${Object.entries(EVAL_CELLS)
        .map(([name, cells]) => `  ${name.padEnd(30)}${cells.join(", ")}`)
        .join("\n")}`
  );
}
if (!EVAL_CELLS[stratum]?.includes(cell)) {
  die(`"${cell}" is not a cell of ${stratum}.`);
}

const model = AVAILABLE_MODELS.find((entry) => entry.id === modelId);
if (!model) die(`No catalogue model "${modelId}".`);

const configuration = PROVIDER_API_CONFIGURATION[model.provider];
if (!configuration) die(`No API configuration for provider "${model.provider}".`);
if (configuration.protocol !== "openai-compatible" && model.provider !== "openai") {
  die(
    `${model.provider} speaks its own dialect and this script only builds OpenAI-shaped\n` +
      "requests. Pick another drafter, or add a builder for it."
  );
}

// The default the whole non-Claude requirement rests on.
if (ROUTABLE_PROVIDERS.includes(model.provider) && !allowRoutable) {
  die(
    `${modelId} is served by ${model.provider}, which is a routing candidate.\n\n` +
      "A set drafted by a routable model measures how well that model handles its\n" +
      "own phrasing. Every provider in the catalogue is routable, so this will fire for\n" +
      "any of them -- what it is protecting against is drafting the whole set with one\n" +
      "family, and Claude in particular, since the agent doing this work is Claude.\n\n" +
      "Pass --allow-routable-drafter to proceed. The provider goes into every item's\n" +
      "draftProvenance either way, and the review sheet prints it."
  );
}

let set;
try {
  set = JSON.parse(readFileSync(setPath, "utf8"));
} catch (error) {
  die(`Could not read ${setPath}: ${error instanceof Error ? error.message : error}`);
}

const inCell = set.items.filter((item) => item.stratum === stratum && item.cell === cell);
const instruction = draftInstruction({
  stratum,
  cell,
  count,
  // Only this cell's prompts. Showing the drafter the English cell while
  // asking for Korean is how a Korean cell becomes a translation of it.
  avoid: inCell.map((item) => item.prompt),
});
const hash = templateHash(instruction);
const resolvedBatch = batchId ?? `${stratum}-${cell}-${String(inCell.length + 1).padStart(3, "0")}`;

// One object, used to build the request and then recorded verbatim. Two
// copies would drift, and a recorded parameter that was not the one sent is
// worse than none.
const capField = model.provider === "openai" ? "max_completion_tokens" : "max_tokens";
const generationParameters = { [capField]: 8000 };

// Cost, from lib/modelPricing.ts rather than from a figure typed into a
// conversation: the repository's own table is what the rest of the product
// bills against, so a drafting estimate that disagreed with it would be
// wrong somewhere that matters.
const pricing = getModelPricingProfile(modelId);
const tier = pricing?.tiers?.[0];
// The instruction is the whole input. Four characters per token is the rough
// figure for mixed Latin and Hangul; it is an estimate and is labelled as one.
const estimatedInputTokens = Math.ceil(instruction.length / 4);
const maximumOutputTokens = generationParameters[capField];
const estimatedCostUsd = tier
  ? (estimatedInputTokens / 1_000_000) * tier.inputUsdPerMillionTokens +
    (maximumOutputTokens / 1_000_000) * tier.outputUsdPerMillionTokens
  : null;

console.log(`Router eval candidate drafting — ${stratum}/${cell}\n`);
console.log(`  drafter   ${modelId} (${model.provider} ${model.apiModel})`);
console.log(`  batch     ${resolvedBatch}`);
console.log(`  count     ${count}`);
console.log(`  template  ${DRAFT_TEMPLATE_VERSION} (${hash})`);
console.log(`  api model  ${model.apiModel}${/latest$/.test(model.apiModel) ? "   (a MOVING alias — the version that answers is recorded per item)" : ""}`);
console.log(`  params    ${JSON.stringify(generationParameters)}`);
console.log(`  already in this cell: ${inCell.length}`);
console.log(`  key from ${configuration.apiKeyEnvName}: ${process.env[configuration.apiKeyEnvName] ? "present" : "MISSING"}`);

if (tier) {
  console.log(
    `\n  cost ceiling  ~$${estimatedCostUsd.toFixed(4)}  ` +
      `(~${estimatedInputTokens.toLocaleString("en-US")} input tokens estimated` +
      ` @ $${tier.inputUsdPerMillionTokens}/M, plus the full ${maximumOutputTokens.toLocaleString("en-US")}` +
      ` output cap @ $${tier.outputUsdPerMillionTokens}/M)`
  );
  console.log(
    `                a CEILING, not a forecast: the reply will be far shorter than the cap.\n` +
      `                rates from lib/modelPricing.ts (${pricing.priceSource}, ${pricing.effectiveDate}).`
  );
} else {
  console.log(`\n  cost ceiling  unknown — lib/modelPricing.ts has no profile for ${modelId}.`);
}

console.log(`\n--- instruction ---\n${instruction}\n--- end ---`);

if (!send) {
  console.log("\nNothing was sent. Re-run with --send. This calls a provider and is billed.");
  process.exit(0);
}

const apiKey = process.env[configuration.apiKeyEnvName];
if (!apiKey) die(`\n${configuration.apiKeyEnvName} is not set.`);

let response;
let text;
try {
  response = await fetch(`${configuration.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model.apiModel,
      messages: [{ role: "user", content: instruction }],
      ...generationParameters,
    }),
    signal: AbortSignal.timeout(Number(process.env.DRAFT_TIMEOUT_MS || 180_000)),
  });
  text = await response.text();
} catch (error) {
  die(`\nNo answer: ${error instanceof Error ? error.message : error}`);
}

if (!response.ok) die(`\nHTTP ${response.status}: ${text.slice(0, 600)}`);

let payload;
try {
  payload = JSON.parse(text);
} catch {
  die(`\nUnparseable response: ${text.slice(0, 600)}`);
}

const content = payload?.choices?.[0]?.message?.content ?? "";
const { prompts, dropped } = parseDraftedPrompts(content);
if (prompts.length === 0) {
  die(`\nNo prompts found in the reply:\n${String(content).slice(0, 600)}`);
}

// The deployed image has no git binary -- the first Wave 1 run printed
// "git: not found" and recorded a null commit for all 28 items. So the
// deployment's own commit is asked for first, the way lib/buildInfo.ts
// already resolves it everywhere else in the product, and the local checkout
// is only the fallback for running this from a workstation.
let generatorCommit =
  formatShortCommitSha(validateCommitSha(process.env.RAILWAY_GIT_COMMIT_SHA)) ?? null;
if (!generatorCommit) {
  try {
    generatorCommit = execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // No git binary and no deployment variable. Left null rather than
    // guessed: a wrong commit is worse than an absent one, because it looks
    // checkable.
  }
}

const language =
  cell === "ko-en"
    ? { prompt: "ko", expectedResponse: "en" }
    : { prompt: cell, expectedResponse: cell };

// Whatever the provider actually called itself. Never the id we asked for:
// The confound is about the model that ANSWERED, and an echo of the request
// would look like a record while recording nothing.
const modelVersion = typeof payload?.model === "string" && payload.model.trim() ? payload.model.trim() : null;

const prefix = `${stratum.split("_")[0]}-${cell}`;
const existing = new Set(set.items.map((item) => item.id));
let sequence = 1;
const nextId = () => {
  let id;
  do {
    id = `${prefix}-${String(sequence).padStart(3, "0")}`;
    sequence += 1;
  } while (existing.has(id));
  existing.add(id);
  return id;
};

const drafted = prompts.map((prompt) => ({
  id: nextId(),
  stratum,
  cell,
  language,
  source: "drafted",
  status: "candidate",
  adoptedBy: null,
  adoptedAt: null,
  draftProvenance: {
    batchId: resolvedBatch,
    provider: model.provider,
    modelId,
    requestedApiModel: model.apiModel,
    modelVersion,
    generationParameters,
    promptTemplateVersion: DRAFT_TEMPLATE_VERSION,
    promptTemplateHash: hash,
    generatorCommit,
    draftedAt: new Date().toISOString(),
  },
  prompt,
}));

set.items = [...set.items, ...drafted];
writeFileSync(setPath, `${JSON.stringify(set, null, 2)}\n`, "utf8");

console.log(`\n  ${drafted.length} candidate(s) written to ${setPath}`);
console.log(
  `  requested ${model.apiModel}; the provider answered as ` +
    `${modelVersion ?? "(no model field in the response — recorded as null, not guessed)"}`
);
if (!generatorCommit) {
  console.log(
    "  generatorCommit is null: no RAILWAY_GIT_COMMIT_SHA and no git binary. The batch\n" +
      "  cannot be tied to the code that drafted it, which a reviewer may weigh."
  );
}
if (dropped > 0) console.log(`  ${dropped} malformed entr(ies) dropped rather than padded.`);
if (drafted.length < count) {
  console.log(
    `  Short of the ${count} asked for. Draft the remainder in another batch rather than\n` +
      "  editing this one, so each batch stays one drafting run."
  );
}
console.log(
  `\n  Every item is status: candidate. Adoption is a human act, reserved by the\n` +
    `  procedure in docs/ops/tomverse-chat-router-evaluation-set.md.\n` +
    `  Next: npm run make:router-eval-review-sheet -- --batch=${resolvedBatch}`
);
