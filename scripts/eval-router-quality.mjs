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
//   --mode=judge-bias   Superseded. Its own-answer preference rate mixes the
//                       two models' quality difference with the judge's
//                       preference for its own output, and 50% reads as "no
//                       self-preference" only if the models are equally good.
//                       Kept runnable because the number is still a diagnostic;
//                       it is no longer citable, and --judge-bias=<path> is
//                       refused outright.
//   --mode=judge-calibration
//                       docs/ops/tomverse-chat-router-evaluation-set.md §5, in
//                       the shape that can be defended: two judges over the
//                       SAME answers, reported as a paired shift with a
//                       pair-level bootstrap interval. Pure analysis of two
//                       verdict files -- it sends nothing.
//   --mode=decision     The run ROUTE-01 cites. Requires a frozen decision
//                       set, a pre-registered `n`, and -- when the judge is
//                       routable -- a calibration artefact that names this
//                       judge, grades development-set answers from a run that
//                       finished, and carries both judges' verdicts on every
//                       pair. Checked before anything is sent.
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
//   ... --preregistration=<path>
//                            decision mode: the frozen `n` and what it is
//                            conditional on. Refused while pending.
//   ... --calibration=<path>  decision mode: the artefact from
//                            --mode=judge-calibration, checked against this run
//                            before anything is sent
//
// Requires provider keys for every model it touches.
//
// This script decides nothing. It never sets a flag, never writes to a
// database, never edits the gate registry. Its outputs are console text and,
// with --json, the artefact a human cites.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  ANSWER_BUNDLE_VERSION,
  answerBundleProblems,
  bundleAnswerIdentities,
  bundleDigest,
  canonicalIdentity,
  parseAnswerBundle,
  sha256,
} from "../lib/routerAnswerBundle.ts";
import {
  CALIBRATION_MIN_COVERAGE,
  calibrateJudges,
  calibrationArtefactProblems,
  calibrationProblems,
} from "../lib/routerJudgeCalibration.ts";
import { decisionRunProblems } from "../lib/routerDecisionPreRegistration.ts";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { generateText } from "ai";

import { getActiveAiModel } from "../lib/activeAiModel.ts";
import { AVAILABLE_MODELS, getModel } from "../lib/models.ts";
import { ACTIVE_ESTIMATOR_VERSION, estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { decideRouterModel, ROUTER_VERSIONS } from "../lib/routerDecision.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import {
  EMPTINESS_REASONS,
  FAILURE_ATTRIBUTIONS,
  failed as answerFailed,
  failureRecord,
  isHarnessAttributable,
  outcomeFromReply,
} from "../lib/routerAnswerOutcome.ts";
import {
  buildCallLimitManifest,
  callLimitManifestProblems,
  resolveCallLimit,
} from "../lib/routerCallLimits.ts";
import {
  executableCallManifest,
  freezeRoutingPlan,
  maxPlannedAnswerRequestCostUsd,
  routingPlanProblems,
} from "../lib/routerRoutingPlan.ts";
import { PILOT_PER_REQUEST_MAX_COST_USD } from "../lib/routerFableEntry.ts";
import {
  JUDGE_TEMPLATE_VERSION,
  identifiesItself,
  judgePrompt,
  readVerdict,
  selfIdentificationMarkers,
} from "../lib/routerJudgeRubric.ts";
import {
  PAIRED_EVALUATION_UNIT,
  ROUTER_QUALITY_EVAL_VERSION,
  computeWinRateDelta,
  decidePairFromAnswers,
  outcomeScore,
  pairAccounting,
  pairAccountingProblems,
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
// Where each pair is appended as it completes, so a run that is killed still
// has a record of what it paid for. Defaults beside --json rather than needing
// its own flag: a run worth preserving is one worth journalling.
const journalPath = argValue("journal", "") || (jsonPath ? `${jsonPath}.jsonl` : "");
// Rebuild a report from a journal instead of running. Without this the journal
// would be data nobody can turn back into a report, which is the shape of
// record this harness refuses everywhere else.
const fromJournalPath = argValue("from-journal", "");
// Where the answers themselves go, so a second judge can grade the same words
// rather than freshly generated ones. Beside --json for the same reason the
// journal is: a run worth preserving is one worth being able to re-judge.
const bundlePath = argValue("bundle", "") || (jsonPath ? `${jsonPath}.answers.jsonl` : "");
// Grade an existing bundle instead of generating anything. Calls only the
// judge, so the answers -- and the order they are shown in -- are identical to
// the pass this is being compared against.
const rejudgePath = argValue("rejudge", "");
// Two verdict files, compared. No provider is called.
const verdictPaths = process.argv
  .filter((argument) => argument.startsWith("--verdicts="))
  .map((argument) => argument.slice("--verdicts=".length));
const limit = Number(argValue("limit", "0")) || 0;
const calibrationPath = argValue("calibration", "");
const preRegistrationPath = argValue("preregistration", "");
const legacyBiasPath = argValue("judge-bias", "");
const useIndex = Number(argValue("use-index", "0")) || 0;
const preRegisteredN = Number(argValue("preregistered-n", "0")) || 0;
const ciMethod = argValue("method", "bootstrap_percentile");
const rawMaxCost = argValue("max-cost-usd", "");
const maxCostUsd = rawMaxCost === "" ? null : Number(rawMaxCost);
// A cost ceiling is tested between calls, because tokens are only known once a
// response returns -- so one call whose worst case already breaches it does so
// with nothing able to intervene. Checked before dispatch instead.
const rawPerRequestMaxCost = argValue("per-request-max-cost-usd", "");
const perRequestMaxCostUsd =
  rawPerRequestMaxCost === "" ? null : Number(rawPerRequestMaxCost);
// Re-calling a pair that already carries a verdict spends money to overwrite
// an answer already paid for, so a resumed pass skips them.
const resumeRejudge = process.argv.includes("--resume");

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const ensureDirectory = (path) => {
  const directory = dirname(path);
  if (directory && directory !== "." && !existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
};

if (legacyBiasPath) {
  die(
    "--judge-bias=<path> is no longer accepted. Its own-answer preference rate mixes the two\n" +
      "models' quality difference with the judge's preference for its own output, so it cannot\n" +
      "settle docs/ops/tomverse-chat-router-evaluation-set.md §5. Run\n" +
      "--mode=judge-calibration against an independent judge and pass that artefact with\n" +
      "--calibration=<path>."
  );
}

if (!["pilot", "decision", "judge-bias", "judge-calibration"].includes(mode)) {
  die(`--mode must be pilot, decision, judge-bias or judge-calibration (got "${mode}").`);
}

// A pure analysis of two judging passes. It calls no provider and scores no
// run, so it exits here rather than through the set, pre-registration and
// billing machinery that a scoring run needs and this one has no use for.
if (mode === "judge-calibration") {
  if (verdictPaths.length !== 2) {
    die(
      "--mode=judge-calibration needs exactly two --verdicts=<path>: the judge under\n" +
        "test first, then the independent one it is compared against."
    );
  }
  const readPass = (path) => {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const header = lines.find((line) => line.kind === "header");
    if (!header) die(`${path} has no header line, so it is not a verdict file.`);
    return {
      path,
      identity: header.judge,
      bundleDigest: header.bundleDigest,
      answerIdentities: header.answerIdentities ?? [],
      bundleMode: header.bundleMode ?? null,
      evaluationSetVersion: header.evaluationSetVersion ?? null,
      evaluationSetPurpose: header.evaluationSetPurpose ?? null,
      bundlePairs: header.bundlePairs ?? null,
      bundlePlannedItems: header.bundlePlannedItems ?? null,
      judgeTemplateVersion: header.judgeTemplateVersion ?? null,
      verdicts: lines
        .filter((line) => line.kind === "verdict")
        .map((line) => ({ pairId: line.pairId, verdict: line.verdict })),
    };
  };
  const [target, reference] = verdictPaths.map(readPass);
  const problems = [
    ...calibrationProblems(target, reference, target.answerIdentities),
    // The digest proves both passes graded the same answers; it says nothing
    // about the provenance the two files claim for them. A disagreement here
    // is a hand-edited header, and the artefact would otherwise take the
    // target's version of it without saying so.
    ...["bundleMode", "evaluationSetVersion", "evaluationSetPurpose", "bundlePairs", "bundlePlannedItems"]
      .filter((field) => target[field] !== reference[field])
      .map(
        (field) =>
          `the two passes disagree about ${field}: ${JSON.stringify(target[field])} against ` +
          `${JSON.stringify(reference[field])}, over a bundle they agree on`
      ),
  ];
  if (problems.length > 0) {
    die(
      "\nThese two passes cannot be compared:\n\n" +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\n\nNothing was computed."
    );
  }
  const result = calibrateJudges(target, reference, { seed: seed || 1 });
  const pp = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`;
  console.log(`Judge calibration — ${result.targetJudge} against ${result.referenceJudge}`);
  console.log(`  pairs            ${result.pairs}`);
  console.log(`  exact agreement  ${(result.exactAgreementRate * 100).toFixed(1)}%`);
  console.log(`  baseline margin  target ${pp(result.targetBaselineMarginPp)}, reference ${pp(result.referenceBaselineMarginPp)}`);
  console.log(
    `  judge shift      ${pp(result.judgeShiftPp)}  95% CI [${pp(result.ci95LowerPp)}, ${pp(result.ci95UpperPp)}]  ` +
      `(paired bootstrap, seed ${result.seed})`
  );
  console.log("");
  console.log("  rows are the target judge's verdict, columns the reference judge's");
  console.log(`  ${"".padEnd(12)}${["auto", "baseline", "equivalent"].map((v) => v.padStart(11)).join("")}`);
  for (const row of ["auto", "baseline", "equivalent"]) {
    console.log(
      `  ${row.padEnd(12)}` +
        ["auto", "baseline", "equivalent"].map((column) => String(result.crossTab[row][column]).padStart(11)).join("")
    );
  }
  console.log(
    "\n  A positive shift means the target judge favours the baseline arm more than\n" +
      "  the reference judge does, over the same answers. That is disagreement\n" +
      "  between judges. Reading it as self-preference assumes the reference judge\n" +
      "  has no preference of its own between these models, which is an assumption\n" +
      "  and not a result -- human labels on a stratified sample are what settle it."
  );
  if (jsonPath) {
    // The numbers alone cannot be checked against the run that later cites
    // them, so the file carries what the check needs: whose bias this is
    // about, which answers were graded, whether the run producing them
    // finished, and which set they came from.
    const artefact = {
      ...result,
      targetIdentity: target.identity,
      referenceIdentity: reference.identity,
      answerIdentities: target.answerIdentities,
      bundleDigest: target.bundleDigest,
      bundlePairs: target.bundlePairs,
      bundlePlannedItems: target.bundlePlannedItems,
      bundleMode: target.bundleMode,
      evaluationSetVersion: target.evaluationSetVersion,
      evaluationSetPurpose: target.evaluationSetPurpose,
      judgeTemplateVersion: target.judgeTemplateVersion,
      producedAt: new Date().toISOString(),
      targetPath: target.path,
      referencePath: reference.path,
    };
    const artefactTrouble = calibrationArtefactProblems(artefact, {
      judgeIdentity: target.identity,
      judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
    });
    ensureDirectory(jsonPath);
    writeFileSync(jsonPath, `${JSON.stringify(artefact, null, 2)}\n`, "utf8");
    console.log(`\nWrote ${jsonPath}`);
    if (artefactTrouble.length > 0) {
      // Written either way -- the numbers are still the numbers -- but a
      // decision run will refuse it, and the operator finds that out now
      // rather than after paying for the decision run.
      console.log(
        "\nThis artefact will NOT be accepted by a decision run:\n" +
          artefactTrouble.map((problem) => `  - ${problem}`).join("\n")
      );
    }
  }
  process.exit(0);
}
if (maxCostUsd !== null && !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
  die(`--max-cost-usd must be a positive number (got "${rawMaxCost}").`);
}

let commitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const random = seededRandom(seed);
let accruedCostUsd = 0;
let truncatedByCost = false;

// Resolved once per model and role, and remembered. Two calls on the same
// model must ask for the same budget, and reading the profile fresh each time
// would let a mid-run change split a run into two conditions.
const resolvedLimits = new Map();
const callLimit = (model, callRole) => {
  const key = `${model.id}::${callRole}`;
  let limit = resolvedLimits.get(key);
  if (!limit) {
    limit = resolveCallLimit(model, callRole);
    resolvedLimits.set(key, limit);
  }
  return limit;
};

/**
 * The most one call can cost, if it fills its whole output budget.
 *
 * A cost ceiling can only stop a run *between* calls: the total is checked
 * after a response comes back, because that is when the tokens are known. So a
 * single call whose worst case already exceeds the run's ceiling can breach it
 * with nothing to stop it. That has to be refused before dispatch rather than
 * discovered afterwards.
 */
const perRequestWorstCaseCostUsd = (limit, promptTokens) =>
  (promptTokens * limit.inputUsdPerMillionTokens) / 1_000_000 +
  (limit.requestedMaxOutputTokens * limit.outputUsdPerMillionTokens) / 1_000_000;
// Frozen before the first paid call and written into the record, so a reader
// can tell what the Router was going to do rather than only what it did.
let routingPlan = null;
// Set when a provider refuses for a reason that will refuse every later call
// too -- an exhausted account balance. The run stops rather than spending its
// remaining items on a wall.
let budgetExhausted = null;
// Every arm answer that produced nothing usable, kept for the record as well
// as the journal. The gate in front of the paid judge reads its classification
// counts, so they have to survive into a file rather than only into a log.
const generationFailures = [];

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

/**
 * One provider call, as an outcome rather than a string.
 *
 * A failed call is billed the same as a successful one where the provider got
 * far enough to charge, so the cost is accrued on both paths: a total that
 * counted only the answers it kept would understate what the run spent.
 *
 * `arm` is passed in because the failure journal is useless without it -- "an
 * answer was empty" says nothing; "the auto arm on deepseek-v4-flash returned
 * 0 characters with finishReason=length" says what to look at.
 *
 * ## The output budget is resolved, not invented
 *
 * This used to send `maxOutputTokens: 2_048` for every model. The product asks
 * 128,000-384,000 for the same ones, and every model in the pre-registration
 * bills reasoning tokens out of that same budget -- so a reasoning model given
 * 2,048 can spend the whole allowance thinking and return no answer. That is
 * what emptied 60 auto-arm answers on 2026-08-28.
 *
 * So an answer call asks for what the product asks for, and a judge call asks
 * for a budget sized to a short structured verdict with its reasoning. The two
 * are separate on purpose: lib/routerCallLimits.ts holds both and the run
 * freezes what it resolved.
 */
const answer = async (model, prompt, arm) => {
  const startedAt = process.hrtime.bigint();
  const limit = callLimit(model, arm === "judge" ? "judge" : "answer");
  const identity = {
    arm,
    modelId: model.id,
    provider: model.provider,
    apiModel: model.apiModel,
    requestedMaxOutputTokens: limit.requestedMaxOutputTokens,
    resolvedProductOutputCap: limit.resolvedProductOutputCap,
  };
  let result;
  try {
    result = await generateText({
      model: getActiveAiModel(model),
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: limit.requestedMaxOutputTokens,
    });
  } catch (error) {
    return answerFailed("provider_error", String(error), {
      ...identity,
      finishReason: null,
      usage: {},
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      rawTextLength: 0,
      traceId: null,
    });
  }
  const usage = result.usage ?? {};
  accruedCostUsd += costMicroUsd(model, usage) / 1_000_000;
  return outcomeFromReply(
    {
      text: result.text,
      finishReason: result.finishReason ?? null,
      usage,
      // The provider's own handle on this response. An emptiness this run
      // cannot classify is reported with it, because it is what somebody would
      // have to quote to ask the provider what it actually sent.
      traceId: result.response?.id ?? null,
    },
    { ...identity, latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6 }
  );
};

// docs/ops/tomverse-chat-router-evaluation-set.md §6 lives in
// lib/routerJudgeRubric.ts, shared with the human review sheets:
// the model judges and the human reviewers have to grade against the same
// words for their agreement to mean anything. The judge sees two answers and
// no arm labels, no model ids and no routing reason.

// Grade a bundle that already exists. The answers are not regenerated and the
// display order is the one the bundle fixed, so the only thing that differs
// from the pass this will be compared against is who graded.
if (rejudgePath) {
  if (!judgeModelId) die("--judge=<model id> is required.");
  // --set is optional here and the bundle does not need it. When it is given,
  // it is checked: the two judges a calibration compares are pre-registered,
  // and picking either one at dispatch time is the drift pre-registration
  // exists to stop.
  if (setPath) {
    const registered = JSON.parse(readFileSync(setPath, "utf8"));
    const allowed = [registered.judge?.modelId, registered.independentJudge?.modelId].filter(Boolean);
    if (!allowed.includes(judgeModelId)) {
      die(
        `--judge=${judgeModelId}, but ${setPath} pre-registers ${allowed.join(" and ") || "no judge"}.\n` +
          "Either re-grade with a pre-registered judge, or pre-register the one you want first."
      );
    }
  }
  const parsed = parseAnswerBundle(readFileSync(rejudgePath, "utf8"));
  const problems = answerBundleProblems(parsed);
  if (problems.length > 0) {
    die(
      `\n${rejudgePath} cannot be judged:\n\n` +
        problems.slice(0, 10).map((problem) => `  - ${problem}`).join("\n") +
        (problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : "") +
        "\n\nNothing was sent and nothing was billed."
    );
  }
  const judge = getModel(judgeModelId);
  if (!judge) die(`Unknown judge model "${judgeModelId}".`);
  const identity = { modelId: judge.id, provider: judge.provider, apiModel: judge.apiModel };
  const answerIdentities = bundleAnswerIdentities(parsed);
  if (answerIdentities.includes(canonicalIdentity(identity))) {
    console.log(
      `NOTE: ${canonicalIdentity(identity)} wrote answers in this bundle, so this pass\n` +
        "grades its own output. That is a valid pass to run -- it is the one whose bias\n" +
        "is in question -- but it cannot be the independent side of a comparison."
    );
  }
  const out = jsonPath || `${rejudgePath}.${judge.id}.verdicts.jsonl`;
  ensureDirectory(out);
  const digest = bundleDigest(parsed);

  // A pass stopped at its ceiling has already paid for the verdicts it wrote,
  // and every one of them is on disk. Resuming re-reads them and skips those
  // pairs: calling them again would spend the same money twice to arrive at an
  // answer already held.
  const alreadyGraded = new Set();
  if (resumeRejudge && existsSync(out)) {
    const lines = readFileSync(out, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const header = lines.find((line) => line.kind === "header");
    // The verdicts have to be about the same answers, judged by the same
    // model. Resuming across either would silently splice two passes into one
    // file and call it a measurement.
    if (!header) die(`${out} exists but carries no header, so it cannot be resumed.`);
    if (header.bundleDigest !== digest) {
      die(
        `${out} was written against bundle ${header.bundleDigest}, not ${digest}.\n` +
          "Resuming across two different sets of answers would splice two passes into one file."
      );
    }
    if (header.judge?.modelId !== judge.id) {
      die(`${out} was judged by ${header.judge?.modelId}, not ${judge.id}. It cannot be resumed.`);
    }
    for (const line of lines) if (line.kind === "verdict") alreadyGraded.add(line.pairId);
    console.log(
      `Resuming: ${alreadyGraded.size} pair(s) already carry a verdict and will not be called again.`
    );
  } else if (existsSync(out) && readFileSync(out, "utf8").trim() !== "") {
    // Never silently. Overwriting a verdict file discards judgements that were
    // paid for, and a run that meant to resume and did not would pay twice.
    die(
      `${out} already holds verdicts. Pass --resume to continue that pass, or name a\n` +
        "different --json path. Overwriting it would discard judgements already paid for."
    );
  }

  if (alreadyGraded.size === 0) writeFileSync(
    out,
    `${JSON.stringify({
      kind: "header",
      judge: identity,
      bundleDigest: digest,
      bundlePath: rejudgePath,
      answerIdentities,
      // Carried through from the bundle so a calibration built from two
      // verdict files can say which set the answers came from and whether the
      // run that produced them finished, without holding the bundle.
      bundleMode: parsed.header.mode,
      evaluationSetVersion: parsed.header.evaluationSetVersion,
      evaluationSetPurpose: parsed.header.evaluationSetPurpose,
      bundlePairs: parsed.entries.length,
      bundlePlannedItems: parsed.header.plannedItems,
      judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
      rejudgedAt: new Date().toISOString(),
      commitSha,
    })}\n`,
    "utf8"
  );
  // Before the first call. The per-request ceiling cannot be enforced by the
  // running total, so the largest request this bundle can produce is priced
  // against it here and refused if it does not fit.
  const judgeLimit = callLimit(judge, "judge");
  if (perRequestMaxCostUsd !== null) {
    const worstRendered = Math.max(
      0,
      ...parsed.entries.map((pair) =>
        estimateRawTextTokens(judgePrompt(pair.prompt ?? "", pair.first?.text ?? "", pair.second?.text ?? ""))
      )
    );
    const worstCase = perRequestWorstCaseCostUsd(judgeLimit, worstRendered);
    if (worstCase > perRequestMaxCostUsd) {
      die(
        `\nOne judge request can cost $${worstCase.toFixed(4)}, over the ` +
          `$${perRequestMaxCostUsd} per-request ceiling.\n\n` +
          `  largest rendered judge input: ${worstRendered} token(s)\n` +
          `  output budget:                ${judgeLimit.requestedMaxOutputTokens} token(s)\n\n` +
          "A cost ceiling is tested between calls, so it cannot stop this one. Nothing was billed.\n"
      );
    }
    console.log(
      `Worst single judge request $${worstCase.toFixed(4)} of $${perRequestMaxCostUsd} allowed.`
    );
  }

  console.log(`Re-judging ${parsed.entries.length} pair(s) from ${rejudgePath} with ${judge.id}`);
  let graded = alreadyGraded.size;
  let stoppedByCost = false;
  for (const [index, pair] of parsed.entries.entries()) {
    // Paid for already. Calling it again buys the same verdict twice.
    if (alreadyGraded.has(pair.pairId)) continue;
    // The ceiling applies here too, and this is the stage where it matters:
    // an independent judge can cost an order of magnitude more per call than
    // the run that produced the answers.
    if (maxCostUsd !== null && accruedCostUsd >= maxCostUsd) {
      stoppedByCost = true;
      console.log(
        `\nStopped at pair ${index} — cost ceiling $${maxCostUsd} reached.\n` +
          `  ${graded} verdict(s) are on disk in ${out} and are not lost.\n` +
          "  Resume with the same --json path and --resume; the pairs already graded will not\n" +
          "  be called again."
      );
      break;
    }
    let text;
    try {
      const judgement = await answer(judge, judgePrompt(pair.prompt, pair.first.text, pair.second.text), "judge");
      if (judgement.status === "failed") {
        console.log(`\n  ${pair.pairId}: judge failed — ${judgement.reason}: ${judgement.detail}`);
        continue;
      }
      text = judgement.text;
    } catch (error) {
      console.log(`\n  ${pair.pairId}: judge failed — ${String(error)}`);
      continue;
    }
    const verdictWord = readVerdict(text);
    if (verdictWord === null) {
      console.log(`\n  ${pair.pairId}: no recognisable verdict`);
      continue;
    }
    // Back to arm terms, using the order the bundle fixed rather than a
    // position this pass chose.
    const firstArm = pair.first.arm;
    const arm =
      verdictWord === "equivalent"
        ? "equivalent"
        : (verdictWord === "first") === (firstArm === "auto")
          ? "auto"
          : "baseline";
    appendFileSync(out, `${JSON.stringify({ kind: "verdict", pairId: pair.pairId, verdict: arm })}\n`, "utf8");
    graded += 1;
    process.stdout.write(arm === "auto" ? "+" : arm === "baseline" ? "-" : ".");
    if (graded % 10 === 0 || index === parsed.entries.length - 1) {
      console.log(`  ${graded}/${parsed.entries.length}  $${accruedCostUsd.toFixed(4)}`);
    }
  }
  console.log(`\nWrote ${out} — ${graded} verdict(s), $${accruedCostUsd.toFixed(4)}`);
  // A pass that stopped at its ceiling covers whatever prefix the money
  // reached, which is not a population. A pass that merely lost a few pairs to
  // unreadable verdicts is a structural shortfall, and the calibration
  // tolerates it up to the same floor lib/routerJudgeCalibration.ts uses --
  // exiting non-zero there would stop a run that is still usable.
  const coverage = parsed.entries.length === 0 ? 0 : graded / parsed.entries.length;
  if (stoppedByCost) {
    console.log(
      `Stopped at the cost ceiling, so this pass covers a prefix rather than the bundle. ` +
        "It cannot be calibrated against."
    );
    process.exit(1);
  }
  if (coverage < CALIBRATION_MIN_COVERAGE) {
    console.log(
      `Only ${(coverage * 100).toFixed(1)}% of the bundle carries a verdict, under the ` +
        `${(CALIBRATION_MIN_COVERAGE * 100).toFixed(0)}% floor a calibration needs.`
    );
    process.exit(1);
  }
  process.exit(0);
}

// Everything below needs the evaluation set. The two modes above do not:
// a calibration reads two verdict files and a rejudge reads a bundle, and
// asking either for a baseline and a seed is asking for the arguments of a
// run that is not happening. The bundle carries the set version, the
// purpose, the seed and the rubric its answers were produced under.
if (!setPath) die("--set=<path to the evaluation set JSON> is required.");
if (!baselineModelId) die("--baseline=<model id> is required and must be pre-registered.");
if (!judgeModelId) die("--judge=<model id> is required.");
if (!seed) {
  die(
    `--seed=<integer> is required: ${"docs/ops/tomverse-chat-router-evaluation-set.md"} §9 records it so the run can be replayed.`
  );
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

// docs/ops/tomverse-chat-router-evaluation-set.md §5. An answer that names its own
// model defeats the blinding, and the
// procedure says such an item is excluded and logged rather than quietly
// scrubbed -- a scrub changes the answer the judge grades.
const selfIdMarkers = selfIdentificationMarkers(routableModelIds);
const judgeIsRoutable = routableModelIds.includes(judgeModelId);

// docs/ops/tomverse-chat-router-evaluation-set.md §4. The baseline the run compares
// against has to be the one the set
// pre-registered; a baseline supplied on the command line that disagrees with
// the frozen record is the comparison being chosen at run time.
if (evaluationSet.baseline && evaluationSet.baseline.modelId !== baselineModelId) {
  die(
    `The set pre-registered "${evaluationSet.baseline.modelId}" as the baseline; ` +
      `--baseline=${baselineModelId} would compare against a different one.`
  );
}

let judgeCalibration = null;
if (calibrationPath) {
  judgeCalibration = JSON.parse(readFileSync(calibrationPath, "utf8"));
}
if (mode === "judge-bias") {
  if (!judgeIsRoutable) {
    die(
      `"${judgeModelId}" is not a routable model, so it has no output of its own in the ` +
        "set to prefer. docs/ops/tomverse-chat-router-evaluation-set.md §5 asks for this " +
        "measurement only where the judge is one of the " +
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
    die(
      "--preregistered-n is required in decision mode.\n" +
        "docs/ops/tomverse-chat-router-evaluation-set.md §3 fixes n before the run, from a measured pilot."
    );
  }
  if (!useIndex) {
    die(
      "--use-index is required in decision mode.\n" +
        "docs/ops/tomverse-chat-router-evaluation-set.md §7: every look at the decision set costs a use, " +
        "and a second run against the same frozen set reports how well the Router fits its own test set."
    );
  }
  if (!preRegistrationPath) {
    die(
      "--preregistration=<path> is required in decision mode. `n` is fixed before the run and\n" +
        "conditional on things that have to have happened; the file says which, and the run is\n" +
        "refused until they have."
    );
  }
  {
    // Checked before anything is sent. A decision run that discovers its `n`
    // was never activated has paid for a report nobody can cite.
    const registration = JSON.parse(readFileSync(preRegistrationPath, "utf8"));
    const trouble = decisionRunProblems(registration, {
      preRegisteredN: preRegisteredN,
      routerVersions: ROUTER_VERSIONS,
      corpusDigest: evaluationSet.frozenDigest,
    });
    if (trouble.length > 0) {
      die(
        `\n${preRegistrationPath} does not authorise this run:\n\n` +
          trouble.map((problem) => `  - ${problem}`).join("\n") +
          "\n\nNothing was sent and nothing was billed."
      );
    }
  }
  if (judgeIsRoutable) {
    if (!judgeCalibration) {
      die(
        `The judge "${judgeModelId}" is itself routable, so ` +
          "docs/ops/tomverse-chat-router-evaluation-set.md §5 requires a calibration against an\n" +
          "independent judge. Run --mode=judge-calibration and pass its artefact with\n" +
          "--calibration=<path>."
      );
    }
    // Checked here, before anything is sent, rather than at report time: a
    // decision run that discovers its calibration is the wrong one after
    // paying for the run has paid for a report nobody can cite.
    const trouble = calibrationArtefactProblems(judgeCalibration, {
      judgeIdentity: {
        modelId: judgeModel.id,
        provider: judgeModel.provider,
        apiModel: judgeModel.apiModel,
      },
      judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
      evaluationSetPurpose: evaluationSet.purpose,
    });
    if (trouble.length > 0) {
      die(
        `\n${calibrationPath} cannot be cited by this run:\n\n` +
          trouble.map((problem) => `  - ${problem}`).join("\n") +
          "\n\nNothing was sent and nothing was billed."
      );
    }
  }
}


/**
 * The output cap the Router is asked to route for.
 *
 * Not the selected model's cap, and not a constant. The product resolves this
 * *before* the Router runs, from the model the user asked for -- the Router's
 * window arithmetic then decides which candidates have room for an answer that
 * size. In this protocol the baseline is the model the user asked for, so its
 * product cap is the honest input.
 *
 * It used to be a hardcoded 2,048. That made the harness route as though it
 * were asking for a 2,048-token answer and then ask for the product's cap --
 * two different questions in one run, and the routing half was the one the
 * product never asks. Fixing it is a repair, not a change of what is measured.
 *
 * The answer call is separate and stays separate:
 * `resolveCallLimit(selectedAutoModel, "answer")` is what the auto arm
 * actually requests, so the Router can route for Luna's 128,000 and DeepSeek
 * can then answer under its own 384,000 -- which is what the product does.
 */
const routerRequestOutputCapTokens = resolveModelPricing(baselineModel).maxOutputTokens;

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
    requestOutputCapTokens: routerRequestOutputCapTokens,
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
// A rebuild reads its pairs from the journal, so the provider loop has nothing
// to iterate. Everything after the loop is unchanged and unaware of which of
// the two produced the pairs.
const liveItems = fromJournalPath ? [] : planned;

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

/**
 * The generation failures, counted the way the gate asks about them.
 *
 * `harnessAttributableFailureCount` is the one that stops a paid judge: a run
 * carrying any of them measured this harness, so its answers are not a
 * measurement of the models and a calibration over them is worth nothing.
 *
 * The undetermined ones are reported per failure rather than only counted,
 * because arm, provider, API model, finish reason, usage and trace id are what
 * somebody would need to go and settle the cause. The harness-attributable
 * ones are reported the same way, and for a better reason: they are the ones
 * somebody has to fix.
 */
const summariseGenerationFailures = (failures) => {
  const byReason = {};
  for (const reason of EMPTINESS_REASONS) byReason[reason] = 0;
  const byAttribution = {};
  for (const attribution of FAILURE_ATTRIBUTIONS) byAttribution[attribution] = 0;
  let providerErrors = 0;
  for (const failure of failures) {
    if (failure.emptinessReason === null) providerErrors += 1;
    else byReason[failure.emptinessReason] += 1;
    byAttribution[failure.attribution] += 1;
  }
  const detailOf = (failure) => ({
    arm: failure.arm,
    callRole: failure.callRole,
    modelId: failure.modelId,
    provider: failure.provider,
    apiModel: failure.apiModel,
    finishReason: failure.finishReason,
    normalizedFinishReason: failure.normalizedFinishReason,
    usage: failure.usage,
    billedOutputTokens: failure.billedOutputTokens,
    requestedMaxOutputTokens: failure.requestedMaxOutputTokens,
    resolvedProductOutputCap: failure.resolvedProductOutputCap,
    traceId: failure.traceId,
    emptinessReason: failure.emptinessReason,
    attribution: failure.attribution,
  });
  return {
    total: failures.length,
    providerErrors,
    byReason,
    byAttribution,
    harnessAttributableFailureCount: byAttribution.harness,
    // Both lists, because they are read by different people for different
    // reasons: one is the bug report, the other is the open question.
    harnessAttributable: failures.filter(isHarnessAttributable).map(detailOf),
    undetermined: failures
      .filter((failure) => failure.attribution === "undetermined")
      .map(detailOf),
  };
};

// The run's own start, taken before the first request rather than after the
// last. `evaluationRecordProblems` refuses a baseline pre-registered after the
// run began, and a `startedAt` stamped at the end weakens exactly that check.
let startedAt = new Date().toISOString();

/**
 * Append one line to the journal.
 *
 * Append-only and synchronous on purpose. The artefact is written once, at the
 * end, after 630 provider calls -- so a run killed at 629 paid for everything
 * and recorded nothing. A line per pair survives a SIGTERM, a runner timeout
 * and a hard kill alike, because the bytes are already on disk when the next
 * call starts.
 */
const journal = (entry) => {
  if (!journalPath) return;
  ensureDirectory(journalPath);
  appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
};

// A single character per item never reaches a CI log. The runner flushes on
// newline, so 210 characters sit in one unfinished line and go with the
// process when it is killed -- the first pilot ran for 89 minutes and printed
// not one of them, which is also why watching for a run of "x" could not have
// worked. A counted line every so often flushes what came before it.
const PROGRESS_EVERY = 10;

/**
 * Append one line to the answer bundle.
 *
 * Separate from the journal because they answer different questions: the
 * journal is what this run scored, the bundle is what a judge was shown. Only
 * the bundle can be re-judged, and only the journal can rebuild this run's own
 * report.
 */
const bundle = (entry) => {
  if (!bundlePath) return;
  ensureDirectory(bundlePath);
  appendFileSync(bundlePath, `${JSON.stringify(entry)}\n`, "utf8");
};

const recordPair = (pair, mark, excluded = null) => {
  pairs.push(pair);
  if (excluded) excludedLog.push(excluded);
  journal({ kind: "pair", pair, excluded, accruedCostUsd });
  process.stdout.write(mark);
  if (pairs.length % PROGRESS_EVERY === 0 || pairs.length === planned.length) {
    console.log(`  ${pairs.length}/${planned.length}  $${accruedCostUsd.toFixed(4)}`);
  }
};

// Frozen before anything runs, and written into both the journal and the
// report. Reading the pricing profile at call time is not enough on its own: a
// table edit between two runs would silently change what the same pilot asked
// for, and nothing downstream could tell that the question had changed.
//
// Every model the run can reach is resolved, not only the ones it happens to
// route to, so the manifest describes the run's whole surface rather than the
// path it took.
const selectableModels = AVAILABLE_MODELS.filter((model) => model.enabled);
const callLimitManifest = buildCallLimitManifest([
  ...selectableModels.map((model) => ({ model, callRole: "answer" })),
  { model: baselineModel, callRole: "answer" },
  { model: judgeModel, callRole: "judge" },
]);
const manifestTrouble = callLimitManifestProblems(callLimitManifest);
if (manifestTrouble.length > 0) {
  die(
    "\nThe call-limit manifest cannot be frozen:\n\n  - " +
      manifestTrouble.join("\n  - ") +
      "\n\nNothing was sent and nothing was billed.\n"
  );
}
for (const entry of callLimitManifest.entries) {
  resolvedLimits.set(`${entry.modelId}::${entry.callRole}`, entry);
}

// The per-request bound is NOT applied here, over every model the catalogue
// offers. That was the first version and it was wrong: it priced a
// claude-fable-5 answer at $6.40 and refused a $2.00 pilot, for a model the
// Router never selects and this harness would never call. A cost bound
// belongs on the executable call manifest -- the models this run will send a
// prompt to -- which is what the frozen routing plan below carries.

journal({ kind: "call-limit-manifest", manifest: callLimitManifest });

// Everything the Router would choose, decided before anything is paid for.
//
// The routing decision is deterministic given the item and the frozen seed, so
// the conflict this checks for can be settled for nothing: claude-fable-5 is
// the pre-registered independent judge AND an Auto candidate, and if the
// Router picks it for even one item the independent judge grades its own
// answer on that pair.
//
// It aborts rather than re-routing. Dropping the judge from the candidate set
// and routing again would measure a Router the product does not have, and
// swapping to claude-opus-4-8 only moves the conflict, because that is an Auto
// candidate too. The conflict is between the pre-registration and the
// catalogue, and resolving it is a decision rather than a dispatch-time
// workaround.
// Not on a rebuild: `--from-journal` reports what a finished run recorded and
// sends nothing, so there is no call to guard and no plan to freeze. Routing
// again there would also re-decide with today's catalogue and report it as the
// plan of a run that happened under an older one.
if (mode !== "judge-bias" && !fromJournalPath) {
  const planEntries = planned.map((item) => {
    const decision = decideRouterModel(routerInputFor(item));
    return {
      itemId: item.id,
      outcome: decision.outcome,
      selectedModelId: decision.outcome === "selected" ? decision.modelId : null,
      // The rest of the Router's ranking. This harness never calls them --
      // a failed answer is recorded and the pair excluded, never retried down
      // the ranking -- so they are recorded for audit and are not answer
      // authors. lib/routerRoutingPlan.ts holds that scoping in one constant.
      rankedAlternatesNonExecutable:
        decision.outcome === "selected" ? [...decision.fallbackCandidateModelIds] : [],
    };
  });
  routingPlan = freezeRoutingPlan(
    planEntries,
    baselineModelId,
    (id) => {
      const model = getModel(id);
      return model ? { provider: model.provider, apiModel: model.apiModel } : null;
    },
    selectableModels.map((model) => model.id)
  );
  journal({ kind: "routing-plan", plan: routingPlan });

  const independentJudgeId = evaluationSet.independentJudge?.modelId;
  const independentJudge = independentJudgeId ? getModel(independentJudgeId) : null;
  if (!independentJudge) {
    die(
      `\n${setPath} pre-registers no usable independentJudge, so whether the Router would hand it\n` +
        "its own answers cannot be checked. Nothing was sent and nothing was billed.\n"
    );
  }
  const worstPromptTokens = Math.max(
    0,
    ...planned.map((item) => estimateRawTextTokens(item.prompt ?? ""))
  );
  const planTrouble = routingPlanProblems(routingPlan, {
    expectedItems: planned.length,
    independentJudge: {
      provider: independentJudge.provider,
      apiModel: independentJudge.apiModel,
      modelId: independentJudge.id,
    },
    perRequestMaxCostUsd: perRequestMaxCostUsd ?? PILOT_PER_REQUEST_MAX_COST_USD,
    limitFor: (id) => {
      const model = getModel(id);
      return model ? callLimit(model, "answer") : null;
    },
    worstPromptTokens,
  });
  if (planTrouble.length > 0) {
    die(
      "\nThe frozen routing plan cannot be run:\n\n  - " +
        planTrouble.join("\n  - ") +
        "\n\nNothing was sent and nothing was billed.\n"
    );
  }
  const limitOf = (id) => {
    const model = getModel(id);
    return model ? callLimit(model, "answer") : null;
  };
  console.log(
    `Routing plan frozen — ${routingPlan.plannedItems} item(s), routed for a ` +
      `${routerRequestOutputCapTokens}-token answer (${baselineModelId}'s product cap).`
  );
  console.log(
    `  the independent judge (${independentJudge.id}) authors no answer this run will make`
  );
  for (const row of executableCallManifest(routingPlan)) {
    console.log(`  will call  ${row.modelId.padEnd(24)} ${row.calls} time(s)  (${row.identity})`);
  }
  console.log(
    `  worst planned answer request $${maxPlannedAnswerRequestCostUsd(routingPlan, limitOf, worstPromptTokens).toFixed(4)}` +
      ` of $${(perRequestMaxCostUsd ?? PILOT_PER_REQUEST_MAX_COST_USD).toFixed(2)} allowed`
  );
}

bundle({
  kind: "header",
  bundleVersion: ANSWER_BUNDLE_VERSION,
  mode,
  evaluationSetVersion: evaluationSet.version,
  // Written before anything runs, so a bundle that stopped at its cost
  // ceiling is one whose entry count falls short of what it planned. A header
  // cannot be amended afterwards, and the run that dies early is exactly the
  // one that never gets to amend it.
  evaluationSetPurpose: evaluationSet.purpose,
  plannedItems: planned.length,
  commitSha,
  seed,
  judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
  createdAt: startedAt,
});

journal({
  kind: "header",
  mode,
  setPath,
  evaluationSetVersion: evaluationSet.version,
  evaluationSetPurpose: evaluationSet.purpose,
  commitSha,
  baselineModelId,
  judgeModelId,
  seed,
  ciMethod,
  plannedItems: planned.length,
  startedAt,
});

// The interruption this exists for. Node's default SIGTERM handling exits
// without running anything, so the message that tells a reader the journal is
// there -- and that the run was killed rather than finished -- has to be
// installed explicitly.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    journal({ kind: "stopped", reason: signal.toLowerCase(), completedItems: pairs.length });
    console.log(
      `\n\n${signal} at ${pairs.length}/${planned.length} item(s). ` +
        `$${accruedCostUsd.toFixed(4)} spent.` +
        (journalPath
          ? `\nThe journal has every pair up to here:\n  ${journalPath}\n` +
            `Rebuild a report from it with --from-journal=${journalPath}`
          : "\nNo --json path was given, so nothing was journalled and the spend bought nothing.")
    );
    process.exit(1);
  });
}

for (const [index, item] of liveItems.entries()) {
  if (maxCostUsd !== null && accruedCostUsd >= maxCostUsd) {
    truncatedByCost = true;
    journal({ kind: "stopped", reason: "cost-ceiling", completedItems: pairs.length });
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
    recordPair({ ...base, outcome: { status: "excluded", reason } }, "x", {
      itemId: item.id,
      reason,
      detail: detail ?? null,
    });
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

  // Both arms are asked before either outcome is inspected. Skipping the
  // second call once the first came back empty would make the failure journal
  // silent about an arm nobody asked, and "the baseline was not called" is not
  // the same finding as "the baseline answered".
  const autoAnswer = await answer(autoModel, item.prompt, "auto");
  const baselineAnswer = await answer(baselineModel, item.prompt, "baseline");

  for (const outcome of [autoAnswer, baselineAnswer]) {
    if (outcome.status !== "failed") continue;
    const failure = failureRecord(outcome);
    generationFailures.push(failure);
    journal(failure);
    // A balance that has run out does not come back mid-run. Continuing turns
    // one failed item into every remaining item, which is how three pairs at
    // the end of the 2026-08-28c pilot took long_context_conversation/ko from
    // 14 to 11 and voided a run that had otherwise measured cleanly.
    if (failure.haltsRun) budgetExhausted = failure;
  }
  if (budgetExhausted) {
    exclude(
      `${budgetExhausted.arm}_arm_failed`,
      `${budgetExhausted.providerErrorReason}: ${budgetExhausted.detail}`
    );
    break;
  }

  // mposition's ruling. An empty answer is a real failure for the person who
  // asked, so it is recorded as that arm losing rather than dropped -- dropping
  // it would delete an arm's worst turns from the comparison and flatter
  // whichever arm fails less gracefully. No judge is called: there is nothing
  // to compare an answer against nothing.
  // The judge below is reachable only through `action: "judge"`, which
  // lib/routerQualityEvalCore.ts returns only when both arms produced text.
  const pairDecision = decidePairFromAnswers(autoAnswer, baselineAnswer);
  if (pairDecision.action === "exclude") {
    exclude(pairDecision.reason, pairDecision.detail);
    continue;
  }

  if (
    identifiesItself(autoAnswer.text, selfIdMarkers) ||
    identifiesItself(baselineAnswer.text, selfIdMarkers)
  ) {
    exclude("self_identified");
    continue;
  }

  const bundledSide = (arm, model, text) => ({
    arm,
    modelId: model.id,
    provider: model.provider,
    apiModel: model.apiModel,
    text,
    digest: sha256(text),
  });
  const autoSide = bundledSide("auto", autoModel, autoAnswer.text);
  const baselineSide = bundledSide("baseline", baselineModel, baselineAnswer.text);
  const [firstSide, secondSide] =
    base.autoPosition === "first" ? [autoSide, baselineSide] : [baselineSide, autoSide];
  const [first, second] = [firstSide.text, secondSide.text];

  // Written before the judge is called. A judge failure excludes the pair from
  // the score, but the answers were still paid for and a later pass can still
  // grade them.
  bundle({
    kind: "pair",
    pairId: item.id,
    stratum: item.stratum,
    cell: item.cell,
    prompt: item.prompt,
    first: firstSide,
    second: secondSide,
  });

  let verdict;
  try {
    const judgement = await answer(judgeModel, judgePrompt(item.prompt, first, second), "judge");
    verdict = judgement.status === "ok" ? readVerdict(judgement.text) : null;
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

  recordPair(
    { ...base, outcome: { status: "judged", verdict: arm } },
    arm === "auto" ? "+" : arm === "baseline" ? "-" : "."
  );
}

let stoppedReason = budgetExhausted
  ? "provider-budget-exhausted"
  : truncatedByCost
    ? "cost-ceiling"
    : "completed";
// The loop only journalled a stop record when something stopped it early, so a
// journal that ran to the end looked exactly like one that was cut off — the
// first real run rebuilt as "journal-ends-without-a-stop-record" despite having
// finished. A journal has to say which of the two it is.
if (!fromJournalPath && liveItems.length > 0) {
  journal({ kind: "stopped", reason: stoppedReason, completedItems: pairs.length });
}
// How many items the run that produced these pairs set out to do. On a rebuild
// that is the journal's number, not this invocation's: the set may hold 210
// while the journal came from a run of 4.
let plannedItems = planned.length;

if (fromJournalPath) {
  // A rebuild reports what the journal holds and nothing more. It never
  // reaches a provider, so it cannot fill a gap the interrupted run left.
  const lines = readFileSync(fromJournalPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const header = lines.find((entry) => entry.kind === "header");
  if (!header) die(`${fromJournalPath} has no header line, so it is not a run journal.`);
  if (header.seed !== seed || header.baselineModelId !== baselineModelId || header.judgeModelId !== judgeModelId) {
    die(
      `${fromJournalPath} was written by a different run:\n` +
        `  journal: baseline ${header.baselineModelId}, judge ${header.judgeModelId}, seed ${header.seed}\n` +
        `  asked:   baseline ${baselineModelId}, judge ${judgeModelId}, seed ${seed}`
    );
  }
  for (const entry of lines) {
    if (entry.kind !== "pair") continue;
    pairs.push(entry.pair);
    if (entry.excluded) excludedLog.push(entry.excluded);
    accruedCostUsd = entry.accruedCostUsd ?? accruedCostUsd;
  }
  // The report names the run that spent the money, not the machine rebuilding
  // it. Taking these from the rebuild would put a different commit and a later
  // clock against pairs it did not produce, and the pre-registration check
  // reads startedAt.
  if (header.commitSha) commitSha = header.commitSha;
  if (header.startedAt) startedAt = header.startedAt;
  if (typeof header.plannedItems === "number") plannedItems = header.plannedItems;
  const stopped = lines.find((entry) => entry.kind === "stopped");
  stoppedReason = stopped ? stopped.reason : "journal-ends-without-a-stop-record";
  truncatedByCost = stopped?.reason === "cost-ceiling";
  console.log(
    `Rebuilt from ${fromJournalPath}: ${pairs.length} of ${plannedItems} planned item(s), ` +
      `stopped by ${stoppedReason}.`
  );
}

console.log("\n");

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

// Two estimates of two different things, reported together because either one
// alone is misleading. The quality delta answers "when both arms answered,
// which answer was better"; the end-to-end delta answers "which arm served the
// person", and counts an arm that produced nothing as losing that pair.
const accounting = pairAccounting(pairs);
const accountingTrouble = pairAccountingProblems(accounting);
if (accountingTrouble.length > 0) {
  die(`\nThe pair accounting does not add up:\n\n  - ${accountingTrouble.join("\n  - ")}\n`);
}
const endToEndDelta = computeWinRateDelta(pairs, {
  method: ciMethod,
  seed,
  score: outcomeScore,
});

console.log(`Outcome        ${verdict.outcome.toUpperCase()}`);
for (const reason of verdict.reasons) console.log(`  - ${reason}`);
console.log("");
console.log(
  `Pairs          ${accounting.total} = ${accounting.judgeable} judgeable + ` +
    `${accounting.singleArmFailure} single-arm failure + ${accounting.doubleArmFailure} double-arm failure + ` +
    `${accounting.otherExclusions} other`
);
console.log("");
console.log(`Judged pairs   ${verdict.delta.n}  (auto ${verdict.delta.wins} / baseline ${verdict.delta.losses} / equivalent ${verdict.delta.ties})`);
console.log(`Discordance    ${pct(verdict.delta.discordanceRate)}`);
console.log(
  `semanticQualityDelta   ${pp(verdict.delta.pointEstimatePp)}  95% CI [${pp(verdict.delta.ci95LowerPp)}, ${pp(verdict.delta.ci95UpperPp)}]` +
    `  over ${verdict.delta.n} pair(s) both arms answered`
);
console.log(
  `endToEndOutcomeDelta   ${pp(endToEndDelta.pointEstimatePp)}  95% CI [${pp(endToEndDelta.ci95LowerPp)}, ${pp(endToEndDelta.ci95UpperPp)}]` +
    `  over ${endToEndDelta.n} pair(s), an arm that produced nothing losing`
);
console.log(`               (${verdict.delta.method}, seed ${seed})`);
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

// Printed even when it is all zeros, because "nothing was attributable to this
// harness" is the finding that lets the run be spent on, and a line that
// appears only on trouble cannot be read as saying that.
{
  const summary = summariseGenerationFailures(generationFailures);
  // Worded to what was observed, not to a cause. The earlier version of this
  // line claimed the answers "existed and this code holds none of them", which
  // named a mechanism the data did not carry -- an answer whose budget was
  // spent on reasoning was never written in the first place.
  console.log(
    `Empty answers  ${summary.total} empty-text result(s) were observed after normalization;\n` +
      "               their causes require finish-reason and usage attribution."
  );
  console.log(
    `  by reason    ${EMPTINESS_REASONS.map((reason) => `${reason} ${summary.byReason[reason]}`).join(", ")}` +
      `, provider_error ${summary.providerErrors}`
  );
  console.log(
    `  by blame     ${FAILURE_ATTRIBUTIONS.map((who) => `${who} ${summary.byAttribution[who]}`).join(", ")}`
  );
  const line = (label, failure) =>
    console.log(
      `  ${label} ${failure.arm}/${failure.callRole} ${failure.provider}/${failure.apiModel}` +
        ` finishReason=${failure.finishReason ?? "none"}(${failure.normalizedFinishReason ?? "none"})` +
        ` billedOutput=${failure.billedOutputTokens ?? "none"}` +
        ` requested=${failure.requestedMaxOutputTokens ?? "none"}` +
        ` productCap=${failure.resolvedProductOutputCap ?? "none"}` +
        ` usage=${JSON.stringify(failure.usage)} traceId=${failure.traceId ?? "none"}`
    );
  // The ones somebody has to fix, and the ones somebody has to settle. Both
  // per failure: a count cannot be acted on.
  for (const failure of summary.harnessAttributable) line("harness     ", failure);
  for (const failure of summary.undetermined) line("undetermined", failure);
  if (budgetExhausted) {
    console.log(
      `\nPROVIDER BUDGET EXHAUSTED — ${budgetExhausted.provider} refused at pair ` +
        `${pairs.length}/${planned.length} (${budgetExhausted.providerErrorReason}).\n` +
        "  The run stopped there rather than spending its remaining items on a wall: the balance\n" +
        "  does not come back mid-run, so every later call would have failed the same way.\n" +
        "  This is an operational failure, not the provider's and not the models' — it is fixed by\n" +
        "  topping the account up, and the run has to start again from the beginning."
    );
  }
  if (summary.harnessAttributableFailureCount > 0) {
    console.log(
      `\nHARNESS DEFECT — ${summary.harnessAttributableFailureCount} empty result(s) are attributable\n` +
        "to this harness. That makes the run a measurement of the harness rather than of the\n" +
        "models, so it is void and nothing downstream may be paid for on the strength of it."
    );
  }
}

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

// How often the judge's own answer won, when the judge's model was the Auto
// arm. Named for what it counts and nothing more: it mixes the two models'
// real quality difference with the judge's preference for its own output, and
// 50% is only "no self-preference" if the two models are equally good, which
// nothing here establishes. --mode=judge-calibration is the measurement that
// separates them.
const ownAnswerPreferenceRate =
  verdict.delta.discordantPairs === 0
    ? Number.NaN
    : verdict.delta.wins / verdict.delta.discordantPairs;

if (mode === "judge-bias") {
  console.log("");
  console.log(
    `Own-answer preference ${pct(ownAnswerPreferenceRate)} of decided pairs went to ${judgeModelId}'s own answer`
  );
  console.log(
    "  This is NOT a self-preference measurement. It mixes the two models' real\n" +
      "  quality difference with the judge's preference for its own output, and 50%\n" +
      "  reads as \"no self-preference\" only if the two models are equally good.\n" +
      "  --mode=judge-calibration compares two judges over the same answers, which\n" +
      "  is the comparison that can separate them.\n" +
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
  // Both estimates in the record, not only the one in the headline. A reader
  // who sees a quality delta over 179 pairs and a total of 210 has to be able
  // to find out where the other 31 went, and what they did to the number that
  // describes what the person received.
  pairAccounting: accounting,
  semanticQualityDelta: verdict.delta,
  endToEndOutcomeDelta: endToEndDelta,
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
            ownAnswerPreferenceRate,
            evaluationSetVersion: evaluationSet.version,
            seed,
          }
        : judgeCalibration,
  },
  exclusions: excludedLog,
  truncatedByCost,
  // What the run actually covered, so a partial report says so in the file
  // rather than only in the console output nobody kept. `truncatedByCost`
  // answers one of the ways a run stops; this answers all of them.
  plannedItems,
  completedItems: pairs.length,
  stoppedReason,
  // What the gate in front of the paid judge reads. Summary counts rather than
  // the raw lines, because the gate asks three questions of them and a reader
  // asking a fourth has the journal.
  generationFailureSummary: summariseGenerationFailures(generationFailures),
  // What every call was allowed to ask for, frozen before the run started. The
  // gate reads it, and a later reader can tell whether two runs asked the same
  // question or merely share a label.
  callLimitManifest,
  // What the Router planned, and the check that the independent judge is not
  // among the models that would have answered.
  routingPlan,
  rebuiltFromJournal: fromJournalPath || null,
  providerCostUsd: Number(accruedCostUsd.toFixed(6)),
  pairs,
};

// The §9 completeness check runs against the harness's own output. A report
// that cannot be cited should say so at the moment it is written, not when
// somebody tries to attach it to the gate.
if (record.completedItems < record.plannedItems) {
  console.log(
    `\nPARTIAL — ${record.completedItems} of ${record.plannedItems} planned item(s), ` +
      `stopped by ${stoppedReason}. The cells this leaves short are not evidence of\n` +
      "anything, and the docs/ops/tomverse-chat-router-evaluation-set.md §3 sizing\n" +
      "computed from a partial sample is a smaller sample reported as a measurement."
  );
}

const recordProblems = evaluationRecordProblems(record, {
  routableModelIds,
  checkCalibration: (artefact) =>
    calibrationArtefactProblems(artefact, {
      judgeIdentity: {
        modelId: judgeModel.id,
        provider: judgeModel.provider,
        apiModel: judgeModel.apiModel,
      },
      judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
      evaluationSetPurpose: evaluationSet.purpose,
    }),
});
if (recordProblems.length > 0) {
  console.log("");
  console.log("This report is NOT decision-grade evidence:");
  for (const problem of recordProblems) console.log(`  - ${problem}`);
}

if (jsonPath) {
  ensureDirectory(jsonPath);
  writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${jsonPath}`);
}

// This run's own verdicts, in the format --rejudge writes, so calibrating
// against an independent judge does not mean paying this judge a second time
// to say what it has already said. The verdicts are the ones above -- same
// answers, same fixed order, same rubric -- and the file is only citable
// against the bundle whose digest it carries.
if (bundlePath && existsSync(bundlePath)) {
  const parsed = parseAnswerBundle(readFileSync(bundlePath, "utf8"));
  const out = `${bundlePath}.${judgeModel.id}.verdicts.jsonl`;
  const judged = pairs.filter((pair) => pair.outcome?.status === "judged");
  writeFileSync(
    out,
    [
      JSON.stringify({
        kind: "header",
        judge: {
          modelId: judgeModel.id,
          provider: judgeModel.provider,
          apiModel: judgeModel.apiModel,
        },
        bundleDigest: bundleDigest(parsed),
        bundlePath,
        answerIdentities: bundleAnswerIdentities(parsed),
        bundleMode: parsed.header.mode,
        evaluationSetVersion: parsed.header.evaluationSetVersion,
        evaluationSetPurpose: parsed.header.evaluationSetPurpose,
        bundlePairs: parsed.entries.length,
        bundlePlannedItems: parsed.header.plannedItems,
        judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
        // Not a rejudge: these verdicts were produced by the run itself.
        judgedDuringRun: true,
        rejudgedAt: startedAt,
        commitSha,
      }),
      ...judged.map((pair) =>
        JSON.stringify({ kind: "verdict", pairId: pair.itemId, verdict: pair.outcome.verdict })
      ),
    ].join("\n") + "\n",
    "utf8"
  );
  console.log(
    `Wrote ${out} — ${judged.length} verdict(s) over ${parsed.entries.length} bundled pair(s).`
  );
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
