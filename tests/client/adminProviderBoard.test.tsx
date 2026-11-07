import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminProviderOpsPanel } from "@/components/admin/AdminProviderOpsPanel";
import { ProviderCostBoard, type CostBoardRow } from "@/components/admin/providers/ProviderCostBoard";
import { ProviderStatusOverview } from "@/components/admin/providers/ProviderStatusOverview";
import { ProviderSyncMoved } from "@/components/admin/providers/ProviderSyncMoved";
import { AdminStackedArea } from "@/components/admin/ui/AdminStackedArea";
import { buildCostSeries, costSeriesDays } from "@/lib/adminProviderBoardCore";

type OverviewRow = Parameters<typeof ProviderStatusOverview>[0]["providers"][number];

const provider = (overrides: Partial<OverviewRow> = {}): OverviewRow => ({
  provider: "openai",
  displayName: "OpenAI",
  status: "available",
  apiKeyConfigured: true,
  successCount24h: 1480,
  failureCount24h: 2,
  statusReasons: [],
  ...overrides,
} as OverviewRow);

test("the status banner counts healthy providers and links to incidents", () => {
  const html = renderToStaticMarkup(
    <ProviderStatusOverview
      providers={[
        provider(),
        provider({
          provider: "anthropic",
          displayName: "Anthropic",
          status: "limited",
          statusReasons: [{ code: "slow", title: "Responses are slow", detail: "" }],
        }),
        provider({ provider: "xai", displayName: "xAI", apiKeyConfigured: false }),
      ]}
      latencyByProvider={{ openai: 640 }}
    />
  );
  assert.match(html, /data-testid="provider-status-banner"[^>]*data-tone="warn"/);
  assert.match(html, /1 of 2 providers are healthy/);
  assert.match(html, /Limited: Anthropic\./);
  assert.match(html, /1 more are off because they have no API key\./);
  assert.match(html, /href="\/admin\/providers\?tab=incidents"/);
  assert.match(html, /Responses are slow/);
  assert.match(html, /640 ms/);
});

test("a provider without a key is a dashed card that points at Models", () => {
  const html = renderToStaticMarkup(
    <ProviderStatusOverview
      providers={[provider({ provider: "xai", displayName: "xAI", apiKeyConfigured: false })]}
      latencyByProvider={{}}
    />
  );
  assert.match(html, /data-state="off"/);
  assert.match(html, /border-dashed/);
  assert.match(html, /href="\/admin\/models"/);
  assert.doesNotMatch(html, /Requests, 24h/);
});

test("a card with no traffic shows no failure rate and an empty share bar", () => {
  const html = renderToStaticMarkup(
    <ProviderStatusOverview
      providers={[provider({ successCount24h: 0, failureCount24h: 0 })]}
      latencyByProvider={{}}
    />
  );
  assert.match(html, /Failed, 24h<\/p><p[^>]*>None</);
  assert.match(html, /0 succeeded and 0 failed in the last 24 hours/);
});

const costRow = (overrides: Partial<CostBoardRow> = {}): CostBoardRow => ({
  provider: "openai",
  displayName: "OpenAI",
  apiKeyConfigured: true,
  monthCostMicroUsd: 198_400_000,
  providerReportedMonthCostMicroUsd: 198_400_000,
  monthBudgetMicroUsd: 500_000_000,
  projectedMonthEndMicroUsd: 400_000_000,
  lastUsageSyncAt: "2026-11-07T22:00:00.000Z",
  ...overrides,
});

test("the cost board draws the chart, the budget ring and only flags a real gap", () => {
  const days = costSeriesDays("2026-11-07", 3);
  const series = buildCostSeries(
    [
      { provider: "openai", day: "2026-11-06", costMicroUsd: 5_000_000 },
      { provider: "anthropic", day: "2026-11-07", costMicroUsd: 7_000_000 },
    ],
    days
  );
  const html = renderToStaticMarkup(
    <ProviderCostBoard
      series={series}
      rows={[
        costRow(),
        costRow({
          provider: "anthropic",
          displayName: "Anthropic",
          monthCostMicroUsd: 141_100_000,
          providerReportedMonthCostMicroUsd: 144_300_000 + 6_000_000,
        }),
        costRow({ provider: "perplexity", displayName: "Perplexity", providerReportedMonthCostMicroUsd: null }),
      ]}
    />
  );
  assert.match(html, /aria-label="Daily cost by provider for the last 30 days"/);
  assert.match(html, /data-testid="provider-budget-ring"/);
  assert.match(html, />Matches</);
  assert.match(html, />Needs a look</);
  assert.match(html, />No invoice yet</);
  // 2026-11-07 22:00 UTC is already 08 Nov in Brisbane, and the clock says AEST.
  assert.match(html, /Last synced 2026-11-08 08:00 AEST/);
  assert.doesNotMatch(html, /UTC/);
});

test("a failed read is an alert in its own tile, never an empty chart or a zero budget", () => {
  const html = renderToStaticMarkup(<ProviderCostBoard series={null} rows={null} />);
  assert.equal(html.match(/role="alert"/g)?.length, 3);
  assert.match(html, /could not be read/);
  assert.doesNotMatch(html, /No cost has been recorded/);
  assert.doesNotMatch(html, /0%/);
});

test("a month with no cost says so instead of drawing a flat chart", () => {
  const html = renderToStaticMarkup(
    <ProviderCostBoard series={buildCostSeries([], costSeriesDays("2026-11-07", 3))} rows={[costRow()]} />
  );
  assert.match(html, /No cost has been recorded in the last 30 days\./);
  assert.doesNotMatch(html, /<svg[^>]*aria-label="Daily cost/);
});

test("the budget ring says there is nothing to compare when no provider has a budget", () => {
  const html = renderToStaticMarkup(
    <ProviderCostBoard series={null} rows={[costRow({ monthBudgetMicroUsd: 0 })]} />
  );
  assert.match(html, /No provider has a monthly budget set/);
});

test("a stacked area keeps its legend and edge labels", () => {
  const html = renderToStaticMarkup(
    <AdminStackedArea
      label="Cost"
      edgeLabels={["a", "b", "c"]}
      layers={[
        { key: "x", label: "Alpha", color: "blue", values: [1, 2] },
        { key: "y", label: "Beta", color: "amber", values: [1, 1] },
      ]}
    />
  );
  assert.match(html, /Alpha/);
  assert.match(html, /var\(--color-amber-500\)/);
  assert.match(html, /<svg[^>]*aria-label="Cost"/);
});

test("the sync button's old places point at Usage and cost", () => {
  const html = renderToStaticMarkup(<ProviderSyncMoved />);
  assert.match(html, /href="\/admin\/providers\?tab=usage-cost"/);
  assert.doesNotMatch(html, /<button/);
});

const model = { id: "m-1", name: "Model One", provider: "google" } as never;
const incident = (overrides: Record<string, unknown> = {}) => ({
  id: "i-1",
  provider: "anthropic",
  modelId: null,
  status: "limited",
  title: "Anthropic responses are slow",
  message: null,
  fallbackModelIds: "",
  createdByEmail: "ops@example.com",
  resolvedByEmail: null,
  startsAt: "2026-11-07T02:10:00.000Z",
  resolvedAt: null,
  createdAt: "2026-11-07T02:10:00.000Z",
  ...overrides,
});

test("the fallback tab draws the order as a chain and puts the provider in trouble in amber", () => {
  const html = renderToStaticMarkup(
    <AdminProviderOpsPanel
      models={[model]}
      incidents={[incident(), incident({ id: "i-2", status: "resolved", title: "OpenAI 503", resolvedAt: "2026-11-07T03:00:00.000Z" })]}
      checks={[]}
      chains={[
        {
          provider: "anthropic",
          displayName: "Anthropic",
          status: "limited",
          steps: [{ modelId: "m-1", name: "Model One", provider: "google" }],
        },
      ]}
    />
  );
  assert.match(html, /data-testid="provider-chain-anthropic"[^>]*data-trouble="true"/);
  assert.match(html, /Having trouble now/);
  assert.match(html, /Fallback 1/);
  assert.match(html, /Model One/);
  assert.match(html, /A switch a person turned off is never turned back on automatically\./);
  assert.match(html, /<h2[^>]*>Incident mode<\/h2>/);
  assert.match(html, /<h2[^>]*>Provider readiness tests<\/h2>/);
  // One open incident keeps its Resolve button; the resolved one has none.
  assert.equal(html.match(/>Resolve<\/button>/g)?.length, 1);
  assert.equal(html.match(/<article/g)?.length, 2);
  assert.match(html, /2026-11-07 12:10 AEST/);
});

test("a fallback chain that could not be read says so, and the incident form still renders", () => {
  const html = renderToStaticMarkup(
    <AdminProviderOpsPanel models={[model]} incidents={[]} checks={[]} chains={null} />
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Provider health could not be read/);
  assert.match(html, /Enable incident mode/);
});

test("without ops access the incident controls are locked and name the access they need", () => {
  const html = renderToStaticMarkup(
    <AdminProviderOpsPanel models={[model]} incidents={[incident()]} checks={[]} chains={[]} canWrite={false} />
  );
  assert.match(html, /Needs ops:write access/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^]*Enable incident mode/);
});
