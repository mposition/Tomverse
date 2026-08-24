import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { getModel } from "../lib/models.ts";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §12.5 says the eval
 * budget is enforced by code. Two things enforce it and
 * only one of them worked.
 *
 * The refusal worked: a pair with no `evalBudget` cannot run live. The
 * *ceiling* did not. `scripts/evalImportedMemoryExtraction.mjs` called
 * `resolveModelPricing(modelId, usage.inputTokens)` -- an id string and a bare
 * number, against a function that takes a model object and an options object.
 * `model.id` on a string is undefined, so it threw on every call, and the
 * catch beside it swallowed the throw. `accruedCostUsd` therefore stayed at
 * zero for an entire live run and the comparison that stops a runaway was
 * comparing zero against the ceiling.
 *
 * A `.mjs` script gets no type checking, which is why a wrong call shape
 * survived. These tests stand in for it.
 */

const harness = readFileSync(
    fileURLToPath(
        new URL("../scripts/evalImportedMemoryExtraction.mjs", import.meta.url)
    ),
    "utf8"
);

const estimator = readFileSync(
    fileURLToPath(
        new URL("../scripts/report-memory-eval-cost-estimate.mjs", import.meta.url)
    ),
    "utf8"
);

test("the eval's pricing basis resolves for every registered pair", () => {
    // If this cannot resolve, the ceiling has no number behind it and a live
    // run spends without a bound.
    for (const entry of MEMORY_EXTRACTION_EVAL_REGISTER) {
        const model = getModel(entry.extractionModelId);
        assert.ok(model, `${entry.extractionModelId} is not a known model`);
        const pricing = resolveModelPricing(model, { estimatedPromptTokens: 0 });
        assert.ok(
            pricing.inputUsdPerMillionTokens > 0,
            `${entry.extractionModelId} resolved a non-positive input price`
        );
        assert.ok(
            pricing.outputUsdPerMillionTokens > 0,
            `${entry.extractionModelId} resolved a non-positive output price`
        );
    }
});

test("passing an id where a model belongs throws rather than pricing wrongly", () => {
    // The failure mode that hid: it is not that the wrong price came back, it
    // is that the call threw and something else decided that was survivable.
    assert.throws(() =>
        resolveModelPricing(
            // @ts-expect-error - the shape the harness used to pass
            MEMORY_EXTRACTION_EVAL_REGISTER[0].extractionModelId,
            0
        )
    );
});

test("the harness prices with a model, not with an id", () => {
    // `.mjs` means no compiler catches the argument shape, so the call site is
    // asserted directly. Narrow on purpose: it pins the two things that were
    // wrong and nothing about how the surrounding code is written.
    assert.doesNotMatch(
        harness,
        /resolveModelPricing\(\s*modelId\b/,
        "resolveModelPricing takes the model, not its id"
    );
    assert.match(
        harness,
        /resolveModelPricing\(\s*model,\s*\{\s*\n?\s*estimatedPromptTokens:/,
        "expected resolveModelPricing(model, { estimatedPromptTokens })"
    );
});

test("a swallowed pricing failure is counted and reported", () => {
    // The catch is still there -- pricing is for the ceiling, and a genuine
    // resolution failure should not abort an otherwise sound run. What changed
    // is that it can no longer be silent: every unpriced call makes the accrued
    // figure a lower bound, and a ceiling compared against a lower bound binds
    // late or not at all.
    assert.match(harness, /pricingFailures \+= 1;/);
    assert.match(harness, /CEILING NOT RELIABLE/);
    assert.match(harness, /spendCeilingReliable:/);
    assert.match(harness, /pricingFailures: runMode\.mode === "live"/);
});

test("neither side hard-codes the output ceiling", () => {
    // These used to be two literal 4,096s kept equal by comparing them. The
    // number was wrong on both sides -- it is the model's
    // `reservationOutputTokens`, entitlement rather than capability -- and
    // agreeing about a wrong number is what a drift test cannot catch. Both
    // now read `maxOutputTokens` off the resolved profile, so there is one
    // source and the question of drift does not arise.
    for (const [name, source] of [
        ["the harness", harness],
        ["the estimator", estimator],
    ]) {
        assert.ok(
            !/maxOutputTokens:\s*[\d_]+/.test(source),
            `${name} should not send a literal output ceiling`
        );
        // A use, not a mention: both files explain the old bug in prose, and
        // a check that could not tell the explanation from the mistake would
        // have to be deleted the first time somebody documented it.
        assert.ok(
            !/\.reservationOutputTokens/.test(source),
            `${name} must not cap output at the reservation`
        );
        assert.match(
            source,
            /(pricing|capability)\.maxOutputTokens/,
            `${name} should read the ceiling from the pricing profile`
        );
    }
});
