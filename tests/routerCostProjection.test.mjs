/**
 * A single cost estimate is not admissible when the observations it would be
 * fitted to are censored.
 *
 * Every usage figure available comes from runs that asked for 2,048 output
 * tokens, and 60 of those calls stopped at that ceiling. They record where
 * answers were cut off, not how long answers are. So a projection carries four
 * numbers and names which of them the evidence supports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ceilingProblems, projectCallCost, sumProjections } from "../lib/routerCostProjection.ts";

const limit = {
    modelId: "m",
    apiModelId: "m",
    callRole: "answer",
    requestedMaxOutputTokens: 10_000,
    limitSource: "product_pricing_profile",
    profileVersion: "v",
    pricingVersion: "p",
    resolvedProductOutputCap: 10_000,
    outputUsdPerMillionTokens: 100,
    inputUsdPerMillionTokens: 10,
    reasoningTokenBilling: "billed_as_output",
};

const projection = projectCallCost({
    limit,
    calls: 10,
    promptTokens: 1_000,
    expectedOutputTokens: 500,
    p95OutputTokens: 2_000,
    observedOutputTokens: 200,
});

test("the four values are ordered, and the observed one is a floor", () => {
    // input 1,000 @ $10/M = $0.01 per call, so every value carries $0.10.
    assert.equal(projection.observedLowerBoundUsd.toFixed(4), (0.1 + 10 * 0.02).toFixed(4));
    assert.equal(projection.expectedUsd.toFixed(4), (0.1 + 10 * 0.05).toFixed(4));
    assert.equal(projection.conservativeUsd.toFixed(4), (0.1 + 10 * 0.2).toFixed(4));
    assert.equal(projection.theoreticalCeilingUsd.toFixed(4), (0.1 + 10 * 1).toFixed(4));
    assert.ok(
        projection.observedLowerBoundUsd < projection.expectedUsd &&
            projection.expectedUsd < projection.conservativeUsd &&
            projection.conservativeUsd < projection.theoreticalCeilingUsd
    );
});

test("a run with no observation says so rather than reporting zero", () => {
    const unobserved = projectCallCost({
        limit,
        calls: 10,
        promptTokens: 1_000,
        expectedOutputTokens: 500,
        p95OutputTokens: 2_000,
    });
    assert.equal(unobserved.observedLowerBoundUsd, null);
    assert.equal(sumProjections([unobserved, unobserved]).observedLowerBoundUsd, null);
});

test("the worst single request is the worst one, not the sum of them", () => {
    // It answers "can one call breach the ceiling", and adding two calls
    // together does not make either of them bigger.
    const summed = sumProjections([projection, projection]);
    assert.equal(summed.perRequestWorstCaseUsd, projection.perRequestWorstCaseUsd);
    assert.equal(summed.expectedUsd.toFixed(4), (2 * projection.expectedUsd).toFixed(4));
});

test("a ceiling one request can breach is refused before dispatch", () => {
    // $0.01 input + 10,000 @ $100/M = $1.01 for one call.
    assert.equal(projection.perRequestWorstCaseUsd.toFixed(4), "1.0100");
    const problems = ceilingProblems(projection, 0.5);
    assert.ok(problems.some((p) => /one request can cost up to \$1\.0100/.test(p)));
    assert.ok(problems.some((p) => /cannot stop a single call/.test(p)));
});

test("a ceiling below the expected cost is a separate complaint", () => {
    // Distinct from the one above because it is fixed differently: this one
    // truncates a healthy run, the other cannot be enforced at all. Many small
    // calls reach it without any single call coming close.
    const many = projectCallCost({
        limit,
        calls: 1_000,
        promptTokens: 1_000,
        expectedOutputTokens: 500,
        p95OutputTokens: 2_000,
    });
    assert.equal(many.expectedUsd.toFixed(2), "60.00");
    assert.equal(many.perRequestWorstCaseUsd.toFixed(4), "1.0100");
    const problems = ceilingProblems(many, 10);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /would be truncated/);
});

test("a ceiling above both is no complaint at all", () => {
    assert.deepEqual(ceilingProblems(projection, 50), []);
});
