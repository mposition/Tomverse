/**
 * Whether the independent judge may start, priced from the bundle it would read.
 *
 * ## Why this is recomputed rather than carried forward
 *
 * The 2026-08-28 judge-cap probe measured what a reasoning judge spends: over
 * ten judgements `claude-fable-5` billed 45 to 1,437 output tokens for a
 * verdict whose visible text was two or three words. The cost is the thinking,
 * not the answer, and it varies by a factor of 32 across pairs.
 *
 * That measurement was taken on the voided pilot's answers, which were
 * generated under a 2,048-token cap and are therefore shorter than the ones a
 * run under the product's own cap will produce. Input is roughly half the
 * judge's cost, so a projection carried over from the probe would understate
 * the real one by however much the answers grew.
 *
 * So the input side is not projected at all: every pair the judge would read
 * is rendered and counted, exactly, from the bundle in hand. Only the output
 * side is projected, from the probe's own distribution.
 *
 * ## Expected and stress, not one number
 *
 * mposition's two figures. `expectedCost` uses the probe's mean output, which
 * is what a normal run should cost. `stressCost` uses its p90, which is what a
 * run of unusually talkative judgements would cost -- and it is `stressCost`,
 * not the expected one, that has to fit under the ceiling. A ceiling only the
 * average fits is a ceiling that stops one run in ten part-way.
 */

import { estimateRawTextTokens } from "./chatTokenEstimate";
import type { AnswerBundle } from "./routerAnswerBundle";
import { judgePrompt } from "./routerJudgeRubric";

/**
 * Output tokens per judgement, measured rather than assumed.
 *
 * From the judge-cap probe of 2026-08-28 (run 33140501584, commit d466db47):
 * ten judgements on `claude-fable-5` at an 8,192-token cap, all finishing
 * `stop`, all parsing, none exhausting the budget. min 45, median 307, p90
 * 838, max 1,437, mean 447.
 *
 * Ten is few and they were chosen to span the range rather than sampled, so
 * these are working figures with a known provenance, not population
 * parameters. They are named here so a later run can disagree with them
 * knowing what it is disagreeing with.
 */
export const PROBED_JUDGE_OUTPUT_TOKENS = {
    expected: 447,
    stress: 838,
    probeRunId: "33140501584",
    probeCommit: "d466db477d77a5624f008375bb3be07bf315733c",
    probeSampleSize: 10,
} as const;

/**
 * mposition's ceilings for the approved job, revised 2026-08-28.
 *
 * The pilot's first pair -- a $2.00 stage with no per-request bound -- could
 * not be enforced. The answer arms ask for the product's own output cap, the
 * Router may pick any enabled model, and `claude-fable-5` at 128,000 output
 * tokens is a $6.40 request on its own. A stage ceiling below that is a
 * ceiling one call can breach with nothing able to intervene, so the pilot
 * stage was raised above its own worst request rather than the answer budget
 * being quietly lowered to fit.
 */
export const FABLE_STAGE_MAX_COST_USD = 18.0;
export const FABLE_PER_REQUEST_MAX_COST_USD = 0.75;
export const PILOT_STAGE_MAX_COST_USD = 7.0;
export const PILOT_PER_REQUEST_MAX_COST_USD = 6.5;
export const JOB_MAX_COST_USD = 25.0;

export type JudgePricing = {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    /** The output budget one judge call may ask for. */
    requestedMaxOutputTokens: number;
};

export type FableEntryProjection = {
    pairs: number;
    /** Summed over every pair the judge would actually read. Not a projection. */
    exactInputTokens: number;
    exactInputCostUsd: number;
    expectedCostUsd: number;
    stressCostUsd: number;
    /** The largest single request, at the full output budget. */
    maxPerRequestWorstCaseUsd: number;
    maxRenderedInputTokens: number;
};

const usd = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;

export const projectFableEntry = (
    bundle: AnswerBundle,
    pricing: JudgePricing
): FableEntryProjection => {
    let exactInputTokens = 0;
    let maxRenderedInputTokens = 0;
    for (const entry of bundle.entries) {
        const rendered = estimateRawTextTokens(
            judgePrompt(entry.prompt ?? "", entry.first?.text ?? "", entry.second?.text ?? "")
        );
        exactInputTokens += rendered;
        if (rendered > maxRenderedInputTokens) maxRenderedInputTokens = rendered;
    }
    const pairs = bundle.entries.length;
    const exactInputCostUsd = usd(exactInputTokens, pricing.inputUsdPerMillionTokens);
    const outputCost = (perPair: number) =>
        usd(perPair * pairs, pricing.outputUsdPerMillionTokens);
    return {
        pairs,
        exactInputTokens,
        exactInputCostUsd,
        expectedCostUsd: exactInputCostUsd + outputCost(PROBED_JUDGE_OUTPUT_TOKENS.expected),
        stressCostUsd: exactInputCostUsd + outputCost(PROBED_JUDGE_OUTPUT_TOKENS.stress),
        maxPerRequestWorstCaseUsd:
            usd(maxRenderedInputTokens, pricing.inputUsdPerMillionTokens) +
            usd(pricing.requestedMaxOutputTokens, pricing.outputUsdPerMillionTokens),
        maxRenderedInputTokens,
    };
};

/**
 * Why the independent judge may not start. Empty means it may.
 *
 * The two cost conditions fail for different reasons and are kept apart: a
 * stage ceiling below the stress case truncates a run part-way and buys a
 * prefix at full price, while a per-request ceiling below one call cannot be
 * enforced at all -- a cost ceiling is tested between calls, so nothing can
 * stop the call that breaches it on its own.
 */
export const fableEntryProblems = (
    projection: FableEntryProjection,
    limits: {
        stageMaxCostUsd: number;
        perRequestMaxCostUsd: number;
    }
): readonly string[] => {
    const problems: string[] = [];
    if (projection.pairs === 0) {
        problems.push("the bundle holds no pairs, so there is nothing to judge");
        return problems;
    }
    if (projection.stressCostUsd > limits.stageMaxCostUsd) {
        problems.push(
            `the stress case costs $${projection.stressCostUsd.toFixed(2)} against a ` +
                `$${limits.stageMaxCostUsd.toFixed(2)} stage ceiling, so a run of talkative ` +
                "judgements would be truncated part-way and buy a prefix at full price"
        );
    }
    if (projection.maxPerRequestWorstCaseUsd > limits.perRequestMaxCostUsd) {
        problems.push(
            `one request can cost up to $${projection.maxPerRequestWorstCaseUsd.toFixed(4)} against a ` +
                `$${limits.perRequestMaxCostUsd.toFixed(2)} per-request ceiling — a cost ceiling is ` +
                "tested between calls, so nothing can stop the call that breaches it"
        );
    }
    return problems;
};
