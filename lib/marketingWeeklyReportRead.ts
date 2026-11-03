import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  marketingAnalysisView,
  marketingStrategyWeek,
  marketingWeeklyStrategySchema,
  type MarketingAnalysisView,
  type MarketingWeeklyStrategy,
} from "@/lib/marketingAnalysisCore";
import { readMarketingMeasurement } from "@/lib/marketingMeasurement";
import { marketingWeekWindow, type MarketingMeasurement } from "@/lib/marketingMeasurementCore";

/**
 * The weekly marketing report (owner request 2026-11-03; the A1 weekly report
 * policy §3 and §10.3 describe): one Brisbane week on one page -- the
 * week's posts and the 120-day metrics counted for it, the analysis and
 * brief written in it, the plan made for it, and what the market reports and
 * experiments recorded. Assembled when read, from the tables that already
 * hold each part; nothing is stored and nothing is written.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type MarketingWeeklyReport = {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly previousWeekStart: string;
  /** Null when the next week has not begun. */
  readonly nextWeekStart: string | null;
  /** Whether the week is still running. */
  readonly inProgress: boolean;
  readonly measurement: MarketingMeasurement;
  /** The newest analysis written in the week, sources judged against the approved hosts now. */
  readonly analysis: (MarketingAnalysisView & { readonly createdAt: string; readonly briefReportId: string }) | null;
  /** The plan made for the week. */
  readonly strategy: MarketingWeeklyStrategy | null;
  readonly marketIntel: {
    readonly reports: number;
    readonly latestAt: string | null;
    readonly factsKept: number | null;
    readonly factsDropped: number | null;
  };
  readonly experiments: { readonly results: number };
  /** Whether the week's stored KPI report exists (written after the week ends). */
  readonly weeklyKpiRecorded: boolean;
};

const isoDate = (date: Date) => new Date(date.getTime() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** The last week that has ended by `now`, by its Monday. */
export const marketingLastFullWeekStart = (now: number): string => marketingStrategyWeek(now - 7 * DAY_MS).start;

export async function readMarketingWeeklyReport(
  db: Pick<PrismaClient, "$queryRaw" | "marketingCompetitor">,
  weekStart: string,
  now: number = Date.now(),
): Promise<MarketingWeeklyReport | null> {
  const window = marketingWeekWindow(weekStart);
  if (!window || window.start.getTime() > now) return null;
  const [measurement, analyses, strategies, intel, experiments, kpi] = await Promise.all([
    readMarketingMeasurement(db, window),
    db.$queryRaw<Array<{ payload: unknown; briefReportId: string; createdAt: Date }>>(Prisma.sql`
      SELECT "payload", "briefReportId", "createdAt" FROM "MarketingAnalysis"
      WHERE "createdAt" >= ${window.start} AND "createdAt" < ${window.end}
      ORDER BY "createdAt" DESC LIMIT 1
    `),
    db.$queryRaw<Array<{ strategy: unknown }>>(Prisma.sql`
      SELECT "payload"->'strategy' AS "strategy" FROM "MarketingAnalysis"
      WHERE "payload"->'strategy'->>'weekStart' = ${weekStart}
      ORDER BY "createdAt" DESC LIMIT 1
    `),
    db.$queryRaw<Array<{ reports: number; latest: Date | null; kept: number | null; dropped: number | null }>>(Prisma.sql`
      SELECT count(*) OVER ()::int AS "reports", "createdAt" AS "latest",
             CASE WHEN jsonb_typeof("payload"->'facts') = 'array' THEN jsonb_array_length("payload"->'facts') END AS "kept",
             CASE WHEN jsonb_typeof("payload"->'unrepresentableFactCount') = 'number'
                  THEN ("payload"->>'unrepresentableFactCount')::int END AS "dropped"
      FROM "MarketingReport"
      WHERE "kind" = 'market_intel' AND "createdAt" >= ${window.start} AND "createdAt" < ${window.end}
      ORDER BY "createdAt" DESC LIMIT 1
    `),
    db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count" FROM "MarketingReport"
      WHERE "kind" = 'experiment_result' AND "createdAt" >= ${window.start} AND "createdAt" < ${window.end}
    `),
    db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count" FROM "MarketingReport"
      WHERE "kind" = 'weekly_kpi' AND "periodStart" = ${window.start}
    `),
  ]);

  let analysis: MarketingWeeklyReport["analysis"] = null;
  if (analyses[0]) {
    const approved = await db.marketingCompetitor.findMany({
      where: { status: "approved" },
      select: { officialHosts: true },
    });
    const hosts = new Set(approved.flatMap((entry) => entry.officialHosts.map((host) => host.toLowerCase())));
    const view = marketingAnalysisView(analyses[0].payload, hosts);
    analysis = view
      ? { ...view, createdAt: analyses[0].createdAt.toISOString(), briefReportId: analyses[0].briefReportId }
      : null;
  }
  const strategy = strategies[0] ? marketingWeeklyStrategySchema.safeParse(strategies[0].strategy) : null;
  const next = new Date(window.end.getTime());
  return {
    weekStart,
    weekEnd: isoDate(new Date(window.end.getTime() - DAY_MS)),
    previousWeekStart: isoDate(new Date(window.start.getTime() - 7 * DAY_MS)),
    nextWeekStart: next.getTime() > now ? null : isoDate(next),
    inProgress: window.end.getTime() > now,
    measurement,
    analysis,
    strategy: strategy?.success ? strategy.data : null,
    marketIntel: {
      reports: intel[0]?.reports ?? 0,
      latestAt: intel[0]?.latest ? intel[0].latest.toISOString() : null,
      factsKept: intel[0]?.kept ?? null,
      factsDropped: intel[0]?.dropped ?? null,
    },
    experiments: { results: experiments[0]?.count ?? 0 },
    weeklyKpiRecorded: (kpi[0]?.count ?? 0) > 0,
  };
}
