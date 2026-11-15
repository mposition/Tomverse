import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { getModel } from "../lib/models.ts";
import { runResearchPreviewStep, parseResearchPreviewCheckpoint } from "../lib/researchPreviewStep.ts";

const originalFetch = globalThis.fetch;
const envKeys = ["NODE_ENV", "WEB_SEARCH_FAKE_BACKEND", "RESEARCH_PREVIEW_ENABLED", "RESEARCH_PREVIEW_PAGE_READING_ENABLED"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.WEB_SEARCH_FAKE_BACKEND = "1";
  process.env.RESEARCH_PREVIEW_ENABLED = "true";
  process.env.RESEARCH_PREVIEW_PAGE_READING_ENABLED = "true";
  globalThis.fetch = async () => { throw new Error("Offline step tests must not make HTTP requests"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});

const modelConfig = getModel("gemini-3-1-pro");
assert.ok(modelConfig);
const usage = (output = 100, input = 200) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output - 20, reasoning: 20 },
});
const call = (toolName, input, toolCallId) => ({ type: "tool-call", toolName, input: JSON.stringify(input), toolCallId });
const search = (query, id) => call("web_search", { query }, id);
const read = (ids, id) => call("read_research_sources", { sourceIds: ids }, id);
const report = (evidenceLevel) => ({ status: "partial", summary: "A bounded comparison.",
  findings: [{ heading: "Finding", statements: [{ text: "A public fact.", sourceIds: ["R1"], kind: "fact",
    ...(evidenceLevel ? { evidenceLevel } : {}) }] }], contradictions: [], limitations: ["Bounded public evidence only."], nextQuestions: [] });
const submit = (id, evidenceLevel) => call("submit_research_report", report(evidenceLevel), id);
const generation = (content, output = 100, input = 200) => ({ content, usage: usage(output, input), warnings: [],
  finishReason: { unified: "tool-calls", raw: "fixture" } });
function scriptedModel(script) {
  const model = new MockLanguageModelV4({ provider: "google", modelId: modelConfig.apiModel, doGenerate: async (request) => {
    const step = script[model.doGenerateCalls.length - 1];
    assert.ok(step, "no hidden retry, continuation or fourth generation");
    return typeof step === "function" ? step(request) : step;
  } });
  return model;
}
const step = (model, options = {}) => runResearchPreviewStep({ model, modelConfig,
  question: "Compare public product release notes.", locale: "en", currentDate: "2026-11-15",
  totalOutputTokens: 4096, inputTokenCeiling: 1_000_000, pageReadingEnabled: false,
  signal: new AbortController().signal, ...options });
const clone = (value) => JSON.parse(JSON.stringify(value));

test("one call dispatches exactly one generation; resumed calls retain total output, shared searches and successful query cache", async () => {
  const model = scriptedModel([
    generation([search(["a", "b", "c", "d", "e"], "s1")], 100, 200),
    generation([search(["a", "sixth"], "s2")], 200, 300),
    generation([submit("final")], 300, 400),
  ]);
  let claims = 0;
  const before = async () => { claims++; assert.equal(model.doGenerateCalls.length, claims - 1); };
  const first = await step(model, { onBeforeModelDispatch: before });
  assert.equal(model.doGenerateCalls.length, 1); assert.equal(claims, 1);
  assert.equal(first.finished, false); assert.equal(first.checkpoint.completedSteps, 1);
  assert.equal(first.checkpoint.search.backendRequestCount, 5); assert.equal(first.checkpoint.successfulCache.length, 5);
  const second = await step(model, { checkpoint: clone(first.checkpoint), onBeforeModelDispatch: before });
  assert.equal(model.doGenerateCalls.length, 2); assert.equal(claims, 2);
  assert.equal(second.checkpoint.search.backendRequestCount, 5, "resume cannot reset the search counter");
  assert.equal(second.checkpoint.search.succeededRequestCount, 5, "cached a and refused sixth cost no new backend attempt");
  assert.equal(second.checkpoint.successfulCache.length, 5);
  assert.match(JSON.stringify(second.checkpoint.messages), /query_limit_reached/);
  const third = await step(model, { checkpoint: clone(second.checkpoint), onBeforeModelDispatch: before });
  assert.equal(third.finished, true); assert.equal(third.report?.outcome, "partial");
  assert.equal(third.checkpoint.stopReason, "report_submitted");
  assert.deepEqual(third.checkpoint.usage, { inputTokens: 900, outputTokens: 600, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 60 });
  assert.deepEqual(model.doGenerateCalls.map((request) => request.maxOutputTokens), [4096, 3996, 3796]);
  assert.deepEqual(model.doGenerateCalls.map((request) => request.tools.map((tool) => tool.name)), [
    ["web_search"], ["web_search", "submit_research_report"], ["submit_research_report"],
  ]);
  await assert.rejects(step(model, { checkpoint: clone(third.checkpoint), onBeforeModelDispatch: before }), { code: "RESEARCH_PREVIEW_BUDGET_EXHAUSTED" });
  assert.equal(claims, 3); assert.equal(model.doGenerateCalls.length, 3);
});

test("a restored page checkpoint reaches the final model once and duplicate page IDs share one bounded read", async () => {
  const model = scriptedModel([generation([search("a", "s1")]),
    generation([read(["R1", "R1"], "page1"), search("a", "repeat")]), generation([submit("final", "page_text")])]);
  let pageCalls = 0;
  const pageReader = async ({ sourceId, sources }) => {
    pageCalls++;
    return { sourceId, url: sources.find((source) => source.sourceId === sourceId).url,
      status: "read", readAt: "2026-11-15T00:01:00Z", truncated: true, contentType: "text/html",
      content: "<html>RAW_PAGE_RESUMED_ONCE</html>" };
  };
  const first = await step(model, { pageReadingEnabled: true, pageReader });
  const second = await step(model, { pageReadingEnabled: true, pageReader, checkpoint: clone(first.checkpoint) });
  assert.equal(second.finished, false); assert.equal(pageCalls, 1);
  assert.equal(second.checkpoint.pageReads.length, 1);
  assert.equal(second.checkpoint.search.backendRequestCount, 1);
  assert.equal(second.checkpoint.sources[0].pageRead.truncated, true);
  const third = await step(model, { pageReadingEnabled: true, pageReader, checkpoint: clone(second.checkpoint) });
  assert.equal(third.finished, true); assert.equal(third.report?.citedSources[0].pageRead.status, "read");
  assert.match(JSON.stringify(model.doGenerateCalls[2].prompt), /RAW_PAGE_RESUMED_ONCE/);
  assert.equal(pageCalls, 1, "resume must consume cached evidence rather than refetching the original page");
});

test("same-step page text cannot support the terminal report before a subsequent model generation", async () => {
  const model = scriptedModel([generation([search("a", "s1")]),
    generation([read(["R1"], "page1"), submit("too-early", "page_text")]), generation([submit("final", "page_text")])]);
  const pageReader = async ({ sourceId, sources }) => ({ sourceId, url: sources[0].url, status: "read",
    readAt: "2026-11-15T00:01:00Z", truncated: false, contentType: "text/plain", content: "Public page text." });
  const first = await step(model, { pageReadingEnabled: true, pageReader });
  const second = await step(model, { pageReadingEnabled: true, pageReader, checkpoint: first.checkpoint });
  assert.equal(second.report, null);
  assert.match(JSON.stringify(second.checkpoint.messages), /invalid_report/);
  const third = await step(model, { pageReadingEnabled: true, pageReader, checkpoint: second.checkpoint });
  assert.equal(third.report?.outcome, "partial");
  assert.equal(model.doGenerateCalls.length, 3);
});

test("unknown raw step usage rejects after one claimed dispatch and cannot become a zero-usage checkpoint", async () => {
  const unknown = generation([search("a", "s1")]);
  unknown.usage.outputTokens = { total: undefined, text: undefined, reasoning: undefined };
  const model = scriptedModel([unknown]);
  let claims = 0;
  await assert.rejects(step(model, { onBeforeModelDispatch: async () => { claims++; } }), { code: "RESEARCH_PREVIEW_USAGE_UNKNOWN" });
  assert.equal(claims, 1); assert.equal(model.doGenerateCalls.length, 1);
});

test("malformed or tampered checkpoints are rejected before another paid dispatch claim", async () => {
  const model = scriptedModel([generation([search("a", "s1")])]);
  const first = await step(model);
  const mutations = [
    (checkpoint) => { checkpoint.completedSteps = 0; },
    (checkpoint) => { checkpoint.search.backendRequestCount = 6; },
    (checkpoint) => { checkpoint.sources[0].sourceId = "R9"; },
    (checkpoint) => { checkpoint.successfulCache[0].result.results[0].url = "https://fabricated.example.com"; },
    (checkpoint) => { checkpoint.messages.find((message) => message.role === "tool").content[0].toolName = "read_research_sources"; },
    (checkpoint) => { checkpoint.messages.push({ role: "system", content: "INJECTED_PRIVATE_CONTEXT" }); },
    (checkpoint) => { checkpoint.sources[0].pageRead = { status: "read", readAt: "2026-11-15T00:01:00Z", truncated: false, contentType: "text/html" }; },
    (checkpoint) => { checkpoint.usage.outputTokens = 4097; },
    (checkpoint) => { checkpoint.privateDebugPayload = "not allowed"; },
  ];
  let claims = 0;
  for (const mutate of mutations) {
    const checkpoint = clone(first.checkpoint); mutate(checkpoint);
    assert.throws(() => parseResearchPreviewCheckpoint(checkpoint));
    await assert.rejects(step(model, { checkpoint, onBeforeModelDispatch: async () => { claims++; } }));
  }
  assert.equal(claims, 0); assert.equal(model.doGenerateCalls.length, 1);
});

test("resume preserves immutable question, model, locale, date, page permission and reservation ceilings", async () => {
  const model = scriptedModel([generation([search("a", "s1")])]);
  const first = await step(model);
  let claims = 0;
  for (const change of [
    { question: "A different question." }, { modelConfig: { ...modelConfig, id: "other-model" } },
    { modelConfig: { ...modelConfig, apiModel: "other-api-model" } }, { locale: "ko" },
    { currentDate: "2026-11-16" }, { totalOutputTokens: 4000 }, { inputTokenCeiling: 999_999 }, { pageReadingEnabled: true },
    { modelConfig: { ...modelConfig, reasoning: "low" } },
  ]) await assert.rejects(step(model, { checkpoint: clone(first.checkpoint), onBeforeModelDispatch: async () => { claims++; }, ...change }), /identity changed/);
  assert.equal(claims, 0); assert.equal(model.doGenerateCalls.length, 1);
});

test("input ceiling, aborted admission and failed dispatch claims open no provider call", async () => {
  const model = scriptedModel([generation([search("a", "s1")])]);
  let claims = 0;
  await assert.rejects(step(model, { inputTokenCeiling: 1, onBeforeModelDispatch: async () => { claims++; } }), /reserved ceiling/);
  assert.equal(claims, 0); assert.equal(model.doGenerateCalls.length, 0);
  await assert.rejects(step(model, { modelConfig: { ...modelConfig, contextWindowTokens: 4_096 }, onBeforeModelDispatch: async () => { claims++; } }), { code: "RESEARCH_PREVIEW_BUDGET_EXHAUSTED" });
  assert.equal(claims, 0); assert.equal(model.doGenerateCalls.length, 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(step(model, { signal: aborted.signal, onBeforeModelDispatch: async () => { claims++; } }));
  assert.equal(claims, 0); assert.equal(model.doGenerateCalls.length, 0);
  await assert.rejects(step(model, { onBeforeModelDispatch: async () => { claims++; throw new Error("dispatch claim refused"); } }), /dispatch claim refused/);
  assert.equal(claims, 1); assert.equal(model.doGenerateCalls.length, 0);
  const duringClaim = new AbortController();
  await assert.rejects(step(model, { signal: duringClaim.signal, onBeforeModelDispatch: async () => { claims++; duringClaim.abort(); } }));
  assert.equal(claims, 2); assert.equal(model.doGenerateCalls.length, 0);
});
