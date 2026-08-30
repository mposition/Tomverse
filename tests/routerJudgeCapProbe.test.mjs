/**
 * Ten judgements are too few to leave to a seed.
 *
 * The quantity being measured is how much a judge *thinks*, which is the thing
 * most likely to move with the language, the task and the length of what it is
 * reading. A random ten could be ten short English questions and would answer
 * a narrower question than the one that was approved.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    PROBE_CELLS,
    PROBE_SAMPLE_SIZE,
    PROBE_STRATA,
    probeAbortReason,
    renderedJudgeInputTokens,
    selectProbeSample,
    summariseProbe,
} from "../lib/routerJudgeCapProbe.ts";
import { estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { judgePrompt } from "../lib/routerJudgeRubric.ts";

const answer = (text) => ({ arm: "auto", modelId: "m", provider: "p", apiModel: "a", text, digest: "d" });
const pair = (pairId, stratum, cell, promptLength, answerLength = 40) => ({
    kind: "pair",
    pairId,
    stratum,
    cell,
    prompt: "q".repeat(promptLength),
    first: answer("x".repeat(answerLength)),
    second: answer("y".repeat(answerLength)),
});

const fullBundle = () => {
    const entries = [];
    for (const stratum of PROBE_STRATA) {
        for (const cell of PROBE_CELLS) {
            for (const size of [40, 400, 4_000]) {
                entries.push(pair(`${stratum}-${cell}-${size}`, stratum, cell, size));
            }
        }
    }
    return { header: { kind: "header" }, entries };
};

test("length is measured on the whole rendered request, not the varying part", () => {
    // mposition's correction. The judge is sent the rubric and the output
    // schema too, and for a short pair those are most of the request -- so
    // ordering by prompt-plus-answers ranks a different quantity from the one
    // the judge actually reads, and prices it wrong by an undeclared constant.
    const entry = pair("p", "coding", "en", 40, 40);
    const rendered = renderedJudgeInputTokens(entry);
    const varyingPartOnly =
        estimateRawTextTokens(entry.prompt) +
        estimateRawTextTokens(entry.first.text) +
        estimateRawTextTokens(entry.second.text);
    assert.equal(
        rendered,
        estimateRawTextTokens(judgePrompt(entry.prompt, entry.first.text, entry.second.text))
    );
    assert.ok(
        rendered > varyingPartOnly,
        "the rendered request is larger than the prompt and answers alone"
    );
});

test("the sample covers every task kind in both languages", () => {
    const { selected, problems } = selectProbeSample(fullBundle());
    assert.equal(selected.length, PROBE_SAMPLE_SIZE);
    assert.deepEqual(problems, []);
    for (const stratum of PROBE_STRATA) {
        for (const cell of PROBE_CELLS) {
            assert.equal(
                selected.filter((s) => s.stratum === stratum && s.cell === cell).length,
                1,
                `${stratum}/${cell}`
            );
        }
    }
});

test("both ends of the length range are represented, and not by one language", () => {
    const { selected } = selectProbeSample(fullBundle());
    assert.equal(selected.filter((s) => s.lengthEnd === "short").length, 5);
    assert.equal(selected.filter((s) => s.lengthEnd === "long").length, 5);
    // The confound the alternation exists to break: if every long pick were
    // Korean, language and length would be measured as one variable.
    for (const cell of PROBE_CELLS) {
        const ends = new Set(selected.filter((s) => s.cell === cell).map((s) => s.lengthEnd));
        assert.equal(ends.size, 2, `${cell} spans both ends`);
    }
});

test("the selection is deterministic", () => {
    const first = selectProbeSample(fullBundle()).selected.map((s) => s.entry.pairId);
    const second = selectProbeSample(fullBundle()).selected.map((s) => s.entry.pairId);
    assert.deepEqual(first, second);
});

test("a pair either arm left empty is never measured on", () => {
    const bundle = fullBundle();
    // The shortest coding/ko pair, which is the one that cell would pick.
    const target = bundle.entries.find((e) => e.pairId === "coding-ko-40");
    target.first = answer("   ");
    const { selected, problems } = selectProbeSample(bundle);
    assert.ok(problems.some((p) => /hold an empty answer and were skipped/.test(p)));
    assert.equal(selected.length, PROBE_SAMPLE_SIZE);
    assert.ok(!selected.some((s) => s.entry.pairId === "coding-ko-40"));
});

test("a cell the bundle cannot fill is named rather than quietly dropped", () => {
    const bundle = fullBundle();
    bundle.entries = bundle.entries.filter((e) => !(e.stratum === "coding" && e.cell === "en"));
    const { selected, problems } = selectProbeSample(bundle);
    assert.equal(selected.length, PROBE_SAMPLE_SIZE - 1);
    assert.ok(problems.some((p) => /coding\/en holds no judgeable pair/.test(p)));
    assert.ok(problems.some((p) => /measures a narrower range than the one that was approved/.test(p)));
});

const observation = (over = {}) => ({
    pairId: "p",
    stratum: "coding",
    cell: "en",
    lengthEnd: "short",
    renderedJudgeInputTokens: 1_200,
    inputTokens: 1_000,
    billedOutputTokens: 300,
    visibleOutputTokens: 3,
    reasoningTokens: 290,
    finishReason: "stop",
    normalizedFinishReason: "stop",
    parseSucceeded: true,
    costUsd: 0.02,
    ...over,
});

const limits = {
    requestedMaxOutputTokens: 8_192,
    perRequestMaxCostUsd: 0.5,
    stageMaxCostUsd: 0.6,
    accruedCostUsd: 0.1,
};

test("a healthy judgement stops nothing", () => {
    assert.equal(probeAbortReason(observation(), limits, false), null);
});

test("each of the five stop conditions ends the probe", () => {
    assert.equal(probeAbortReason(observation(), limits, true), "output_budget_exhausted");
    assert.equal(
        probeAbortReason(observation({ visibleOutputTokens: 0 }), limits, false),
        "empty_verdict"
    );
    assert.equal(
        probeAbortReason(observation({ parseSucceeded: false }), limits, false),
        "verdict_parse_failed"
    );
    assert.equal(
        probeAbortReason(observation({ costUsd: 0.51 }), limits, false),
        "per_request_cost_exceeded"
    );
    assert.equal(
        probeAbortReason(observation(), { ...limits, accruedCostUsd: 0.6 }, false),
        "stage_cost_reached"
    );
});

test("an empty verdict is caught before the parse complaint", () => {
    // Both are true of an empty verdict, and "it was empty" is the finding.
    assert.equal(
        probeAbortReason(observation({ visibleOutputTokens: 0, parseSucceeded: false }), limits, false),
        "empty_verdict"
    );
});

test("the summary reports the spread, because the ceiling follows the tail", () => {
    const summary = summariseProbe(
        [100, 200, 300, 400].map((tokens) => observation({ billedOutputTokens: tokens, costUsd: 0.01 })),
        null
    );
    const d = summary.billedOutputTokens;
    assert.equal(d.n, 4);
    assert.equal(d.min, 100);
    assert.equal(d.median, 250);
    assert.equal(d.p90, 400);
    assert.equal(d.max, 400);
    assert.equal(d.mean, 250);
    assert.equal(summary.totalCostUsd.toFixed(4), "0.0400");
    assert.equal(summary.parsedCount, 4);
    assert.deepEqual(summary.finishReasons, { stop: 4 });
});

test("a mean hides the tail a ceiling has to survive", () => {
    // The reason the spread is reported at all: these two have the same mean
    // and completely different budget implications.
    const tight = summariseProbe(
        [300, 300, 300, 300].map((t) => observation({ billedOutputTokens: t })),
        null
    );
    const skewed = summariseProbe(
        [10, 10, 10, 1_170].map((t) => observation({ billedOutputTokens: t })),
        null
    );
    assert.equal(tight.billedOutputTokens.mean, skewed.billedOutputTokens.mean);
    assert.notEqual(tight.billedOutputTokens.max, skewed.billedOutputTokens.max);
});

test("a probe that measured nothing reports no distribution rather than zero", () => {
    const summary = summariseProbe([], { at: 0, reason: "empty_verdict" });
    assert.equal(summary.billedOutputTokens, null);
    assert.equal(summary.renderedJudgeInputTokens, null);
    assert.equal(summary.totalCostUsd, 0);
    assert.equal(summary.aborted.reason, "empty_verdict");
});
