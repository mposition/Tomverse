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

import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import { MEMORY_EVAL_DATASET_VERSION } from "../lib/memoryExtractionEvalFixtures.ts";
import { MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM } from "../lib/memoryExtractionEvalCore.ts";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    MEMORY_EXTRACTION_PROMPT_VERSION,
} from "../lib/memoryExtractionEvalRegister.ts";
import { toExtractionPromptInput } from "../lib/memoryExtractionPrompt.ts";
import { estimatePromptTokens } from "../lib/chatTokenEstimate.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { getModel } from "../lib/models.ts";

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

/** The harness's own per-call output ceiling. Kept in step by a test. */
const MAX_OUTPUT_TOKENS = 4_096;

/**
 * A stand-in for how long a real answer runs.
 *
 * Not measured, and said so: it is a quarter of the ceiling, which is enough
 * to separate "the worst case is affordable" from "even the typical case is
 * not". The worst case is the number to set a ceiling from.
 */
const TYPICAL_OUTPUT_FRACTION = 0.25;

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

const worstPerRun = costFor(floorTotal, MAX_OUTPUT_TOKENS);
const typicalPerRun = costFor(floorTotal, MAX_OUTPUT_TOKENS * TYPICAL_OUTPUT_FRACTION);

const usd = (value) => `US$${value.toFixed(2)}`;
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
line("worst case, one run", usd(worstPerRun));
line("worst case, all runs", usd(worstPerRun * runs));
line(`typical (output at ${TYPICAL_OUTPUT_FRACTION * 100}% of ceiling), all runs`, usd(typicalPerRun * runs));

console.log(
    `\nSet the ceiling from the worst case, not the typical one: ${usd(worstPerRun * runs)}.\n` +
        "A run that behaves cannot exceed it, and a run that does not is exactly what a\n" +
        "ceiling is for."
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
