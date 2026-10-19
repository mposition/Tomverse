import assert from "node:assert/strict";
import test from "node:test";

import { marketingLlmBudgetRequestSchema, marketingLlmBudgetRequestSigned } from "@/lib/marketingLlmBudgetRequest";
import {
  MARKETING_LLM_ADAPTER_VERSION,
  marketingLlmAdapterConfigDigest,
  marketingLlmConfigSnapshot,
} from "@/lib/marketingLlmBudgetCore";
import {
  MARKETING_LLM_CHAT_COMPLETIONS_URL,
  MARKETING_LLM_RESPONSES_URL,
  marketingLlmBudgetHttpPort,
  marketingLlmRequestBody,
  marketingLlmWebSearchRequestBody,
  readMarketingLlmProviderAnswer,
  readMarketingLlmWebSearchAnswer,
  runMarketingLlmCall,
} from "@/lib/marketingLlmClientCore";

const PIN = {
  model: "fixture-model-2026-10-01",
  tokenizerFamily: "o200k",
  projectId: "proj_fixture",
  region: "us",
  tiers: ["default"],
  contextWindowTokens: 128_000,
  worstInputMicroUsdPerMillion: 800_000,
  worstOutputMicroUsdPerMillion: 3_200_000,
  maxOutputTokens: 4_096,
  priceVersion: "fixture-v1",
  verifiedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-12-30T00:00:00.000Z",
  source: "https://example.invalid/pricing",
};
const MESSAGES = [
  { role: "system", content: "Write one LinkedIn post from the facts given." },
  { role: "user", content: "{\"facts\":[]}" },
];

const completion = (overrides = {}) => ({
  model: PIN.model,
  service_tier: "default",
  usage: { prompt_tokens: 120, completion_tokens: 80 },
  choices: [{ message: { role: "assistant", content: "Three answers, side by side." } }],
  ...overrides,
});

/** A budget port that answers from a script and records what it was asked. */
function budget(script = {}) {
  const calls = [];
  const answers = {
    reserve: { httpStatus: 200, body: { status: "ok", replay: false, callId: "call0000000000000000001", reservedMicroUsd: 115_508 } },
    dispatch: { httpStatus: 200, body: { status: "ok", replay: false, callId: "call0000000000000000001", firstConsumption: true } },
    settle: { httpStatus: 200, body: { status: "ok", replay: false, callId: "call0000000000000000001", state: "settled", reason: "settled" } },
    unknown: { httpStatus: 200, body: { status: "ok", replay: false, callId: "call0000000000000000001", state: "unknown_retained" } },
    release: { httpStatus: 200, body: { status: "ok", replay: false, callId: "call0000000000000000001", state: "released" } },
    ...script,
  };
  const port = async (action, fields) => {
    calls.push({ action, fields });
    const answer = answers[action];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { port, calls, actions: () => calls.map((call) => call.action) };
}

/** A provider transport that counts its attempts. */
function provider(respond) {
  const requests = [];
  const transport = async (url, init) => {
    requests.push({ url: String(url), init });
    return respond(requests.length);
  };
  return { transport, requests };
}
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let counter = 0;
const ids = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const run = (b, p, extra = {}) =>
  runMarketingLlmCall(
    { pin: PIN, generatorRunId: "run-1", purpose: "draft", messages: MESSAGES },
    { budget: b.port, transport: p.transport, apiKey: "sk-fixture", newId: ids, ...extra },
  );

test("the provider request is the allowlist and nothing else", () => {
  const body = marketingLlmRequestBody(PIN, MESSAGES);
  assert.deepEqual(Object.keys(body).sort(), [
    "max_completion_tokens",
    "messages",
    "model",
    "service_tier",
    "store",
    "stream",
  ]);
  assert.equal(body.max_completion_tokens, PIN.maxOutputTokens);
  assert.equal(body.service_tier, "default");
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
});

test("an answered call: reserve, dispatch, one provider request, settle with what came back", async () => {
  const b = budget();
  const p = provider(() => jsonResponse(200, completion()));
  const outcome = await run(b, p);
  assert.equal(outcome.status, "answered");
  assert.equal(outcome.content, "Three answers, side by side.");
  assert.equal(outcome.ledgerState, "settled");
  assert.deepEqual(b.actions(), ["reserve", "dispatch", "settle"]);
  assert.equal(p.requests.length, 1);

  const [request] = p.requests;
  assert.equal(request.url, MARKETING_LLM_CHAT_COMPLETIONS_URL);
  assert.equal(request.init.headers["openai-project"], PIN.projectId);
  assert.deepEqual(JSON.parse(request.init.body), marketingLlmRequestBody(PIN, MESSAGES));

  const dispatch = b.calls[1].fields;
  assert.equal(
    dispatch.adapterConfigDigest,
    marketingLlmAdapterConfigDigest(marketingLlmConfigSnapshot({ pin: PIN, adapterVersion: MARKETING_LLM_ADAPTER_VERSION })),
  );
  const settle = b.calls[2].fields;
  assert.deepEqual(
    { model: settle.reportedModel, tier: settle.reportedServiceTier, input: settle.reportedInputTokens, output: settle.reportedOutputTokens },
    { model: PIN.model, tier: "default", input: 120, output: 80 },
  );
  assert.equal(settle.dispatchIntentId, dispatch.dispatchIntentId);
});

test("a refused reservation sends nothing to the provider", async () => {
  const b = budget({ reserve: { httpStatus: 200, body: { status: "refused", code: "model_not_pinned" } } });
  const p = provider(() => jsonResponse(200, completion()));
  assert.deepEqual(await run(b, p), { status: "refused", stage: "reserve", code: "model_not_pinned" });
  assert.deepEqual(b.actions(), ["reserve"]);
  assert.equal(p.requests.length, 0);
});

test("giving up before dispatch releases the reservation and calls nothing", async () => {
  const b = budget();
  const p = provider(() => jsonResponse(200, completion()));
  const outcome = await run(b, p, { proceed: () => false });
  assert.equal(outcome.status, "released");
  assert.deepEqual(b.actions(), ["reserve", "release"]);
  assert.equal(p.requests.length, 0);
});

for (const [name, respond] of [
  ["429", () => jsonResponse(429, { error: { message: "rate limited" } })],
  ["503", () => jsonResponse(503, { error: { message: "unavailable" } })],
  ["a dropped connection", () => { throw new TypeError("fetch failed"); }],
  ["a body that is not a completion", () => jsonResponse(200, { choices: [] })],
  ["a completion without usage", () => jsonResponse(200, completion({ usage: undefined }))],
]) {
  test(`${name}: exactly one provider attempt, reported unknown, never released`, async () => {
    const b = budget();
    const p = provider(respond);
    const outcome = await run(b, p);
    assert.equal(outcome.status, "unknown");
    assert.equal(p.requests.length, 1);
    assert.deepEqual(b.actions(), ["reserve", "dispatch", "unknown"]);
  });
}

test("a replayed receipt is reported unknown without calling the provider, and is not released", async () => {
  const b = budget({
    dispatch: { httpStatus: 200, body: { status: "ok", replay: true, callId: "call0000000000000000001", firstConsumption: false } },
  });
  const p = provider(() => jsonResponse(200, completion()));
  const outcome = await run(b, p);
  assert.equal(outcome.status, "unknown");
  assert.equal(p.requests.length, 0);
  assert.deepEqual(b.actions(), ["reserve", "dispatch", "unknown"]);
});

test("a lost dispatch answer stops: no provider call, no release, no unknown", async () => {
  const b = budget({ dispatch: new Error("socket hang up") });
  const p = provider(() => jsonResponse(200, completion()));
  const outcome = await run(b, p);
  assert.equal(outcome.status, "stopped");
  assert.equal(outcome.stage, "dispatch");
  assert.equal(p.requests.length, 0);
  assert.deepEqual(b.actions(), ["reserve", "dispatch"]);
});

test("a refused dispatch calls nothing and reports nothing more", async () => {
  const b = budget({ dispatch: { httpStatus: 200, body: { status: "refused", code: "kill_switch" } } });
  const p = provider(() => jsonResponse(200, completion()));
  assert.deepEqual(await run(b, p), { status: "refused", stage: "dispatch", code: "kill_switch" });
  assert.equal(p.requests.length, 0);
  assert.deepEqual(b.actions(), ["reserve", "dispatch"]);
});

test("a settle the ledger has already closed stops, keeping the answer it cannot yet submit", async () => {
  const b = budget({ settle: { httpStatus: 409, body: { status: "conflict" } } });
  const p = provider(() => jsonResponse(200, completion()));
  const outcome = await run(b, p);
  assert.equal(outcome.status, "stopped");
  assert.equal(outcome.stage, "settle");
  assert.equal(outcome.content, "Three answers, side by side.");
  assert.equal(p.requests.length, 1);
  assert.deepEqual(b.actions(), ["reserve", "dispatch", "settle"]);
});

test("an answer the ledger keeps as unknown is not returned: the caller stops on it", async () => {
  const b = budget({
    settle: { httpStatus: 200, body: { status: "ok", replay: false, callId: "call0000000000000000001", state: "unknown_retained", reason: "tier_mismatch" } },
  });
  const p = provider(() => jsonResponse(200, completion({ service_tier: "priority" })));
  const outcome = await run(b, p);
  assert.equal(outcome.status, "retained");
  assert.equal(outcome.ledgerState, "unknown_retained");
  assert.equal("content" in outcome, false, "the unconfirmed answer is not handed back");
  assert.equal(b.calls[2].fields.reportedServiceTier, "priority");
});

test("a settle answer that names no state is not taken as settled", async () => {
  const b = budget({
    settle: { httpStatus: 200, body: { status: "ok", replay: false, callId: "call0000000000000000001" } },
  });
  const outcome = await run(b, provider(() => jsonResponse(200, completion())));
  assert.equal(outcome.status, "retained");
  assert.equal("content" in outcome, false);
});

test("the HTTP budget port signs each action the way the app's route verifies it", async () => {
  const sent = [];
  const port = marketingLlmBudgetHttpPort({
    appUrl: "https://app.example.invalid",
    secret: "g".repeat(48),
    deadlineAt: "2026-10-16T01:00:00.000Z",
    fetch: async (url, init) => {
      sent.push({ url: String(url), init });
      return jsonResponse(200, { status: "ok" });
    },
  });
  await port("reserve", {
    requestKey: "00000000-0000-4000-8000-000000000001",
    generatorRunId: "run-1",
    purpose: "draft",
    model: PIN.model,
    adapterProfile: "text-only-v1",
  });
  assert.equal(sent[0].url, "https://app.example.invalid/api/internal/marketing-llm-budget");
  assert.equal(sent[0].init.headers.authorization, `Bearer ${"g".repeat(48)}`);
  const parsed = marketingLlmBudgetRequestSchema.parse(JSON.parse(sent[0].init.body));
  assert.equal(marketingLlmBudgetRequestSigned("g".repeat(48), parsed), true);
  assert.equal(marketingLlmBudgetRequestSigned("h".repeat(48), parsed), false);
});

test("a budget request that hangs is aborted into a lost answer, which stops the call", async () => {
  const controller = new AbortController();
  const port = marketingLlmBudgetHttpPort({
    appUrl: "https://app.example.invalid",
    secret: "g".repeat(48),
    deadlineAt: "2026-10-16T01:00:00.000Z",
    signal: controller.signal,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });
  const p = provider(() => jsonResponse(200, completion()));
  const pending = runMarketingLlmCall(
    { pin: PIN, generatorRunId: "run-1", purpose: "draft", messages: MESSAGES },
    { budget: port, transport: p.transport, apiKey: "sk-fixture", newId: ids },
  );
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.status, "stopped");
  assert.equal(outcome.stage, "reserve");
  assert.equal(p.requests.length, 0);
});

test("a provider answer is read only when every field the ledger needs is there", () => {
  assert.deepEqual(readMarketingLlmProviderAnswer(completion()), {
    content: "Three answers, side by side.",
    citations: [],
    model: PIN.model,
    serviceTier: "default",
    inputTokens: 120,
    outputTokens: 80,
  });
  for (const broken of [
    null,
    completion({ model: 3 }),
    completion({ service_tier: undefined }),
    completion({ usage: { prompt_tokens: -1, completion_tokens: 1 } }),
    completion({ usage: { prompt_tokens: 1.5, completion_tokens: 1 } }),
    completion({ choices: [{ message: { content: null } }] }),
  ]) {
    assert.equal(readMarketingLlmProviderAnswer(broken), null);
  }
});

// ---------------------------------------------------------------------------
// Web search (A3): the Responses API with one domain-limited search tool.

const SEARCH_PIN = { ...PIN, webSearchMicroUsdPerCall: 10_000, maxWebSearchCalls: 3 };
const searchAnswer = (overrides = {}) => ({
  status: "completed",
  model: PIN.model,
  service_tier: "default",
  usage: { input_tokens: 9_000, output_tokens: 400 },
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search" } },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: '{"facts":[]}',
          annotations: [
            { type: "url_citation", url: "https://claude.com/pricing?utm_source=chatgpt.com", title: "Pricing" },
            { type: "url_citation", url: "https://claude.com/pricing?utm_source=chatgpt.com", title: "Pricing" },
          ],
        },
      ],
    },
  ],
  ...overrides,
});

test("a web-search request is one domain-limited search tool, capped at the pin's search count", () => {
  const body = marketingLlmWebSearchRequestBody(SEARCH_PIN, MESSAGES, ["claude.com", "support.claude.com"]);
  assert.deepEqual(Object.keys(body).sort(), [
    "input",
    "instructions",
    "max_output_tokens",
    "max_tool_calls",
    "model",
    "service_tier",
    "store",
    "stream",
    "tools",
  ]);
  assert.equal(body.max_tool_calls, 3);
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, [
    {
      type: "web_search",
      filters: { allowed_domains: ["claude.com", "support.claude.com"] },
      search_context_size: "low",
      user_location: { type: "approximate" },
    },
  ]);
  assert.equal(body.instructions, MESSAGES[0].content);
  assert.equal(body.input, MESSAGES[1].content);
});

test("a web-search answer is read with its cited URLs, once each, or not at all", () => {
  assert.deepEqual(readMarketingLlmWebSearchAnswer(searchAnswer()), {
    content: '{"facts":[]}',
    citations: ["https://claude.com/pricing?utm_source=chatgpt.com"],
    model: PIN.model,
    serviceTier: "default",
    inputTokens: 9_000,
    outputTokens: 400,
  });
  for (const broken of [
    null,
    searchAnswer({ status: "incomplete" }),
    searchAnswer({ model: 3 }),
    searchAnswer({ usage: { input_tokens: -1, output_tokens: 1 } }),
    searchAnswer({ output: [] }),
  ]) {
    assert.equal(readMarketingLlmWebSearchAnswer(broken), null, JSON.stringify(broken));
  }
});

test("a web-search call reserves under its own profile, calls the Responses API once and returns the citations", async () => {
  const b = budget();
  const p = provider(() => jsonResponse(200, searchAnswer()));
  const outcome = await runMarketingLlmCall(
    { pin: SEARCH_PIN, generatorRunId: "run-1", purpose: "market_intel", messages: MESSAGES, webSearch: { allowedDomains: ["claude.com"] } },
    { budget: b.port, transport: p.transport, apiKey: "sk-fixture", newId: ids },
  );
  assert.equal(outcome.status, "answered");
  assert.deepEqual(outcome.citations, ["https://claude.com/pricing?utm_source=chatgpt.com"]);
  assert.deepEqual(b.actions(), ["reserve", "dispatch", "settle"]);
  assert.equal(b.calls[0].fields.adapterProfile, "web-search-v1");
  assert.equal(
    b.calls[1].fields.adapterConfigDigest,
    marketingLlmAdapterConfigDigest(
      marketingLlmConfigSnapshot({ pin: SEARCH_PIN, adapterVersion: MARKETING_LLM_ADAPTER_VERSION, adapterProfile: "web-search-v1" }),
    ),
  );
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].url, MARKETING_LLM_RESPONSES_URL);
  assert.equal(JSON.parse(p.requests[0].init.body).max_tool_calls, 3);
});
