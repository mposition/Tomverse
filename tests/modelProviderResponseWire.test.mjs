import assert from "node:assert/strict";
import test from "node:test";
import { generateText, jsonSchema, Output, streamText } from "ai";
import { getActiveAiModel } from "../lib/activeAiModel.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
import { getModel } from "../lib/models.ts";

const mistral = {
  ...getModel("mistral-large-3"),
  apiModel: "mistral-large-4-0",
  reasoning: "medium",
};
const thinking = { type: "thinking", thinking: [{ type: "text", text: "Checking the calculation." }] };
const answer = { type: "text", text: "The answer is 42." };

test.beforeEach(t => {
  for (const key of ["MISTRAL_API_KEY", "MINIMAX_API_KEY"]) {
    const previous = process.env[key];
    process.env[key] = "isolated-wire-fixture";
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
});

test("Mistral HTTP 200 thinking chunks produce an answer and retain usage", async t => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.mistral.ai/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal(body.model, mistral.apiModel);
    assert.equal(body.reasoning_effort, "medium");
    return Response.json({
      id: "test-mistral", object: "chat.completion", created: 1, model: mistral.apiModel,
      choices: [{ index: 0, message: { role: "assistant", content: [thinking, answer] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 23, total_tokens: 35 },
    });
  });
  const result = await generateText({
    model: getActiveAiModel(mistral), prompt: "Calculate 6 * 7.", maxRetries: 0,
    ...getModelGenerationSettings(mistral),
  });
  assert.equal(result.text, answer.text);
  assert.equal(result.reasoningText, thinking.thinking[0].text);
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 23);
});

test("Mistral streaming thinking and text chunks stay separate", async t => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    const chunk = (content, finish_reason = null) => ({
      id: "test-mistral", object: "chat.completion.chunk", created: 1, model: mistral.apiModel,
      choices: [{ index: 0, delta: { content }, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 12, completion_tokens: 23, total_tokens: 35 } } : {}),
    });
    return new Response([
      chunk([thinking]), chunk([answer]), chunk("", "stop"),
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const result = streamText({
    model: getActiveAiModel(mistral), prompt: "Calculate 6 * 7.", maxRetries: 0,
    ...getModelGenerationSettings(mistral),
  });
  assert.equal(await result.text, answer.text);
  assert.equal(await result.reasoningText, thinking.thinking[0].text);
  assert.equal((await result.usage).outputTokens, 23);
});

test("Mistral still accepts a plain text response", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    id: "test-mistral", object: "chat.completion", created: 1, model: "mistral-small-latest",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }));
  const result = await generateText({ model: getActiveAiModel(getModel("mistral-small-4")), prompt: "Hello.", maxRetries: 0 });
  assert.equal(result.text, "Hello.");
});

test("Mistral effort is mapped to each model's supported values", async t => {
  let expected;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.reasoning_effort, expected);
    return Response.json({
      id: "test-mistral", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: answer.text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  });
  for (const [apiModel, reasoning, effort] of [
    ["mistral-large-4-0", "none", "low"],
    ["mistral-large-4-0", "low", "low"],
    ["mistral-large-4-0", "medium", "medium"],
    ["mistral-small-latest", "medium", "high"],
    ["mistral-large-latest", "high", undefined],
  ]) {
    const model = { ...mistral, apiModel, reasoning };
    expected = effort;
    const result = await generateText({
      model: getActiveAiModel(model), prompt: "Calculate 6 * 7.", maxRetries: 0,
      ...getModelGenerationSettings(model),
    });
    assert.equal(result.text, answer.text);
  }
});

test("Mistral structured output preserves the previous strict schema default", async t => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    return Response.json({
      id: "test-mistral", object: "chat.completion", created: 1, model: mistral.apiModel,
      choices: [{ index: 0, message: { role: "assistant", content: '{"answer":42}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
  });
  const result = await generateText({
    model: getActiveAiModel(mistral), prompt: "Calculate 6 * 7.", maxRetries: 0,
    output: Output.object({ schema: jsonSchema({
      type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false,
    }) }),
    // Existing structured-output callers still send this namespace.
    providerOptions: { openai: { strictJsonSchema: true } },
  });
  assert.deepEqual(result.output, { answer: 42 });
});

test("MiniMax M3.1 Flash sends explicit effort without raising the output cap", async t => {
  const model = { ...getModel("minimax-m3"), apiModel: "MiniMax-M3.1-Flash" };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.minimax.io/anthropic/v1/messages");
    const body = JSON.parse(init.body);
    assert.equal(body.model, model.apiModel);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.equal(body.max_tokens, 6_048);
    return Response.json({
      id: "test-minimax", type: "message", role: "assistant", model: model.apiModel,
      content: [{ type: "thinking", thinking: "Checking.", signature: "test" }, answer],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 32 },
    });
  });
  const result = await generateText({
    model: getActiveAiModel(model), prompt: "Calculate 6 * 7.", maxOutputTokens: 6_048, maxRetries: 0,
    ...getModelGenerationSettings(model),
  });
  assert.equal(result.text, answer.text);
  assert.equal(result.usage.outputTokens, 32);
});
