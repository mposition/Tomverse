/**
 * The independent judge's cost is recomputed from the bundle it would read,
 * not carried over from the probe that measured its output length.
 *
 * The probe ran on the voided pilot's answers, generated under a 2,048-token
 * cap and therefore shorter than what a run under the product's cap produces.
 * Input is roughly half the judge's cost, so a projection carried forward
 * would understate the real one by however much the answers grew. Only the
 * output side is projected; the input side is counted.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    FABLE_PER_REQUEST_MAX_COST_USD,
    FABLE_STAGE_MAX_COST_USD,
    JOB_MAX_COST_USD,
    PILOT_PER_REQUEST_MAX_COST_USD,
    PILOT_STAGE_MAX_COST_USD,
    PROBED_JUDGE_OUTPUT_TOKENS,
    fableEntryProblems,
    projectFableEntry,
} from "../lib/routerFableEntry.ts";
import { estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { judgePrompt } from "../lib/routerJudgeRubric.ts";

// claude-fable-5's registry prices.
const fablePricing = {
    inputUsdPerMillionTokens: 10,
    outputUsdPerMillionTokens: 50,
    requestedMaxOutputTokens: 8_192,
};

const answer = (text) => ({ arm: "auto", modelId: "m", provider: "p", apiModel: "a", text, digest: "d" });
const bundleOf = (count, answerLength) => ({
    header: { kind: "header" },
    entries: Array.from({ length: count }, (_, i) => ({
        kind: "pair",
        pairId: `p${i}`,
        stratum: "coding",
        cell: "en",
        prompt: "question ".repeat(20),
        first: answer("a".repeat(answerLength)),
        second: answer("b".repeat(answerLength)),
    })),
});

test("mposition's approved ceilings", () => {
    assert.equal(PILOT_STAGE_MAX_COST_USD, 2.0);
    assert.equal(PILOT_PER_REQUEST_MAX_COST_USD, 1.0);
    assert.equal(FABLE_STAGE_MAX_COST_USD, 18.0);
    assert.equal(FABLE_PER_REQUEST_MAX_COST_USD, 0.75);
    assert.equal(JOB_MAX_COST_USD, 20.0);
    assert.equal(PILOT_STAGE_MAX_COST_USD + FABLE_STAGE_MAX_COST_USD, JOB_MAX_COST_USD);
    // A stage ceiling has to sit above the worst single request it can
    // produce, or it is a ceiling one call breaches with nothing to stop it.
    assert.ok(PILOT_PER_REQUEST_MAX_COST_USD < PILOT_STAGE_MAX_COST_USD);
    assert.ok(FABLE_PER_REQUEST_MAX_COST_USD < FABLE_STAGE_MAX_COST_USD);
});

test("the output figures carry the measurement they came from", () => {
    assert.equal(PROBED_JUDGE_OUTPUT_TOKENS.expected, 447);
    assert.equal(PROBED_JUDGE_OUTPUT_TOKENS.stress, 838);
    assert.equal(PROBED_JUDGE_OUTPUT_TOKENS.probeSampleSize, 10);
    assert.match(PROBED_JUDGE_OUTPUT_TOKENS.probeCommit, /^[0-9a-f]{40}$/);
});

test("the input side is counted, not projected", () => {
    const bundle = bundleOf(3, 400);
    const projection = projectFableEntry(bundle, fablePricing);
    const byHand = bundle.entries.reduce(
        (sum, e) => sum + estimateRawTextTokens(judgePrompt(e.prompt, e.first.text, e.second.text)),
        0
    );
    assert.equal(projection.exactInputTokens, byHand);
    assert.equal(projection.exactInputCostUsd.toFixed(6), ((byHand * 10) / 1e6).toFixed(6));
    assert.equal(projection.pairs, 3);
});

test("longer answers raise the input cost, which is why it is recounted", () => {
    // The reason the probe's own number cannot be carried forward.
    const short = projectFableEntry(bundleOf(210, 400), fablePricing);
    const long = projectFableEntry(bundleOf(210, 4_000), fablePricing);
    assert.ok(long.exactInputCostUsd > short.exactInputCostUsd * 2);
    // The output side is unchanged: it is per judgement, not per token read.
    assert.equal(
        (long.expectedCostUsd - long.exactInputCostUsd).toFixed(6),
        (short.expectedCostUsd - short.exactInputCostUsd).toFixed(6)
    );
});

test("expected and stress differ only by the projected output", () => {
    const p = projectFableEntry(bundleOf(210, 800), fablePricing);
    const delta = (PROBED_JUDGE_OUTPUT_TOKENS.stress - PROBED_JUDGE_OUTPUT_TOKENS.expected) * 210;
    assert.equal((p.stressCostUsd - p.expectedCostUsd).toFixed(6), ((delta * 50) / 1e6).toFixed(6));
    assert.ok(p.stressCostUsd > p.expectedCostUsd);
});

test("the ceiling has to fit the stress case, not the expected one", () => {
    const p = projectFableEntry(bundleOf(210, 800), fablePricing);
    // A ceiling between the two: the average run fits and one in ten does not.
    const between = (p.expectedCostUsd + p.stressCostUsd) / 2;
    const problems = fableEntryProblems(p, {
        stageMaxCostUsd: between,
        perRequestMaxCostUsd: FABLE_PER_REQUEST_MAX_COST_USD,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /stress case costs/);
    assert.match(problems[0], /truncated part-way and buy a prefix at full price/);
});

test("a per-request ceiling one call can breach is a separate refusal", () => {
    const p = projectFableEntry(bundleOf(210, 800), fablePricing);
    // 8,192 output at $50/M is $0.41 before any input, so this cannot hold.
    const problems = fableEntryProblems(p, {
        stageMaxCostUsd: FABLE_STAGE_MAX_COST_USD,
        perRequestMaxCostUsd: 0.2,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /nothing can stop the call that breaches it/);
});

test("the approved ceilings hold for a bundle of the shape the probe saw", () => {
    // ~765 tokens per answer is what the 2026-08-28 bundle carried.
    const p = projectFableEntry(bundleOf(210, 3_000), fablePricing);
    assert.deepEqual(
        fableEntryProblems(p, {
            stageMaxCostUsd: FABLE_STAGE_MAX_COST_USD,
            perRequestMaxCostUsd: FABLE_PER_REQUEST_MAX_COST_USD,
        }),
        []
    );
    assert.ok(p.stressCostUsd < FABLE_STAGE_MAX_COST_USD);
});

test("an empty bundle is refused before it is priced", () => {
    const problems = fableEntryProblems(projectFableEntry(bundleOf(0, 100), fablePricing), {
        stageMaxCostUsd: FABLE_STAGE_MAX_COST_USD,
        perRequestMaxCostUsd: FABLE_PER_REQUEST_MAX_COST_USD,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /holds no pairs/);
});
