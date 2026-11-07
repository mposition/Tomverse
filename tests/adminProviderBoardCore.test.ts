import assert from "node:assert/strict";
import test from "node:test";
import { adminStackedAreaPaths } from "../lib/adminStackedAreaCore.ts";
import {
  RECONCILIATION_FLAG_PERCENT,
  budgetSummary,
  buildCostSeries,
  buildFallbackChains,
  costSeriesDays,
  formatMicroUsd,
  latestCheckLatencyByProvider,
  providerBannerSummary,
  providerCardModel,
  reconciliationRows,
} from "../lib/adminProviderBoardCore.ts";

type Row = {
  provider: string;
  displayName: string;
  status: "available" | "limited" | "outage";
  apiKeyConfigured: boolean;
  successCount24h: number;
  failureCount24h: number;
};

const row = (overrides: Partial<Row> = {}): Row => ({
  provider: "openai",
  displayName: "OpenAI",
  status: "available",
  apiKeyConfigured: true,
  successCount24h: 98,
  failureCount24h: 2,
  ...overrides,
});

test("a provider without an API key is off, not healthy", () => {
  const card = providerCardModel(row({ apiKeyConfigured: false }), null);
  assert.equal(card.off, true);
  assert.equal(card.tone, "idle");
});

test("a card says nothing about a failure rate when nothing was sent", () => {
  assert.equal(providerCardModel(row({ successCount24h: 0, failureCount24h: 0 }), null).failureRatePercent, null);
  assert.equal(providerCardModel(row(), 420).failureRatePercent, 2);
  assert.equal(providerCardModel(row(), 420).checkLatencyMs, 420);
});

test("the banner counts only providers with a key, and names the ones in trouble", () => {
  const summary = providerBannerSummary([
    row(),
    row({ provider: "anthropic", displayName: "Anthropic", status: "limited" }),
    row({ provider: "google", displayName: "Google", status: "outage" }),
    row({ provider: "xai", displayName: "xAI", apiKeyConfigured: false, status: "outage" }),
  ]);
  assert.equal(summary.active, 3);
  assert.equal(summary.healthy, 1);
  assert.deepEqual(summary.limited, ["Anthropic"]);
  assert.deepEqual(summary.outage, ["Google"]);
  assert.equal(summary.off, 1);
});

test("the newest readiness-check latency wins for each provider", () => {
  assert.deepEqual(
    latestCheckLatencyByProvider([
      { provider: "openai", latencyMs: 300 },
      { provider: "openai", latencyMs: 900 },
      { provider: "google", latencyMs: null },
    ]),
    { openai: 300, google: null }
  );
});

test("fallback chains name the models the catalogue knows and put trouble first", () => {
  const chains = buildFallbackChains(
    [
      { ...row(), fallback: { recommendedModelIds: ["m-1", "m-unknown"] } },
      {
        ...row({ provider: "anthropic", displayName: "Anthropic", status: "limited" }),
        fallback: { recommendedModelIds: ["m-1"] },
      },
      { ...row({ provider: "xai", apiKeyConfigured: false }), fallback: { recommendedModelIds: ["m-1"] } },
    ],
    [{ id: "m-1", name: "Model One", provider: "google" }]
  );
  assert.deepEqual(
    chains.map((chain) => chain.provider),
    ["anthropic", "openai"]
  );
  assert.deepEqual(chains[1].steps, [
    { modelId: "m-1", name: "Model One", provider: "google" },
    { modelId: "m-unknown", name: "m-unknown", provider: null },
  ]);
});

test("reconciliation marks only a real gap, and says when there is no invoice", () => {
  const base = { apiKeyConfigured: true };
  const rows = reconciliationRows([
    { ...base, provider: "a", displayName: "A", monthCostMicroUsd: 100_000_000, providerReportedMonthCostMicroUsd: 100_000_000 },
    { ...base, provider: "b", displayName: "B", monthCostMicroUsd: 141_000_000, providerReportedMonthCostMicroUsd: 150_000_000 },
    { ...base, provider: "c", displayName: "C", monthCostMicroUsd: 9_000_000, providerReportedMonthCostMicroUsd: null },
    { apiKeyConfigured: false, provider: "d", displayName: "D", monthCostMicroUsd: 0, providerReportedMonthCostMicroUsd: null },
  ]);
  assert.deepEqual(
    rows.map((entry) => [entry.provider, entry.state]),
    [
      ["a", "match"],
      ["b", "check"],
      ["c", "no-invoice"],
    ]
  );
  assert.equal(rows[1].diffMicroUsd, -9_000_000);
  assert.equal(rows[2].diffMicroUsd, null);
  assert.equal(RECONCILIATION_FLAG_PERCENT, 5);
});

test("a budget needs a budgeted provider and prefers the invoice over our estimate", () => {
  assert.equal(
    budgetSummary([
      { monthBudgetMicroUsd: 0, monthCostMicroUsd: 5, projectedMonthEndMicroUsd: 5, providerReportedMonthCostMicroUsd: null },
    ]),
    null
  );
  const summary = budgetSummary([
    { monthBudgetMicroUsd: 500_000_000, monthCostMicroUsd: 100_000_000, projectedMonthEndMicroUsd: 400_000_000, providerReportedMonthCostMicroUsd: 120_000_000 },
    { monthBudgetMicroUsd: 500_000_000, monthCostMicroUsd: 80_000_000, projectedMonthEndMicroUsd: 200_000_000, providerReportedMonthCostMicroUsd: null },
    { monthBudgetMicroUsd: 0, monthCostMicroUsd: 999_000_000, projectedMonthEndMicroUsd: 999_000_000, providerReportedMonthCostMicroUsd: null },
  ]);
  assert.ok(summary);
  assert.equal(summary.usedMicroUsd, 200_000_000);
  assert.equal(summary.limitMicroUsd, 1_000_000_000);
  assert.equal(summary.projectedMicroUsd, 600_000_000);
  assert.equal(summary.fraction, 0.2);
});

test("the cost series covers each day, keeps the top providers and folds the rest into other", () => {
  const days = costSeriesDays("2026-11-07", 3);
  assert.deepEqual(days, ["2026-11-05", "2026-11-06", "2026-11-07"]);
  const series = buildCostSeries(
    [
      { provider: "openai", day: "2026-11-05", costMicroUsd: 10 },
      { provider: "openai", day: "2026-11-07", costMicroUsd: 30 },
      { provider: "anthropic", day: "2026-11-06", costMicroUsd: 20 },
      { provider: "google", day: "2026-11-06", costMicroUsd: 5 },
      { provider: "xai", day: "2026-11-06", costMicroUsd: 2 },
      { provider: "zhipu", day: "2026-11-07", costMicroUsd: 1 },
      // Outside the window and invalid values are not drawn.
      { provider: "openai", day: "2026-10-01", costMicroUsd: 999 },
      { provider: "openai", day: "2026-11-06", costMicroUsd: -4 },
    ],
    days
  );
  assert.deepEqual(
    series.layers.map((layer) => layer.key),
    ["openai", "anthropic", "google", "other"]
  );
  assert.deepEqual(series.layers[0].values, [10, 0, 30]);
  assert.deepEqual(series.layers[3].values, [0, 2, 1]);
  assert.equal(series.totalMicroUsd, 68);
});

test("a series with no cost has no layers", () => {
  assert.deepEqual(buildCostSeries([], costSeriesDays("2026-11-07", 2)).layers, []);
});

test("micro dollars are shown as dollars", () => {
  assert.equal(formatMicroUsd(412_600_000), "$412.60");
  assert.equal(formatMicroUsd(-3_200_000), "-$3.20");
  assert.equal(formatMicroUsd(1_234_560_000), "$1,234.56");
});

test("a stacked area draws one closed shape per layer and nothing for unreadable data", () => {
  const area = adminStackedAreaPaths(
    [
      [1, 2, 3],
      [1, 1, 1],
    ],
    300,
    100
  );
  assert.ok(area);
  assert.equal(area.layers.length, 2);
  assert.equal(area.max, 4);
  for (const layer of area.layers) assert.match(layer.path, /^M[\d.,-]+ .*Z$/);
  assert.equal(adminStackedAreaPaths([[0, 0, 0]], 300, 100), null);
  assert.equal(adminStackedAreaPaths([[1, Number.NaN]], 300, 100), null);
  assert.equal(adminStackedAreaPaths([[1, -1]], 300, 100), null);
  assert.equal(adminStackedAreaPaths([[1, 2], [1]], 300, 100), null);
  assert.equal(adminStackedAreaPaths([], 300, 100), null);
  assert.ok(adminStackedAreaPaths([[5]], 300, 100), "one day still has width");
});
