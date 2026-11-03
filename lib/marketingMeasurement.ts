import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";

import { readMarketingAutomationSettings } from "@/lib/appSettings";
import { MARKETING_LLM_SETTINGS_KEY, parseMarketingLlmSettings } from "@/lib/marketingLlmBudgetCore";
import { MARKETING_LLM_COUNTED_MICRO_USD_SQL } from "@/lib/marketingLlmBudgetStore";
import {
  summarizeMarketingMeasurement,
  type MarketingConversionCount,
  type MarketingMeasurement,
  type MarketingMeasurementLlm,
  type MarketingMeasurementPost,
  type MarketingMeasurementWindow,
} from "@/lib/marketingMeasurementCore";
import { MARKETING_TOUCH_EVENT } from "@/lib/marketingTouchCore";

/**
 * The rows lib/marketingMeasurementCore.ts counts: the posts a window or the
 * queue can see, the accounts, the touches and attributed conversions, and
 * this UTC month's LLM ledger. Read-only and counts only -- no post text, no
 * person, no URL. Each part fails on its own and reads as null, never zero.
 */

type Reader = Pick<PrismaClient, "$queryRaw">;

/**
 * The dispatch attempts in a post's history. Read leniently: an entry this
 * does not recognise is not an attempt. Attempts retention has folded into a
 * summary are past the 24-month window any report reads.
 */
export const marketingAttemptsOf = (history: unknown): MarketingMeasurementPost["attempts"] =>
  (Array.isArray(history) ? history : []).flatMap((entry) => {
    const value = entry as { type?: unknown; at?: unknown; attempt?: unknown; outcome?: unknown; errorCode?: unknown };
    if (value?.type !== "attempt" || typeof value.at !== "string" || typeof value.attempt !== "number") return [];
    if (typeof value.outcome !== "string") return [];
    const at = new Date(value.at);
    if (Number.isNaN(at.getTime())) return [];
    return [{ at, attempt: value.attempt, outcome: value.outcome, errorCode: typeof value.errorCode === "string" ? value.errorCode : null }];
  });

const settle = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

const conversions = (db: Reader, window: MarketingMeasurementWindow, eventName: string, guestsOnly: boolean) =>
  settle(async (): Promise<MarketingConversionCount> => {
    const rows = await db.$queryRaw<Array<{ total: number; attributed: number }>>(Prisma.sql`
      SELECT count(*)::int AS "total",
             (count(*) FILTER (WHERE "properties"->>'touch_attribution' = 'attributed'))::int AS "attributed"
      FROM "ProductAnalyticsEvent"
      WHERE "eventName" = ${eventName}
        AND "occurredAt" >= ${window.start} AND "occurredAt" < ${window.end}
        ${guestsOnly ? Prisma.sql`AND "userId" IS NULL` : Prisma.empty}
    `);
    return { total: rows[0]?.total ?? 0, attributed: rows[0]?.attributed ?? 0 };
  });

/** This UTC month's marketing LLM ledger, at what the cap counts, and the cap. */
export const readMarketingLlmMonth = (db: Reader): Promise<MarketingMeasurementLlm | null> =>
  settle(async () => {
    const [rows, setting] = await Promise.all([
      db.$queryRaw<Array<{ calls: number; counted: bigint }>>(Prisma.sql`
        SELECT count(*)::int AS "calls", COALESCE(sum(${MARKETING_LLM_COUNTED_MICRO_USD_SQL}), 0)::bigint AS "counted"
        FROM "MarketingLlmCall"
        WHERE "monthStart" = date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')
      `),
      db.$queryRaw<Array<{ value: string }>>(Prisma.sql`
        SELECT "value" FROM "AppSetting" WHERE "key" = ${MARKETING_LLM_SETTINGS_KEY}
      `),
    ]);
    const cap = parseMarketingLlmSettings(setting[0]?.value)?.monthlyUsdCap ?? null;
    const capUsd = cap === null ? null : Number(cap);
    return {
      calls: rows[0]?.calls ?? 0,
      countedMicroUsd: Number(rows[0]?.counted ?? 0),
      capUsd: capUsd !== null && Number.isFinite(capUsd) ? capUsd : null,
    };
  });

export async function readMarketingMeasurement(
  db: Reader,
  window: MarketingMeasurementWindow,
): Promise<MarketingMeasurement> {
  const [posts, channels, touches, signups, signupChannels, guestLeads, llm] = await Promise.all([
    db
      .$queryRaw<Array<Omit<MarketingMeasurementPost, "attempts"> & { history: unknown }>>(Prisma.sql`
        SELECT c."accountSlug", p."status", p."publishAttempt", p."mode", p."createdAt", p."updatedAt", p."approvedAt", p."scheduledAt",
               p."publishedAt", p."verifiedPublicAt", p."outcomeUnknownAt", p."approvalExpiresAt",
               p."errorCode", p."guardCodes", p."history"
        FROM "MarketingPost" p JOIN "MarketingChannel" c ON c."id" = p."channelId"
        WHERE p."updatedAt" >= ${window.start} OR p."createdAt" >= ${window.start}
           OR p."status" IN ('pending_approval', 'approved', 'scheduled')
      `)
      .then((rows) => rows.map(({ history, ...row }) => ({ ...row, attempts: marketingAttemptsOf(history) }))),
    db.$queryRaw<Array<{ accountSlug: string; channel: string; status: string; pauseReasonCode: string | null }>>(Prisma.sql`
      SELECT "accountSlug", "channel", "status", "pauseReasonCode" FROM "MarketingChannel" ORDER BY "accountSlug"
    `),
    settle(async () => {
      const rows = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT count(*)::int AS "count" FROM "ProductAnalyticsEvent"
        WHERE "eventName" = ${MARKETING_TOUCH_EVENT}
          AND "occurredAt" >= ${window.start} AND "occurredAt" < ${window.end}
      `);
      return rows[0]?.count ?? 0;
    }),
    conversions(db, window, "signup_completed", false),
    settle(() =>
      db.$queryRaw<Array<{ source: string; medium: string; campaign: string; attributed: number }>>(Prisma.sql`
        SELECT COALESCE("properties"->>'touch_utm_source', '(direct)') AS "source",
               COALESCE("properties"->>'touch_utm_medium', '(none)') AS "medium",
               COALESCE("properties"->>'touch_utm_campaign', '(not set)') AS "campaign",
               count(*)::int AS "attributed"
        FROM "ProductAnalyticsEvent"
        WHERE "eventName" = 'signup_completed'
          AND "properties"->>'touch_attribution' = 'attributed'
          AND "occurredAt" >= ${window.start} AND "occurredAt" < ${window.end}
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC
        LIMIT 20
      `),
    ),
    conversions(db, window, "first_response_completed", true),
    readMarketingLlmMonth(db),
  ]);
  return summarizeMarketingMeasurement({ window, posts, channels, touches, signups, signupChannels, guestLeads, llm });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the morning report is given (lib/marketingMorningCore.ts): the last
 * seven days counted, and the switches a decision may turn on. Counts and
 * switch states only.
 */
export async function readMarketingOperations(db: Reader, now: number = Date.now()) {
  const [measurement, settings] = await Promise.all([
    readMarketingMeasurement(db, { start: new Date(now - 7 * DAY_MS), end: new Date(now) }),
    settle(() => readMarketingAutomationSettings()),
  ]);
  const value = (read: { ok: boolean; value?: boolean } | undefined) => (read?.ok ? (read.value ?? null) : null);
  return {
    measurement,
    switches: {
      draftsEnabled: value(settings?.draftsEnabled),
      publishEnabled: value(settings?.publishEnabled),
      autoPublishEnabled: value(settings?.autoPublishEnabled),
    },
  };
}

/**
 * Competitor prices from the two newest market reports, newest first: the
 * money facts only, without their pages, for the morning report to compare.
 */
export async function readMarketingPriceHistory(db: Reader) {
  const rows = await db.$queryRaw<Array<{ createdAt: Date; facts: unknown }>>(Prisma.sql`
    SELECT "createdAt", "payload"->'facts' AS "facts" FROM "MarketingReport"
    WHERE "kind" = 'market_intel' ORDER BY "createdAt" DESC LIMIT 2
  `);
  return rows.map((row) => ({
    reportCreatedAt: row.createdAt.toISOString(),
    prices: (Array.isArray(row.facts) ? row.facts : [])
      .filter(
        (fact): fact is { competitorId: string; factType: string; value: { kind: string } } =>
          typeof fact === "object" &&
          fact !== null &&
          typeof (fact as { competitorId?: unknown }).competitorId === "string" &&
          typeof (fact as { factType?: unknown }).factType === "string" &&
          (fact as { value?: { kind?: unknown } }).value?.kind === "money",
      )
      .map((fact) => ({ competitorId: fact.competitorId, factType: fact.factType, value: fact.value })),
  }));
}
