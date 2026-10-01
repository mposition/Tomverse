import assert from "node:assert/strict";
import test from "node:test";
import {
    PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT,
    PROMPT_REFINER_VNEXT_PRICE_PIN,
    guardPromptRefinerVnextBilledUsage,
    promptRefinerVnextExecutionContractProblems,
} from "../lib/promptRefinerQualityEvaluationVnextExecutionContract.ts";

const usage = () => ({
    inputTokens: 100_000,
    outputTokens: 4_096,
    cachedInputTokens: 1,
    cacheWriteInputTokens: 99_998,
    reasoningTokens: 4_000,
});
const guard = (observedUsage, effectivePricePin = { ...PROMPT_REFINER_VNEXT_PRICE_PIN }) =>
    guardPromptRefinerVnextBilledUsage({ usage: observedUsage, effectivePricePin });

test("successor freezes 80 slots, nested non-additive ceilings and non-admission", () => {
    assert.deepEqual(promptRefinerVnextExecutionContractProblems(), []);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.numericSpecSha256,
        "a1ebccdbbe10c02725d73686235f379f51abd38f5cf8a6acd9e3ba294edbbfea");
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.slotCount, 80);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.stageCapacity, 80);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.maxInputTokens, 100_000);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.maxOutputTokens, 4_096);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.timeoutMs, 15_000);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.perRequestCeilingMicroUsd, 29_918);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.stageCeilingMicroUsd, 2_393_440);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.runCeilingMicroUsd, 2_393_440);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.retryCount, 0);
    assert.deepEqual(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.pricePin, {
        provider: "openai",
        modelId: "gpt-5-6-luna",
        apiModelId: "gpt-5.6-luna",
        routing: "direct_provider_api",
        processingTier: "standard",
        inputUsdPerMillionTokens: 0.2,
        cachedInputPriceMultiplier: 0.1,
        cacheWriteUsdPerMillionTokens: 0.25,
        outputUsdPerMillionTokens: 1.2,
    });
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.executionAdmitted, false);
    assert.equal(PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.productAdapterReady, false);
});

test("three input buckets and billed reasoning output independently round to the approved worst case", () => {
    assert.deepEqual(guard(usage()), {
        complete: true,
        costUpperBoundMicroUsd: 29_918,
        problems: [],
        reservationReleaseAuthorized: false,
    });
    assert.equal(guard({ ...usage(), cachedInputTokens: 0, cacheWriteInputTokens: 100_000 })
        .costUpperBoundMicroUsd, 29_916);
    assert.equal(guard({ ...usage(), cachedInputTokens: 0, cacheWriteInputTokens: 0 })
        .costUpperBoundMicroUsd, 24_916);
    assert.equal(guard({ ...usage(), cacheWriteInputTokens: 0 })
        .costUpperBoundMicroUsd, 24_917);
});

test("cache-write telemetry omission, null, coercion and bucket overlap never become zero", () => {
    for (const invalid of [
        { ...usage(), cacheWriteInputTokens: null },
        { ...usage(), cacheWriteInputTokens: undefined },
        { ...usage(), cacheWriteInputTokens: "0" },
        { ...usage(), cacheWriteInputTokens: -1 },
        { ...usage(), cacheWriteInputTokens: 1.5 },
        { ...usage(), cachedInputTokens: 3, cacheWriteInputTokens: 99_998 },
    ]) {
        const result = guard(invalid);
        assert.equal(result.complete, false);
        assert.equal(result.costUpperBoundMicroUsd, null);
        assert.equal(result.reservationReleaseAuthorized, false);
    }
    const omitted = usage();
    delete omitted.cacheWriteInputTokens;
    assert.deepEqual(guard(omitted).problems, ["usage_shape_invalid"]);
});

test("price drift and missing cache-write rate keep the worst reservation", () => {
    for (const pin of [
        { ...PROMPT_REFINER_VNEXT_PRICE_PIN, cacheWriteUsdPerMillionTokens: null },
        { ...PROMPT_REFINER_VNEXT_PRICE_PIN, cacheWriteUsdPerMillionTokens: 0 },
        { ...PROMPT_REFINER_VNEXT_PRICE_PIN, inputUsdPerMillionTokens: 0.21 },
        { ...PROMPT_REFINER_VNEXT_PRICE_PIN, routing: "aggregator" },
    ]) {
        assert.deepEqual(guard(usage(), pin).problems, ["price_pin_mismatch"]);
        assert.equal(guard(usage(), pin).costUpperBoundMicroUsd, null);
    }
    const missing = { ...PROMPT_REFINER_VNEXT_PRICE_PIN };
    delete missing.cacheWriteUsdPerMillionTokens;
    assert.deepEqual(guard(usage(), missing).problems, ["price_pin_mismatch"]);
});

test("invalid totals, reasoning relationships and incomplete observations fail closed", () => {
    for (const invalid of [
        { ...usage(), inputTokens: 0 },
        { ...usage(), inputTokens: 100_001 },
        { ...usage(), outputTokens: 4_097 },
        { ...usage(), reasoningTokens: 4_097 },
        { ...usage(), inputTokens: Number.MAX_SAFE_INTEGER + 1 },
        { ...usage(), outputTokens: null },
    ]) {
        assert.equal(guard(invalid).complete, false);
        assert.equal(guard(invalid).costUpperBoundMicroUsd, null);
    }
    assert.equal(guard({ ...usage(), reasoningTokens: null }).complete, true);
});

test("accessor, inherited and extra fields cannot supply authority or usage", () => {
    const accessor = { ...usage() };
    Object.defineProperty(accessor, "cacheWriteInputTokens", {
        get() { throw new Error("untrusted getter"); }, enumerable: true,
    });
    assert.deepEqual(guard(accessor).problems, ["usage_shape_invalid"]);
    assert.deepEqual(guard(Object.assign(Object.create({ inputTokens: 1 }), usage())).problems,
        ["usage_shape_invalid"]);
    assert.deepEqual(guard({ ...usage(), costUpperBoundMicroUsd: 0 }).problems,
        ["usage_shape_invalid"]);
});
