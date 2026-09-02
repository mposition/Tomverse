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

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION,
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
import {
  draftingCallCostCeilingUsd,
  draftingInputTokenCeiling,
} from "../lib/aiReviewEvalPlan.ts";
import {
  admitDraftCall,
  ledgerBalance,
} from "../lib/aiReviewDraftLedger.ts";

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

// A test seam, not a configuration knob.
//
// The stub-provider regressions need the request to go somewhere they control,
// and the ledger is only worth testing against a provider that can be made to
// return nothing usable on demand. Loopback only: an override that could name
// any host would be a way to send a live API key somewhere else, and this
// script holds one.
const baseUrlOverride = process.env.AI_REVIEW_DRAFT_BASE_URL ?? null;
if (baseUrlOverride !== null && !/^http:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/.test(baseUrlOverride)) {
  die(
    `AI_REVIEW_DRAFT_BASE_URL is a loopback-only test seam and "${baseUrlOverride}" is not\n` +
      "loopback. It exists so the spend regressions can stand a stub provider up on a\n" +
      "local port; it is not a way to point a drafting run, and the API key it sends,\n" +
      "at another host."
  );
}
const baseUrl = baseUrlOverride ?? configuration.baseUrl;

// The set is created on first use rather than committed empty.
//
// An empty decision set is a valid JSON file and an invalid dataset -- and
// `check:ai-review-eval` runs on every pull request, so committing one would
// turn the repository's own gate red for as long as the set takes to write.
// Weakening the gate to accommodate a placeholder would be the wrong trade:
// the rule that a decision set has cases is the rule, and a file that does not
// satisfy it yet does not need to exist yet.
let set;
const resolvedSetPath = resolve(process.cwd(), setPath);
if (!existsSync(resolvedSetPath)) {
  if (!send) {
    console.log(
      `\n${setPath} does not exist. --send would create it as an empty decision set\n` +
        "first. It is created here rather than committed empty because an empty\n" +
        "decision set fails check:ai-review-eval, which runs on every pull request."
    );
  }
  set = {
    version: basename(setPath).replace(/\.json$/, ""),
    schemaVersion: AI_REVIEW_EVAL_DATASET_SCHEMA_VERSION,
    purpose: "decision",
    frozenAt: null,
    frozenBy: null,
    frozenDigest: null,
    cases: [],
  };
} else {
  try {
    set = JSON.parse(readFileSync(resolvedSetPath, "utf8"));
  } catch (error) {
    die(`Could not read ${setPath}: ${error instanceof Error ? error.message : error}`);
  }
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
// A ceiling, not an estimate: see draftingInputTokenCeiling(). The name says
// so, because this number is what the hard stop is checked against.
const inputTokenCeiling = draftingInputTokenCeiling(instruction);
const estimatedCostUsd = tier
  ? (inputTokenCeiling / 1_000_000) * tier.inputUsdPerMillionTokens +
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
if (baseUrlOverride !== null) {
  console.log(`  BASE URL OVERRIDDEN to ${baseUrl} — no provider is being called`);
}
if (tier) {
  console.log(
    `\n  cost ceiling  ~$${estimatedCostUsd.toFixed(4)}  ` +
      `(<=${inputTokenCeiling.toLocaleString("en-US")} input tokens @ ` +
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

// The cumulative hard stop: reserve before the call, settle after.
//
// This script sends ONE batch per invocation and the plan needs 330 of them, so
// a per-call ceiling printed on screen bounds nothing across the loop -- an
// operator running it overnight has approved 330 calls' worth one call at a
// time. (330 is not 1,240 / 10: a batch belongs to one (cell, phenomenon, mode),
// so a phenomenon split across three modes is three batches, not the two its
// count alone would suggest. `report:ai-review-drafting-plan` prints the real
// figure per cell.)
//
// Reserve-then-settle rather than a single write afterwards, for the same
// reason the credit path works that way: the decision to spend and the record
// of spending cannot be one event, because everything between them can fail.
// A settle-only ledger lost every call that returned nothing usable, every
// reply that would not parse, every process that died after the response, and
// let two processes read the same balance and both proceed.
const ledgerPath = join(dirname(resolvedSetPath), `${basename(setPath, ".json")}.spend.jsonl`);
const lockPath = `${ledgerPath}.lock`;

const readLedger = () =>
  ledgerBalance(
    existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n") : []
  );

const maxTotalCostUsd = argValue("max-total-cost-usd")
  ? Number(argValue("max-total-cost-usd"))
  : null;
const callCeilingUsd = tier
  ? draftingCallCostCeilingUsd({
      inputTokens: inputTokenCeiling,
      outputTokenCap,
      inputUsdPerMillionTokens: tier.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: tier.outputUsdPerMillionTokens,
    })
  : null;

const balanceBefore = readLedger();
console.log(`\n  budget ledger  ${ledgerPath}`);
console.log(
  `  committed ceiling  ~$${balanceBefore.committedUsd.toFixed(4)}` +
    ` (${balanceBefore.settledCount} settled, ${balanceBefore.outstandingCount} outstanding)` +
    (maxTotalCostUsd === null ? "" : ` of $${maxTotalCostUsd.toFixed(2)}`)
);
for (const problem of balanceBefore.problems.slice(0, 5)) {
  console.log(`  LEDGER PROBLEM ${problem}`);
}

if (!send) {
  console.log(
    "\nNothing was sent and nothing was spent. Re-run with --send " +
      "--max-total-cost-usd=<total>; that calls a provider and is billed."
  );
  process.exit(0);
}

if (maxTotalCostUsd === null || !Number.isFinite(maxTotalCostUsd) || maxTotalCostUsd <= 0) {
  die(
    "--max-total-cost-usd=<total> is required with --send.\n\n" +
      "This sends one batch per run and the plan needs 330 of them, so a\n" +
      "per-call figure bounds nothing across the loop. The total is enforced\n" +
      `against ${ledgerPath}, which persists between runs.`
  );
}

// Before the lock, because everything past this point writes a reservation and
// a reservation stands for money that was very likely spent. A run with no key
// cannot call anything, so it must not leave one behind.
const apiKey = process.env[configuration.apiKeyEnvName];
if (!apiKey) die(`\n${configuration.apiKeyEnvName} is not set.`);

// The lock. An exclusive create is atomic, so two processes cannot both hold
// it.
//
// Held for the WHOLE run -- reserve, call, write the set, settle -- not just
// across the ledger read. The ledger was never the only shared thing: both
// processes also read the whole decision set, append their cases to their own
// copy in memory and write the file back, so the second one to finish erases
// the first one's candidates. A budget that admits two calls therefore paid
// for two and kept one.
//
// Serialising the entire run is the fix that matches what this tool is: one
// batch at a time, 330 times. There is no throughput to protect here, and a
// lock held across a two-minute provider call costs nothing that concurrency
// would have bought.
let lockHandle;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    lockHandle = openSync(lockPath, "wx");
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await new Promise((resolve_) => setTimeout(resolve_, 100));
  }
}
if (lockHandle === undefined) {
  die(
    `Another drafting run holds ${lockPath}.\n\n` +
      "Two runs reading the same balance would each decide they had room. If no\n" +
      "run is active, remove the lock file by hand -- and check the ledger for an\n" +
      "outstanding reservation first, because a run that died holding the lock\n" +
      "probably also left one."
  );
}

let lockReleased = false;
const releaseLock = () => {
  if (lockReleased) return;
  lockReleased = true;
  try {
    closeSync(lockHandle);
  } catch {
    // Already closed. The file removal below is what actually frees the lock.
  }
  rmSync(lockPath, { force: true });
};

const reservationId = randomUUID();
let reserved = false;
try {
  // Re-read INSIDE the lock. The balance printed above was read outside it and
  // is only for the operator's eyes.
  const balance = readLedger();
  const decision = admitDraftCall({
    balance,
    callCostCeilingUsd: callCeilingUsd,
    maxTotalCostUsd,
  });
  if (!decision.allowed) {
    releaseLock();
    die(`\nHARD STOP. ${decision.reason}\n\nNothing was sent.`);
  }
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({
      op: "reserve",
      id: reservationId,
      at: new Date().toISOString(),
      costCeilingUsd: callCeilingUsd,
      modelId,
      language,
      taskType,
      phenomenon,
      mode,
      requestedCases: count,
      inputTokenCeiling,
      outputTokenCap,
    })}\n`,
    "utf8"
  );
  reserved = true;
  console.log(
    `  reserved       ~$${callCeilingUsd.toFixed(4)} as ${reservationId}` +
      `  (~$${decision.remainingUsd.toFixed(4)} would remain)`
  );
} catch (error) {
  releaseLock();
  throw error;
}

// Every exit from here on releases the lock. `process.on("exit")` rather than
// a `finally` around the rest of the file, because `die()` calls
// `process.exit()` and a finally block does not run through that.
process.on("exit", releaseLock);

/**
 * Records what the reserved call turned into.
 *
 * Called on every exit path after the reservation exists, including the ones
 * that produce nothing usable -- the call was billed either way. A reservation
 * left unsettled keeps holding the budget for ever, which is the safe
 * direction: it stands for a call that was very likely charged.
 */
const settle = (outcome) => {
  if (!reserved) return;
  reserved = false;
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({
      op: "settle",
      reservationId,
      at: new Date().toISOString(),
      costCeilingUsd: callCeilingUsd,
      outcome,
    })}\n`,
    "utf8"
  );
};

let response;
try {
  response = await fetch(
  `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
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
} catch (error) {
  // The request may or may not have reached the provider. Settled rather than
  // left outstanding only because the alternative -- holding the budget for
  // ever on a connection error -- would stop the loop on the first flake; the
  // outcome names it so an operator can tell.
  settle("request_failed");
  die(`\nThe request failed: ${error.message}`);
}
const body = await response.text();
if (!response.ok) {
  settle(`http_${response.status}`);
  die(`\nHTTP ${response.status}: ${body.slice(0, 500)}`);
}

let completion;
try {
  completion = JSON.parse(body);
} catch (error) {
  settle("unparseable_response");
  die(`\nThe reply is not JSON: ${error.message}`);
}
const { cases, problems } = parseDraftedCases(
  completion.choices?.[0]?.message?.content ?? ""
);
for (const problem of problems) console.error(`  rejected: ${problem}`);
if (cases.length === 0) {
  settle("no_usable_cases");
  die("\nNothing usable came back. The call was billed and is settled in the ledger.");
}

// Re-read the set from disk, under the lock, before appending anything.
//
// Holding the lock across the write was not enough. `set` was read at startup,
// which for the run that waited on the lock is BEFORE the run ahead of it
// wrote its cases -- so appending to that stale copy and writing the whole
// file back erased them. The regression caught this: two runs, two
// settlements, one case in the file.
//
// The read has to be here, inside the lock and after the call, because that is
// the only point at which "what the file holds" is a fact that will still be
// true when the file is written.
// On a first --send the file does not exist yet: the skeleton built at startup
// is the only copy, and it is nobody else's to clobber.
if (existsSync(resolvedSetPath)) {
  let setOnDisk;
  try {
    setOnDisk = JSON.parse(readFileSync(resolvedSetPath, "utf8"));
  } catch (error) {
    settle("set_unreadable");
    die(
      `\n${setPath} could not be re-read before writing: ` +
        `${error instanceof Error ? error.message : error}\n\n` +
        "The call was billed and is settled. Nothing was written to the set."
    );
  }
  if (!Array.isArray(setOnDisk.cases)) {
    settle("set_unreadable");
    die(`\n${setPath} no longer has a cases array. Nothing was written.`);
  }
  set = setOnDisk;
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

settle(`drafted_${cases.length}`);

console.log(`\n${cases.length} candidate(s) appended to ${setPath}.`);
console.log(
  "Every one is status: candidate with no adopter. A person reads the gold and " +
    "adopts it; nothing here may."
);
console.log("Next: npm run report:ai-review-eval-coverage");
