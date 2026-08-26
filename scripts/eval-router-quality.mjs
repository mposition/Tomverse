// ROUTE-01's harness: paired, blind answer-quality comparison of Auto against
// the pre-registered fixed-model baseline.
//
// This is NOT a CI test. It makes real, billed provider calls -- three per
// item, two answers and a judgement -- so it is a deliberate operator action,
// the same way scripts/evalDefaultModel.mjs is.
//
// The procedure it implements is docs/ops/tomverse-chat-router-evaluation-set.md
// and the arithmetic is lib/routerQualityEvalCore.ts. Everything this file
// adds is the part that has to touch a provider: running the real Router over
// a real question, generating both answers, blinding them, and asking a judge.
//
// ## The three modes, and why they are not one command
//
//   --mode=pilot        200-ish items from the development set. Measures the
//                       discordance rate so §3's `n` can be computed instead
//                       of guessed. Emits no decision evidence, ever.
//   --mode=judge-bias   §5. Measures a routable judge's preference for its own
//                       output on held-out pairs, so the bias is a number
//                       beside the result rather than a caveat under it.
//   --mode=decision     The run ROUTE-01 cites. Requires a frozen decision
//                       set, a pre-registered `n`, and -- when the judge is
//                       routable -- a bias artefact from the mode above.
//
// Splitting them is the point. "Run it and see, then decide how big it should
// have been" is how a sample size becomes an outcome that was chosen rather
// than measured, and a single command that did all three would make that the
// path of least resistance.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/eval-router-quality.mjs \
//     --mode=pilot --set=docs/ops/router-evaluation-set/development-v0.json \
//     --baseline=gpt-5-6-luna --judge=gpt-5-6-luna --seed=20260812 --json=pilot.json
//
//   ... --limit=50            stop after this many items
//   ... --max-cost-usd=5      stop once this much provider cost has accrued
//   ... --use-index=1         decision mode: which use of the decision set this is
//   ... --judge-bias=<path>   decision mode: the artefact from --mode=judge-bias
//
// Requires provider keys for every model it touches.
//
// This script decides nothing. It never sets a flag, never writes to a
// database, never edits the gate registry. Its outputs are console text and,
// with --json, the artefact a human cites.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { generateText } from "ai";

import { getActiveAiModel } from "../lib/activeAiModel.ts";
import { AVAILABLE_MODELS, getModel } from "../lib/models.ts";
import { ACTIVE_ESTIMATOR_VERSION, estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { decideRouterModel, ROUTER_VERSIONS } from "../lib/routerDecision.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import {
  PAIRED_EVALUATION_UNIT,
  ROUTER_QUALITY_EVAL_VERSION,
  computeWinRateDelta,
  evaluateRouterQualityRun,
  evaluationRecordProblems,
  requiredSampleSize,
  seededRandom,
} from "../lib/routerQualityEvalCore.ts";
import {
  adoptedItems,
  decisionRunRefusals,
  evalSetProblems,
  runParameterMismatches,
} from "../lib/routerQualityEvalSet.ts";

const argValue = (name, fallback) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const mode = argValue("mode", "pilot");
const setPath = argValue("set", "");
const baselineModelId = argValue("baseline", "");
const allowCandidates = process.argv.includes("--allow-candidates");
const judgeModelId = argValue("judge", "");
const seed = Number(argValue("seed", "")) || 0;
const jsonPath = argValue("json", "");
const limit = Number(argValue("limit", "0")) || 0;
const judgeBiasPath = argValue("judge-bias", "");
const useIndex = Number(argValue("use-index", "0")) || 0;
const preRegisteredN = Number(argValue("preregistered-n", "0")) || 0;
const ciMethod = argValue("method", "bootstrap_percentile");
const rawMaxCost = argValue("max-cost-usd", "");
const maxCostUsd = rawMaxCost === "" ? null : Number(rawMaxCost);

const die = (message) => {
  console.error(message);
  process.exit(1);
};

if (!["pilot", "decision", "judge-bias"].includes(mode)) {
  die(`--mode must be pilot, decision or judge-bias (got "${mode}").`);
}
if (!setPath) die("--set=<path to the evaluation set JSON> is required.");
if (!baselineModelId) die("--baseline=<model id> is required and must be pre-registered.");
if (!judgeModelId) die("--judge=<model id> is required.");
if (!seed) {
  die("--seed=<integer> is required: §9 records it so the run can be replayed.");
}
if (maxCostUsd !== null && !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
  die(`--max-cost-usd must be a positive number (got "${rawMaxCost}").`);
}

const evaluationSet = JSON.parse(readFileSync(setPath, "utf8"));
const setProblems = evalSetProblems(evaluationSet, {
  expectedPurpose: mode === "decision" ? "decision" : "development",
});
if (setProblems.length > 0) {
  die(
    `The evaluation set at ${setPath} cannot be used for a ${mode} run:\n` +
      setProblems.map((problem) => `  - ${problem}`).join("\n")
  );
}

// Before anything is resolved or sent: the arguments must be the ones the set
// pre-registered. The report copies the set's pre-registration provenance in
// beside whatever was passed on the command line, so an unchecked argument
// would produce a record that names a person and a date for a choice they
// never made. Checked in every mode -- a pilot run on a different judge or a
// different seed is a different measurement, whatever it is called.
const mismatches = runParameterMismatches(evaluationSet, {
  mode,
  baselineModelId,
  judgeModelId,
  seed,
});
if (mismatches.length > 0) {
  die(
    `\nThe run does not match what ${setPath} pre-registered:\n\n` +
      mismatches.map((reason) => `  - ${reason}`).join("\n") +
      `\n\nEither run the pre-registered configuration, or pre-register the one you\n` +
      `want first. Nothing was sent and nothing was billed.`
  );
}

const baselineModel = getModel(baselineModelId);
if (!baselineModel) die(`Unknown baseline model "${baselineModelId}".`);
const judgeModel = getModel(judgeModelId);
if (!judgeModel) die(`Unknown judge model "${judgeModelId}".`);

const routableModelIds = AVAILABLE_MODELS.map((model) => model.id);
const judgeIsRoutable = routableModelIds.includes(judgeModelId);

// §4. The baseline the run compares against has to be the one the set
// pre-registered; a baseline supplied on the command line that disagrees with
// the frozen record is the comparison being chosen at run time.
if (evaluationSet.baseline && evaluationSet.baseline.modelId !== baselineModelId) {
  die(
    `The set pre-registered "${evaluationSet.baseline.modelId}" as the baseline; ` +
      `--baseline=${baselineModelId} would compare against a different one.`
  );
}

let judgeBias = null;
if (judgeBiasPath) {
  judgeBias = JSON.parse(readFileSync(judgeBiasPath, "utf8"));
}
if (mode === "judge-bias") {
  if (!judgeIsRoutable) {
    die(
      `"${judgeModelId}" is not a routable model, so it has no output of its own in the ` +
        "set to prefer. §5 asks for this measurement only where the judge is one of the " +
        "models being judged."
    );
  }
  if (baselineModelId === judgeModelId) {
    // Both arms would be the same model, so every verdict would be that model
    // against itself and the "self-preference rate" would be sampling noise.
    die("--baseline must differ from --judge in a bias run, or nothing is being compared.");
  }
}
if (mode === "decision") {
  if (!preRegisteredN) {
    die("--preregistered-n is required in decision mode: §3 fixes n before the run, from a measured pilot.");
  }
  if (!useIndex) {
    die(
      "--use-index is required in decision mode. §7: every look at the decision set costs a use, " +
        "and a second run against the same frozen set reports how well the Router fits its own test set."
    );
  }
  if (judgeIsRoutable && !judgeBias) {
    die(
      `The judge "${judgeModelId}" is itself routable, so §5 requires a bias measurement. ` +
        "Run --mode=judge-bias first and pass its artefact with --judge-bias=<path>."
    );
  }
}

const commitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const random = seededRandom(seed);
let accruedCostUsd = 0;
let truncatedByCost = false;

// Priced through the same lib/modelPricing.ts profile the product bills from,
// so the figure this prints is the one the run actually costs rather than a
// list price. Micro-USD per the pricing table's own units.
const costMicroUsd = (model, usage) => {
  const pricing = resolveModelPricing(model, {
    estimatedPromptTokens: usage.inputTokens ?? 0,
  });
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, (usage.inputTokens ?? 0) - cachedTokens);
  return (
    uncachedInput * pricing.inputUsdPerMillionTokens +
    cachedTokens * pricing.inputUsdPerMillionTokens * pricing.cachedInputPriceMultiplier +
    (usage.outputTokens ?? 0) * pricing.outputUsdPerMillionTokens
  );
};

const answer = async (model, prompt) => {
  const startedAt = process.hrtime.bigint();
  const result = await generateText({
    model: getActiveAiModel(model),
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: 2_048,
  });
  const usage = result.usage ?? {};
  accruedCostUsd += costMicroUsd(model, usage) / 1_000_000;
  return {
    text: result.text ?? "",
    latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    usage,
  };
};

// §5. An answer that names its own model defeats the blinding, and the
// procedure says such an item is excluded and logged rather than quietly
// scrubbed -- a scrub changes the answer the judge grades.
const SELF_IDENTIFICATION = [
  ...routableModelIds,
  "openai",
  "anthropic",
  "deepseek",
  "gemini",
  "claude",
  "gpt-",
  "as an ai language model",
  "저는 ai 언어 모델",
];

const identifiesItself = (text) => {
  const lowered = text.toLowerCase();
  return SELF_IDENTIFICATION.some((marker) => lowered.includes(marker.toLowerCase()));
};

// §6, verbatim in its tie-break order. The judge sees two answers and no arm
// labels, no model ids and no routing reason.
const JUDGE_TEMPLATE_VERSION = "judge-rubric-v1";
const judgePrompt = (question, first, second) =>
  [
    "You are grading two answers to the same question. Decide which better serves the person who asked.",
    "",
    "Apply these criteria in order, and stop at the first one that separates them:",
    "1. Correctness. A factual or logical error outweighs everything below.",
    "2. Instruction compliance. Format, length, language and explicit constraints. Answering in the wrong language is a failure, not a style difference.",
    "3. Usefulness. Does it resolve the request, or only describe it.",
    "4. Grounding. Sourced claims beat confident unsourced ones.",
    "5. Concision. Only as a tie-break. Length is not quality.",
    "",
    'Reply with exactly one word: "FIRST", "SECOND", or "EQUIVALENT".',
    'If the two answers serve the person equally well, reply "EQUIVALENT". This is a real verdict, not a way to avoid deciding, and a forced preference between equal answers makes the measurement worse.',
    "",
    `QUESTION:\n${question}`,
    "",
    `ANSWER A:\n${first}`,
    "",
    `ANSWER B:\n${second}`,
  ].join("\n");

const readVerdict = (text) => {
  const upper = (text ?? "").toUpperCase();
  if (upper.includes("EQUIVALENT")) return "equivalent";
  if (upper.includes("FIRST")) return "first";
  if (upper.includes("SECOND")) return "second";
  return null;
};

const routerInputFor = (item) => {
  const reservedInputTokens = estimateRawTextTokens(item.prompt);
  return {
    text: item.prompt,
    attachments: (item.attachments ?? []).map((attachment) => ({
      mediaType: attachment.mediaType,
    })),
    webSearchRequested: item.webSearchRequested === true,
    models: AVAILABLE_MODELS,
    // Evaluated at the plan the gate is about. A cheaper plan filters models
    // out and would grade a Router that never had the candidates.
    plan: "Pro",
    reservedInputTokens,
    requestOutputCapTokens: 2_048,
  };
};

// Which items a run may bill against, decided before anything is sent.
//
// This used to read: adopted items if there are any, otherwise every item in
// the set. Three ways that goes wrong, each of which bills:
//
//   - Nothing adopted yet, so it runs the whole candidate pool -- a pool that
//     grew to 234 during collection, against a pilot designed for 210.
//   - Some cells adopted and others not, so it runs whatever happens to be
//     ready and reports it as the pilot. The strata are the design; a subset
//     of them measures something the pre-registration never described.
//   - `pilotReady` never consulted at all, so the flag a person sets to say
//     "this set is ready to be measured" had no effect on whether it was.
//
// A decision run now refuses unless the set says it is ready, every cell holds
// exactly its frozen target, and a baseline is pre-registered. Exploratory
// modes still run, but never by silently falling back to candidates: that
// needs --allow-candidates, said out loud.
const adopted = adoptedItems(evaluationSet);

if (mode === "decision") {
  const refusals = decisionRunRefusals(evaluationSet);
  if (refusals.length > 0) {
    die(
      `\nA decision run is refused. It is the only mode that produces ROUTE-01\n` +
        `evidence, so it runs on the set that was pre-registered or not at all.\n\n` +
        refusals.map((reason) => `  - ${reason}`).join("\n") +
        `\n\nNothing was sent and nothing was billed.`
    );
  }
}

let items;
if (adopted.length > 0) {
  items = adopted;
} else if (allowCandidates) {
  items = evaluationSet.items;
  console.log(
    `  NOTE: no item is adopted, so this runs ${items.length} candidate(s) because\n` +
      "        --allow-candidates was given. Candidates are unreviewed."
  );
} else {
  die(
    `\nNo item in the set is adopted, and this run would otherwise bill against\n` +
      `all ${evaluationSet.items.length} candidate(s) -- unreviewed prompts, in whatever\n` +
      `number collection happens to have reached.\n\n` +
      `  Adopt the items first, or pass --allow-candidates to run them knowingly.`
  );
}

const planned = limit > 0 ? items.slice(0, limit) : items;

console.log(`Router quality evaluation — ${mode} run`);
console.log(`  set            ${evaluationSet.version} (${evaluationSet.purpose})`);
console.log(`  items          ${planned.length}${limit > 0 ? ` of ${items.length} (--limit)` : ""}`);
console.log(`  baseline       ${baselineModelId}`);
console.log(`  judge          ${judgeModelId}${judgeIsRoutable ? " (routable — bias must be measured)" : ""}`);
console.log(`  seed           ${seed}`);
if (mode !== "decision") {
  console.log("  This run produces no ROUTE-01 evidence. Only --mode=decision does.");
}
console.log("");

const pairs = [];
const excludedLog = [];

for (const [index, item] of planned.entries()) {
  if (maxCostUsd !== null && accruedCostUsd >= maxCostUsd) {
    truncatedByCost = true;
    console.log(`\nStopped at item ${index} — cost ceiling $${maxCostUsd} reached.`);
    break;
  }

  // §5's bias run replaces the Router with the judge's own model, so the
  // graded arm is the judge's own output and the win rate it produces is the
  // self-preference rate. Nothing else about the protocol changes -- same
  // blinding, same rubric, same seeded ordering -- because a bias measured
  // under a different protocol does not describe this one.
  const decision = mode === "judge-bias" ? null : decideRouterModel(routerInputFor(item));
  const base = {
    itemId: item.id,
    stratum: item.stratum,
    cell: item.cell,
    baselineModelId,
    autoModelId:
      mode === "judge-bias"
        ? judgeModelId
        : decision.outcome === "selected"
          ? decision.modelId
          : null,
    // Randomised per item from the recorded seed, so the whole run replays.
    autoPosition: random() < 0.5 ? "first" : "second",
  };

  const exclude = (reason, detail) => {
    pairs.push({ ...base, outcome: { status: "excluded", reason } });
    excludedLog.push({ itemId: item.id, reason, detail: detail ?? null });
    process.stdout.write("x");
  };

  // A refusal to route is a routing outcome, not a quality loss. It is
  // excluded from the delta and counted on its own, because scoring it as a
  // loss would mix "Auto answered worse" with "Auto did not answer".
  if (decision && decision.outcome !== "selected") {
    exclude("no_candidate", decision.rejections.map((r) => `${r.modelId}:${r.reason}`).join(","));
    continue;
  }

  const autoModel = getModel(base.autoModelId);
  if (!autoModel) {
    exclude("auto_arm_failed", `the Router chose "${base.autoModelId}", which is not in the catalogue`);
    continue;
  }

  let autoAnswer;
  let baselineAnswer;
  try {
    autoAnswer = await answer(autoModel, item.prompt);
  } catch (error) {
    exclude("auto_arm_failed", String(error));
    continue;
  }
  try {
    baselineAnswer = await answer(baselineModel, item.prompt);
  } catch (error) {
    exclude("baseline_arm_failed", String(error));
    continue;
  }

  if (identifiesItself(autoAnswer.text) || identifiesItself(baselineAnswer.text)) {
    exclude("self_identified");
    continue;
  }

  const [first, second] =
    base.autoPosition === "first"
      ? [autoAnswer.text, baselineAnswer.text]
      : [baselineAnswer.text, autoAnswer.text];

  let verdict;
  try {
    const judgement = await answer(judgeModel, judgePrompt(item.prompt, first, second));
    verdict = readVerdict(judgement.text);
  } catch (error) {
    exclude("judge_failed", String(error));
    continue;
  }
  if (verdict === null) {
    exclude("judge_failed", "the judge returned no recognisable verdict");
    continue;
  }

  // Position back to arm. Recorded in arm terms because that is what the
  // score means; the position is kept separately so §5's bias is measurable.
  const arm =
    verdict === "equivalent"
      ? "equivalent"
      : (verdict === "first") === (base.autoPosition === "first")
        ? "auto"
        : "baseline";

  pairs.push({ ...base, outcome: { status: "judged", verdict: arm } });
  process.stdout.write(arm === "auto" ? "+" : arm === "baseline" ? "-" : ".");
}

console.log("\n");

const startedAt = new Date().toISOString();
const verdict = evaluateRouterQualityRun({
  pairs,
  // Cell targets grade the decision set. A pilot is deliberately small and a
  // bias run deliberately narrow, so applying the targets to either would
  // report `underpowered` for runs that were never meant to fill a cell.
  cellTargets: mode === "decision" ? (evaluationSet.cellTargets ?? []) : [],
  preRegisteredSampleSize: mode === "decision" ? preRegisteredN : null,
  method: ciMethod,
  seed,
});

const cellCounts = {};
for (const pair of pairs) {
  if (pair.outcome.status !== "judged") continue;
  const key = `${pair.stratum}/${pair.cell}`;
  cellCounts[key] = (cellCounts[key] ?? 0) + 1;
}

const pct = (value) => (Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(1)}%`);
const pp = (value) => (Number.isNaN(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`);

console.log(`Outcome        ${verdict.outcome.toUpperCase()}`);
for (const reason of verdict.reasons) console.log(`  - ${reason}`);
console.log("");
console.log(`Judged pairs   ${verdict.delta.n}  (auto ${verdict.delta.wins} / baseline ${verdict.delta.losses} / equivalent ${verdict.delta.ties})`);
console.log(`Discordance    ${pct(verdict.delta.discordanceRate)}`);
console.log(`Win-rate delta ${pp(verdict.delta.pointEstimatePp)}  95% CI [${pp(verdict.delta.ci95LowerPp)}, ${pp(verdict.delta.ci95UpperPp)}]  (${verdict.delta.method}, seed ${seed})`);
const exclusionBreakdown = Object.entries(verdict.exclusions.byReason)
  .filter(([, count]) => count > 0)
  .map(([reason, count]) => `${reason} ${count}`)
  .join(", ");
console.log(
  `Excluded       ${verdict.exclusions.total} (${pct(verdict.exclusions.rate)})` +
    (exclusionBreakdown ? ` — ${exclusionBreakdown}` : "")
);
console.log(`Judge position ${pct(verdict.positionBias.firstRate)} preferred the first answer (auto was first ${pct(verdict.positionBias.autoFirstRate)} of the time)`);
console.log(`Routed away    ${pct(verdict.routedAwayRate)} of judged pairs used a model other than the baseline`);
console.log(`Provider cost  $${accruedCostUsd.toFixed(4)}${truncatedByCost ? " (run truncated by --max-cost-usd)" : ""}`);

if (mode === "pilot") {
  const measured = verdict.delta.discordanceRate;
  console.log("");
  if (!(measured > 0)) {
    // Zero discordance over a handful of pairs is not "no items needed"; it is
    // a pilot too small to have produced a disagreement yet. Printing a size
    // from it would hand the collection plan a number that came from nowhere.
    console.log(
      `§3 sizing: not computable. ${verdict.delta.n} judged pair(s) produced no discordance,\n` +
        "  which sizes nothing. Run a larger pilot before pre-registering `n`."
    );
  } else {
    console.log("§3 sizing, from the discordance this pilot measured:");
    for (const halfWidth of [2, 3, 4]) {
      console.log(
        `  ±${halfWidth}pp half-width needs ~${requiredSampleSize(measured, halfWidth)} items`
      );
    }
    console.log(
      "  Pre-register one of these as `n` before collecting the decision set. Sizing\n" +
        "  after seeing the full result is how a sample size becomes an outcome."
    );
  }
}

// §5's number, in the form the decision run consumes it.
const selfPreferenceRate =
  verdict.delta.discordantPairs === 0
    ? Number.NaN
    : verdict.delta.wins / verdict.delta.discordantPairs;

if (mode === "judge-bias") {
  console.log("");
  console.log(
    `Self-preference ${pct(selfPreferenceRate)} of decided pairs went to ${judgeModelId}'s own answer`
  );
  console.log(
    "  50% is no self-preference. This measures the judge, not the Router, and it is\n" +
      "  reported beside a decision run rather than subtracted from it -- a correction\n" +
      "  would claim a precision this measurement does not have."
  );
}

if (verdict.outcome === "measured" && mode === "decision") {
  console.log("");
  console.log(
    verdict.meetsMargin
      ? "The 95% lower bound clears -2pp. ROUTE-01's metric is met by this run."
      : "The 95% lower bound does not clear -2pp. ROUTE-01's metric is not met by this run."
  );
  console.log(
    "This is one input to the gate, not the gate. Approval, evidence refs and the\n" +
      "cohort decision are separate and human."
  );
}

const record = {
  evalVersion: ROUTER_QUALITY_EVAL_VERSION,
  mode,
  evaluationSetVersion: evaluationSet.version,
  evaluationSetPurpose: evaluationSet.purpose,
  decisionSetUseIndex: mode === "decision" ? useIndex : null,
  commitSha,
  startedAt,
  cellCounts,
  baseline: {
    modelId: baselineModelId,
    catalogueVersion: evaluationSet.baseline?.catalogueVersion ?? null,
    preRegisteredAt: evaluationSet.baseline?.preRegisteredAt ?? null,
    preRegisteredBy: evaluationSet.baseline?.preRegisteredBy ?? null,
  },
  versions: {
    router: ROUTER_VERSIONS.decision,
    estimator: ACTIVE_ESTIMATOR_VERSION,
    // No Planner stage runs in this harness. Saying so beats a version number
    // for a stage that did not execute.
    planner: "none",
    template: JUDGE_TEMPLATE_VERSION,
  },
  routerVersions: ROUTER_VERSIONS,
  pairedUnit: PAIRED_EVALUATION_UNIT,
  ciMethod,
  seed,
  sampleSize: verdict.delta.n,
  discordantPairs: verdict.delta.discordantPairs,
  pointEstimatePp: verdict.delta.pointEstimatePp,
  ci95LowerPp: verdict.delta.ci95LowerPp,
  ci95UpperPp: verdict.delta.ci95UpperPp,
  outcome: verdict.outcome,
  outcomeReasons: verdict.reasons,
  meetsMargin: verdict.meetsMargin,
  positionBias: verdict.positionBias,
  routedAwayRate: verdict.routedAwayRate,
  seedPreRegistration: {
    preRegisteredAt: evaluationSet.seed?.preRegisteredAt ?? null,
    preRegisteredBy: evaluationSet.seed?.preRegisteredBy ?? null,
  },
  judge: {
    identity: judgeModelId,
    isRoutableModel: judgeIsRoutable,
    preRegisteredAt: evaluationSet.judge?.preRegisteredAt ?? null,
    preRegisteredBy: evaluationSet.judge?.preRegisteredBy ?? null,
    // In a bias run this artefact *is* the measurement; elsewhere it carries
    // whatever earlier bias run was passed in, so a decision report is never
    // the only place its own judge's bias is recorded.
    biasMeasurement:
      mode === "judge-bias"
        ? {
            judgeModelId,
            comparedAgainstModelId: baselineModelId,
            heldOutPairs: verdict.delta.n,
            decidedPairs: verdict.delta.discordantPairs,
            selfPreferenceRate,
            evaluationSetVersion: evaluationSet.version,
            seed,
          }
        : judgeBias,
  },
  exclusions: excludedLog,
  truncatedByCost,
  providerCostUsd: Number(accruedCostUsd.toFixed(6)),
  pairs,
};

// The §9 completeness check runs against the harness's own output. A report
// that cannot be cited should say so at the moment it is written, not when
// somebody tries to attach it to the gate.
const recordProblems = evaluationRecordProblems(record, { routableModelIds });
if (recordProblems.length > 0) {
  console.log("");
  console.log("This report is NOT decision-grade evidence:");
  for (const problem of recordProblems) console.log(`  - ${problem}`);
}

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${jsonPath}`);
}

// A run that produced no verdict exits non-zero, so a scheduled invocation
// cannot report success for a run that established nothing. A `measured` run
// that failed the margin exits zero: it measured what it set out to measure,
// and the margin is the gate's decision rather than this script's.
if (verdict.outcome === "not_run" || verdict.outcome === "inconclusive") {
  process.exit(2);
}

// Verify one derived figure against the raw pairs, so a refactor that broke
// the scoring would fail the run rather than publish a wrong delta.
const recomputed = computeWinRateDelta(pairs, { method: ciMethod, seed });
if (recomputed.pointEstimatePp !== verdict.delta.pointEstimatePp) {
  die("The reported delta does not match a recomputation from the stored pairs.");
}
