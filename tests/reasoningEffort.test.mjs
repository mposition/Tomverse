import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS, getModelUsageProfile, resolveModelRequestPricing } from "../lib/models.ts";
import {
    modelReasoningEffortOptions, modelReasoningEffortSteps, modelReasoningEfforts, modelWithReasoningEffort,
    reasoningEffortStepsEnabled,
} from "../lib/reasoningEffort.ts";
import { toPublicCatalogModel } from "../lib/publicModelCatalog.ts";
import { externalApiModelCapabilities } from "../lib/externalApiCatalogCore.ts";
import { validateChatPayload } from "../lib/chatSecurity.ts";
import { parseChatStreamTrailer } from "../lib/webSearchStreamTrailer.ts";
import { getModelProviderOptions } from "../lib/modelGenerationCompatibility.ts";
import { parseChatCompletionRequest } from "../lib/openAiChatProtocol.ts";

const luna = AVAILABLE_MODELS.find(({ id }) => id === "gpt-6-luna");
const haiku = AVAILABLE_MODELS.find(({ id }) => id === "claude-haiku-5-5");

test("supported levels describe the provider target and preserve the current default", () => {
    assert.deepEqual(modelReasoningEfforts(luna), ["low", "high"]);
    assert.deepEqual(modelReasoningEfforts({ ...luna, apiModel: "remapped" }), []);
    assert.equal(modelWithReasoningEffort(luna), luna);
    assert.equal(getModelProviderOptions(modelWithReasoningEffort(luna, "high")).openai.reasoningEffort, "high");
    assert.deepEqual(getModelProviderOptions(modelWithReasoningEffort(haiku, "low")).anthropic, {
        thinking: { type: "adaptive" },
        effort: "low",
    });
    assert.equal(haiku.reasoning, "high");
});

test("the coding API field accepts the named steps and nothing beyond them", () => {
    const request = { model: luna.id, messages: [{ role: "user", content: "Hello" }] };
    assert.equal(parseChatCompletionRequest(request).tomverse_effort, undefined);
    assert.equal(parseChatCompletionRequest({ ...request, tomverse_effort: "high" }).tomverse_effort, "high");
    assert.equal(parseChatCompletionRequest({ ...request, tomverse_effort: "medium" }).tomverse_effort, "medium");
    for (const invalid of ["max", "xhigh", "minimal", "default", ""]) {
        assert.throws(() => parseChatCompletionRequest({ ...request, tomverse_effort: invalid }), invalid);
    }
});

const withSwitches = (values, run) => {
    const keys = ["TOMVERSE_REASONING_EFFORT_ENABLED", "TOMVERSE_DESKTOP_REASONING_STEPS_ENABLED"];
    const previous = keys.map((key) => process.env[key]);
    try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, values);
        return run();
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
    }
};

test("the steps are the same two models with a middle step, and only while their switch and the effort switch are both on", () => {
    assert.deepEqual(modelReasoningEffortSteps(luna), ["low", "medium", "high"]);
    assert.deepEqual(modelReasoningEffortSteps(haiku), ["low", "medium", "high"]);
    // A remapped upstream id, or a model that does not reason, takes no step either.
    assert.deepEqual(modelReasoningEffortSteps({ ...luna, apiModel: "remapped" }), []);
    assert.deepEqual(modelReasoningEffortSteps({ ...luna, reasoning: "none" }), []);
    withSwitches({}, () => {
        assert.equal(reasoningEffortStepsEnabled(), false);
        assert.deepEqual(modelReasoningEffortOptions(luna), ["low", "high"]);
    });
    // The steps switch alone is not enough: with the effort switch off there is no effort at all.
    withSwitches({ TOMVERSE_DESKTOP_REASONING_STEPS_ENABLED: "true" }, () => assert.equal(reasoningEffortStepsEnabled(), false));
    withSwitches({ TOMVERSE_REASONING_EFFORT_ENABLED: "true" }, () => assert.equal(reasoningEffortStepsEnabled(), false));
    withSwitches({ TOMVERSE_REASONING_EFFORT_ENABLED: "true", TOMVERSE_DESKTOP_REASONING_STEPS_ENABLED: "true" }, () => {
        assert.equal(reasoningEffortStepsEnabled(), true);
        assert.deepEqual(modelReasoningEffortOptions(luna), ["low", "medium", "high"]);
    });
});

test("a step is sent to the provider as the model's own reasoning level", () => {
    assert.equal(getModelProviderOptions(modelWithReasoningEffort(luna, "medium")).openai.reasoningEffort, "medium");
    assert.equal(getModelProviderOptions(modelWithReasoningEffort(haiku, "medium")).anthropic.effort, "medium");
    // Which step was asked for never moves the credit weight or the request price and reservation: only the model decides them.
    for (const base of [luna, haiku]) {
        const reference = { usage: getModelUsageProfile(base), pricing: resolveModelRequestPricing(base, { estimatedPromptTokens: 1000 }) };
        for (const step of ["low", "medium", "high"]) {
            const stepped = modelWithReasoningEffort(base, step);
            assert.deepEqual({ usage: getModelUsageProfile(stepped), pricing: resolveModelRequestPricing(stepped, { estimatedPromptTokens: 1000 }) },
                reference, `${base.id} ${step}`);
        }
    }
});

test("the public catalogue adds the step list beside the two presets, and only while the steps switch is on", () => {
    const entry = withSwitches({ TOMVERSE_REASONING_EFFORT_ENABLED: "true" }, () => toPublicCatalogModel(luna));
    assert.deepEqual(entry.reasoningEfforts, ["low", "high"]);
    assert.equal("reasoningEffortSteps" in entry, false);
    const stepped = withSwitches({ TOMVERSE_REASONING_EFFORT_ENABLED: "true", TOMVERSE_DESKTOP_REASONING_STEPS_ENABLED: "true" },
        () => toPublicCatalogModel(luna));
    // The legacy field is untouched, so a client that predates the steps reads the catalogue as it always did.
    assert.deepEqual(stepped.reasoningEfforts, ["low", "high"]);
    assert.deepEqual(stepped.reasoningEffortSteps, ["low", "medium", "high"]);
    const off = withSwitches({}, () => toPublicCatalogModel(luna));
    assert.equal("reasoningEfforts" in off || "reasoningEffortSteps" in off, false);
});

test("the coding API catalogue lists the steps only when asked to", () => {
    const limits = { maxInputTokens: 1000, maxOutputTokens: 1000, creditWeight: 1 };
    assert.deepEqual(externalApiModelCapabilities(luna, limits).reasoningEfforts, ["low", "high"]);
    assert.deepEqual(externalApiModelCapabilities(luna, limits, { effortSteps: true }).reasoningEfforts, ["low", "medium", "high"]);
});

test("a chat payload may carry the middle step, and the route alone decides who is allowed it", () => {
    const payload = { messages: [{ role: "user", content: "hi" }], modelId: luna.id };
    assert.equal(validateChatPayload({ ...payload, reasoningEffort: "medium" }).reasoningEffort, "medium");
    for (const invalid of ["max", "xhigh", "default", 1, null]) {
        assert.throws(() => validateChatPayload({ ...payload, reasoningEffort: invalid }), (error) => error.code === "INVALID_REASONING_EFFORT");
    }
});

test("the stream trailer reports the middle step as applied", () => {
    const trailer = (applied) => parseChatStreamTrailer(JSON.stringify({ searchMetadata: null, appliedReasoningEffort: applied }));
    assert.equal(trailer("medium")?.appliedReasoningEffort, "medium");
    assert.equal(trailer("xhigh")?.appliedReasoningEffort, undefined);
});
