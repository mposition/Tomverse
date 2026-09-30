/**
 * A blind review sheet is only worth drawing a sample for if it is actually
 * blind. These assert the two halves of that: what a sheet cannot say, and
 * what two sheets cannot share.
 *
 * mposition's contract: the sheet shows the same prompt, answers, order and
 * rubric the model judge saw, and nothing that would let a reviewer guess the
 * author -- not the provider or model id, not the Router's choice, not a model
 * judge's verdict, and not the internal score, cost, TTFT or generation time
 * that would let one be inferred.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bundle, ROUTABLE_MODEL_IDS, side } from "./routerHumanReviewFixture.mjs";
import { JUDGE_RUBRIC_CRITERIA, JUDGE_TEMPLATE_VERSION } from "../lib/routerJudgeRubric.ts";
import { HUMAN_REVIEWERS_PER_PAIR, drawPrimarySample } from "../lib/routerHumanReviewSample.ts";
import {
    FORBIDDEN_SHEET_KEYS,
    buildReviewPackage,
    renderSheetMarkdown,
    sheetBlindnessProblems,
    sheetIndependenceProblems,
    sheetItemId,
} from "../lib/routerHumanReviewSheet.ts";

const REVIEWERS = ["reviewer-a", "reviewer-b"];

const manifestFor = (source = bundle()) =>
    drawPrimarySample({ bundle: source, seed: 20260827, drawnAt: "2026-08-27T06:00:00Z", drawnBy: "mposition" });

/** A pair that is actually in the drawn 60, since only 4 of each cell's 14 are. */
const sampledPairId = (source) => manifestFor(source).cells[0].primary[0];

const build = (source = bundle(), reviewerIds = REVIEWERS) =>
    buildReviewPackage({
        manifest: manifestFor(source),
        bundle: source,
        reviewerIds,
        builtAt: "2026-08-27T07:00:00Z",
        builtBy: "mposition",
        routableModelIds: ROUTABLE_MODEL_IDS,
    });

test("every reviewer gets the whole sample and nothing else", () => {
    const source = bundle();
    const pack = build(source);
    assert.equal(pack.sheets.length, HUMAN_REVIEWERS_PER_PAIR);
    for (const sheet of pack.sheets) {
        assert.equal(sheet.items.length, 60);
        assert.equal(new Set(sheet.items.map((item) => item.itemId)).size, 60);
    }
    assert.equal(pack.key.length, 120);
});

test("a sheet item carries only the question, the two answers and its label", () => {
    const pack = build();
    for (const item of pack.sheets[0].items) {
        assert.deepEqual(Object.keys(item).sort(), ["answerA", "answerB", "itemId", "question"]);
    }
});

test("no forbidden field reaches an item, however the type is later widened", () => {
    const pack = build();
    assert.deepEqual(sheetBlindnessProblems(pack.sheets[0], bundle()), []);

    const leaky = {
        ...pack.sheets[0],
        items: pack.sheets[0].items.map((item, index) =>
            index === 0 ? { ...item, provider: "openai", latencyMs: 812 } : item
        ),
    };
    const problems = sheetBlindnessProblems(leaky, bundle());
    assert.ok(problems.some((problem) => problem.includes('"provider"')));
    assert.ok(problems.some((problem) => problem.includes('"latencyMs"')));
    for (const key of ["provider", "latencyMs"]) assert.ok(FORBIDDEN_SHEET_KEYS.includes(key));
});

test("an answer that names a model in the bundle is refused, not shipped", () => {
    const source = bundle();
    const target = source.entries.find((entry) => entry.pairId === sampledPairId(source));
    target.second = side("baseline", "I am GPT-5.6-luna, and here is the answer.");
    const pack = build(source);
    const problems = sheetBlindnessProblems(pack.sheets[0], source);
    assert.ok(problems.some((problem) => problem.includes("gpt-5.6-luna")));
});

test("a question that names a provider is not a leak, because both answers share it", () => {
    const source = bundle();
    const target = source.entries.find((entry) => entry.pairId === sampledPairId(source));
    target.prompt = "What does OpenAI charge for its API?";
    const pack = build(source);
    assert.deepEqual(sheetBlindnessProblems(pack.sheets[0], source), []);
});

test("answer A is the bundle's first answer, never re-drawn per reviewer", () => {
    const source = bundle();
    const pack = build(source);
    const byPairId = new Map(source.entries.map((entry) => [entry.pairId, entry]));
    for (const row of pack.key) {
        const entry = byPairId.get(row.pairId);
        const sheet = pack.sheets.find((candidate) => candidate.reviewerId === row.reviewerId);
        const item = sheet.items.find((candidate) => candidate.itemId === row.itemId);
        assert.equal(item.answerA, entry.first.text);
        assert.equal(item.answerB, entry.second.text);
        assert.equal(row.aArm, entry.first.arm);
    }
});

test("the two reviewers see the same items in different orders under different labels", () => {
    const pack = build();
    assert.deepEqual(sheetIndependenceProblems(pack.sheets), []);
});

test("two sheets in the same order are reported as not independent", () => {
    const pack = build();
    const cloned = { ...pack.sheets[1], items: pack.sheets[0].items };
    const problems = sheetIndependenceProblems([pack.sheets[0], cloned]);
    assert.ok(problems.some((problem) => problem.includes("same order")));
});

test("an item label is opaque and says nothing about the pair it stands for", () => {
    const pack = build();
    const pairIds = new Set(pack.key.map((row) => row.pairId));
    for (const sheet of pack.sheets) {
        for (const item of sheet.items) {
            assert.match(item.itemId, /^[0-9a-f]{12}$/);
            assert.ok(!pairIds.has(item.itemId));
        }
    }
});

test("labels are derived, so rebuilding the same package gives the same sheets", () => {
    assert.equal(
        JSON.stringify(build().sheets),
        JSON.stringify(build().sheets)
    );
    assert.notEqual(
        sheetItemId({ reviewerId: "reviewer-a", seed: 20260827, pairId: "coding-ko-1" }),
        sheetItemId({ reviewerId: "reviewer-b", seed: 20260827, pairId: "coding-ko-1" })
    );
});

test("the sheet renders the judges' rubric, not a paraphrase of it", () => {
    const pack = build();
    assert.equal(pack.sheets[0].judgeTemplateVersion, JUDGE_TEMPLATE_VERSION);
    const rendered = renderSheetMarkdown(pack.sheets[0]);
    for (const criterion of JUDGE_RUBRIC_CRITERIA) assert.ok(rendered.includes(criterion));
    for (const word of ["FIRST", "SECOND", "EQUIVALENT"]) assert.ok(rendered.includes(word));
});

test("a rendered sheet names no model, arm, cost or time", () => {
    const rendered = renderSheetMarkdown(build().sheets[0]).toLowerCase();
    for (const marker of ["deepseek", "openai", "gpt-5", "claude", "usd", "ttft", "latency"]) {
        assert.ok(!rendered.includes(marker), `the sheet mentions ${marker}`);
    }
});

test("a rubric mismatch between the draw and the build is refused", () => {
    const source = bundle();
    const manifest = { ...manifestFor(source), judgeTemplateVersion: "judge-rubric-v0" };
    assert.throws(
        () =>
            buildReviewPackage({
                manifest,
                bundle: source,
                reviewerIds: REVIEWERS,
                builtAt: "2026-08-27T07:00:00Z",
                builtBy: "mposition",
                routableModelIds: ROUTABLE_MODEL_IDS,
            }),
        /judge-rubric-v0/
    );
});

test("the wrong number of reviewers, or the same one twice, is refused", () => {
    assert.throws(() => build(bundle(), ["only-one"]), /2 reviewer ids/);
    assert.throws(() => build(bundle(), ["same", "same"]), /not be independent/);
});

test("a self-identifying answer is reported rather than scrubbed", () => {
    const source = bundle();
    const original = "As an AI language model made by Anthropic, here is the answer.";
    const target = source.entries.find((entry) => entry.pairId === sampledPairId(source));
    target.first = side("auto", original);
    const pack = build(source);
    const found = pack.disclosures.find((entry) => entry.pairId === target.pairId);
    assert.ok(found);
    assert.equal(found.side, "A");
    assert.ok(found.markers.includes("anthropic"));

    // Reported, and still shown verbatim: a scrub would change the answer the
    // reviewer grades, so the pair is a person's call, not the builder's.
    const sheet = pack.sheets[0];
    const row = pack.key.find((entry) => entry.pairId === target.pairId && entry.reviewerId === sheet.reviewerId);
    assert.equal(sheet.items.find((item) => item.itemId === row.itemId).answerA, original);
});

test("a sample the bundle cannot serve is refused rather than shortened", () => {
    const source = bundle();
    const manifest = manifestFor(source);
    const short = { ...source, entries: source.entries.filter((entry) => entry.pairId !== manifest.cells[0].primary[0]) };
    assert.throws(
        () =>
            buildReviewPackage({
                manifest,
                bundle: short,
                reviewerIds: REVIEWERS,
                builtAt: "2026-08-27T07:00:00Z",
                builtBy: "mposition",
                routableModelIds: ROUTABLE_MODEL_IDS,
            }),
        /not in the bundle/
    );
});

test("the key holds what the sheet does not, and stays out of the sheet", () => {
    const pack = build();
    for (const row of pack.key) {
        assert.deepEqual(
            Object.keys(row).sort(),
            ["aArm", "aDigest", "bArm", "bDigest", "cell", "itemId", "pairId", "reviewerId"]
        );
    }
    const rendered = JSON.stringify(pack.sheets);
    for (const row of pack.key.slice(0, 5)) {
        assert.ok(!rendered.includes(row.pairId));
        assert.ok(!rendered.includes(row.aDigest));
    }
});
