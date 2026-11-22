import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { modelReasoningEfforts, modelWithReasoningEffort } from "../lib/reasoningEffort.ts";
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

test("the coding API field accepts only the two explicit presets", () => {
    const request = { model: luna.id, messages: [{ role: "user", content: "Hello" }] };
    assert.equal(parseChatCompletionRequest(request).tomverse_effort, undefined);
    assert.equal(parseChatCompletionRequest({ ...request, tomverse_effort: "high" }).tomverse_effort, "high");
    assert.throws(() => parseChatCompletionRequest({ ...request, tomverse_effort: "max" }));
});
