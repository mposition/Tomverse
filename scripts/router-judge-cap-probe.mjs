// How many output tokens does a reasoning judge actually spend on one verdict?
//
// ############################################################################
// # THIS SCRIPT SPENDS MONEY. Ten judge calls, one per selected pair.        #
// ############################################################################
//
// It exists because the independent judge's cost rests on a number nobody has
// measured. docs/ops/tomverse-chat-router-calibration-cost.md priced the judge
// pass at a three-token verdict, which is what gpt-5-6-luna emitted and the
// fit reproduced to 0.0%. claude-fable-5 reasons at effort `high` and bills
// reasoning as output, so its verdict call is not three tokens -- and the
// whole calibration budget follows from whatever it is.
//
// Ten pairs, spanning both languages, five task kinds and both ends of the
// length range. Same rubric, same prompt, same output schema as a real judge
// pass, so the number it produces is about the real thing.
//
// It stops at once on any of: a budget exhausted, an empty verdict, a verdict
// that will not parse, a single request over its per-request ceiling, or the
// stage ceiling reached. mposition approved $0.60 for this and nothing else.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/router-judge-cap-probe.mjs \
//     --bundle=<answers.jsonl> --set=<evaluation set JSON> \
//     --judge-max-output-tokens=8192 \
//     --per-request-max-cost-usd=0.50 --stage-max-cost-usd=0.60 \
//     --json=artifacts/judge-cap-probe.json

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { generateText } from "ai";

import { estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { getActiveAiModel } from "../lib/activeAiModel.ts";
import { getModel } from "../lib/models.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { answerBundleProblems, parseAnswerBundle } from "../lib/routerAnswerBundle.ts";
import { resolveCallLimit } from "../lib/routerCallLimits.ts";
import {
  PROBE_SAMPLE_SIZE,
  probeAbortReason,
  selectProbeSample,
  summariseProbe,
} from "../lib/routerJudgeCapProbe.ts";
import { JUDGE_TEMPLATE_VERSION, judgePrompt, readVerdict } from "../lib/routerJudgeRubric.ts";
import { normalizeFinishReason } from "../lib/routerAnswerOutcome.ts";

const die = (message) => {
  console.error(message);
  process.exit(1);
};
const flag = (name, fallback = null) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const positive = (name, fallback) => {
  const raw = flag(name, null);
  const value = raw === null ? fallback : Number(raw);
  if (!(Number.isFinite(value) && value > 0)) die(`--${name} must be a positive number.`);
  return value;
};

const bundlePath = flag("bundle") ?? die("--bundle=<answers.jsonl> is required.");
const setPath = flag("set") ?? die("--set=<evaluation set JSON> is required.");
const jsonPath = flag("json") ?? die("--json=<report path> is required.");
const judgeMaxOutputTokens = positive("judge-max-output-tokens", 8_192);
const perRequestMaxCostUsd = positive("per-request-max-cost-usd", 0.5);
const stageMaxCostUsd = positive("stage-max-cost-usd", 0.6);

// mposition approved a probe with no retries. Stated rather than implied,
// because "it does not retry today" is not the same promise.
const RETRY_COUNT = 0;

const set = JSON.parse(readFileSync(setPath, "utf8"));
// The probe must not touch anything a decision or a future calibration will be
// computed from. The development set is the one that may be spent freely; a
// decision set has a fixed number of uses and this is not one of them.
if (set.purpose !== "development") {
  die(
    `${setPath} is a "${set.purpose}" set. The judge-cap probe may only read the development set:\n` +
      "spending a decision set's uses on an instrumentation question is not a trade anybody made."
  );
}

const judgeModelId = set.independentJudge?.modelId ?? die(`${setPath} pre-registers no independentJudge.`);
const judge = getModel(judgeModelId) ?? die(`Unknown judge model "${judgeModelId}".`);

const bundle = parseAnswerBundle(readFileSync(bundlePath, "utf8"));
const bundleTrouble = answerBundleProblems(bundle);
// A bundle with unreadable answers is not a reason to stop here the way it is
// before a full rejudge: this probe reads ten pairs it picks itself, and it
// picks only pairs both arms answered. The problems are reported and the
// selection works around them.
if (bundleTrouble.length > 0) {
  console.log(`NOTE: ${bundlePath} carries ${bundleTrouble.length} bundle problem(s):`);
  for (const problem of bundleTrouble.slice(0, 5)) console.log(`  - ${problem}`);
  if (bundleTrouble.length > 5) console.log(`  ... and ${bundleTrouble.length - 5} more`);
  console.log("");
}

const { selected, problems } = selectProbeSample(bundle);
for (const problem of problems) console.log(`NOTE: ${problem}`);
if (selected.length !== PROBE_SAMPLE_SIZE) {
  die(
    `\nThe probe could not assemble its ${PROBE_SAMPLE_SIZE}-pair sample, so it would measure a\n` +
      "narrower range than the one that was approved. Nothing was sent and nothing was billed."
  );
}

const limit = resolveCallLimit(judge, "judge", { judgeMaxOutputTokens });
const pricing = resolveModelPricing(judge);

console.log(`Judge cap probe — ${judge.id} (${judge.provider}/${judge.apiModel})`);
console.log(`  bundle       ${bundlePath}`);
console.log(`  sample       ${selected.length} pair(s), ${PROBE_SAMPLE_SIZE} approved`);
console.log(`  judge cap    ${limit.requestedMaxOutputTokens} output token(s)`);
console.log(`  ceilings     $${perRequestMaxCostUsd.toFixed(2)} per request, $${stageMaxCostUsd.toFixed(2)} for the stage`);
console.log(`  retries      ${RETRY_COUNT}`);
console.log(`  rubric       ${JUDGE_TEMPLATE_VERSION}`);
console.log("");

const costUsdOf = (usage) => {
  const priced = resolveModelPricing(judge, { estimatedPromptTokens: usage.inputTokens ?? 0 });
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, (usage.inputTokens ?? 0) - cachedTokens);
  return (
    (uncachedInput * priced.inputUsdPerMillionTokens +
      cachedTokens * priced.inputUsdPerMillionTokens * priced.cachedInputPriceMultiplier +
      (usage.outputTokens ?? 0) * priced.outputUsdPerMillionTokens) /
    1_000_000
  );
};

// Where the provider reports reasoning separately. Anthropic and OpenAI spell
// it differently and some report nothing at all, which stays null rather than
// becoming zero -- "not reported" is not "none spent".
const reasoningTokensOf = (usage) => {
  for (const key of ["reasoningTokens", "reasoning_tokens", "thoughtsTokenCount"]) {
    const value = usage?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const details = usage?.outputTokensDetails ?? usage?.completionTokensDetails;
  const nested = details?.reasoningTokens ?? details?.reasoning_tokens;
  return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
};

const observations = [];
let accruedCostUsd = 0;
let aborted = null;

for (const [index, pick] of selected.entries()) {
  const { entry } = pick;
  // The real prompt, built the same way the real run builds it. A probe that
  // measured a different prompt would measure a different question.
  const prompt = judgePrompt(entry.prompt, entry.first.text, entry.second.text);

  let result;
  try {
    result = await generateText({
      model: getActiveAiModel(judge),
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: limit.requestedMaxOutputTokens,
    });
  } catch (error) {
    // Its own reason: a call that never returned has no verdict to call
    // empty and nothing to fail parsing, and retries are not approved.
    console.log(`  ${entry.pairId}  provider error: ${String(error)}`);
    aborted = { at: index, reason: "provider_error" };
    break;
  }

  const usage = result.usage ?? {};
  const costUsd = costUsdOf(usage);
  accruedCostUsd += costUsd;
  const visible = (result.text ?? "").trim();
  const normalizedFinishReason = normalizeFinishReason(result.finishReason ?? null);
  const observation = {
    pairId: entry.pairId,
    stratum: pick.stratum,
    cell: pick.cell,
    lengthEnd: pick.lengthEnd,
    // What the selection measured, and what the provider actually billed. Both,
    // because the first is an estimate and the second is the check on it.
    renderedJudgeInputTokens: estimateRawTextTokens(prompt),
    inputTokens: usage.inputTokens ?? estimateRawTextTokens(prompt),
    billedOutputTokens: usage.outputTokens ?? null,
    visibleOutputTokens: estimateRawTextTokens(visible),
    reasoningTokens: reasoningTokensOf(usage),
    finishReason: result.finishReason ?? null,
    normalizedFinishReason,
    parseSucceeded: readVerdict(visible) !== null,
    costUsd,
  };
  observations.push(observation);

  console.log(
    `  ${String(index + 1).padStart(2)}/${selected.length} ${entry.pairId.padEnd(28)} ` +
      `${pick.stratum}/${pick.cell}/${pick.lengthEnd}  renderedIn=${observation.renderedJudgeInputTokens} ` +
      `billedIn=${observation.inputTokens} ` +
      `billedOut=${observation.billedOutputTokens ?? "none"} visible=${observation.visibleOutputTokens} ` +
      `reasoning=${observation.reasoningTokens ?? "n/r"} finish=${observation.finishReason ?? "none"} ` +
      `parsed=${observation.parseSucceeded} $${costUsd.toFixed(4)} (cum $${accruedCostUsd.toFixed(4)})`
  );

  // The whole budget spent with the provider stopping at the output limit is
  // the defect this probe is here to avoid walking into at 210x the scale.
  const budgetExhausted =
    normalizedFinishReason === "output_limit" &&
    (observation.billedOutputTokens ?? 0) >= limit.requestedMaxOutputTokens * 0.95;

  const reason = probeAbortReason(
    observation,
    {
      requestedMaxOutputTokens: limit.requestedMaxOutputTokens,
      perRequestMaxCostUsd,
      stageMaxCostUsd,
      accruedCostUsd,
    },
    budgetExhausted
  );
  if (reason) {
    aborted = { at: index, reason };
    break;
  }
}

const summary = summariseProbe(observations, aborted);
const show = (label, d) =>
  d &&
  console.log(
    `${label.padEnd(22)} min ${d.min}, median ${d.median}, p90 ${d.p90}, max ${d.max}` +
      `  (mean ${d.mean.toFixed(0)}, n=${d.n})`
  );
console.log("");
show("Billed output tokens", summary.billedOutputTokens);
show("Rendered input tokens", summary.renderedJudgeInputTokens);
console.log(
  `Finish reasons         ${Object.entries(summary.finishReasons)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ") || "none"}`
);
console.log(`Verdicts parsed        ${summary.parsedCount}/${observations.length}`);
console.log(`Total cost             $${summary.totalCostUsd.toFixed(4)} of $${stageMaxCostUsd.toFixed(2)} approved`);

const sha256 = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const report = {
  kind: "judge-cap-probe",
  // Said in the artefact rather than left to whoever finds it later. These
  // answers came from a run that is void, so the measurement is about the
  // judge's output length and about nothing else. A file that does not say so
  // is a file somebody will eventually quote for something it cannot support.
  purpose: "judge-cap-probe",
  sourceRunStatus: "void",
  usableForQualityEvidence: false,
  usableForCalibrationEvidence: false,
  provenanceNote:
    "Answers come from the VOID_GENERATION_VALIDATION_MISMATCH pilot of 2026-08-28, generated " +
    "under a 2,048-token output cap. They do not represent the longer answers the product's own " +
    "cap will produce, so this measures the judge's output length as an initial observation only. " +
    "Full-run cost must be recomputed from a fresh bundle and its real rendered judge inputs.",
  // What ran, exactly. A measurement whose code cannot be identified is not a
  // measurement anybody can repeat.
  workflowSha: process.env.PROBE_WORKFLOW_SHA ?? null,
  checkoutSha: process.env.PROBE_CHECKOUT_SHA ?? null,
  sourceBundleDigest: sha256(readFileSync(bundlePath, "utf8")),
  evaluationSetDigest: sha256(readFileSync(setPath, "utf8")),
  judgeModelId: judge.id,
  provider: judge.provider,
  apiModel: judge.apiModel,
  pricingVersion: pricing.pricingVersion,
  judgeTemplateVersion: JUDGE_TEMPLATE_VERSION,
  bundlePath,
  evaluationSetVersion: set.version,
  evaluationSetPurpose: set.purpose,
  requestedMaxOutputTokens: limit.requestedMaxOutputTokens,
  perRequestMaxCostUsd,
  stageMaxCostUsd,
  retryCount: RETRY_COUNT,
  ...summary,
};
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Wrote ${jsonPath}`);

if (aborted) {
  console.error(
    `\nSTOPPED at judgement ${aborted.at + 1} — ${aborted.reason}.\n` +
      (aborted.reason === "provider_error"
        ? "The call never returned, so it says nothing about the judge either way. Retries are\n" +
          "not approved for this probe, so it stops here.\n"
        : "That is one of the conditions mposition set for stopping.\n") +
      "The full run stays on hold: the cap this probe was testing has not been shown to hold."
  );
  process.exit(1);
}

console.log(
  `\nOK — ${observations.length} judgement(s) at a ${limit.requestedMaxOutputTokens}-token cap, none exhausted,\n` +
    "every verdict parsed. The observed distribution is what --judge-output-expected and the\n" +
    "full-run ceilings should now be set from."
);
