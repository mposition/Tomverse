/**
 * Records A1's weekly KPI report (S3 plan, S3g): once a week, the counts
 * `lib/marketingWeeklyKpiCore.ts` makes of the week that has just ended, as
 * one `weekly_kpi` report. Run by the daily maintenance job, so a missed day
 * is caught up the next; a week already reported is left alone.
 *
 * Nothing is recorded while there is no marketing account: there is no week
 * of marketing to count, and weeks of zeros would read as one. Nothing is
 * done at all while the marketing kill switch is on (policy §6.1: everything
 * but reading records stops), as retention does nothing then either.
 *
 * The report is derived data, not an action, so it has no audit entry of its
 * own -- as the retention job's `retention_run` report has none.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { marketingKpiWeek, marketingWeeklyKpi } from "@/lib/marketingWeeklyKpiCore";
import { insertMarketingReport, runMarketingTransaction } from "@/lib/marketingStore";

/** Recorded on the report, so a change to what is counted is a new version. */
export const MARKETING_WEEKLY_KPI_SOURCE_VERSION = "marketing-weekly-kpi-v1";

export type MarketingWeeklyKpiResult =
  | { readonly recorded: true; readonly weekStart: string; readonly reportId: string }
  | { readonly recorded: false; readonly weekStart: string; readonly reason: "already_recorded" | "no_accounts" }
  | { readonly recorded: false; readonly reason: "kill_switch" };

export async function runMarketingWeeklyKpi(
  client: PrismaClient,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MarketingWeeklyKpiResult> {
  // The same reading as every marketing gate: any non-empty value is on.
  const killSwitch = env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  if (typeof killSwitch === "string" && killSwitch.trim().length > 0) {
    return { recorded: false, reason: "kill_switch" };
  }
  return runMarketingTransaction(
    client,
    async (tx) => {
      // One writer at a time, so two maintenance runs cannot both find the week unreported.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tomverse-marketing-weekly-kpi'))`;
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
      `;
      const week = marketingKpiWeek(now);
      const weekStart = week.start.toISOString();
      const existing = await tx.marketingReport.findFirst({
        where: { kind: "weekly_kpi", periodStart: week.start },
        select: { id: true },
      });
      if (existing) return { recorded: false, weekStart, reason: "already_recorded" } as const;
      const channels = await tx.marketingChannel.findMany({ select: { id: true, accountSlug: true } });
      if (channels.length === 0) return { recorded: false, weekStart, reason: "no_accounts" } as const;
      const range = { gte: week.start, lt: week.end };
      const posts = await tx.marketingPost.findMany({
        where: { OR: [{ publishedAt: range }, { updatedAt: range }, { createdAt: range }] },
        select: { channelId: true, status: true, guardCodes: true, createdAt: true, updatedAt: true, publishedAt: true },
      });
      const report = await insertMarketingReport(tx, {
        kind: "weekly_kpi",
        periodStart: week.start,
        periodEnd: week.end,
        payload: marketingWeeklyKpi({ week, channels, posts }),
        sourceVersion: MARKETING_WEEKLY_KPI_SOURCE_VERSION,
      });
      return { recorded: true, weekStart, reportId: report.id } as const;
    },
    { maxWait: 5_000, timeout: 60_000 },
  );
}
