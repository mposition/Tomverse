import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  marketingAnalysisView,
  marketingStrategyWeek,
  marketingWeeklyStrategySchema,
  type MarketingAnalysisView,
  type MarketingWeeklyStrategy,
} from "@/lib/marketingAnalysisCore";
import { readExperimentSnapshot } from "@/lib/marketingExperimentState";
import { readMarketingMeasurement } from "@/lib/marketingMeasurement";
import {
  marketingWeekWindow,
  type MarketingMeasurement,
  type MarketingMeasurementWindow,
} from "@/lib/marketingMeasurementCore";
import { MARKETING_TOUCH_EVENT } from "@/lib/marketingTouchCore";
import {
  marketingWeeklyExperiments,
  summarizeMarketingFunnel,
  type MarketingFunnel,
  type MarketingFunnelCounts,
  type MarketingWeeklyExperiment,
} from "@/lib/marketingWeeklyFunnelCore";

/**
 * The weekly marketing report (owner request 2026-11-03; the A1 weekly report
 * `docs/policy/marketing-automation.md` §3 and §10.3 describe): one Brisbane week on one page -- the
 * week's posts and the 120-day metrics counted for it, the analysis and
 * brief written in it, the plan made for it, what the market reports and
 * experiments recorded, and (2026-11-09) the traffic and conversion funnel
 * per account against the week before. Assembled when read, from the tables that already
 * hold each part; nothing is stored and nothing is written.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a week can be read: the shortest retention among the rows it
 * counts. Rejected and expired drafts are deleted, and dispatch attempts
 * summarised, after ninety days (analytics events last 400), so an older week
 * would show deletions as zeros. A week that began before this is not read.
 */
export const MARKETING_WEEKLY_REPORT_HORIZON_MS = 84 * DAY_MS;

/** Whether a week beginning at `start` can still be read whole at `now`. */
export const marketingWeekReadable = (start: Date, now: number): boolean =>
  start.getTime() <= now && now - start.getTime() <= MARKETING_WEEKLY_REPORT_HORIZON_MS;

export type MarketingWeeklyReport = {
  readonly weekStart: string;
  readonly weekEnd: string;
  /** Null when the week before is past what can still be read whole. */
  readonly previousWeekStart: string | null;
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
  readonly experiments: {
    readonly results: number;
    /**
     * The landing experiments the week saw, with exposures and conversions
     * per arm (counted from each experiment's start: there is no weekly
     * counter). Null when they could not be read.
     */
    readonly entries: readonly MarketingWeeklyExperiment[] | null;
  };
  /** Posts → touches → attributed sign-ups → first use → paid, per account, against the week before. */
  readonly funnel: MarketingFunnel;
  /** Whether the week's stored KPI report exists (written after the week ends). */
  readonly weeklyKpiRecorded: boolean;
};

const settle = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/**
 * The funnel's counts for one window (lib/marketingWeeklyFunnelCore.ts): the
 * posts each account published, the touches by the account slug their link
 * carried in `utm_content` (lib/marketingLinks.ts sets it), and the sign-ups
 * attributed to such a touch (the snapshot's `touch_utm_content`), with how
 * many of those accounts now have a conversation and a paid transaction.
 * Aggregates only: no user id or event leaves the query. Each part fails on
 * its own and reads as null.
 */
export async function readMarketingFunnelCounts(
  db: Pick<PrismaClient, "$queryRaw">,
  window: MarketingMeasurementWindow,
): Promise<MarketingFunnelCounts> {
  const [published, touches, signups] = await Promise.all([
    settle(() =>
      db.$queryRaw<Array<{ accountSlug: string; count: number }>>(Prisma.sql`
        SELECT c."accountSlug", count(*)::int AS "count"
        FROM "MarketingPost" p JOIN "MarketingChannel" c ON c."id" = p."channelId"
        WHERE p."publishedAt" >= ${window.start} AND p."publishedAt" < ${window.end}
        GROUP BY 1
      `),
    ),
    settle(() =>
      db.$queryRaw<Array<{ account: string | null; count: number }>>(Prisma.sql`
        SELECT "properties"->>'utm_content' AS "account", count(*)::int AS "count"
        FROM "ProductAnalyticsEvent"
        WHERE "eventName" = ${MARKETING_TOUCH_EVENT}
          AND "occurredAt" >= ${window.start} AND "occurredAt" < ${window.end}
        GROUP BY 1
      `),
    ),
    settle(() =>
      db.$queryRaw<Array<{ account: string | null; signups: number; firstUse: number; paid: number }>>(Prisma.sql`
        SELECT s."account", count(*)::int AS "signups",
               (count(*) FILTER (WHERE s."used"))::int AS "firstUse",
               (count(*) FILTER (WHERE s."paid"))::int AS "paid"
        FROM (
          SELECT e."properties"->>'touch_utm_content' AS "account",
                 EXISTS (SELECT 1 FROM "Conversation" v WHERE v."userId" = e."userId") AS "used",
                 EXISTS (
                   SELECT 1 FROM "BillingTransaction" b WHERE b."userId" = e."userId" AND b."status" = 'paid'
                 ) AS "paid"
          FROM "ProductAnalyticsEvent" e
          WHERE e."eventName" = 'signup_completed'
            AND e."properties"->>'touch_attribution' = 'attributed'
            AND e."occurredAt" >= ${window.start} AND e."occurredAt" < ${window.end}
        ) s
        GROUP BY 1
      `),
    ),
  ]);
  return { published, touches, signups };
}

/** The landing experiments a week saw: the stored one if it overlapped, and the results recorded in it. */
async function readWeeklyExperiments(
  db: Pick<PrismaClient, "$queryRaw" | "appSetting">,
  window: MarketingMeasurementWindow,
): Promise<MarketingWeeklyExperiment[] | null> {
  return settle(async () => {
    const [snapshot, results] = await Promise.all([
      readExperimentSnapshot(db),
      db.$queryRaw<Array<{ payload: unknown }>>(Prisma.sql`
        SELECT "payload" FROM "MarketingReport"
        WHERE "kind" = 'experiment_result' AND "createdAt" >= ${window.start} AND "createdAt" < ${window.end}
        ORDER BY "createdAt"
      `),
    ]);
    const config = snapshot.config;
    return marketingWeeklyExperiments({
      window,
      stored:
        config && snapshot.counts
          ? {
              experimentId: config.experimentId,
              bundleId: config.bundleId,
              variantId: config.variantId,
              status: config.status,
              startsAt: config.startsAt,
              endsAt: config.endsAt,
              stoppedAt: config.stoppedAt,
              counts: snapshot.counts,
            }
          : null,
      results: results.map((row) => row.payload),
    });
  });
}

const isoDate = (date: Date) => new Date(date.getTime() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** The last week that has ended by `now`, by its Monday. */
export const marketingLastFullWeekStart = (now: number): string => marketingStrategyWeek(now - 7 * DAY_MS).start;

export async function readMarketingWeeklyReport(
  db: Pick<PrismaClient, "$queryRaw" | "marketingCompetitor" | "appSetting">,
  weekStart: string,
  now: number = Date.now(),
): Promise<MarketingWeeklyReport | null> {
  const window = marketingWeekWindow(weekStart);
  if (!window || !marketingWeekReadable(window.start, now)) return null;
  const previousWindow = { start: new Date(window.start.getTime() - 7 * DAY_MS), end: window.start };
  // The week before is compared only while it can still be read whole.
  const previousReadable = marketingWeekReadable(previousWindow.start, now);
  const [measurement, analyses, strategies, intel, experiments, kpi, funnelNow, funnelBefore, experimentEntries] = await Promise.all([
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
    readMarketingFunnelCounts(db, window),
    previousReadable ? readMarketingFunnelCounts(db, previousWindow) : Promise.resolve(null),
    readWeeklyExperiments(db, window),
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
    previousWeekStart: marketingWeekReadable(new Date(window.start.getTime() - 7 * DAY_MS), now)
      ? isoDate(new Date(window.start.getTime() - 7 * DAY_MS))
      : null,
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
    experiments: { results: experiments[0]?.count ?? 0, entries: experimentEntries },
    funnel: summarizeMarketingFunnel({
      accounts: measurement.accounts.map((account) => account.accountSlug),
      current: funnelNow,
      previous: funnelBefore,
    }),
    weeklyKpiRecorded: (kpi[0]?.count ?? 0) > 0,
  };
}
