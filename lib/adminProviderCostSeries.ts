import "server-only";

import { prisma } from "@/lib/prisma";
import { buildCostSeries, costSeriesDays, type CostSeries } from "@/lib/adminProviderBoardCore";

const DAY_MS = 86_400_000;
export const PROVIDER_COST_SERIES_DAYS = 30;

/**
 * Our own cost per provider per day for the last 30 days, from the existing
 * `ProviderDailyUsage` rollup (the `internal` rows the monitoring read also
 * sums for the month). Read-only; nothing here writes the rollup.
 */
export async function loadProviderCostSeries(now = new Date()): Promise<CostSeries> {
  const endDay = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const days = costSeriesDays(endDay.toISOString().slice(0, 10), PROVIDER_COST_SERIES_DAYS);
  const grouped = await prisma.providerDailyUsage.groupBy({
    by: ["provider", "date"],
    where: {
      source: "internal",
      date: { gte: new Date(`${days[0]}T00:00:00Z`), lte: endDay },
    },
    _sum: { estimatedCostMicroUsd: true },
  });
  return buildCostSeries(
    grouped.map((row) => ({
      provider: row.provider,
      day: row.date.toISOString().slice(0, 10),
      costMicroUsd: row._sum.estimatedCostMicroUsd || 0,
    })),
    days
  );
}
