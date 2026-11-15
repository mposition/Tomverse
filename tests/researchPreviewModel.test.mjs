import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "ai";
import { z } from "zod";
import { getModel } from "../lib/models.ts";
import { getResearchPreviewAiModel, researchPreviewGoogleFetch } from "../lib/researchPreviewModel.ts";
import { runResearchPreviewStep } from "../lib/researchPreviewStep.ts";
import { createResearchPreviewExecution } from "../lib/researchPreviewExecution.ts";
import { researchPreviewReportSchema } from "../lib/researchPreviewReport.ts";

test("Google SDK internal continuation opens no second Research HTTP request", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let requests = 0;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "offline-research-fixture-only";
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Unfinished output" }] },
      finishReason: "CONTINUATION", continuationToken: "must-not-be-replayed" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } });
  };
  try {
    const configuration = { ...getModel("gemini-3-1-pro"), id: "gemini-4-argon", apiModel: "gemini-4-argon" };
    await assert.rejects(generateText({ model: getResearchPreviewAiModel(configuration), prompt: "A public question", maxOutputTokens: 4096, maxRetries: 0 }), /CONTINUATION_REFUSED/);
    assert.equal(requests, 1);
    await assert.rejects(researchPreviewGoogleFetch("https://generativelanguage.googleapis.com", { body: JSON.stringify({ continuationToken: "no" }) }), /CONTINUATION_REFUSED/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY; else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousKey;
  }
});

test("Argon omits only report array maximum hints while original server bounds still reject oversized reports", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const requests = [];
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "offline-research-fixture-only";
  const oversized = { status: "partial", summary: "An oversized report.", findings: Array.from({ length: 7 }, () => ({
    heading: "Finding", statements: [{ text: "Uncertain.", sourceIds: [], kind: "uncertain" }] })),
    contradictions: [], limitations: ["Fixture."], nextQuestions: [] };
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ functionCall: {
      name: "submit_research_report", args: oversized }, thoughtSignature: "offline-report-signature" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100 } });
  };
  try {
    const signal = new AbortController().signal;
    const execution = createResearchPreviewExecution({ backend: "brave", totalOutputTokens: 4096, locale: "en", signal, stepNumberOffset: 2 });
    const config = { ...getModel("gemini-3-1-pro"), id: "gemini-4-argon", apiModel: "gemini-4-argon" };
    const result = await generateText({ model: getResearchPreviewAiModel(config), prompt: "Submit a bounded report.",
      tools: execution.tools, prepareStep: execution.prepareStep, maxOutputTokens: 4096, maxRetries: 0 });
    assert.equal(requests.length, 1);
    const schema = requests[0].tools[0].functionDeclarations[0].parametersJsonSchema;
    assert.equal(JSON.stringify(schema).includes('"maxItems"'), false);
    assert.equal(schema.properties.findings.items.properties.statements.minItems, 1);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.summary.maxLength, 1600);
    assert.deepEqual(schema.required, Object.keys(researchPreviewReportSchema.shape));
    assert.ok(result.steps[0].content.some(part => part.type === "tool-error"));
    assert.equal(execution.finalReport(), null);
    assert.equal(researchPreviewReportSchema.safeParse(oversized).success, false);
    // Other tools and other Google models retain their own schema bounds.
    const body = { tools: [{ functionDeclarations: [{ name: "web_search", parametersJsonSchema: z.toJSONSchema(z.array(z.string()).max(5)) }] }] };
    await researchPreviewGoogleFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent", { body: JSON.stringify(body) });
    assert.equal(requests[1].tools[0].functionDeclarations[0].parametersJsonSchema.maxItems, 5);
    body.tools[0].functionDeclarations[0] = { name: "submit_research_report", parametersJsonSchema: z.toJSONSchema(researchPreviewReportSchema) };
    await researchPreviewGoogleFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent", { body: JSON.stringify(body) });
    assert.equal(requests[2].tools[0].functionDeclarations[0].parametersJsonSchema.properties.findings.maxItems, 6);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY; else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousKey;
  }
});

test("Google SDK preserves signed parallel tool calls across research checkpoints", async () => {
  const previousFetch = globalThis.fetch;
  const keys = ["GOOGLE_GENERATIVE_AI_API_KEY", "WEB_SEARCH_FAKE_BACKEND", "NODE_ENV"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests = [];
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "offline-research-fixture-only";
  process.env.WEB_SEARCH_FAKE_BACKEND = "1";
  process.env.NODE_ENV = "test";
  const report = { status: "partial", summary: "Public release evidence.", findings: [{ heading: "Releases",
    statements: [{ text: "The release schedule is public.", sourceIds: ["R1"], kind: "fact" }] }],
    contradictions: [], limitations: ["Offline protocol fixture."], nextQuestions: [] };
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const parts = requests.length === 1 ? [
      { functionCall: { name: "web_search", args: { query: "Node.js release schedule" } }, thoughtSignature: "offline-signed-first-call" },
      { functionCall: { name: "web_search", args: { query: "Node.js release phases" } } },
    ] : [{ functionCall: { name: "submit_research_report", args: report }, thoughtSignature: "offline-signed-report" }];
    return Response.json({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 0 } });
  };
  try {
    const modelConfig = { ...getModel("gemini-3-1-pro"), id: "gemini-4-argon", apiModel: "gemini-4-argon", reasoning: "low" };
    const input = { modelConfig, model: getResearchPreviewAiModel(modelConfig), question: "Compare official Node.js releases.",
      locale: "en", currentDate: "2026-11-15", totalOutputTokens: 4096, inputTokenCeiling: 1_000_000,
      pageReadingEnabled: true, signal: new AbortController().signal };
    const first = await runResearchPreviewStep(input);
    const second = await runResearchPreviewStep({ ...input, checkpoint: JSON.parse(JSON.stringify(first.checkpoint)) });
    assert.equal(requests.length, 2);
    const assistant = requests[1].contents.find(content => content.role === "model");
    assert.equal(assistant.parts[0].thoughtSignature, "offline-signed-first-call");
    assert.equal(assistant.parts[1].thoughtSignature, undefined);
    assert.equal(assistant.parts.filter(part => part.functionCall).length, 2);
    assert.equal(requests[1].contents.at(-1).parts.filter(part => part.functionResponse).length, 2);
    assert.equal(second.finished, true);
    assert.equal(second.checkpoint.stopReason, "report_submitted");
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test("OpenAI Responses forces only the application search function, never native search", async () => {
  const previousFetch = globalThis.fetch;
  const keys = ["OPENAI_API_KEY", "WEB_SEARCH_FAKE_BACKEND", "NODE_ENV"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests = [];
  process.env.OPENAI_API_KEY = "offline-research-fixture-only";
  process.env.WEB_SEARCH_FAKE_BACKEND = "1";
  process.env.NODE_ENV = "test";
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ id: "resp_offline", object: "response", created_at: 1, model: "gpt-6-luna", status: "completed",
      output: [{ id: "fc_offline", type: "function_call", call_id: "call_offline", name: "web_search", arguments: '{"query":"public release schedule"}', status: "completed" }],
      usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
  };
  try {
    const modelConfig = { ...getModel("gpt-6-luna"), reasoning: "low" };
    const result = await runResearchPreviewStep({ modelConfig, model: getResearchPreviewAiModel(modelConfig),
      question: "Compare official Node.js releases.", locale: "en", currentDate: "2026-11-15",
      totalOutputTokens: 4096, inputTokenCeiling: 1_000_000, pageReadingEnabled: true, signal: new AbortController().signal });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tool_choice, "required");
    assert.deepEqual(requests[0].tools.map(tool => [tool.type, tool.name]), [["function", "web_search"]]);
    assert.equal(result.checkpoint.completedSteps, 1);
    assert.equal(result.checkpoint.search.backendRequestCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
