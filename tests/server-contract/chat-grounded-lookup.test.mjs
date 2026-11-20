import assert from "node:assert/strict";
import test from "node:test";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { getActiveAiModel, qwenLookupStep } from "../../lib/activeAiModel.ts";

const model = { provider: "qwen", apiModel: "qwen3.8-flash" };

test("Qwen bounds source verification on eligible steps and preserves the legacy no-thinking first call", async (t) => {
  const oldKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "test-only";
  t.after(() => { if (oldKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = oldKey; });
  let bodies = [];
  let extraTool = false;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const first = bodies.length === 1;
    const toolCalls = [{ id: "t1", type: "function", function: { name: "web_search", arguments: "{}" } }];
    if (extraTool) toolCalls.push({ id: "t2", type: "function", function: { name: "create_file", arguments: "{}" } });
    const message = first ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: "Grounded answer" };
    return Response.json({ id: "r" + bodies.length, model: model.apiModel, created: 1, choices: [{ index: 0, message, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } });
  });
  const ok = { status: "ok", results: [{ title: "Original", url: "https://example.org/source" }] };
  const empty = { status: "ok", results: [] };
  const failed = { status: "failed", reason: "backend_timeout" };
  const inputSchema = jsonSchema({ type: "object", properties: {} });
  for (const [extend, result, mixed, expectFast] of [
    [false, ok, false, false],
    [true, ok, false, true],
    [true, { status: "batch", searches: [ok, ok] }, false, true],
    [true, { status: "batch", searches: [ok, failed] }, false, false],
    [true, empty, false, false],
    [true, failed, false, false],
    [true, ok, true, false],
  ]) {
    bodies = [];
    extraTool = mixed;
    const prepareStep = qwenLookupStep(model, extend);
    assert.equal(prepareStep({ stepNumber: 1 }), undefined);
    const out = await generateText({
      model: getActiveAiModel(model), prepareStep,
      prompt: "Answer from the evidence, searching for missing facts.", stopWhen: stepCountIs(2), maxRetries: 0,
      tools: {
        web_search: tool({ inputSchema, execute: async () => result }),
        create_file: tool({ inputSchema, execute: async () => "done" }),
      },
    });
    assert.equal(out.text, "Grounded answer");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].enable_thinking, extend);
    assert.equal(bodies[0].thinking_budget, extend ? 128 : undefined);
    assert.equal(bodies[1].enable_thinking, expectFast ? true : undefined);
    assert.equal(bodies[1].thinking_budget, expectFast ? 128 : undefined);
    assert.equal(bodies[0].model, bodies[1].model);
    assert.deepEqual(bodies[0].tools, bodies[1].tools);
    assert.ok(bodies[1].messages.some(message => message.role === "tool" && message.content === JSON.stringify(result)));
  }
});

test("reasoning configurations, other models and providers retain their own settings", () => {
  for (const config of [{ ...model, reasoning: "high" }, { ...model, apiModel: "qwen3-max" }, { ...model, provider: "openai" }]) {
    assert.equal(qwenLookupStep(config), undefined);
    assert.equal(qwenLookupStep(config, true), undefined);
  }
  assert.equal(qwenLookupStep({ ...model, reasoning: "none" }, true), undefined);
  assert.equal(typeof qwenLookupStep({ ...model, reasoning: "none" }), "function");
});
