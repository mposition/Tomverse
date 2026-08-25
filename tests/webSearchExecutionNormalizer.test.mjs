import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebSearchExecution } from "../lib/webSearchExecutionNormalizer.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";

const openaiCapability = getWebSearchCapability("gpt-5-5");
const anthropicCapability = getWebSearchCapability("claude-sonnet-5");
// Native, priced per query, and with no ceiling any request can impose --
// so nothing may dispatch it today. Kept under its own name because the
// contract it exercises is "the register says native and the answer is still
// no".
const googleCapability = getWebSearchCapability("gemini-3-6-flash");
// The same tool the day Google ships a per-request cap. Only the ceiling
// differs, which is the point: the normalizer's cost arithmetic is keyed on
// the provider and is ready for it.
const boundedGoogleCapability = {
  ...googleCapability,
  maxBillableSearchQueriesPerRequest: 5,
};
const perplexityCapability = getWebSearchCapability("perplexity/sonar");
const unsupportedCapability = getWebSearchCapability("codestral");

test("off mode never claims a search happened, even for a native-capable model", () => {
  const result = normalizeWebSearchExecution({
    capability: openaiCapability,
    searchRequested: false,
    provider: "openai",
    toolName: "web_search",
    content: [],
  });
  assert.equal(result.requested, false);
  assert.equal(result.executed, false);
  assert.equal(result.supported, true);
  assert.deepEqual(result.citations, []);
});

test("a native model that actually executed the tool reports completed with citations", () => {
  const result = normalizeWebSearchExecution({
    capability: openaiCapability,
    searchRequested: true,
    provider: "openai",
    toolName: "web_search",
    content: [
      { type: "tool-call", toolName: "web_search" },
      { type: "tool-result", toolName: "web_search" },
      {
        type: "source",
        sourceType: "url",
        url: "https://example.com/result",
        title: "Example result",
      },
    ],
  });
  assert.equal(result.requested, true);
  assert.equal(result.supported, true);
  assert.equal(result.executed, true);
  assert.equal(result.failureCode, undefined);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].url, "https://example.com/result");
});

test("a native model that chose not to search is requested+supported but not executed", () => {
  const result = normalizeWebSearchExecution({
    capability: anthropicCapability,
    searchRequested: true,
    provider: "anthropic",
    toolName: "web_search",
    content: [{ type: "text", text: "The answer, no search needed." }],
  });
  assert.equal(result.requested, true);
  assert.equal(result.supported, true);
  assert.equal(result.executed, false);
  assert.equal(result.failureCode, undefined);
  assert.deepEqual(result.citations, []);
});

test("a tool-error part is surfaced as a failure, never a false completion", () => {
  const result = normalizeWebSearchExecution({
    capability: boundedGoogleCapability,
    searchRequested: true,
    provider: "google",
    toolName: "google_search",
    content: [{ type: "tool-error", toolName: "google_search" }],
  });
  assert.equal(result.requested, true);
  assert.equal(result.supported, true);
  assert.equal(result.executed, false);
  assert.equal(result.failureCode, "provider_tool_error");
  assert.deepEqual(result.citations, []);
});

test("a native capability nothing may dispatch reports unsupported, not searched", () => {
  // Google's grounding takes no per-request call ceiling, so no request may
  // carry it and none did. The parts below cannot have come from this turn,
  // and reporting them would put a "searched the web" badge on an answer that
  // was written from training data.
  const result = normalizeWebSearchExecution({
    capability: googleCapability,
    searchRequested: true,
    provider: "google",
    toolName: "google_search",
    content: [
      { type: "tool-result", toolName: "google_search" },
      {
        type: "source",
        sourceType: "url",
        url: "https://example.com/not-from-this-turn",
      },
    ],
  });
  assert.equal(result.requested, true);
  assert.equal(result.supported, false, "the register says native; the budget says no");
  assert.equal(result.executed, false);
  assert.equal(result.queryCount, undefined);
  assert.equal(result.costMetadata, undefined);
  assert.deepEqual(result.citations, []);
});

test("Anthropic search cost is tracked internally, only when queries actually ran", () => {
  const result = normalizeWebSearchExecution({
    capability: anthropicCapability,
    searchRequested: true,
    provider: "anthropic",
    toolName: "web_search",
    content: [
      { type: "tool-result", toolName: "web_search" },
      { type: "tool-result", toolName: "web_search" },
    ],
  });
  assert.equal(result.queryCount, 2);
  assert.deepEqual(result.costMetadata, { searchCostMicroUsd: 20_000 });
});

test("OpenAI search cost is tracked internally at $10 per 1,000 queries", () => {
  const result = normalizeWebSearchExecution({
    capability: openaiCapability,
    searchRequested: true,
    provider: "openai",
    toolName: "web_search",
    content: [{ type: "tool-result", toolName: "web_search" }],
  });
  assert.equal(result.queryCount, 1);
  assert.deepEqual(result.costMetadata, { searchCostMicroUsd: 10_000 });
});

test("Google search cost is tracked internally at $14 per 1,000 queries", () => {
  const result = normalizeWebSearchExecution({
    capability: boundedGoogleCapability,
    searchRequested: true,
    provider: "google",
    toolName: "google_search",
    content: [
      { type: "tool-result", toolName: "google_search" },
      { type: "tool-result", toolName: "google_search" },
      { type: "tool-result", toolName: "google_search" },
    ],
  });
  assert.equal(result.queryCount, 3);
  assert.deepEqual(result.costMetadata, { searchCostMicroUsd: 42_000 });
});

test("Perplexity search-model executions never carry an internal per-query cost estimate", () => {
  const result = normalizeWebSearchExecution({
    capability: perplexityCapability,
    searchRequested: true,
    provider: "perplexity",
    toolName: undefined,
    content: [],
  });
  assert.equal(result.executed, true);
  assert.equal(result.costMetadata, undefined);
});

test("a native model that did not execute a search never carries a cost estimate", () => {
  const result = normalizeWebSearchExecution({
    capability: anthropicCapability,
    searchRequested: true,
    provider: "anthropic",
    toolName: "web_search",
    content: [{ type: "text", text: "No search needed." }],
  });
  assert.equal(result.executed, false);
  assert.equal(result.queryCount, undefined);
  assert.equal(result.costMetadata, undefined);
});

test("an unsupported model that had search requested is flagged unsupported, not executed", () => {
  const result = normalizeWebSearchExecution({
    capability: unsupportedCapability,
    searchRequested: true,
    provider: "groq",
    toolName: undefined,
    content: [],
  });
  assert.equal(result.requested, true);
  assert.equal(result.supported, false);
  assert.equal(result.executed, false);
  assert.deepEqual(result.citations, []);
});

test("an unverified model behaves the same as unsupported -- never assumed native", () => {
  const unverified = getWebSearchCapability("gpt-5-4-mini");
  const result = normalizeWebSearchExecution({
    capability: unverified,
    searchRequested: true,
    provider: "openai",
    toolName: undefined,
    content: [],
  });
  assert.equal(result.supported, false);
  assert.equal(result.executed, false);
});

test("Perplexity search models always report executed, independent of webSearchMode", () => {
  const withSourcesAlwaysMode = normalizeWebSearchExecution({
    capability: perplexityCapability,
    searchRequested: true,
    provider: "perplexity",
    content: [
      { type: "source", sourceType: "url", url: "https://example.com/p1" },
    ],
  });
  assert.equal(withSourcesAlwaysMode.requested, true);
  assert.equal(withSourcesAlwaysMode.supported, true);
  assert.equal(withSourcesAlwaysMode.executed, true);
  assert.equal(withSourcesAlwaysMode.citations.length, 1);

  // Even when the global toggle is "off", Perplexity's own chat models
  // still searched as part of normal completion -- this must never be
  // misreported as "training knowledge" just because the app-wide mode
  // wasn't set to "always".
  const offMode = normalizeWebSearchExecution({
    capability: perplexityCapability,
    searchRequested: false,
    provider: "perplexity",
    content: [],
  });
  assert.equal(offMode.requested, true);
  assert.equal(offMode.executed, true);
});

test("dangerous citation URLs never survive normalization", () => {
  const result = normalizeWebSearchExecution({
    capability: openaiCapability,
    searchRequested: true,
    provider: "openai",
    toolName: "web_search",
    content: [
      { type: "tool-result", toolName: "web_search" },
      { type: "source", sourceType: "url", url: "javascript:alert(1)" },
      { type: "source", sourceType: "url", url: "https://safe.example.com" },
    ],
  });
  assert.deepEqual(
    result.citations.map((citation) => citation.url),
    ["https://safe.example.com"]
  );
});

test("Perplexity's own top-level citations are what the source list is built from", () => {
  // The AI SDK content array is empty for Perplexity: its sources arrive as
  // top-level `citations`/`search_results` response fields, which the
  // OpenAI-compatible chat adapter never turns into `source` parts. Without
  // providerCitations this list is empty while the answer still says "[1]".
  const result = normalizeWebSearchExecution({
    capability: perplexityCapability,
    searchRequested: false,
    provider: "perplexity",
    content: [],
    providerCitations: [
      { url: "https://example.com/one", title: "One", referenceNumber: 1 },
      { url: "https://example.com/four", title: "Four", referenceNumber: 4 },
    ],
  });
  assert.equal(result.executed, true);
  assert.deepEqual(
    result.citations.map((citation) => [citation.referenceNumber, citation.url]),
    [
      [1, "https://example.com/one"],
      [4, "https://example.com/four"],
    ]
  );
  assert.equal(result.citations[0].sourceProvider, "perplexity");
});

test("provider citations keep their numbers when source parts repeat them", () => {
  const result = normalizeWebSearchExecution({
    capability: perplexityCapability,
    searchRequested: true,
    provider: "perplexity",
    content: [
      // A duplicate of the numbered citation, plus one the top-level field
      // did not carry. Neither may renumber or displace the numbered rows.
      { type: "source", sourceType: "url", url: "https://example.com/one" },
      { type: "source", sourceType: "url", url: "https://example.com/extra" },
    ],
    providerCitations: [
      { url: "https://example.com/one", title: "One", referenceNumber: 1 },
    ],
  });
  assert.deepEqual(
    result.citations.map((citation) => [citation.referenceNumber, citation.url]),
    [
      [1, "https://example.com/one"],
      [undefined, "https://example.com/extra"],
    ]
  );
});

test("unsafe provider citation URLs are dropped without renumbering the rest", () => {
  const result = normalizeWebSearchExecution({
    capability: perplexityCapability,
    searchRequested: true,
    provider: "perplexity",
    content: [],
    providerCitations: [
      { url: "javascript:alert(1)", referenceNumber: 1 },
      { url: "https://safe.example.com", referenceNumber: 2 },
    ],
  });
  assert.deepEqual(
    result.citations.map((citation) => [citation.referenceNumber, citation.url]),
    [[2, "https://safe.example.com"]]
  );
});

test("providers other than Perplexity are unchanged by the new field", () => {
  const openai = normalizeWebSearchExecution({
    capability: openaiCapability,
    searchRequested: true,
    provider: "openai",
    toolName: "web_search",
    content: [
      { type: "tool-result", toolName: "web_search" },
      {
        type: "source",
        sourceType: "url",
        url: "https://example.com/result",
        title: "Example result",
      },
    ],
  });
  assert.equal(openai.citations.length, 1);
  // Inline-annotation providers publish no citation order, so no number is
  // invented for them.
  assert.equal(openai.citations[0].referenceNumber, undefined);
  assert.deepEqual(openai.costMetadata, { searchCostMicroUsd: 10_000 });
});
