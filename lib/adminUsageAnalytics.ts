import "server-only";

import { Prisma } from "@prisma/client";
import { getConfiguredAdminAccess } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import {
  OPERATOR_TIME_ZONE,
  denseDailySeries,
  matrixDayTotals,
  matrixHourTotals,
  resolveUsageWindow,
  shareTable,
  stickiness,
  timeZoneRegion,
  weekHourMatrix,
  windowDayKeys,
  type DailyPoint,
  type ShareTable,
  type UsagePeriodId,
  type UsageWindow,
} from "@/lib/adminUsageAnalyticsCore";

/**
 * Who actually used Tomverse, read for the Admin Console usage tab.
 *
 * The source of "use" is `ChatCreditReservation`: `acquireChatAccess()` writes
 * one row for every model request -- signed-in or guest, chat or AI Review,
 * completed or failed -- before the provider is called. It is the only record
 * that sees guests at all, since a guest conversation lives in the browser.
 * Messages and conversations come from their own tables and therefore describe
 * accounts only; the screen labels them that way.
 *
 * Everything is aggregated in SQL. No account id, email, prompt or answer is
 * selected into this process, only counts and the segment values being
 * counted.
 */

export type PeriodMetric = { current: number; previous: number };

export type UsageSegmentDimension =
  | "plan"
  | "language"
  | "country"
  | "countrySource"
  | "timeZone"
  | "region"
  | "defaultModel";

export type UsageSegments = Record<UsageSegmentDimension, ShareTable>;

export type UsageModelRow = {
  modelId: string;
  provider: string;
  requests: number;
  failed: number;
  /** Requests with an outcome; the failure rate's denominator. */
  finished: number;
  credits: number;
  /** Every attempt this model was dispatched for, fallbacks included. */
  costMicroUsd: number;
  share: number;
};

export type UsageAnalyticsReport = {
  available: boolean;
  generatedAt: string;
  timeZone: string;
  window: Omit<UsageWindow, "start" | "end" | "previousStart" | "previousEnd"> & {
    start: string;
    end: string;
    previousStart: string;
    previousEnd: string;
  };
  headline: {
    activeAccounts: PeriodMetric;
    activeGuests: PeriodMetric;
    modelRequests: PeriodMetric;
    failedRequests: PeriodMetric;
    finishedRequests: PeriodMetric;
    userMessages: PeriodMetric;
    activeConversations: PeriodMetric;
    conversationsStarted: PeriodMetric;
    newSignups: PeriodMetric;
    creditsUsed: PeriodMetric;
    /** Chat and AI Review attempts plus settled image generations. */
    providerCostMicroUsd: PeriodMetric;
    imageCostMicroUsd: PeriodMetric;
    aiReviewRuns: PeriodMetric;
    imagesGenerated: PeriodMetric;
  };
  engagement: {
    newActiveAccounts: number;
    operatorActiveAccounts: number;
    topTenRequestShare: number | null;
    requestingAccounts: number;
  };
  conversationsByProduct: ShareTable;
  requestsBySource: ShareTable;
  models: { total: number; rows: UsageModelRow[] };
  providers: ShareTable;
  activity: {
    matrix: number[][];
    hours: number[];
    weekdays: number[];
  };
  trend: {
    days: DailyPoint[];
    wau: number;
    mau: number;
    stickiness: number | null;
  };
  retention: {
    cohortStart: string;
    cohortEnd: string;
    cohort: number;
    activatedDay0: number;
    /** Activated accounts that also made a request on days 1 to 7. */
    retainedWeek1: number;
  };
  activeSegments: UsageSegments;
  allAccountSegments: UsageSegments;
  visitors: {
    country: ShareTable;
    language: ShareTable;
  };
};

/** Days in the trend chart and the MAU window, fixed regardless of the period. */
export const USAGE_TREND_DAYS = 30;

/** Per statement, so one slow range read cannot hold the connection. */
const USAGE_STATEMENT_TIMEOUT_MS = 10_000;
/** For the whole report. */
const USAGE_REPORT_TIMEOUT_MS = 45_000;

type Db = Prisma.TransactionClient;

/** Fewer segments shown for the long-tail dimensions. */
const MODEL_ROW_LIMIT = 12;

const num = (value: unknown) => Number(value ?? 0);

const emptyShare = (): ShareTable => ({ total: 0, rows: [] });

const emptySegments = (): UsageSegments => ({
  plan: emptyShare(),
  language: emptyShare(),
  country: emptyShare(),
  countrySource: emptyShare(),
  timeZone: emptyShare(),
  region: emptyShare(),
  defaultModel: emptyShare(),
});

/**
 * `"createdAt"` as a local timestamp in the operator's zone. The columns are
 * `timestamp(3)` holding UTC, so they are first marked as UTC and then
 * converted; the zone is a bound parameter, never spliced text.
 */
const localCreatedAt = (timeZone: string) =>
  Prisma.sql`(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})`;

type WindowCounts = {
  accounts: bigint;
  guests: bigint;
  requests: bigint;
  failed: bigint;
  finished: bigint;
  credits: bigint;
  cost: bigint;
  imageCost: bigint;
  messages: bigint;
  conversations: bigint;
  started: bigint;
  signups: bigint;
};

const readWindowCounts = async (db: Db, start: Date, end: Date) => {
  const [row] = await db.$queryRaw<WindowCounts[]>`
    SELECT
      r.accounts, r.guests, r.requests, r.failed, r.finished, r.credits,
      a.cost, i.cost AS "imageCost",
      m.messages, m.conversations, c.started, u.signups
    FROM (
      SELECT
        COUNT(DISTINCT "userId") AS accounts,
        COUNT(DISTINCT "subjectKey") FILTER (WHERE "subjectKey" LIKE 'guest:%') AS guests,
        COUNT(*) AS requests,
        COUNT(*) FILTER (WHERE "outcome" IN ('failed', 'empty')) AS failed,
        COUNT(*) FILTER (WHERE "outcome" IS NOT NULL) AS finished,
        COALESCE(SUM("settledCredits"), 0)::bigint AS credits
      FROM "ChatCreditReservation"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    ) r,
    (
      -- What providers were actually paid for: every dispatched attempt,
      -- a failed primary before a fallback included, with its corrections.
      -- The reservation's settled cost is only the attempt the user paid for.
      SELECT COALESCE(SUM(ua."costMicroUsd" + COALESCE(adj.delta, 0)), 0)::bigint AS cost
      FROM "ChatAttemptUsage" ua
      LEFT JOIN LATERAL (
        SELECT SUM(x."costDeltaMicroUsd") AS delta
        FROM "ChatAttemptUsageAdjustment" x
        WHERE x."reservationId" = ua."reservationId" AND x."attemptIndex" = ua."attemptIndex"
      ) adj ON TRUE
      WHERE ua."createdAt" >= ${start} AND ua."createdAt" < ${end}
    ) a,
    (
      SELECT COALESCE(SUM("settledCostMicroUsd"), 0)::bigint AS cost
      FROM "ImageCreditReservation"
      WHERE "status" = 'settled' AND "settledAt" >= ${start} AND "settledAt" < ${end}
    ) i,
    (
      SELECT COUNT(*) AS messages, COUNT(DISTINCT "conversationId") AS conversations
      FROM "Message"
      WHERE "role" = 'user' AND "createdAt" >= ${start} AND "createdAt" < ${end}
    ) m,
    (
      SELECT COUNT(*) AS started
      FROM "Conversation"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    ) c,
    (
      SELECT COUNT(*) AS signups
      FROM "User"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    ) u
  `;
  const aiReviewRuns = await db.comparisonReviewRun.count({
    where: { createdAt: { gte: start, lt: end } },
  });
  // Counted when the image finished, so a closed period does not change after
  // the fact when a generation started before midnight completes.
  const imagesGenerated = await db.imageGeneration.count({
    where: { completedAt: { gte: start, lt: end }, status: "succeeded" },
  });
  return {
    accounts: num(row?.accounts),
    guests: num(row?.guests),
    requests: num(row?.requests),
    failed: num(row?.failed),
    finished: num(row?.finished),
    credits: num(row?.credits),
    cost: num(row?.cost) + num(row?.imageCost),
    imageCost: num(row?.imageCost),
    messages: num(row?.messages),
    conversations: num(row?.conversations),
    started: num(row?.started),
    signups: num(row?.signups),
    aiReviewRuns,
    imagesGenerated,
  };
};

type SegmentRow = { dim: string; key: string | null; count: bigint };

const segmentsFromRows = (rows: readonly SegmentRow[]): UsageSegments => {
  const grouped = new Map<string, { key: string | null; count: number }[]>();
  for (const row of rows) {
    const list = grouped.get(row.dim) ?? [];
    list.push({ key: row.key, count: num(row.count) });
    grouped.set(row.dim, list);
  }
  const timeZones = grouped.get("timeZone") ?? [];
  return {
    plan: shareTable(grouped.get("plan") ?? []),
    language: shareTable(grouped.get("language") ?? []),
    country: shareTable(grouped.get("country") ?? []),
    countrySource: shareTable(grouped.get("countrySource") ?? []),
    timeZone: shareTable(timeZones),
    region: shareTable(timeZones.map((row) => ({ key: timeZoneRegion(row.key), count: row.count }))),
    defaultModel: shareTable(grouped.get("defaultModel") ?? []),
  };
};

/**
 * One row per (dimension, value) over a population of accounts.
 *
 * `country` prefers the account's own statement and falls back to the payment
 * country; `countrySource` says which one answered, so a table full of
 * "billing" is visibly a table about paying accounts.
 */
const SEGMENT_SELECT = Prisma.sql`
  SELECT v.dim, v.key, COUNT(*) AS count
  FROM population p
  JOIN "User" u ON u."id" = p."userId"
  LEFT JOIN "UserSettings" s ON s."userId" = u."id"
  CROSS JOIN LATERAL (VALUES
    ('plan', u."plan"),
    ('language', s."language"),
    ('country', UPPER(COALESCE(s."country", s."billingCountry"))),
    ('countrySource', CASE
      WHEN s."country" IS NOT NULL THEN COALESCE(s."countrySource", 'declared')
      WHEN s."billingCountry" IS NOT NULL THEN 'billing'
      ELSE NULL END),
    ('timeZone', s."timeZone"),
    ('defaultModel', s."defaultModel")
  ) AS v(dim, key)
  GROUP BY v.dim, v.key
`;

const readActiveSegments = (db: Db, start: Date, end: Date) =>
  db.$queryRaw<SegmentRow[]>`
    WITH population AS (
      SELECT DISTINCT "userId" FROM "ChatCreditReservation"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end} AND "userId" IS NOT NULL
    )
    ${SEGMENT_SELECT}
  `;

/** Every account not already on its way out. */
const readAllAccountSegments = (db: Db) =>
  db.$queryRaw<SegmentRow[]>`
    WITH population AS (
      SELECT "id" AS "userId" FROM "User"
      WHERE "accountStatus" NOT IN ('pending_deletion', 'deletion_processing')
    )
    ${SEGMENT_SELECT}
  `;

const readEngagement = async (db: Db, start: Date, end: Date) => {
  const operators = getConfiguredAdminAccess();
  const operatorEmails = operators
    .filter((entry) => entry.identityType === "email")
    .map((entry) => entry.identity.toLowerCase());
  const operatorUserIds = operators
    .filter((entry) => entry.identityType === "userId")
    .map((entry) => entry.identity);

  const [row] = await db.$queryRaw<
    Array<{ fresh: bigint; operators: bigint; top: bigint; total: bigint; accounts: bigint }>
  >`
    WITH per_account AS (
      SELECT "userId", COUNT(*) AS requests
      FROM "ChatCreditReservation"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end} AND "userId" IS NOT NULL
      GROUP BY "userId"
    ),
    ranked AS (
      SELECT requests, ROW_NUMBER() OVER (ORDER BY requests DESC) AS rank
      FROM per_account
    )
    SELECT
      (SELECT COUNT(*) FROM per_account p JOIN "User" u ON u."id" = p."userId"
        WHERE u."createdAt" >= ${start}) AS fresh,
      (SELECT COUNT(*) FROM per_account p JOIN "User" u ON u."id" = p."userId"
        WHERE LOWER(u."email") = ANY(${operatorEmails}::text[])
           OR u."id" = ANY(${operatorUserIds}::text[])) AS operators,
      (SELECT COALESCE(SUM(requests), 0)::bigint FROM ranked WHERE rank <= 10) AS top,
      (SELECT COALESCE(SUM(requests), 0)::bigint FROM ranked) AS total,
      (SELECT COUNT(*) FROM per_account) AS accounts
  `;
  const total = num(row?.total);
  return {
    newActiveAccounts: num(row?.fresh),
    operatorActiveAccounts: num(row?.operators),
    // Ten accounts out of ten is not concentration; say nothing until there
    // are more accounts than the cut.
    topTenRequestShare: num(row?.accounts) > 10 && total > 0 ? num(row?.top) / total : null,
    requestingAccounts: num(row?.accounts),
  };
};

const readModels = async (db: Db, start: Date, end: Date) => {
  const rows = await db.$queryRaw<
    Array<{
      modelId: string;
      provider: string;
      source: string;
      requests: bigint;
      failed: bigint;
      finished: bigint;
      credits: bigint;
    }>
  >`
    SELECT
      "modelId", "provider", "source",
      COUNT(*) AS requests,
      COUNT(*) FILTER (WHERE "outcome" IN ('failed', 'empty')) AS failed,
      COUNT(*) FILTER (WHERE "outcome" IS NOT NULL) AS finished,
      COALESCE(SUM("settledCredits"), 0)::bigint AS credits
    FROM "ChatCreditReservation"
    WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    GROUP BY "modelId", "provider", "source"
  `;
  // Cost comes from the attempt ledger, keyed by the model each attempt was
  // actually sent to: a fallback's cost belongs to the fallback model, not to
  // the model the user picked.
  const attemptCosts = await db.$queryRaw<
    Array<{ modelId: string; provider: string; cost: bigint }>
  >`
    SELECT ua."modelId", ua."provider",
      COALESCE(SUM(ua."costMicroUsd" + COALESCE(adj.delta, 0)), 0)::bigint AS cost
    FROM "ChatAttemptUsage" ua
    LEFT JOIN LATERAL (
      SELECT SUM(x."costDeltaMicroUsd") AS delta
      FROM "ChatAttemptUsageAdjustment" x
      WHERE x."reservationId" = ua."reservationId" AND x."attemptIndex" = ua."attemptIndex"
    ) adj ON TRUE
    WHERE ua."createdAt" >= ${start} AND ua."createdAt" < ${end}
    GROUP BY ua."modelId", ua."provider"
  `;
  const byModel = new Map<string, UsageModelRow>();
  const rowFor = (provider: string, modelId: string) => {
    const key = JSON.stringify([provider, modelId]);
    let current = byModel.get(key);
    if (!current) {
      current = {
        modelId,
        provider,
        requests: 0,
        failed: 0,
        finished: 0,
        credits: 0,
        costMicroUsd: 0,
        share: 0,
      };
      byModel.set(key, current);
    }
    return current;
  };
  for (const row of rows) {
    const current = rowFor(row.provider, row.modelId);
    current.requests += num(row.requests);
    current.failed += num(row.failed);
    current.finished += num(row.finished);
    current.credits += num(row.credits);
  }
  for (const row of attemptCosts) {
    rowFor(row.provider, row.modelId).costMicroUsd += num(row.cost);
  }
  const total = [...byModel.values()].reduce((sum, row) => sum + row.requests, 0);
  const modelRows = [...byModel.values()]
    .map((row) => ({ ...row, share: total ? row.requests / total : 0 }))
    .sort((a, b) => b.requests - a.requests || a.modelId.localeCompare(b.modelId))
    .slice(0, MODEL_ROW_LIMIT);
  return {
    models: { total, rows: modelRows },
    providers: shareTable(rows.map((row) => ({ key: row.provider, count: num(row.requests) }))),
    requestsBySource: shareTable(rows.map((row) => ({ key: row.source, count: num(row.requests) }))),
  };
};

const readConversationProducts = async (db: Db, start: Date, end: Date) => {
  const rows = await db.$queryRaw<Array<{ product: string | null; count: bigint }>>`
    SELECT
      CASE WHEN "kind" = 'image' THEN 'image' ELSE COALESCE("productKey", "kind") END AS product,
      COUNT(*) AS count
    FROM "Conversation"
    WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    GROUP BY 1
  `;
  return shareTable(rows.map((row) => ({ key: row.product, count: num(row.count) })));
};

const readActivityMatrix = async (db: Db, start: Date, end: Date, timeZone: string) => {
  const local = localCreatedAt(timeZone);
  const rows = await db.$queryRaw<Array<{ dow: number; hour: number; count: bigint }>>`
    SELECT
      EXTRACT(DOW FROM ${local})::int AS dow,
      EXTRACT(HOUR FROM ${local})::int AS hour,
      COUNT(*) AS count
    FROM "ChatCreditReservation"
    WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    GROUP BY 1, 2
  `;
  const matrix = weekHourMatrix(
    rows.map((row) => ({ dow: row.dow, hour: row.hour, count: num(row.count) }))
  );
  return { matrix, hours: matrixHourTotals(matrix), weekdays: matrixDayTotals(matrix) };
};

const readTrend = async (db: Db, now: Date, timeZone: string) => {
  const trendWindow = resolveUsageWindow("last30", now, timeZone);
  const weekWindow = resolveUsageWindow("last7", now, timeZone);
  const local = localCreatedAt(timeZone);
  const reservationDays = await db.$queryRaw<Array<{ day: string; accounts: bigint; guests: bigint; requests: bigint }>>`
      SELECT
        TO_CHAR(${local}, 'YYYY-MM-DD') AS day,
        COUNT(DISTINCT "userId") AS accounts,
        COUNT(DISTINCT "subjectKey") FILTER (WHERE "subjectKey" LIKE 'guest:%') AS guests,
        COUNT(*) AS requests
      FROM "ChatCreditReservation"
      WHERE "createdAt" >= ${trendWindow.start} AND "createdAt" < ${trendWindow.end}
      GROUP BY 1
    `;
  const messageDays = await db.$queryRaw<Array<{ day: string; messages: bigint }>>`
      SELECT TO_CHAR(${local}, 'YYYY-MM-DD') AS day, COUNT(*) AS messages
      FROM "Message"
      WHERE "role" = 'user'
        AND "createdAt" >= ${trendWindow.start} AND "createdAt" < ${trendWindow.end}
      GROUP BY 1
    `;
  const distinct = await db.$queryRaw<Array<{ wau: bigint; mau: bigint }>>`
      SELECT
        COUNT(DISTINCT "userId") FILTER (WHERE "createdAt" >= ${weekWindow.start}) AS wau,
        COUNT(DISTINCT "userId") AS mau
      FROM "ChatCreditReservation"
      WHERE "createdAt" >= ${trendWindow.start} AND "createdAt" < ${trendWindow.end}
    `;
  const days = denseDailySeries(windowDayKeys(trendWindow), [
    ...reservationDays.map((row) => ({
      day: row.day,
      accounts: num(row.accounts),
      guests: num(row.guests),
      requests: num(row.requests),
    })),
    ...messageDays.map((row) => ({ day: row.day, messages: num(row.messages) })),
  ]);
  const mau = num(distinct[0]?.mau);
  // Today is still in progress; averaging it in would drag stickiness down
  // every morning.
  const completeDays = days.slice(0, -1).map((day) => day.accounts);
  return {
    days,
    wau: num(distinct[0]?.wau),
    mau,
    stickiness: stickiness(completeDays, mau),
  };
};

/**
 * Week-1 retention of recent signups.
 *
 * The cohort is accounts created between 38 and 8 days ago, so every member
 * has had its whole day-1-to-7 window. "Activated" is a model request within 24 hours of
 * signup; "retained" is an activated account that made another request on
 * days 1 to 7, so the retention rate's denominator is the activated accounts,
 * not every sign-up -- an account first used on day 3 was never away.
 */
const readRetention = async (db: Db, now: Date) => {
  // Eight days, not seven: "days 1 to 7" runs until signup + 8 days, and an
  // account still inside that span has not yet had its chance to come back.
  const cohortEnd = new Date(now.getTime() - 8 * 86_400_000);
  const cohortStart = new Date(cohortEnd.getTime() - 30 * 86_400_000);
  const [row] = await db.$queryRaw<
    Array<{ cohort: bigint; activated: bigint; retained: bigint }>
  >`
    SELECT
      COUNT(*) AS cohort,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "ChatCreditReservation" r
        WHERE r."userId" = u."id"
          AND r."createdAt" >= u."createdAt"
          AND r."createdAt" < u."createdAt" + INTERVAL '1 day'
      )) AS activated,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "ChatCreditReservation" r
        WHERE r."userId" = u."id"
          AND r."createdAt" >= u."createdAt"
          AND r."createdAt" < u."createdAt" + INTERVAL '1 day'
      ) AND EXISTS (
        SELECT 1 FROM "ChatCreditReservation" r
        WHERE r."userId" = u."id"
          AND r."createdAt" >= u."createdAt" + INTERVAL '1 day'
          AND r."createdAt" < u."createdAt" + INTERVAL '8 days'
      )) AS retained
    FROM "User" u
    WHERE u."createdAt" >= ${cohortStart} AND u."createdAt" < ${cohortEnd}
  `;
  return {
    cohortStart: cohortStart.toISOString(),
    cohortEnd: cohortEnd.toISOString(),
    cohort: num(row?.cohort),
    activatedDay0: num(row?.activated),
    retainedWeek1: num(row?.retained),
  };
};

/**
 * Consented visitors, including guests, by the IP country and language the
 * product analytics ledger recorded. Only visitors who accepted analytics are
 * in this ledger, so it is a sample and the screen names it as one.
 */
const readVisitors = async (db: Db, start: Date, end: Date) => {
  const rows = await db.$queryRaw<SegmentRow[]>`
    SELECT v.dim, v.key, COUNT(DISTINCT e."anonymousIdHash") AS count
    FROM "ProductAnalyticsEvent" e
    CROSS JOIN LATERAL (VALUES
      ('country', NULLIF(NULLIF(UPPER(e."country"), 'ZZ'), '')),
      ('language', NULLIF(e."language", ''))
    ) AS v(dim, key)
    WHERE e."occurredAt" >= ${start} AND e."occurredAt" < ${end}
    GROUP BY v.dim, v.key
  `;
  const pick = (dim: string) =>
    shareTable(
      rows.filter((row) => row.dim === dim).map((row) => ({ key: row.key, count: num(row.count) }))
    );
  return { country: pick("country"), language: pick("language") };
};

const metric = (current: number, previous: number): PeriodMetric => ({ current, previous });

export const readUsageAnalytics = async (
  period: UsagePeriodId,
  now: Date = new Date(),
  timeZone: string = OPERATOR_TIME_ZONE
): Promise<UsageAnalyticsReport> => {
  const window = resolveUsageWindow(period, now, timeZone);
  const serializedWindow = {
    ...window,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    previousStart: window.previousStart.toISOString(),
    previousEnd: window.previousEnd.toISOString(),
  };

  try {
    // One read-only transaction on one connection, statements in sequence.
    //
    // Several of these range reads have no index to lean on: the reservation
    // and attempt ledgers are indexed for per-account and per-provider reads.
    // Adding one is a write-blocking lock on the table every chat request
    // inserts into, and Prisma applies a migration inside a transaction, so it
    // cannot be built concurrently there. Until production row counts justify
    // that as its own change, the report is bounded instead: it holds at most
    // one pooled connection, every statement is cut off by a timeout, and the
    // snapshot is consistent across every number on the screen.
    const data = await prisma.$transaction(
      async (db) => {
        await db.$executeRaw`SET TRANSACTION READ ONLY`;
        await db.$queryRaw`SELECT set_config('statement_timeout', ${String(USAGE_STATEMENT_TIMEOUT_MS)}, true)`;
        const current = await readWindowCounts(db, window.start, window.end);
        const previous = await readWindowCounts(db, window.previousStart, window.previousEnd);
        const engagement = await readEngagement(db, window.start, window.end);
        const modelData = await readModels(db, window.start, window.end);
        const conversationsByProduct = await readConversationProducts(db, window.start, window.end);
        const activity = await readActivityMatrix(db, window.start, window.end, timeZone);
        const trend = await readTrend(db, now, timeZone);
        const retention = await readRetention(db, now);
        const activeSegmentRows = await readActiveSegments(db, window.start, window.end);
        const allSegmentRows = await readAllAccountSegments(db);
        const visitors = await readVisitors(db, window.start, window.end);
        return {
          current,
          previous,
          engagement,
          modelData,
          conversationsByProduct,
          activity,
          trend,
          retention,
          activeSegmentRows,
          allSegmentRows,
          visitors,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: USAGE_REPORT_TIMEOUT_MS,
      }
    );
    const {
      current,
      previous,
      engagement,
      modelData,
      conversationsByProduct,
      activity,
      trend,
      retention,
      activeSegmentRows,
      allSegmentRows,
      visitors,
    } = data;

    return {
      available: true,
      generatedAt: now.toISOString(),
      timeZone,
      window: serializedWindow,
      headline: {
        activeAccounts: metric(current.accounts, previous.accounts),
        activeGuests: metric(current.guests, previous.guests),
        modelRequests: metric(current.requests, previous.requests),
        failedRequests: metric(current.failed, previous.failed),
        finishedRequests: metric(current.finished, previous.finished),
        userMessages: metric(current.messages, previous.messages),
        activeConversations: metric(current.conversations, previous.conversations),
        conversationsStarted: metric(current.started, previous.started),
        newSignups: metric(current.signups, previous.signups),
        creditsUsed: metric(current.credits, previous.credits),
        providerCostMicroUsd: metric(current.cost, previous.cost),
        imageCostMicroUsd: metric(current.imageCost, previous.imageCost),
        aiReviewRuns: metric(current.aiReviewRuns, previous.aiReviewRuns),
        imagesGenerated: metric(current.imagesGenerated, previous.imagesGenerated),
      },
      engagement,
      conversationsByProduct,
      requestsBySource: modelData.requestsBySource,
      models: modelData.models,
      providers: modelData.providers,
      activity,
      trend,
      retention,
      activeSegments: segmentsFromRows(activeSegmentRows),
      allAccountSegments: segmentsFromRows(allSegmentRows),
      visitors,
    };
  } catch (error) {
    // The tab must still render its period selector and say the report is
    // unavailable, rather than taking the whole Analytics page down with it.
    console.error(
      JSON.stringify({
        event: "admin_usage_analytics_failed",
        period,
        error: error instanceof Error ? error.name : "unknown",
      })
    );
    const zero = metric(0, 0);
    return {
      available: false,
      generatedAt: now.toISOString(),
      timeZone,
      window: serializedWindow,
      headline: {
        activeAccounts: zero,
        activeGuests: zero,
        modelRequests: zero,
        failedRequests: zero,
        finishedRequests: zero,
        userMessages: zero,
        activeConversations: zero,
        conversationsStarted: zero,
        newSignups: zero,
        creditsUsed: zero,
        providerCostMicroUsd: zero,
        imageCostMicroUsd: zero,
        aiReviewRuns: zero,
        imagesGenerated: zero,
      },
      engagement: {
        newActiveAccounts: 0,
        operatorActiveAccounts: 0,
        topTenRequestShare: null,
        requestingAccounts: 0,
      },
      conversationsByProduct: emptyShare(),
      requestsBySource: emptyShare(),
      models: { total: 0, rows: [] },
      providers: emptyShare(),
      activity: {
        matrix: weekHourMatrix([]),
        hours: Array<number>(24).fill(0),
        weekdays: Array<number>(7).fill(0),
      },
      trend: { days: [], wau: 0, mau: 0, stickiness: null },
      retention: {
        cohortStart: now.toISOString(),
        cohortEnd: now.toISOString(),
        cohort: 0,
        activatedDay0: 0,
        retainedWeek1: 0,
      },
      activeSegments: emptySegments(),
      allAccountSegments: emptySegments(),
      visitors: { country: emptyShare(), language: emptyShare() },
    };
  }
};
