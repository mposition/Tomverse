import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createResearchPreviewExecution, RESEARCH_PREVIEW_REPORT_TOOL_NAME, usedResearchOutputTokens } from "../lib/researchPreviewExecution.ts";
import { researchPreviewMessages, researchPreviewInstructions } from "../lib/researchPreviewPrompt.ts";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let backendCalls = [];
const usage = (output = 100, input = 200) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output === undefined ? undefined : output - 20, reasoning: 20 },
});
const call = (name, value, id = name) => ({ type: "tool-call", toolName: name, toolCallId: id, input: JSON.stringify(value) });
const search = (query, id) => call("web_search", { query }, id);
const report = (id = "R1", status = "complete") => ({
  status, summary: "Public evidence summary", findings: id ? [{ heading: "Finding", statements: [{ text: "A bounded fact", sourceIds: [id], kind: "fact" }] }] : [],
  contradictions: [], limitations: ["Only excerpts were available."], nextQuestions: ["What changed since publication?"],
});
const submit = (value = report(), id) => call(RESEARCH_PREVIEW_REPORT_TOOL_NAME, value, id);
const generation = (content, output = 100) => ({ content, usage: usage(output), finishReason: { unified: "tool-calls", raw: undefined }, warnings: [] });

test("Google raw missing usage cannot become a known zero through SDK normalization", () => {
  for (const raw of [{}, { promptTokenCount: 1 }, { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: -1 }]) {
    assert.throws(() => usedResearchOutputTokens([{ usage: { inputTokens: 0, outputTokens: 0, raw } }], "google"), error => error.code === "RESEARCH_PREVIEW_USAGE_UNKNOWN");
  }
  assert.equal(usedResearchOutputTokens([{ usage: { inputTokens: 4, outputTokens: 5, raw: { promptTokenCount: 3, toolUsePromptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 3 } } }], "google"), 5);
});

beforeEach(() => {
  backendCalls = [];
  process.env.NODE_ENV = "test";
  process.env.WEB_SEARCH_FAKE_BACKEND = "0";
  process.env.BRAVE_SEARCH_API_KEY = "offline-fixture-only";
  globalThis.fetch = async (url) => {
    const query = new URL(url).searchParams.get("q");
    backendCalls.push(query);
    return Response.json({ web: { results: Array.from({ length: 5 }, (_, i) => ({
      title: `${query} result ${i}`, url: `https://example.test/${query}/${i}`,
      description: `Public excerpt ${query} ${i}`,
    })) } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ["NODE_ENV", "WEB_SEARCH_FAKE_BACKEND", "BRAVE_SEARCH_API_KEY"]) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});

const run = async (script, options = {}) => {
  const signal = options.signal ?? new AbortController().signal;
  const execution = createResearchPreviewExecution({ backend: "brave", totalOutputTokens: 4096, locale: "en", signal });
  const model = new MockLanguageModelV4({ doGenerate: async (request) => {
    const index = model.doGenerateCalls.length - 1;
    const step = script[index];
    assert.ok(step, "no unplanned repair/fallback generation");
    return typeof step === "function" ? step(request, execution) : step;
  } });
  const pending = generateText({ model, messages: researchPreviewMessages("Compare public sources"),
    system: researchPreviewInstructions({ locale: "en", currentDate: "2026-11-15" }),
    tools: execution.tools, prepareStep: execution.prepareStep, stopWhen: execution.stopWhen,
    maxOutputTokens: 4096, maxRetries: 0, abortSignal: signal,
  });
  try { return { result: await pending, execution, model }; }
  catch (error) { Object.assign(error, { execution, model }); throw error; }
};

test("SDK7 executes at most three generations and spends only remaining total output including reasoning", async () => {
  const { result, execution, model } = await run([
    generation([search(["a", "b", "c"], "s1")], 400),
    generation([search(["d", "e"], "s2")], 500),
    generation([submit(report("R25"), "r1")], 600),
  ]);
  assert.equal(model.doGenerateCalls.length, 3);
  assert.deepEqual(model.doGenerateCalls.map(request => request.maxOutputTokens), [4096, 3696, 3196]);
  assert.deepEqual(model.doGenerateCalls.map(request => request.tools.map(tool => tool.name)), [
    ["web_search"], ["web_search", RESEARCH_PREVIEW_REPORT_TOOL_NAME], [RESEARCH_PREVIEW_REPORT_TOOL_NAME],
  ]);
  assert.equal(result.usage.outputTokens, 1500, "SDK7 usage is aggregate; no deprecated alias required");
  assert.equal(result.usage.inputTokens, 600);
  assert.equal(backendCalls.length, 5);
  assert.equal(execution.registry.snapshot().length, 25);
  assert.equal(execution.finalReport().citedSources[0].sourceId, "R25");
  assert.match(execution.finalReport().content, /https:\/\/example.test\/e\/4/);
  assert.equal(execution.finalReport().citations[0].referenceNumber, 1);
});

test("tool-only early terminal is a nonempty server report and stops all further model work", async () => {
  const { result, execution, model } = await run([generation([search("a", "s1")]), generation([submit()])]);
  assert.equal(result.text, "");
  assert.match(execution.finalReport().content, /Public evidence summary/);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(execution.finalReport().outcome, "complete");
});

test("duplicate terminals accept one report and reject search after terminal", async () => {
  const { execution, model } = await run([
    generation([search("a", "s1")]),
    generation([submit(report("R1"), "r1"), submit(report("R2"), "r2"), search("late", "s2")]),
  ]);
  assert.equal(execution.finalReport().citedSources[0].sourceId, "R1");
  assert.equal(backendCalls.length, 1);
  assert.equal(model.doGenerateCalls.length, 2);
});

test("same-step newly dispatched evidence cannot be cited before the model reads it", async () => {
  const { execution, result } = await run([
    generation([search("a", "s1")]),
    generation([search("b", "s2"), submit(report("R6"), "bad")]),
    generation([submit(report("R99"), "fake")]),
  ]);
  assert.equal(execution.finalReport(), null);
  assert.ok(result.steps.flatMap(step => step.toolResults).some(result => result.output?.reason === "unknown_source"));
});

test("all steps share the five backend attempt counter including duplicate queries", async () => {
  const { execution } = await run([
    generation([search(["a", "b", "c", "d", "e"], "s1")]),
    generation([search(["a", "sixth"], "s2")]),
    generation([submit()]),
  ]);
  assert.equal(backendCalls.length, 5);
  assert.equal(execution.session.snapshot().backendRequestCount, 5);
});

test("unknown model usage stops before another paid generation", async () => {
  const unknown = generation([search("a", "s1")]);
  unknown.usage.outputTokens = { total: undefined, text: undefined, reasoning: undefined };
  await assert.rejects(run([unknown]), error => {
    assert.equal(error.code, "RESEARCH_PREVIEW_USAGE_UNKNOWN");
    assert.equal(error.model.doGenerateCalls.length, 1);
    return true;
  });
});

test("a fully consumed known output allowance stops without claiming usage is unknown", async () => {
  await assert.rejects(run([generation([search("a", "s1")], 4096)]), error => {
    assert.equal(error.code, "RESEARCH_PREVIEW_BUDGET_EXHAUSTED");
    assert.equal(error.model.doGenerateCalls.length, 1); return true;
  });
});

test("no terminal, truncated JSON, and valid insufficient evidence remain distinct", async () => {
  await assert.rejects(run([generation([search("a", "s1")]), generation([{ type: "text", text: "unfinished reasoning" }])]), error => {
    assert.equal(error.execution.finalReport(), null);
    assert.equal(error.model.doGenerateCalls.length, 2); return true;
  });
  const truncated = await run([generation([search("a", "s1")]), generation([{ ...submit(), input: '{"status":' }]), generation([{ ...submit(), input: '{"status":' }])])
    .catch(error => ({ execution: error.execution }));
  assert.equal(truncated.execution.finalReport(), null);
  if (truncated.model) assert.equal(truncated.model.doGenerateCalls.length, 2, "schema failure does not dispatch a repair step");
  await assert.rejects(async () => {
    for await (const chunk of truncated.execution.finalTextStream(new ReadableStream({ start(controller) { controller.close(); } }))) void chunk;
  }, error => error.stopReason === "invalid_report");
  const insufficient = await run([generation([search("a", "s1")]), generation([submit(report(null, "insufficient_evidence"))])]);
  assert.equal(insufficient.execution.finalReport().outcome, "insufficient_evidence");
});

test("a mixed terminal aborts searches already dispatched without resetting their attempt count", async () => {
  const successfulFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).searchParams.get("q") === "pending") {
      backendCalls.push("pending");
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }
    return successfulFetch(url, init);
  };
  const { execution } = await run([
    generation([search("a", "s1")]),
    generation([search("pending", "s2"), submit(report("R1"), "r1")]),
  ]);
  assert.equal(execution.session.snapshot().backendRequestCount, 2);
  assert.equal(execution.session.snapshot().succeededRequestCount, 1);
  assert.equal(execution.finalReport().outcome, "complete");
  assert.equal(cancelled, true);
});

test("caller abort prevents another generation and aborts dispatched backend body", async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start() { queueMicrotask(() => controller.abort()); },
    cancel() { bodyCancelled = true; },
  }));
  await assert.rejects(run([generation([search("a", "s1")])], { signal: controller.signal }), error => {
    assert.equal(error.model.doGenerateCalls.length, 1); return true;
  });
  assert.equal(bodyCancelled, true);
});

test("the actual SDK text stream emits only the server-rendered terminal, with aggregated usage", async () => {
  const signal = new AbortController().signal;
  const execution = createResearchPreviewExecution({ backend: "brave", totalOutputTokens: 4096, locale: "en", signal });
  const script = [[search("a", "s1")], [submit(report("R1"), "r1")]];
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({
    start(controller) {
      const index = model.doStreamCalls.length - 1;
      assert.ok(script[index], "no model dispatch after the terminal");
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "hidden" });
      controller.enqueue({ type: "text-delta", id: "hidden", delta: "INTERMEDIATE_PROSE_MUST_NOT_ESCAPE" });
      controller.enqueue({ type: "text-end", id: "hidden" });
      for (const part of script[index]) controller.enqueue(part);
      controller.enqueue({ type: "finish", usage: usage(100), finishReason: { unified: "tool-calls", raw: undefined } });
      controller.close();
    },
  }) }) });
  const result = streamText({ model, messages: researchPreviewMessages("Compare public sources"),
    tools: execution.tools, prepareStep: execution.prepareStep, stopWhen: execution.stopWhen,
    abortSignal: signal, maxOutputTokens: 4096, maxRetries: 0,
  });
  let text = "";
  for await (const chunk of execution.finalTextStream(result.textStream, result.usage, result.steps)) text += chunk;
  assert.equal(text, execution.finalReport().content);
  assert.ok(!text.includes("INTERMEDIATE_PROSE_MUST_NOT_ESCAPE"));
  assert.ok(!text.includes('"sourceIds"'));
  assert.equal((await result.usage).outputTokens, 200);
  assert.equal(model.doStreamCalls.length, 2);
});

test("a terminal step with unknown usage cannot hide behind the SDK aggregate of earlier known steps", async () => {
  const signal = new AbortController().signal;
  const execution = createResearchPreviewExecution({ backend: "brave", totalOutputTokens: 4096, locale: "en", signal });
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({
    start(controller) {
      const first = model.doStreamCalls.length === 1;
      const stepUsage = usage();
      if (!first) stepUsage.outputTokens = { total: undefined, text: undefined, reasoning: undefined };
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue(first ? search("a", "s1") : submit(report("R1"), "r1"));
      controller.enqueue({ type: "finish", usage: stepUsage, finishReason: { unified: "tool-calls", raw: undefined } });
      controller.close();
    },
  }) }) });
  const result = streamText({ model, messages: researchPreviewMessages("Compare public sources"),
    tools: execution.tools, prepareStep: execution.prepareStep, stopWhen: execution.stopWhen,
    abortSignal: signal, maxOutputTokens: 4096, maxRetries: 0,
  });
  let emitted = "";
  await assert.rejects(async () => {
    for await (const chunk of execution.finalTextStream(result.textStream, result.usage, result.steps)) emitted += chunk;
  }, error => error.code === "RESEARCH_PREVIEW_USAGE_UNKNOWN");
  assert.equal((await result.usage).outputTokens, 100, "SDK aggregate omits missing counts rather than preserving unknown");
  assert.equal((await result.steps)[1].usage.outputTokens, undefined);
  assert.equal(emitted, "");
  assert.equal(model.doStreamCalls.length, 2, "no repair or judge generation follows unknown terminal usage");
});

test("downstream stream cancellation forbids later SDK model dispatch", { timeout: 5000 }, async () => {
  let searchStarted;
  const started = new Promise(resolve => { searchStarted = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    start() { searchStarted(); }, cancel() {},
  }));
  const signal = new AbortController().signal;
  const execution = createResearchPreviewExecution({ backend: "brave", totalOutputTokens: 4096, locale: "en", signal });
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue(model.doStreamCalls.length === 1 ? search("pending", "s1") : submit(report(null, "insufficient_evidence"), "r1"));
      controller.enqueue({ type: "finish", usage: usage(100), finishReason: { unified: "tool-calls", raw: undefined } });
      controller.close();
    },
  }) }) });
  const result = streamText({ model, messages: researchPreviewMessages("Compare public sources"),
    tools: execution.tools, prepareStep: execution.prepareStep, stopWhen: execution.stopWhen,
    abortSignal: signal, maxOutputTokens: 4096, maxRetries: 0, onError: () => {},
  });
  const reader = execution.finalTextStream(result.textStream).getReader();
  await started;
  await reader.cancel("downstream disconnected");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.doStreamCalls.length, 1, "cancelling a text reader must not permit another paid step");
});
