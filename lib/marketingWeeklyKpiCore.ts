/**
 * A1's weekly KPI (S3 plan, S3g): what the marketing tables say about one
 * week, in the `weekly_kpi` payload shape. Pure, so the counting is tested
 * without a database; `lib/marketingWeeklyKpi.ts` reads the rows and records
 * the report.
 *
 * A default chosen under the owner's 2026-10-30 request to build it: the
 * first weekly report counts Tomverse's own tables only. Google Analytics and
 * Search Console (plan D8) need a read credential and are a later report, not
 * a prerequisite for this one.
 *
 * A week is Monday 00:00 to Monday 00:00 in Brisbane (UTC+10, no daylight
 * saving), the operator's clock.
 */

import { MARKETING_REPORT_PAYLOAD_SCHEMAS } from "./marketingAutomationSchema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000;

/** The last week that has ended by `now`: [start, end), Monday 00:00 Brisbane to the next. */
export function marketingKpiWeek(now: Date): { readonly start: Date; readonly end: Date } {
  const local = now.getTime() + BRISBANE_OFFSET_MS;
  const midnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  // getUTCDay of the shifted clock is the Brisbane weekday; Monday is 1.
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  const end = midnight - sinceMonday * DAY_MS - BRISBANE_OFFSET_MS;
  return { start: new Date(end - 7 * DAY_MS), end: new Date(end) };
}

/** The post fields a weekly count reads. */
export type MarketingKpiPostRow = {
  readonly channelId: string;
  readonly status: string;
  readonly guardCodes: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
};

export type MarketingWeeklyKpi = {
  readonly postsPublished: number;
  readonly postsRejected: number;
  readonly guardRejectionsByCode: ReadonlyArray<{ readonly code: string; readonly count: number }>;
  readonly channelTotals: ReadonlyArray<{ readonly accountSlug: string; readonly published: number; readonly failed: number }>;
};

/** Accounts one report lists (the payload schema's limit). */
const MAX_CHANNELS = 20;

/**
 * The week's counts:
 * - published: a post whose `publishedAt` falls in the week, whatever it has become since;
 * - rejected by a person, failed: a post in that status whose last change falls in the week;
 * - Guard rejections: a post the Guard refused that was created in the week, once per code.
 *
 * Every account is listed, a quiet one with zeros: a missing account would
 * read as one nobody looked at. The result parses against the stored schema,
 * so a code that is not a registry id fails here rather than at the insert.
 */
export function marketingWeeklyKpi(input: {
  readonly week: { readonly start: Date; readonly end: Date };
  readonly channels: ReadonlyArray<{ readonly id: string; readonly accountSlug: string }>;
  readonly posts: readonly MarketingKpiPostRow[];
}): MarketingWeeklyKpi {
  const inWeek = (at: Date | null) =>
    at !== null && at.getTime() >= input.week.start.getTime() && at.getTime() < input.week.end.getTime();
  const totals = new Map(
    [...input.channels]
      .sort((left, right) => (left.accountSlug < right.accountSlug ? -1 : 1))
      .slice(0, MAX_CHANNELS)
      .map((channel) => [channel.id, { accountSlug: channel.accountSlug, published: 0, failed: 0 }]),
  );
  const codes = new Map<string, number>();
  let postsPublished = 0;
  let postsRejected = 0;
  for (const post of input.posts) {
    const total = totals.get(post.channelId);
    if (inWeek(post.publishedAt)) {
      postsPublished += 1;
      if (total) total.published += 1;
    }
    if (post.status === "rejected" && inWeek(post.updatedAt)) postsRejected += 1;
    if (post.status === "failed" && inWeek(post.updatedAt) && total) total.failed += 1;
    if (post.status === "guard_rejected" && inWeek(post.createdAt)) {
      for (const code of new Set(post.guardCodes)) codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  }
  return MARKETING_REPORT_PAYLOAD_SCHEMAS.weekly_kpi.parse({
    postsPublished,
    postsRejected,
    guardRejectionsByCode: [...codes.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([code, count]) => ({ code, count })),
    channelTotals: [...totals.values()],
  }) as MarketingWeeklyKpi;
}
