/**
 * What a decision-grade memory-extraction eval would cost, before it is run.
 *
 *   npm run report:memory-eval-cost-estimate
 *   npm run report:memory-eval-cost-estimate -- --model=gpt-5-4-mini --runs=2
 *
 * docs/policy/external-conversation-import-and-memory.md §12.5 asks a person
 * to approve a ceiling in dollars, and nothing produced a dollar figure. The
 * harness accrues cost only while a live run is in flight, which is after the
 * approval it is meant to inform. So the approver's only options were to guess
 * or to run the thing they were approving.
 *
 * Counting is not the approver's job (AGENTS.md: 셈과 대조는 에이전트가 합니다).
 * The judgement -- what ceiling to set, and whether to spend at all -- is.
 *
 * **This is an estimate and it is named one everywhere it appears.** Two parts
 * are not measured:
 *
 *   * Input tokens come from this repository's own calibrated estimator
 *     (`lib/chatTokenEstimate.ts`), not from the provider's tokenizer. The
 *     estimator exists because the exact tokenizer is not available locally;
 *     using it here means the number rests on the same basis the product
 *     already bills against rather than on a ratio invented for this script.
 *   * Output tokens are unknowable before the run. The figure below prices the
 *     harness's own `maxOutputTokens` ceiling, which is the largest a call can
 *     be. Real answers are far shorter, so the total is a **worst case** and
 *     the typical figure is reported beside it.
 *
 * A ceiling set from the worst case cannot be exceeded by a run that behaves.
 * That is the direction an approver wants to be wrong in.
 */

// The set a decision-grade run will actually use. This used to read
// `mem-eval-seed-11`, which is schema 1 and cannot support a decision-grade
// run at all — so the report priced a run nobody can make. The conversations
// are byte-identical between the two sets, so the figure barely moved; the
// label did, and a number labelled with the wrong dataset is a number nobody
// should approve a budget from.
// Read from the harness's own target rather than pinned here. An estimate is
// what a §12.5 budget is approved from, so it has to be an estimate of the
// sample that would actually be run -- and this file has already been the
// place where the two drifted apart once.
import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM } from "../lib/memoryExtractionEvalCore.ts";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import {
    MEMORY_EXTRACTION_PROMPT_VERSION,
    toExtractionPromptInput,
} from "../lib/memoryExtractionPrompt.ts";
import { estimatePromptTokens } from "../lib/chatTokenEstimate.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS } from "../lib/memoryExtractionWorker.ts";
import { getModel } from "../lib/models.ts";

const evalTarget = harnessTarget();
const MEMORY_EVAL_CASES = evalTarget.cases;
const MEMORY_EVAL_DATASET_VERSION = evalTarget.datasetVersion;

const argValue = (name, fallback) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const modelId = argValue("model", MEMORY_EXTRACTION_EVAL_REGISTER[0]?.extractionModelId);
const runs = Number(argValue("runs", "2"));
if (!Number.isFinite(runs) || runs < 1) {
    console.error(`--runs must be a positive integer (got "${argValue("runs", "")}").`);
    process.exit(1);
}

const model = getModel(modelId);
if (!model) {
    console.error(
        `${modelId} is not a known model. Known eval pairs: ` +
            MEMORY_EXTRACTION_EVAL_REGISTER.map((e) => e.extractionModelId).join(", ")
    );
    process.exit(1);
}



/**
 * How long an answer is assumed to run. **An assumption, not a measurement.**
 *
 * It used to be a fraction of the output ceiling, which worked while that
 * ceiling was 4,096 and stopped meaning anything when it became the model's
 * real capability: a quarter of 128,000 is 32,000 tokens, which is nothing
 * like an extraction answer.
 *
 * So the assumption is stated in tokens instead. A few hundred cover the JSON;
 * the rest is headroom for reasoning tokens, which this model produces and
 * which are billed as output. Nobody has measured them here, and the first
 * live run that reports usage replaces this number -- until then the report
 * prints the per-1,000-token slope so a reader can scale it themselves rather
 * than trusting the guess.
 */
const ASSUMED_OUTPUT_TOKENS = 1_024;

/** Input tokens for one case, built from the prompt the harness actually sends. */
const promptTokensFor = (testCase) => {
    const conversations = testCase.conversations.map((conversation) => ({
        externalConversationId: conversation.externalConversationId,
        title: conversation.title,
        messages: conversation.messages.map((message) => ({
            externalMessageId: message.externalMessageId,
            role: message.role,
            content: message.content,
            contentDigest: "0".repeat(64),
        })),
    }));
    const { prompt } = toExtractionPromptInput(conversations);
    return estimatePromptTokens(`${prompt.system}\n${prompt.user}`);
};

const measured = MEMORY_EVAL_CASES.map(promptTokensFor);
const measuredTotal = measured.reduce((sum, tokens) => sum + tokens, 0);
const meanPromptTokens = measured.length > 0 ? measuredTotal / measured.length : 0;

/** What §12.2 asks a decision-grade run to cover. */
const floorTotal = Object.values(MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM).reduce(
    (sum, floor) => sum + floor * 2,
    0
);

const priceFor = (promptTokens) =>
    resolveModelPricing(model, { estimatedPromptTokens: Math.round(promptTokens) });

const pricing = priceFor(meanPromptTokens);

const costFor = (cases, outputTokens) => {
    const input = (cases * meanPromptTokens * pricing.inputUsdPerMillionTokens) / 1_000_000;
    const output = (cases * outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000;
    return input + output;
};

/**
 * The per-call output ceiling, read from the constant both the product and
 * the harness send.
 *
 * It was briefly the model's `maxOutputTokens` -- its full capability -- on
 * the reasoning that a reservation must not be used as a cap. That was the
 * wrong reading of the right rule: 4,096 here is not
 * `reservationOutputTokens`, it is `memoryExtractionWorker`'s deliberate
 * ceiling on one chunk's answer, and pricing anything else would price a
 * request nobody makes.
 */
const MAX_OUTPUT_TOKENS = MEMORY_EXTRACTION_CHUNK_MAX_OUTPUT_TOKENS;

const worstPerRun = costFor(floorTotal, MAX_OUTPUT_TOKENS);
const assumedPerRun = costFor(floorTotal, ASSUMED_OUTPUT_TOKENS);
const inputOnlyPerRun = costFor(floorTotal, 0);
const perThousandOutputPerRun = costFor(floorTotal, 1_000) - inputOnlyPerRun;

/**
 * Two formatters, because one of these numbers is transcribed into a ceiling
 * and the rest are read.
 *
 * `toFixed(2)` rounds to nearest, which rounds **down** about half the time,
 * and this report's whole purpose is to hand somebody a figure to approve. On
 * `mem-eval-succ-9` the raw per-run worst case is US$6.4928602 and the rounded
 * display was `US$6.49` — a ceiling a fifth of a cent *below* the worst case it
 * is supposed to bound. A run that hit the cap would have been truncated by its
 * own approved ceiling, and a truncated run is not decision-grade.
 *
 * Nothing had gone wrong yet, because the figure being proposed was the two-run
 * total, where 12.9857204 happens to round up. It rounded up by luck of that
 * value rather than by construction, which is not a property worth relying on
 * twice.
 *
 * So a ceiling is rounded **up** to the cent and says so, and the raw value is
 * printed beside it: a reader checking the arithmetic should not have to
 * reproduce this script to see what was rounded.
 */
const usd = (value) => `US$${value.toFixed(2)}`;
const ceilCents = (value) => Math.ceil(value * 100 - 1e-9) / 100;
const line = (label, value) => console.log(`${label.padEnd(42)} ${value}`);

console.log(`memory extraction eval — cost estimate (NOT a quote)\n`);
line("pair", `${modelId} :: ${MEMORY_EXTRACTION_PROMPT_VERSION}`);
line("price source", pricing.costSource ?? "unknown");
line("input (USD / 1M tokens)", pricing.inputUsdPerMillionTokens);
line("output (USD / 1M tokens)", pricing.outputUsdPerMillionTokens);

console.log(`\nmeasured on the ${MEMORY_EVAL_CASES.length} adopted case(s) of ${MEMORY_EVAL_DATASET_VERSION}:`);
line("mean prompt tokens per case", Math.round(meanPromptTokens));
line("per-call output ceiling", MAX_OUTPUT_TOKENS);

console.log(`\nprojected onto the §12.2 floor:`);
line("cases per run", floorTotal);
line("runs (§12.4 independent re-run)", runs);

console.log("\nmeasured — the input side:");
line("input only, all runs", usd(inputOnlyPerRun * runs));

console.log("\nassumed — the output side (nobody has measured it yet):");
line("assumed output tokens per answer", ASSUMED_OUTPUT_TOKENS.toLocaleString("en-US"));
line("at that assumption, all runs", usd(assumedPerRun * runs));
line("per +1,000 output tokens/answer, all runs", usd(perThousandOutputPerRun * runs));
line("if every answer hit the cap, all runs", usd(worstPerRun * runs));

// The per-run ceiling first, and the programme total from *it* rather than
// from the raw total rounded once. `findEvalRegisterProblems()` refuses a
// budget whose `maxUsd × maxProviderDispatchedRuns` exceeds the programme
// figure, so rounding the two ends independently is how a budget earns a
// refusal by arithmetic nobody intended.
const perRunCeilingUsd = ceilCents(worstPerRun);
const programmeCeilingUsd = perRunCeilingUsd * runs;

console.log("\nthe numbers to approve — rounded UP to the cent, never to nearest:");
line("per run  (evalBudget.maxUsd)", `US$${perRunCeilingUsd.toFixed(2)}`);
line(
    "all runs (programmeMaxMicroUsd)",
    `US$${programmeCeilingUsd.toFixed(2)}  ` +
        `= ${Math.round(programmeCeilingUsd * 1_000_000)} microUSD`
);
line("raw worst case, per run / all runs", `${worstPerRun} / ${worstPerRun * runs}`);

console.log(
    "\nSet the ceiling from the worst case, not the assumption. A run that behaves\n" +
        "cannot exceed it, and a run that does not is exactly what a ceiling is for. A\n" +
        "run stopped by that ceiling is truncated, and a truncated run is not\n" +
        "decision-grade -- so the worst case is the number to approve, not the number to\n" +
        "fear."
);

console.log(
    "\nWhat this figure does not include: blind review set generation, any\n" +
        "re-run after a failure, and provider-side rounding. It also prices the\n" +
        "adopted dataset's mean prompt length -- cases still in the candidate pool\n" +
        "are not measured, and a longer conversation costs more."
);

if (MEMORY_EVAL_CASES.length < floorTotal) {
    console.log(
        `\nThe dataset holds ${MEMORY_EVAL_CASES.length} adopted case(s) against a floor of ${floorTotal}.\n` +
            "The projection above assumes the remaining cases resemble these in length.\n" +
            "It is a planning figure, not a settled one."
    );
}
