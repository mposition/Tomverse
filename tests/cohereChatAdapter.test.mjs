import assert from "node:assert/strict";
import test from "node:test";
import { asSchema, generateText, jsonSchema, streamText, tool } from "ai";
import { getActiveAiModel } from "../lib/activeAiModel.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
import { createCohereResearchFetch } from "../lib/cohereResearchFetch.ts";
import { createResearchPreviewExecution } from "../lib/researchPreviewExecution.ts";

const model = { id: "cohere-wire-fixture", provider: "cohere", apiModel: "command-a-plus-05-2026", reasoning: "none" };
const usage = { tokens: { input_tokens: 12, output_tokens: 23 }, billed_units: { input_tokens: 7, output_tokens: 9 } };
const reply = (extra = {}) => ({ id: "cohere-fixture", message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] }, finish_reason: "COMPLETE", usage, ...extra });
const request = (extra = {}) => ({ model: getActiveAiModel(model), ...getModelGenerationSettings(model), prompt: "Calculate 6 * 7.", maxOutputTokens: 128, maxRetries: 0, ...extra });
const optionalTool = tool({ inputSchema: jsonSchema({ type: "object", properties: { title: { type: "string" } }, additionalProperties: false }) });

test.beforeEach(t => {
  for (const [key, value] of Object.entries({ COHERE_API_KEY: "isolated-cohere-wire-fixture", COHERE_CHAT_ENABLED: undefined })) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
});

test("Cohere is available by default and uses native v2, explicit thinking disabled and the existing output cap", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.cohere.com/v2/chat");
    const body = JSON.parse(init.body);
    assert.equal(body.model, model.apiModel);
    assert.equal(body.max_tokens, 128);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.strict_tools, undefined);
    return Response.json(reply());
  });
  const result = await generateText(request());
  assert.equal(calls, 1);
  assert.equal(result.text, "The answer is 42.");
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 23);
  assert.deepEqual(result.usage.raw.billed_units, usage.billed_units);
});

test("explicit Cohere opt-out refuses before client dispatch", async t => {
  process.env.COHERE_CHAT_ENABLED = "false";
  t.mock.method(globalThis, "fetch", async () => assert.fail("disabled Cohere must not dispatch"));
  assert.throws(() => getActiveAiModel(model), /COHERE_CHAT_DISABLED/);
});

test("initial Cohere connection refuses other API model IDs before dispatch", t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("an unverified Cohere model must not dispatch"));
  for (const apiModel of ["command-a-03-2025", "command-a-plus-05-2026-other", "command-a-plus-latest"]) {
    assert.throws(() => getActiveAiModel({ ...model, apiModel }), /COHERE_CHAT_MODEL_UNSUPPORTED/);
  }
});

test("Cohere streams thinking and text separately while preserving raw token and billing units", async t => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    const events = [
      { type: "message-start", id: "cohere-stream-fixture" },
      { type: "content-start", index: 0, delta: { message: { content: { type: "thinking", thinking: "" } } } },
      { type: "content-delta", index: 0, delta: { message: { content: { thinking: "Checking." } } } },
      { type: "content-end", index: 0 },
      { type: "content-start", index: 1, delta: { message: { content: { type: "text", text: "" } } } },
      { type: "content-delta", index: 1, delta: { message: { content: { text: "The answer is 42." } } } },
      { type: "content-end", index: 1 },
      { type: "message-end", delta: { finish_reason: "COMPLETE", usage } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  });
  const result = streamText(request());
  assert.equal(await result.text, "The answer is 42.");
  assert.equal(await result.reasoningText, "Checking.");
  assert.equal((await result.usage).outputTokens, 23);
  assert.deepEqual((await result.usage).raw.billed_units, usage.billed_units);
});

test("missing raw usage rejects before it can become fabricated zero", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(reply({ usage: undefined })); });
  await assert.rejects(generateText(request()));
  assert.equal(calls, 1);
});

test("billed units without raw tokens fail closed without retrying or substituting units", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(reply({ usage: { billed_units: usage.billed_units } })); });
  await assert.rejects(generateText(request()));
  assert.equal(calls, 1);
});

test("Cohere streaming tool arguments reach the existing Chat tool handler", async t => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(init.body).strict_tools, undefined);
    const events = [
      { type: "message-start", id: "cohere-tool-fixture" },
      { type: "tool-call-start", delta: { message: { tool_calls: { id: "artifact", type: "function", function: { name: "create_artifact", arguments: "" } } } } },
      { type: "tool-call-delta", delta: { message: { tool_calls: { function: { arguments: '{"title":"Fixture"}' } } } } },
      { type: "tool-call-end" },
      { type: "message-end", delta: { finish_reason: "TOOL_CALL", usage } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  });
  const result = streamText(request({ tools: { create_artifact: optionalTool } }));
  assert.deepEqual((await result.toolCalls).map(call => ({ name: call.toolName, input: call.input })), [{ name: "create_artifact", input: { title: "Fixture" } }]);
});

test("ordinary Chat preserves optional artifact parameters and does not opt into strict tools", async t => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.strict_tools, undefined);
    assert.equal(body.tools[0].function.parameters.required, undefined);
    return Response.json(reply());
  });
  await generateText(request({ tools: { create_artifact: optionalTool } }));
});

test("forced Research terminal tool filters the SDK tool list and enables strict_tools", async t => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.strict_tools, true);
    assert.equal(body.tool_choice, "REQUIRED");
    assert.deepEqual(body.tools.map(value => value.function.name), ["submit_research_report"]);
    return Response.json(reply({ message: { role: "assistant", tool_calls: [{ id: "report", type: "function", function: { name: "submit_research_report", arguments: '{"summary":"Fixture"}' } }] }, finish_reason: "TOOL_CALL" }));
  });
  const result = await generateText(request({ tools: { other_tool: optionalTool, submit_research_report: tool({ inputSchema: jsonSchema({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false }) }) }, toolChoice: { type: "tool", toolName: "submit_research_report" } }));
  assert.equal(result.toolCalls[0].toolName, "submit_research_report");
  assert.deepEqual(result.toolCalls[0].input, { summary: "Fixture" });
});

test("Research rejects tools plus response_format before a request is sent", () => {
  const fetcher = createCohereResearchFetch(async () => assert.fail("incompatible Research request must not dispatch"));
  assert.throws(() => fetcher("https://api.cohere.com/v2/chat", { body: JSON.stringify({ tools: [{ type: "function", function: { name: "submit_research_report" } }], response_format: { type: "json_object" } }) }), /COHERE_RESEARCH_RESPONSE_FORMAT_WITH_TOOLS/);
});

test("actual Research tool schemas stay within Cohere's strict tool field limit and require a top-level field", async () => {
  const execution = createResearchPreviewExecution({ backend: "brave", totalOutputTokens: 4096, locale: "en", pageReadingEnabled: true, signal: new AbortController().signal });
  let total = 0;
  function fields(value) {
    if (!value || typeof value !== "object") return 0;
    return Object.entries(value).reduce((sum, [key, child]) => sum + (key === "properties" ? Object.keys(child).length : 0) + fields(child), 0);
  }
  for (const [name, definition] of Object.entries(execution.tools)) {
    const schema = await asSchema(definition.inputSchema).jsonSchema;
    assert.ok(schema.required?.length > 0, `${name} needs at least one required top-level field`);
    total += fields(schema);
  }
  assert.ok(total <= 200, `Research tools define ${total} fields`);
});
