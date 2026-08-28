import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebSearchExecution } from "../lib/webSearchExecutionNormalizer.ts";
import {
  getWebSearchCapability,
  NATIVE_GOOGLE_GROUNDING,
} from "../lib/webSearchCapability.ts";
import { ALL_WEB_SEARCH_BACKENDS_READY } from "../lib/webSearchBackends.ts";

const openaiCapability = getWebSearchCapability("gpt-5-5");
const anthropicCapability = getWebSearchCapability("claude-sonnet-5");
// Native, priced per query, and with no ceiling any request can impose --
// so nothing may dispatch it today. Kept under its own name because the
// contract it exercises is "the register says native and the answer is still
// no".
const googleCapability = NATIVE_GOOGLE_GROUNDING;
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
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

// ---------------------------------------------------------------------------
// Application-managed search: the sources come from what this process ran.
// ---------------------------------------------------------------------------

const geminiCapability = getWebSearchCapability("gemini-3-7-flash");

const snapshot = (overrides = {}) => ({
  backend: "brave",
  backendRequestCount: 1,
  succeededRequestCount: 1,
  refusedCallCount: 0,
  executed: true,
  sources: [],
  maxQueries: 5,
  ...overrides,
});

test("application-managed citations come from the executor, never from the answer text", () => {
  const result = normalizeWebSearchExecution({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    capability: geminiCapability,
    searchRequested: true,
    provider: "google",
    toolName: "web_search",
    appManagedSearch: snapshot({
      sources: [
        { url: "https://example.com/a", title: "A" },
        { url: "https://example.com/b", title: "B" },
      ],
    }),
    // A model that wrote a plausible-looking URL in its own answer. The
    // normalizer never reads the answer, so nothing here can become a source:
    // a URL a model wrote is a string shaped like a citation.
    content: [
      { type: "text", text: "See https://example.com/invented for details." },
    ],
  });
  assert.equal(result.executed, true);
  assert.equal(result.executionKind, "app_managed");
  assert.equal(result.searchBackend, "brave");
  assert.deepEqual(
    result.citations.map((citation) => citation.url),
    ["https://example.com/a", "https://example.com/b"]
  );
  // The vendor that returned it, not the model's provider: a list crediting
  // Google for a Brave result would be wrong about where the evidence is from.
  assert.equal(result.citations[0].sourceProvider, "brave");
});

test("duplicate source URLs are collapsed once, keeping the first title", () => {
  const result = normalizeWebSearchExecution({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    capability: geminiCapability,
    searchRequested: true,
    provider: "google",
    toolName: "web_search",
    appManagedSearch: snapshot({
      succeededRequestCount: 2,
      backendRequestCount: 2,
      sources: [
        { url: "https://example.com/a", title: "First" },
        { url: "https://example.com/a", title: "Second" },
      ],
    }),
  });
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].title, "First");
});

test("unsafe result URLs never reach the citation list", () => {
  const result = normalizeWebSearchExecution({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    capability: geminiCapability,
    searchRequested: true,
    provider: "google",
    toolName: "web_search",
    appManagedSearch: snapshot({
      sources: [
        { url: "javascript:alert(1)", title: "no" },
        { url: "data:text/html,<script>", title: "no" },
        { url: "https://example.com/ok", title: "yes" },
      ],
    }),
  });
  assert.deepEqual(
    result.citations.map((citation) => citation.url),
    ["https://example.com/ok"]
  );
});

test("a turn whose every backend request failed did not search, and is refunded", () => {
  const result = normalizeWebSearchExecution({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    capability: geminiCapability,
    searchRequested: true,
    provider: "google",
    toolName: "web_search",
    appManagedSearch: snapshot({
      backendRequestCount: 3,
      succeededRequestCount: 0,
      executed: false,
      failureCode: "backend_rate_limited",
    }),
  });
  assert.equal(result.executed, false);
  assert.equal(result.failureCode, "backend_rate_limited");
  assert.equal(result.queryCount, 0);
  // Attempts and successes are different numbers, and both are reported: one
  // says the model searched a lot, the other says the backend was unwell.
  assert.equal(result.backendRequestCount, 3);
  assert.equal(result.costMetadata?.searchBackendCostMicroUsd, 0);
});

test("the model may register the tool and never call it, which is the refunded case", () => {
  const result = normalizeWebSearchExecution({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    capability: geminiCapability,
    searchRequested: true,
    provider: "google",
    toolName: "web_search",
    appManagedSearch: null,
  });
  assert.equal(result.supported, true);
  assert.equal(result.executed, false);
  // No failure code: nothing failed. The switch was on, the question did not
  // need the web, and the eight credits go back.
  assert.equal(result.failureCode, undefined);
  assert.equal(result.queryCount, 0);
});

test("application-managed cost is its own key, never the model provider's", () => {
  const result = normalizeWebSearchExecution({
    backendReadiness: ALL_WEB_SEARCH_BACKENDS_READY,
    capability: geminiCapability,
    searchRequested: true,
    provider: "google",
    toolName: "web_search",
    appManagedSearch: snapshot({
      backendRequestCount: 3,
      succeededRequestCount: 3,
    }),
  });
  // Three Brave requests at 5,000 micro-USD, not three Google grounding queries
  // at 14,000. And under `searchBackendCostMicroUsd`, because
  // `searchCostMicroUsd` settles against the model provider's budget.
  assert.equal(result.costMetadata?.searchBackendCostMicroUsd, 15_000);
  assert.equal(result.costMetadata?.searchCostMicroUsd, undefined);
});

test("with no reachable backend the turn is unsupported, not merely unsearched", () => {
  const result = normalizeWebSearchExecution({
    backendReadiness: {},
    capability: geminiCapability,
    searchRequested: true,
    provider: "google",
    toolName: "web_search",
    appManagedSearch: null,
  });
  // "supported: true" would make the badge say the search was possible and
  // simply did not happen, which is the wrong story on a deployment holding no
  // credential.
  assert.equal(result.supported, false);
  assert.equal(result.executed, false);
});
