import assert from "node:assert/strict";
import test, { after } from "node:test";
import { generateText, APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
import { collectFromProvider, createCollectionSdkAdapter, observeCollectionBody, collectionReturnedOutcome } from "../lib/routerDevelopmentCollectorProvider.ts";
import { COLLECTION_LIMITS, emptyCollectionObservation, estimateCollectionUsageCost, validateCollectionOutcome } from "../lib/routerDevelopmentCollector.ts";
import { auditProcessingTierMentions, PROCESSING_TIER_REQUEST_ALLOWLIST } from "../scripts/check-processing-tier-core.mjs";

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("PROVIDER_TEST_NETWORK_FORBIDDEN"); };
after(() => { globalThis.fetch = originalFetch; });
const model = AVAILABLE_MODELS.find((entry) => entry.id === DEFAULT_MODEL_ID);
const request = () => ({ modelId: model.id, prompt: "Return the supplied fixture JSON only.", maxOutputTokens: 128000, settings: getModelGenerationSettings(model), signal: new AbortController().signal });
const sdkUsage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

test("actual SDK7 mock proves request boundary, body opt-in, one step, and no normalized evidence", async () => {
  const mock = new MockLanguageModelV4({ doGenerate: { content: [{ type: "text", text: "{}" }, { type: "reasoning", text: "MUST_NOT_BE_RECORDED" }], usage: sdkUsage, finishReason: { unified: "stop", raw: undefined }, response: { body: {} }, warnings: [] } });
  let options;
  const adapter = createCollectionSdkAdapter({ generate: (value) => { options = value; return generateText(value); }, getModel: () => mock, getSettings: getModelGenerationSettings });
  const outcome = await adapter(request());
  assert.equal(mock.doGenerateCalls.length, 1);
  assert.equal(options.maxRetries, 0);
  assert.deepEqual(options.include, { responseBody: true });
  for (const key of ["tools", "repairText", "expected", "caseId", "grading", "stopWhen", "fallback"]) assert.ok(!(key in options));
  assert.equal(outcome.answerText, "{}");
  assert.equal(outcome.observation.inputTokens, null);
  assert.equal(outcome.observation.outputTokens, null);
  assert.equal(outcome.observation.providerResponseId, null);
  assert.equal(outcome.observation.providerReportedModel, null);
  assert.ok(!JSON.stringify(outcome).includes("MUST_NOT_BE_RECORDED"));
});
for (const statusCode of [429, 503]) test(`actual SDK7 retryable ${statusCode} invokes a mock once`, async () => {
  const mock = new MockLanguageModelV4({ doGenerate: async () => { throw new APICallError({ message: "SENSITIVE_ERROR_DO_NOT_STORE", url: "https://example.invalid", requestBodyValues: { secret: "NEVER" }, statusCode, isRetryable: true, responseBody: "{}" }); } });
  const adapter = createCollectionSdkAdapter({ generate: generateText, getModel: () => mock, getSettings: getModelGenerationSettings });
  const outcome = await adapter(request());
  assert.equal(mock.doGenerateCalls.length, 1);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureCode, "provider_http_error");
  assert.ok(!JSON.stringify(outcome).includes("SENSITIVE"));
  assert.ok(!JSON.stringify(outcome).includes("NEVER"));
});

test("raw usage preserves missing versus explicit zero across five adapter families", () => {
  const examples = [
    ["openai", { id: "r", model: "reported", status: "completed", usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }],
    ["xai", { id: "r", model: "reported", choices: [{ finish_reason: "stop", message: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }],
    ["anthropic", { id: "r", model: "reported", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
    ["google", { responseId: "r", modelVersion: "reported", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 0 } }],
    ["moonshot", { id: "r", model: "reported", choices: [{ finish_reason: "stop", message: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, cached_tokens: 0, prompt_tokens_details: { cache_write_tokens: 0 } } }],
  ];
  for (const [provider, body] of examples) {
    const observation = observeCollectionBody(provider, body);
    assert.equal(observation.inputTokens, 3, provider);
    assert.equal(observation.outputTokens, 2, provider);
    assert.equal(observation.providerResponseId, "r", provider);
    assert.equal(observation.providerReportedModel, "reported", provider);
    assert.equal(observation.finish, "stop", provider);
    assert.equal(observeCollectionBody(provider, {}).outputTokens, null);
  }
  assert.equal(observeCollectionBody("google", { usageMetadata: { candidatesTokenCount: 5 } }).outputTokens, null);
  assert.equal(observeCollectionBody("anthropic", { usage: { input_tokens: 5, cache_read_input_tokens: 0 } }).inputTokens, null);
  assert.equal(observeCollectionBody("deepseek", { usage: { prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 5 } } }).cacheReadTokens, null);
  assert.equal(observeCollectionBody("deepseek", { usage: { prompt_cache_hit_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }).cacheReadTokens, 2);
});

test("Google cached reads leave writes, uncached input, and cost unknown despite extra raw and normalized values", async () => {
  const googleModel = AVAILABLE_MODELS.find((entry) => entry.provider === "google");
  assert.ok(googleModel);
  const body = {
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 0, cachedContentTokenCount: 3 },
    // Adversarial non-allowlisted keys, not claims about Google's response schema.
    usage: { input_tokens: 8, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } },
    candidates: [{ finishReason: "STOP" }],
  };
  const normalizedUsage = { inputTokens: { total: 8, noCache: 0, cacheRead: 3, cacheWrite: 5 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
  const mock = new MockLanguageModelV4({ doGenerate: { content: [{ type: "text", text: "{}" }], usage: normalizedUsage,
    finishReason: { unified: "stop", raw: "STOP" }, response: { body }, warnings: [] } });
  const adapter = createCollectionSdkAdapter({ generate: generateText, getModel: () => mock, getSettings: getModelGenerationSettings });
  const outcome = await adapter({ ...request(), modelId: googleModel.id, settings: getModelGenerationSettings(googleModel), maxOutputTokens: 128 });
  assert.equal(mock.doGenerateCalls.length, 1);
  assert.equal(outcome.status, "returned");
  assert.equal(outcome.answerText, "{}");
  assert.deepEqual(outcome.observation, observeCollectionBody("google", body));
  const observation = outcome.observation;
  assert.equal(observation.source, "provider_body_allowlist");
  assert.equal(observation.inputTokens, 8);
  assert.equal(observation.outputTokens, 2);
  assert.equal(observation.cacheReadTokens, 3);
  assert.equal(observation.cacheWriteTokens, null);
  assert.equal(observation.noCacheInputTokens, null);
  const pricedCall = { pricing: { tiers: [{ maxPromptTokens: null, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1,
    cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: 1.25 }] } };
  assert.equal(estimateCollectionUsageCost(observation, pricedCall), null);
});

test("metadata failures, invalid counters, and oversize do not invent evidence", () => {
  for (const number of [-1, Infinity, NaN, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) assert.equal(observeCollectionBody("openai", { usage: { input_tokens: number } }).inputTokens, null);
  const throwing = Object.defineProperty({}, "usage", { get() { throw new Error("SECRET"); }, enumerable: true });
  assert.equal(observeCollectionBody("openai", throwing).source, "unavailable");
  const text = "x".repeat(COLLECTION_LIMITS.answerStorageBytes + 1);
  const outcome = collectionReturnedOutcome("openai", {}, text, 1);
  assert.equal(outcome.status, "measurement_unsupported");
  assert.equal(outcome.answerBytes, Buffer.byteLength(text));
  assert.equal(outcome.answerText, null);
  assert.equal(outcome.textOmitted, true);
  assert.doesNotThrow(() => validateCollectionOutcome(outcome));
});

test("served-tier mismatch is observed read-only and the guard still blocks new outbound selectors", () => {
  const entry = PROCESSING_TIER_REQUEST_ALLOWLIST.find((item) => item.file === "lib/routerDevelopmentCollectorProvider.ts");
  assert.equal(entry.sendsATier, false);
  const lines = entry.mentions.map((text) => ({ file: entry.file, text }));
  assert.deepEqual(auditProcessingTierMentions({ matchedLines: lines, allowlist: [entry] }).errors, []);
  assert.ok(auditProcessingTierMentions({ matchedLines: [...lines, { file: entry.file, text: 'service_tier: "priority",' }], allowlist: [entry] }).errors.length);
  const observation = observeCollectionBody("openai", { service_tier: "priority", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(observation.servedProcessingTier, "priority");
  assert.equal(observation.unsupportedBilling, true);
  assert.equal(observeCollectionBody("openai", {}).servedProcessingTier, null);
});

test("non-standard tier on a provider HTTP error remains unsupported rather than ordinary failed", async () => {
  const adapter = createCollectionSdkAdapter({ getModel: () => ({}), getSettings: getModelGenerationSettings,
    generate: async () => { throw new APICallError({ message: "synthetic", url: "https://example.invalid", requestBodyValues: {}, statusCode: 503,
      responseBody: JSON.stringify({ service_tier: "priority", usage: { input_tokens: 1, output_tokens: 1 } }) }); } });
  const outcome = await adapter(request());
  assert.equal(outcome.status, "measurement_unsupported");
  assert.equal(outcome.failureCode, "provider_billing_unsupported");
  assert.equal(outcome.observation.servedProcessingTier, "priority");
  assert.equal(outcome.observation.unsupportedBilling, true);
  assert.doesNotThrow(() => validateCollectionOutcome(outcome));
});

test("unknown provider metadata is explicitly unsupported without inventing observations", () => {
  for (const provider of ["qwen", "groq", "zhipu", "perplexity", "unknown"]) {
    for (const body of [undefined, {}, { id: "not-an-observation", service_tier: "priority", usage: { prompt_tokens: 1, completion_tokens: 1 } }]) {
      const observation = observeCollectionBody(provider, body);
      assert.deepEqual(observation, { ...emptyCollectionObservation(), unsupportedBilling: true });
      const outcome = collectionReturnedOutcome(provider, body, "{}", 1);
      assert.equal(outcome.status, "measurement_unsupported");
      assert.equal(outcome.failureCode, "provider_family_unsupported");
      assert.doesNotThrow(() => validateCollectionOutcome(outcome));
      assert.throws(() => validateCollectionOutcome({ ...outcome, observation: { ...observation, inputTokens: 0 } }), /collector_unavailable_observation_has_metrics/);
    }
  }
});

test("an unsupported provider is refused before settings, model creation, generate, or SDK entry", async () => {
  const unsupported = AVAILABLE_MODELS.find((entry) => entry.provider === "qwen");
  assert.ok(unsupported);
  const calls = [];
  const adapter = createCollectionSdkAdapter({
    getModel: () => { calls.push("getModel"); return {}; },
    getSettings: () => { calls.push("getSettings"); return {}; },
    generate: async () => { calls.push("generate"); return {}; },
  });
  const input = { ...request(), modelId: unsupported.id, settings: {} };
  await assert.rejects(adapter(input), /collector_provider_family_unsupported/);
  await assert.rejects(collectFromProvider(input), /collector_provider_family_unsupported/);
  assert.deepEqual(calls, []);
});
