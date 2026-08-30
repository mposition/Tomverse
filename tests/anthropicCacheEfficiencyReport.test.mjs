import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicUsageParseError,
  anthropicUsageReportUrl,
  cacheEfficiencyMetrics,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  completedUtcDayRange,
  parseAnthropicUsagePage,
  priceUsageRow,
  REQUEST_COUNT_IS_NOT_REPORTED_BY_THE_USAGE_API,
  resolveReportRange,
  summariseUsageRows,
  UNPRICED_REASONS,
} from "../scripts/report-anthropic-cache-efficiency-core.mjs";

/**
 * Fixtures, in the exact shape Anthropic's Usage API documents.
 *
 * Hand-written from the API reference rather than captured from a live call, on
 * purpose: nobody has run this against the organisation's real key yet, and a
 * fixture that claimed to be a capture would be an operational observation
 * invented in a test file. What these prove is that the parser and the
 * arithmetic behave; what they cannot prove is anything about Tomverse's actual
 * hit rate. See docs/policy/anthropic-prompt-caching.md §8.
 */
const usageResult = (overrides = {}) => ({
  account_id: null,
  api_key_id: null,
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  cache_read_input_tokens: 0,
  context_window: "0-200k",
  inference_geo: null,
  model: "claude-sonnet-5",
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0 },
  service_account_id: null,
  service_tier: "standard",
  uncached_input_tokens: 0,
  workspace_id: null,
  ...overrides,
});

const usageBucket = (day, results) => ({
  starting_at: `${day}T00:00:00Z`,
  ending_at: `${day}T23:59:59Z`,
  results,
});

const usagePage = (buckets, { hasMore = false, nextPage = null } = {}) => ({
  data: buckets,
  has_more: hasMore,
  next_page: nextPage,
});

// A fixed price table, so the arithmetic assertions are about the arithmetic.
const SONNET = {
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 10,
  cachedInputPriceMultiplier: 0.1,
  cacheWriteUsdPerMillionTokens: 2.5,
  pricingVersion: "test-standard",
};
const resolveFixedPrice = (modelId) =>
  modelId === "claude-sonnet-5" ? SONNET : null;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a well-formed page parses into one row per result", () => {
  const parsed = parseAnthropicUsagePage(
    usagePage([
      usageBucket("2026-08-20", [
        usageResult({
          uncached_input_tokens: 1_500,
          cache_read_input_tokens: 200,
          cache_creation: {
            ephemeral_5m_input_tokens: 500,
            ephemeral_1h_input_tokens: 1_000,
          },
          output_tokens: 500,
          server_tool_use: { web_search_requests: 10 },
        }),
      ]),
    ])
  );
  assert.equal(parsed.rows.length, 1);
  const [row] = parsed.rows;
  assert.equal(row.day, "2026-08-20");
  assert.equal(row.model, "claude-sonnet-5");
  assert.equal(row.uncachedInputTokens, 1_500);
  assert.equal(row.cacheReadInputTokens, 200);
  assert.equal(row.cacheCreation5mTokens, 500);
  assert.equal(row.cacheCreation1hTokens, 1_000);
  assert.equal(row.outputTokens, 500);
  assert.equal(row.webSearchRequests, 10);
  assert.equal(row.serviceTier, "standard");
  assert.equal(parsed.hasMore, false);
});

test("a bucket with no usage is a bucket, not an error", () => {
  // The API documents that it returns empty-result buckets for intervals with
  // no traffic. Treating one as malformed would drop a day out of the
  // denominator of every rate this report computes.
  const parsed = parseAnthropicUsagePage(
    usagePage([usageBucket("2026-08-21", [])])
  );
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.bucketCount, 1);
});

test("each day is taken from its own bucket rather than counted off the range", () => {
  const parsed = parseAnthropicUsagePage(
    usagePage([
      usageBucket("2026-08-20", [usageResult({ uncached_input_tokens: 1 })]),
      usageBucket("2026-08-21", []),
      usageBucket("2026-08-22", [usageResult({ uncached_input_tokens: 2 })]),
    ])
  );
  assert.deepEqual(
    parsed.rows.map((row) => row.day),
    ["2026-08-20", "2026-08-22"],
    "an empty bucket in the middle must not shift later rows onto the wrong date"
  );
});

test("pagination follows the cursor and refuses a page that omits one", () => {
  const withCursor = parseAnthropicUsagePage(
    usagePage([usageBucket("2026-08-20", [])], {
      hasMore: true,
      nextPage: "page_abc",
    })
  );
  assert.equal(withCursor.hasMore, true);
  assert.equal(withCursor.nextPage, "page_abc");

  assert.throws(
    () =>
      parseAnthropicUsagePage(
        usagePage([usageBucket("2026-08-20", [])], { hasMore: true })
      ),
    (error) =>
      error instanceof AnthropicUsageParseError &&
      error.code === "ANTHROPIC_USAGE_MISSING_CURSOR",
    "a page that promises more and names no cursor would silently truncate"
  );
});

test("malformed payloads are refused rather than skipped", () => {
  const cases = [
    [null, "ANTHROPIC_USAGE_INVALID_PAYLOAD"],
    ["not an object", "ANTHROPIC_USAGE_INVALID_PAYLOAD"],
    [{}, "ANTHROPIC_USAGE_INVALID_PAYLOAD"],
    [{ data: "nope" }, "ANTHROPIC_USAGE_INVALID_PAYLOAD"],
    [{ data: [null] }, "ANTHROPIC_USAGE_INVALID_PAYLOAD"],
    [{ data: [{ starting_at: "2026-08-20T00:00:00Z" }] }, "ANTHROPIC_USAGE_INVALID_PAYLOAD"],
    [{ data: [{ results: [] }] }, "ANTHROPIC_USAGE_INVALID_PAYLOAD"],
    [
      { data: [{ starting_at: "never", results: [] }] },
      "ANTHROPIC_USAGE_INVALID_PAYLOAD",
    ],
    [
      usagePage([usageBucket("2026-08-20", [usageResult({ cache_creation: [] })])]),
      "ANTHROPIC_USAGE_INVALID_PAYLOAD",
    ],
    [
      usagePage([
        usageBucket("2026-08-20", [
          usageResult({ uncached_input_tokens: "1500" }),
        ]),
      ]),
      "ANTHROPIC_USAGE_INVALID_TOKEN_COUNT",
    ],
    [
      usagePage([
        usageBucket("2026-08-20", [usageResult({ output_tokens: -1 })]),
      ]),
      "ANTHROPIC_USAGE_INVALID_TOKEN_COUNT",
    ],
    [
      usagePage([
        usageBucket("2026-08-20", [usageResult({ output_tokens: 1.5 })]),
      ]),
      "ANTHROPIC_USAGE_INVALID_TOKEN_COUNT",
    ],
  ];
  for (const [payload, code] of cases) {
    assert.throws(
      () => parseAnthropicUsagePage(payload),
      (error) =>
        error instanceof AnthropicUsageParseError && error.code === code,
      `expected ${code} for ${JSON.stringify(payload)?.slice(0, 80)}`
    );
  }
});

// ---------------------------------------------------------------------------
// Date boundaries
// ---------------------------------------------------------------------------

test("the default range is the last completed UTC days, excluding today", () => {
  // Today is excluded because a partial day is a partial denominator: a hit
  // rate over three hours of one time zone's morning is not the seven-day
  // figure anybody asked for, and nothing in the output would say so.
  const now = new Date("2026-08-30T13:45:00.000Z");
  const range = completedUtcDayRange({ days: 7, now });
  assert.equal(range.endingAt.toISOString(), "2026-08-30T00:00:00.000Z");
  assert.equal(range.startingAt.toISOString(), "2026-08-23T00:00:00.000Z");
});

test("the range crosses a month boundary correctly", () => {
  const range = completedUtcDayRange({
    days: 7,
    now: new Date("2026-09-03T00:00:01.000Z"),
  });
  assert.equal(range.startingAt.toISOString(), "2026-08-27T00:00:00.000Z");
  assert.equal(range.endingAt.toISOString(), "2026-09-03T00:00:00.000Z");
});

test("explicit --from/--to is validated and bounded", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const ok = resolveReportRange({ from: "2026-08-20", to: "2026-08-27", now });
  assert.equal(ok.days, 7);
  assert.equal(ok.explicit, true);
  assert.equal(ok.startingAt.toISOString(), "2026-08-20T00:00:00.000Z");

  assert.match(resolveReportRange({ from: "2026-08-20", now }).error, /together/);
  assert.match(
    resolveReportRange({ from: "20 Aug 2026", to: "2026-08-27", now }).error,
    /YYYY-MM-DD/
  );
  assert.match(
    resolveReportRange({ from: "2026-08-27", to: "2026-08-20", now }).error,
    /after/
  );
  assert.match(
    resolveReportRange({ from: "2026-01-01", to: "2026-06-01", now }).error,
    /31 days/
  );
  assert.match(resolveReportRange({ days: 0, now }).error, /between 1 and 31/);
  assert.match(resolveReportRange({ days: 40, now }).error, /between 1 and 31/);
  assert.match(resolveReportRange({ days: 2.5, now }).error, /whole number/);
});

test("the request URL asks for every dimension the pricing depends on", () => {
  const url = anthropicUsageReportUrl({
    baseUrl: "https://api.anthropic.com/v1/organizations/usage_report/messages",
    startingAt: new Date("2026-08-23T00:00:00.000Z"),
    endingAt: new Date("2026-08-30T00:00:00.000Z"),
    limit: 7,
  });
  assert.equal(url.searchParams.get("bucket_width"), "1d");
  assert.equal(url.searchParams.get("limit"), "7");
  assert.deepEqual(url.searchParams.getAll("group_by[]"), [
    "model",
    "service_tier",
    "context_window",
  ]);
  assert.equal(url.searchParams.get("starting_at"), "2026-08-23T00:00:00.000Z");
  // A dimension not in `group_by[]` comes back as null, so a report that
  // priced rows without asking for service_tier would rate a batch row at
  // standard without ever seeing that it was batch.
  assert.ok(url.searchParams.getAll("group_by[]").includes("service_tier"));
});

// ---------------------------------------------------------------------------
// Pricing and metrics
// ---------------------------------------------------------------------------

const row = (overrides = {}) => ({
  day: "2026-08-20",
  startingAt: "2026-08-20T00:00:00Z",
  model: "claude-sonnet-5",
  serviceTier: "standard",
  contextWindow: "0-200k",
  inferenceGeo: null,
  speed: null,
  uncachedInputTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  webSearchRequests: 0,
  ...overrides,
});

test("the published multipliers are the ones used", () => {
  assert.equal(CACHE_WRITE_MULTIPLIER["5m"], 1.25);
  assert.equal(CACHE_WRITE_MULTIPLIER["1h"], 2);
  assert.equal(CACHE_READ_MULTIPLIER, 0.1);
});

test("a priced row costs uncached 1.0x, read 0.1x, 5m write 1.25x, 1h write 2x", () => {
  const priced = priceUsageRow(
    row({
      uncachedInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreation5mTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
      outputTokens: 1_000_000,
    }),
    resolveFixedPrice
  );
  assert.equal(priced.priced, true);
  assert.equal(priced.uncachedCostUsd, 2); // 1M x US$2
  assert.equal(priced.cacheReadCostUsd, 0.2); // 1M x US$2 x 0.1
  assert.equal(priced.cacheWrite5mCostUsd, 2.5); // 1M x US$2.50
  assert.equal(priced.cacheWrite1hCostUsd, 4); // 1M x US$2 x 2
  assert.equal(priced.outputCostUsd, 10);
  assert.equal(priced.actualInputCostUsd, 2 + 0.2 + 2.5 + 4);
  // The counterfactual: all 4M input tokens at the plain input rate.
  assert.equal(priced.uncachedCounterfactualInputCostUsd, 8);
});

test("the saving is the counterfactual minus the actual, input only", () => {
  // A healthy loop: most of the prefix read back, a small delta written.
  const summary = summariseUsageRows(
    [
      row({
        uncachedInputTokens: 100_000,
        cacheReadInputTokens: 800_000,
        cacheCreation5mTokens: 100_000,
        outputTokens: 50_000,
      }),
    ],
    resolveFixedPrice
  );
  const { metrics } = summary.overall;
  assert.equal(metrics.inputTokens, 1_000_000);
  assert.equal(metrics.cacheReadShare, 0.8);
  assert.equal(metrics.cacheReadToWriteRatio, 8);
  // actual = 0.1M x 2 + 0.8M x 0.2 + 0.1M x 2.5 = 0.2 + 0.16 + 0.25 = 0.61
  assert.ok(Math.abs(metrics.actualInputCostUsd - 0.61) < 1e-9);
  // counterfactual = 1M x 2 = 2.00
  assert.ok(Math.abs(metrics.uncachedCounterfactualInputCostUsd - 2) < 1e-9);
  assert.ok(Math.abs(metrics.listPriceSavingUsd - 1.39) < 1e-9);
  assert.ok(Math.abs(metrics.listPriceSavingShare - 0.695) < 1e-9);
});

test("a write-heavy period reports a negative saving rather than hiding it", () => {
  // Writing a cache nothing reads back costs 25% more than not caching. The
  // report has to be able to say that -- it is the finding that would justify
  // narrowing which paths cache.
  const summary = summariseUsageRows(
    [row({ cacheCreation5mTokens: 1_000_000 })],
    resolveFixedPrice
  );
  assert.ok(summary.overall.metrics.listPriceSavingUsd < 0);
  assert.equal(summary.overall.metrics.cacheReadToWriteRatio, 0);
});

test("an empty period reports null rates rather than a misleading zero", () => {
  const summary = summariseUsageRows([], resolveFixedPrice);
  assert.equal(summary.overall.metrics.cacheReadShare, null);
  assert.equal(summary.overall.metrics.cacheReadToWriteRatio, null);
  assert.equal(summary.overall.metrics.listPriceSavingShare, null);
});

test("batch, fast mode and US-only rows are reported unpriced, with their tokens intact", () => {
  const rows = [
    row({ serviceTier: "batch", uncachedInputTokens: 10_000 }),
    row({ speed: "fast", uncachedInputTokens: 20_000 }),
    row({ inferenceGeo: "us", uncachedInputTokens: 30_000 }),
    row({ model: "claude-something-unreleased", uncachedInputTokens: 40_000 }),
  ];
  for (const [index, reason] of [
    UNPRICED_REASONS.SERVICE_TIER,
    UNPRICED_REASONS.SPEED,
    UNPRICED_REASONS.INFERENCE_GEO,
    UNPRICED_REASONS.UNKNOWN_MODEL,
  ].entries()) {
    const priced = priceUsageRow(rows[index], resolveFixedPrice);
    assert.equal(priced.priced, false);
    assert.equal(priced.reason, reason);
  }

  const summary = summariseUsageRows(rows, resolveFixedPrice);
  // Tokens counted -- they are real traffic.
  assert.equal(summary.overall.totals.uncachedInputTokens, 100_000);
  // Cost excluded -- their rates are not in this registry, and estimating them
  // would put an unverified number into a savings figure somebody will quote.
  assert.equal(summary.overall.totals.actualInputCostUsd, 0);
  assert.equal(summary.overall.totals.unpricedRowCount, 4);
  assert.equal(summary.overall.totals.pricedRowCount, 0);
  assert.equal(summary.unpriced.length, 4);
});

test("a range crossing a price change prices each day at that day's rate", () => {
  // The reason the resolver takes a day at all. Rates here are synthetic; what
  // is asserted is that the per-day price reaches the arithmetic.
  const resolveByDay = (modelId, day) =>
    modelId !== "claude-sonnet-5"
      ? null
      : day < "2026-09-01"
        ? { ...SONNET, pricingVersion: "old" }
        : {
            ...SONNET,
            inputUsdPerMillionTokens: 3,
            cacheWriteUsdPerMillionTokens: 3.75,
            pricingVersion: "new",
          };

  const before = priceUsageRow(
    row({ day: "2026-08-31", uncachedInputTokens: 1_000_000 }),
    resolveByDay
  );
  const after = priceUsageRow(
    row({ day: "2026-09-01", uncachedInputTokens: 1_000_000 }),
    resolveByDay
  );
  assert.equal(before.uncachedCostUsd, 2);
  assert.equal(before.pricingVersion, "old");
  assert.equal(after.uncachedCostUsd, 3);
  assert.equal(after.pricingVersion, "new");
});

test("a model with no verified write rate falls back to the published 1.25x and says so", () => {
  const resolveWithoutWriteRate = () => ({
    ...SONNET,
    cacheWriteUsdPerMillionTokens: null,
  });
  const priced = priceUsageRow(
    row({ cacheCreation5mTokens: 1_000_000 }),
    resolveWithoutWriteRate
  );
  assert.equal(priced.cacheWrite5mCostUsd, 2.5);
  assert.equal(priced.cacheWriteRateWasDerived, true);
});

test("per-model and overall totals are both produced, largest first", () => {
  const summary = summariseUsageRows(
    [
      row({ model: "claude-haiku-4-5", uncachedInputTokens: 10 }),
      row({ uncachedInputTokens: 1_000 }),
    ],
    (modelId) => (modelId === "claude-sonnet-5" ? SONNET : { ...SONNET, inputUsdPerMillionTokens: 1 })
  );
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byModel[0].model, "claude-sonnet-5");
  assert.equal(summary.overall.totals.uncachedInputTokens, 1_010);
});

test("the report states that request count is not available", () => {
  // The Usage API returns token counts and web-search requests, and no
  // per-bucket request count. Deriving one from tokens would be a fabricated
  // operational figure of exactly the kind the policy forbids.
  assert.equal(REQUEST_COUNT_IS_NOT_REPORTED_BY_THE_USAGE_API, true);
});

test("cacheEfficiencyMetrics is a pure function of its totals", () => {
  const totals = {
    uncachedInputTokens: 100,
    cacheReadInputTokens: 300,
    cacheCreation5mTokens: 100,
    cacheCreation1hTokens: 0,
    outputTokens: 0,
    webSearchRequests: 0,
    inputTokensTotal: 500,
    actualInputCostUsd: 1,
    uncachedCounterfactualInputCostUsd: 4,
    outputCostUsd: 0,
    pricedRowCount: 1,
    unpricedRowCount: 0,
  };
  const metrics = cacheEfficiencyMetrics(totals);
  assert.equal(metrics.inputTokens, 500);
  assert.equal(metrics.cacheReadShare, 0.6);
  assert.equal(metrics.cacheReadToWriteRatio, 3);
  assert.equal(metrics.listPriceSavingUsd, 3);
  assert.equal(metrics.listPriceSavingShare, 0.75);
});
