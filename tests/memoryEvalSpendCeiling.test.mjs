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

/** The number after `maxOutputTokens:` in a source file. */
const outputCeiling = (source, pattern) => {
    const match = pattern.exec(source);
    return match ? Number(match[1].replace(/_/g, "")) : null;
};

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

test("the cost estimate prices the ceiling the harness actually sends", () => {
    // The estimate's worst case is "every call hits the output ceiling". If
    // the harness raises `maxOutputTokens` and the estimator keeps the old
    // number, the approved budget is set from a ceiling that no longer bounds
    // anything -- and the gap shows up on an invoice rather than here.
    const harnessCeiling = outputCeiling(
        harness,
        /maxOutputTokens:\s*([\d_]+)/
    );
    const estimatorCeiling = outputCeiling(
        estimator,
        /MAX_OUTPUT_TOKENS\s*=\s*([\d_]+)/
    );
    assert.ok(harnessCeiling, "could not read maxOutputTokens from the harness");
    assert.ok(estimatorCeiling, "could not read MAX_OUTPUT_TOKENS from the estimator");
    assert.equal(
        estimatorCeiling,
        harnessCeiling,
        "the estimator prices a different output ceiling than the harness sends"
    );
});
