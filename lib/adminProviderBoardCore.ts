import type { AdminChartColor, AdminTone } from "@/lib/adminUiCore";
import type { ProviderHealthStatus } from "@/lib/providerMonitoring";

/**
 * What the Providers screens draw, worked out from the rows the existing
 * loaders already return. No React and no database: the rules (which provider
 * is "off", what counts as a mismatch, how a cost series is stacked) are
 * plain functions so a test can pin them.
 */

type CardSource = {
  provider: string;
  displayName: string;
  status: ProviderHealthStatus;
  apiKeyConfigured: boolean;
  successCount24h: number;
  failureCount24h: number;
};

export const STATUS_TONE: Record<ProviderHealthStatus, AdminTone> = {
  available: "ok",
  limited: "warn",
  outage: "bad",
};

export type ProviderCardModel = {
  provider: string;
  displayName: string;
  /** No API key: the provider is not in use, and its card is drawn dashed. */
  off: boolean;
  tone: AdminTone;
  status: ProviderHealthStatus;
  requests24h: number;
  /** Failed share of the last 24 hours, in percent; null when nothing was sent. */
  failureRatePercent: number | null;
  /** Latency of the newest readiness check, which is not a p95. */
  checkLatencyMs: number | null;
};

export function providerCardModel(row: CardSource, checkLatencyMs: number | null): ProviderCardModel {
  const requests24h = row.successCount24h + row.failureCount24h;
  const off = !row.apiKeyConfigured;
  return {
    provider: row.provider,
    displayName: row.displayName,
    off,
    tone: off ? "idle" : STATUS_TONE[row.status],
    status: row.status,
    requests24h,
    failureRatePercent:
      requests24h > 0 ? Math.round((row.failureCount24h / requests24h) * 1000) / 10 : null,
    checkLatencyMs,
  };
}

export type ProviderBannerSummary = {
  /** Providers with a key, which is what "N of M" counts. */
  active: number;
  healthy: number;
  limited: readonly string[];
  outage: readonly string[];
  off: number;
};

export function providerBannerSummary(rows: readonly CardSource[]): ProviderBannerSummary {
  const active = rows.filter((row) => row.apiKeyConfigured);
  return {
    active: active.length,
    healthy: active.filter((row) => row.status === "available").length,
    limited: active.filter((row) => row.status === "limited").map((row) => row.displayName),
    outage: active.filter((row) => row.status === "outage").map((row) => row.displayName),
    off: rows.length - active.length,
  };
}

/** The newest readiness-check latency for each provider (checks arrive newest first). */
export function latestCheckLatencyByProvider(
  checks: readonly { provider: string; latencyMs: number | null }[]
): Record<string, number | null> {
  const latest: Record<string, number | null> = {};
  for (const check of checks) {
    if (!(check.provider in latest)) latest[check.provider] = check.latencyMs;
  }
  return latest;
}

// ---------------------------------------------------------------- fallbacks

export type FallbackChain = {
  provider: string;
  displayName: string;
  status: ProviderHealthStatus;
  /** The replacements the policy offers, in order, named where the catalogue knows them. */
  steps: { modelId: string; name: string; provider: string | null }[];
};

export function buildFallbackChains(
  rows: readonly (CardSource & { fallback: { recommendedModelIds: readonly string[] } })[],
  models: readonly { id: string; name: string; provider: string }[]
): FallbackChain[] {
  const byId = new Map(models.map((model) => [model.id, model] as const));
  return rows
    .filter((row) => row.apiKeyConfigured)
    .map((row) => ({
      provider: row.provider,
      displayName: row.displayName,
      status: row.status,
      steps: row.fallback.recommendedModelIds.map((modelId) => {
        const model = byId.get(modelId);
        return { modelId, name: model?.name || modelId, provider: model?.provider ?? null };
      }),
    }))
    // What is failing now comes first: that is the chain somebody came to read.
    .sort((a, b) => Number(b.status !== "available") - Number(a.status !== "available"));
}

// ---------------------------------------------------------- reconciliation

/** A gap of at least this share of the provider's own invoice is flagged. */
export const RECONCILIATION_FLAG_PERCENT = 5;

export type ReconciliationRow = {
  provider: string;
  displayName: string;
  ourMicroUsd: number;
  reportedMicroUsd: number | null;
  diffMicroUsd: number | null;
  state: "match" | "check" | "no-invoice";
};

type ReconcileSource = {
  provider: string;
  displayName: string;
  apiKeyConfigured: boolean;
  monthCostMicroUsd: number;
  providerReportedMonthCostMicroUsd: number | null;
};

export function reconciliationRows(rows: readonly ReconcileSource[]): ReconciliationRow[] {
  return rows
    .filter(
      (row) =>
        row.apiKeyConfigured ||
        row.monthCostMicroUsd > 0 ||
        (row.providerReportedMonthCostMicroUsd ?? 0) > 0
    )
    .map((row) => {
      const reported = row.providerReportedMonthCostMicroUsd;
      if (reported === null) {
        return {
          provider: row.provider,
          displayName: row.displayName,
          ourMicroUsd: row.monthCostMicroUsd,
          reportedMicroUsd: null,
          diffMicroUsd: null,
          state: "no-invoice" as const,
        };
      }
      const diff = row.monthCostMicroUsd - reported;
      const flagged =
        reported > 0
          ? (Math.abs(diff) / reported) * 100 >= RECONCILIATION_FLAG_PERCENT
          : Math.abs(diff) > 0;
      return {
        provider: row.provider,
        displayName: row.displayName,
        ourMicroUsd: row.monthCostMicroUsd,
        reportedMicroUsd: reported,
        diffMicroUsd: diff,
        state: flagged ? ("check" as const) : ("match" as const),
      };
    });
}

export type BudgetSummary = {
  usedMicroUsd: number;
  limitMicroUsd: number;
  projectedMicroUsd: number;
  /** Used over limit; may pass 1. */
  fraction: number;
};

/** Only providers that have a monthly budget count: an unset one is not a zero limit. */
export function budgetSummary(
  rows: readonly {
    monthBudgetMicroUsd: number;
    monthCostMicroUsd: number;
    projectedMonthEndMicroUsd: number;
    providerReportedMonthCostMicroUsd: number | null;
  }[]
): BudgetSummary | null {
  const budgeted = rows.filter((row) => row.monthBudgetMicroUsd > 0);
  if (budgeted.length === 0) return null;
  const limit = budgeted.reduce((sum, row) => sum + row.monthBudgetMicroUsd, 0);
  // The invoice wins over our estimate when the provider has reported one, as
  // the monitoring read does for its own projection.
  const used = budgeted.reduce(
    (sum, row) => sum + (row.providerReportedMonthCostMicroUsd ?? row.monthCostMicroUsd),
    0
  );
  const projected = budgeted.reduce((sum, row) => sum + row.projectedMonthEndMicroUsd, 0);
  return { usedMicroUsd: used, limitMicroUsd: limit, projectedMicroUsd: projected, fraction: used / limit };
}

// -------------------------------------------------------------- cost series

export type DailyCostRow = { provider: string; day: string; costMicroUsd: number };

export type CostSeries = {
  days: string[];
  layers: { key: string; provider: string | null; values: number[] }[];
  totalMicroUsd: number;
};

/** `YYYY-MM-DD` for each of the `count` days ending on `endDay`, oldest first. */
export function costSeriesDays(endDay: string, count: number): string[] {
  const end = Date.parse(`${endDay}T00:00:00Z`);
  if (!Number.isFinite(end) || count < 1) return [];
  return Array.from({ length: count }, (_, index) =>
    new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10)
  );
}

/**
 * Stacks the biggest `topCount` providers and folds the rest into one "other"
 * layer (`provider: null`). A day with no row is a zero, which is right here:
 * the rollup only has a row once a request was recorded.
 */
export function buildCostSeries(rows: readonly DailyCostRow[], days: readonly string[], topCount = 3): CostSeries {
  const index = new Map(days.map((day, position) => [day, position] as const));
  const perProvider = new Map<string, number[]>();
  for (const row of rows) {
    const position = index.get(row.day);
    if (position === undefined || !Number.isFinite(row.costMicroUsd) || row.costMicroUsd < 0) continue;
    const values = perProvider.get(row.provider) || new Array<number>(days.length).fill(0);
    values[position] += row.costMicroUsd;
    perProvider.set(row.provider, values);
  }
  const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);
  const ranked = [...perProvider.entries()]
    .map(([provider, values]) => ({ provider, values, total: total(values) }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total);
  const top = ranked.slice(0, topCount);
  const rest = ranked.slice(topCount);
  const layers: CostSeries["layers"] = top.map((entry) => ({
    key: entry.provider,
    provider: entry.provider,
    values: entry.values,
  }));
  if (rest.length > 0) {
    layers.push({
      key: "other",
      provider: null,
      values: days.map((_, position) => rest.reduce((sum, entry) => sum + entry.values[position], 0)),
    });
  }
  return { days: [...days], layers, totalMicroUsd: ranked.reduce((sum, entry) => sum + entry.total, 0) };
}

/** Layer colours in stacking order; the fourth is the shared "other". */
export const COST_LAYER_COLORS: readonly AdminChartColor[] = ["blue", "amber", "emerald", "violet"];

/** "$12.34" for an amount held in millionths of a dollar. */
export const formatMicroUsd = (microUsd: number) =>
  `${microUsd < 0 ? "-" : ""}$${Math.abs(microUsd / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
