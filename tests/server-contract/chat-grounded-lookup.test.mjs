import assert from "node:assert/strict";
import test from "node:test";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { getActiveAiModel, qwenLookupStep } from "../../lib/activeAiModel.ts";

const model = { provider: "qwen", apiModel: "qwen3.8-flash" };

test("an evidence-backed direct lookup only disables thinking on step zero and can still search", async (t) => {
  const oldKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "test-only";
  t.after(() => { if (oldKey === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = oldKey; });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const first = bodies.length === 1;
    const message = first ? { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "web_search", arguments: "{}" } }] } : { role: "assistant", content: "Grounded answer" };
    return Response.json({ id: "r" + bodies.length, model: model.apiModel, created: 1, choices: [{ index: 0, message, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } });
  });
  const out = await generateText({
    model: getActiveAiModel(model), prepareStep: qwenLookupStep(model),
    prompt: "Answer from the evidence, searching for missing facts.", stopWhen: stepCountIs(2), maxRetries: 0,
    tools: { web_search: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "verified" }) },
  });
  assert.equal(out.text, "Grounded answer");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].enable_thinking, false);
  assert.equal(Object.hasOwn(bodies[1], "enable_thinking"), false);
  assert.equal(bodies[0].model, bodies[1].model);
  assert.deepEqual(bodies[0].tools, bodies[1].tools);
});

test("reasoning configurations, other models and providers retain their own settings", () => {
  for (const config of [{ ...model, reasoning: "high" }, { ...model, apiModel: "qwen3-max" }, { ...model, provider: "openai" }]) {
    assert.equal(qwenLookupStep(config), undefined);
  }
});
