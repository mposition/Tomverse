import "server-only";

import type { Prisma } from "@prisma/client";
import { FOUNDING_TESTER_PASS_STATUS, INTERNAL_PASS_FULFILLMENT } from "@/lib/foundingTesterPassCore";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import { getZonedDayWindow } from "@/lib/userTimeZone";
import type {
  AdminUserRow,
  AdminUserSegment,
  AdminUserStats,
  AdminUsersPage,
} from "@/lib/adminUserTypes";

const adminUserListSelect = {
  id: true,
  email: true,
  name: true,
  plan: true,
  createdAt: true,
  subscriptionStatus: true,
  subscriptionCurrentPeriodEnd: true,
  subscriptionBillingInterval: true,
  subscriptionCancelAtPeriodEnd: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  creditDebtCredits: true,
  creditDebtCostMicroUsd: true,
  billingRiskStatus: true,
  settings: {
    select: {
      timeZone: true,
    },
  },
  _count: {
    select: {
      conversations: true,
      accounts: true,
      refundRequests: true,
      promotionRedemptions: true,
    },
  },
} satisfies Prisma.UserSelect;

type AdminUserRecord = Prisma.UserGetPayload<{
  select: typeof adminUserListSelect;
}>;

export const getAdminActivePaidWhere = (
  now = new Date()
): Prisma.UserWhereInput => ({
  plan: { in: ["Pro", "Max"] },
  stripeSubscriptionId: { not: null },
  subscriptionStatus: { in: ["active", "trialing"] },
  OR: [
    { subscriptionCurrentPeriodEnd: null },
    { subscriptionCurrentPeriodEnd: { gt: now } },
  ],
});

export const getAdminTesterPassWhere = (
  now = new Date()
): Prisma.UserWhereInput => ({
  plan: { in: ["Pro", "Max"] },
  subscriptionStatus: FOUNDING_TESTER_PASS_STATUS,
  subscriptionCurrentPeriodEnd: { gt: now },
  promotionRedemptions: {
    some: {
      expiredAt: null,
      accessEndsAt: { gt: now },
      promotion: { fulfillmentType: INTERNAL_PASS_FULFILLMENT },
    },
  },
});

export const getAdminCancelingWhere = (
  now = new Date()
): Prisma.UserWhereInput => ({
  AND: [
    getAdminActivePaidWhere(now),
    { subscriptionCancelAtPeriodEnd: true },
  ],
});

export const getAdminBillingRiskWhere = (): Prisma.UserWhereInput => ({
  OR: [
    { billingRiskStatus: "disputed_hold" },
    { creditDebtCredits: { gt: 0 } },
    { creditDebtCostMicroUsd: { gt: BigInt(0) } },
  ],
});

export const getAdminUserSegmentWhere = (
  segment: AdminUserSegment,
  now = new Date()
): Prisma.UserWhereInput | undefined => {
  switch (segment) {
    case "free":
      return { plan: "Free" };
    case "pro":
      return { plan: "Pro" };
    case "max":
      return { plan: "Max" };
    case "activePaid":
      return getAdminActivePaidWhere(now);
    case "testerPass":
      return getAdminTesterPassWhere(now);
    case "canceling":
      return getAdminCancelingWhere(now);
    case "billingRisk":
      return getAdminBillingRiskWhere();
    default:
      return undefined;
  }
};

const getSearchWhere = (query: string): Prisma.UserWhereInput | undefined =>
  query
    ? {
        OR: [
          { id: { contains: query, mode: "insensitive" } },
          { email: { contains: query, mode: "insensitive" } },
          { name: { contains: query, mode: "insensitive" } },
          { stripeCustomerId: { contains: query, mode: "insensitive" } },
        ],
      }
    : undefined;

const combineWhere = (
  segment: AdminUserSegment,
  query: string,
  now: Date
): Prisma.UserWhereInput | undefined => {
  const conditions = [
    getAdminUserSegmentWhere(segment, now),
    getSearchWhere(query),
  ].filter(Boolean) as Prisma.UserWhereInput[];
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { AND: conditions };
};

const serializeAdminUser = (
  user: AdminUserRecord,
  metrics: AdminUserDailyMetrics
): AdminUserRow => {
  const { settings: _settings, ...publicUser } = user;
  void _settings;
  return {
    ...publicUser,
    createdAt: user.createdAt?.toISOString() || null,
    subscriptionCurrentPeriodEnd:
      user.subscriptionCurrentPeriodEnd?.toISOString() || null,
    creditDebtCostMicroUsd: Number(user.creditDebtCostMicroUsd),
    timeZone: metrics.timeZone,
    messagesToday: metrics.messagesToday,
    creditsToday: metrics.creditsToday,
  };
};

type AdminUserDailyMetrics = {
  timeZone: string;
  messagesToday: number;
  creditsToday: number;
};

const getDailyMetricsByUserId = async (
  users: AdminUserRecord[],
  now: Date
) => {
  if (users.length === 0) return new Map<string, AdminUserDailyMetrics>();

  const descriptors = users.map((user) => {
    const window = getZonedDayWindow(user.settings?.timeZone, now);
    return {
      userId: user.id,
      usageKey: getUserChatUsageKey(user.id),
      ...window,
    };
  });

  const windows = new Map<
    string,
    { start: Date; end: Date; userIds: string[] }
  >();
  for (const descriptor of descriptors) {
    const key = `${descriptor.start.toISOString()}:${descriptor.end.toISOString()}`;
    const existing = windows.get(key);
    if (existing) existing.userIds.push(descriptor.userId);
    else {
      windows.set(key, {
        start: descriptor.start,
        end: descriptor.end,
        userIds: [descriptor.userId],
      });
    }
  }

  const [usageRows, messageGroups] = await Promise.all([
    prisma.chatUsageBucket.findMany({
      where: {
        period: "day",
        OR: descriptors.map((descriptor) => ({
          key: descriptor.usageKey,
          periodStart: descriptor.start,
        })),
      },
      select: { key: true, periodStart: true, count: true },
    }),
    Promise.all(
      Array.from(windows.values()).map(async (window) => ({
        window,
        conversations: await prisma.conversation.findMany({
          where: {
            userId: { in: window.userIds },
            messages: {
              some: { createdAt: { gte: window.start, lt: window.end } },
            },
          },
          select: {
            userId: true,
            _count: {
              select: {
                messages: {
                  where: { createdAt: { gte: window.start, lt: window.end } },
                },
              },
            },
          },
        }),
      }))
    ),
  ]);

  const usageByKey = new Map(
    usageRows.map((row) => [row.key, usageBucketCount(row.count)])
  );
  const messagesByUserId = new Map<string, number>();
  for (const group of messageGroups) {
    for (const conversation of group.conversations) {
      messagesByUserId.set(
        conversation.userId,
        (messagesByUserId.get(conversation.userId) || 0) +
          conversation._count.messages
      );
    }
  }

  return new Map(
    descriptors.map((descriptor) => [
      descriptor.userId,
      {
        timeZone: descriptor.timeZone,
        messagesToday: messagesByUserId.get(descriptor.userId) || 0,
        creditsToday: usageByKey.get(descriptor.usageKey) || 0,
      },
    ])
  );
};

/**
 * The Admin Console KPI counters, read straight from the database.
 *
 * These were previously served from `unstable_cache(..., { revalidate: 60,
 * tags: ["admin-user-stats"] })`, and nothing in the repository ever
 * invalidated that tag — so the counters were only ever refreshed by the timer.
 * Wiring the tag up to the writes did not fix it either. Measured on this
 * codebase against Next.js 16.2.12:
 *
 * - `revalidate: 60` is stale-while-revalidate, so a render always serves the
 *   previous entry and starts the refresh behind it. A probe rendered `17`
 *   while the database held `9`, then rendered `9` while the database held
 *   `16`: the screen is a page-load behind, and can show a figure from a run
 *   that no longer exists.
 * - `revalidateTag(tag, { expire: 0 })` was a silent no-op here — the counters
 *   did not move and nothing was logged. Only the deprecated single-argument
 *   `revalidateTag(tag)` actually expired the entry.
 * - Invalidation could not have been complete in any case. Sign-ups and Stripe
 *   subscription changes move these counts from paths that are not admin
 *   writes, and stale-while-revalidate would still hand the operator the old
 *   number on the first render after each of them.
 *
 * Meanwhile Overview renders a *fresh* plan mix next to what was a *cached*
 * paid-conversion rate, so one screen could contradict itself. The Admin
 * Console is an internal, low-traffic surface and this is ten `count()`
 * queries; paying for them on each render is cheaper than counters an operator
 * cannot trust. If they ever need caching again, cache them with `use cache`
 * plus `cacheTag()` and invalidate from every path that moves a plan — not
 * from the admin writes alone.
 */
export const getAdminUserStats = async (
  now = new Date()
): Promise<AdminUserStats> => {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const [
    totalAccounts,
    freeUsers,
    proUsers,
    maxUsers,
    activePaidSubscriptions,
    testerPassUsers,
    cancelingSubscriptions,
    billingRiskUsers,
    newUsers7d,
    newUsers30d,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { plan: "Free" } }),
    prisma.user.count({ where: { plan: "Pro" } }),
    prisma.user.count({ where: { plan: "Max" } }),
    prisma.user.count({ where: getAdminActivePaidWhere(now) }),
    prisma.user.count({ where: getAdminTesterPassWhere(now) }),
    prisma.user.count({ where: getAdminCancelingWhere(now) }),
    prisma.user.count({ where: getAdminBillingRiskWhere() }),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
  ]);

  return {
    generatedAt: now.toISOString(),
    totalAccounts,
    freeUsers,
    proUsers,
    maxUsers,
    activePaidSubscriptions,
    testerPassUsers,
    cancelingSubscriptions,
    billingRiskUsers,
    newUsers7d,
    newUsers30d,
    paidConversionRatePercent:
      totalAccounts > 0
        ? Number(((activePaidSubscriptions / totalAccounts) * 100).toFixed(2))
        : 0,
  };
};

export const getAdminUsersPage = async ({
  query = "",
  segment = "all",
  cursor,
  take = 30,
  now = new Date(),
}: {
  query?: string;
  segment?: AdminUserSegment;
  cursor?: string | null;
  take?: number;
  now?: Date;
} = {}): Promise<AdminUsersPage> => {
  const pageSize = Math.min(Math.max(Math.trunc(take), 1), 50);
  const records = await prisma.user.findMany({
    where: combineWhere(segment, query.trim(), now),
    orderBy: { id: "desc" },
    take: pageSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: adminUserListSelect,
  });
  const hasMore = records.length > pageSize;
  const pageRecords = hasMore ? records.slice(0, pageSize) : records;

  const metricsByUserId = await getDailyMetricsByUserId(pageRecords, now);

  return {
    users: pageRecords.map((user) =>
      serializeAdminUser(
        user,
        metricsByUserId.get(user.id) || {
          timeZone: "UTC",
          messagesToday: 0,
          creditsToday: 0,
        }
      )
    ),
    nextCursor: hasMore ? pageRecords.at(-1)?.id || null : null,
  };
};

export const getAdminUsersExportBatch = async ({
  query = "",
  segment = "all",
  cursor,
  take = 500,
  now = new Date(),
}: {
  query?: string;
  segment?: AdminUserSegment;
  cursor?: string | null;
  take?: number;
  now?: Date;
} = {}): Promise<AdminUsersPage> => {
  const batchSize = Math.min(Math.max(Math.trunc(take), 1), 1_000);
  const records: AdminUserRecord[] = await prisma.user.findMany({
    where: combineWhere(segment, query.trim(), now),
    orderBy: { id: "desc" },
    take: batchSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: adminUserListSelect,
  });
  const hasMore = records.length > batchSize;
  const batchRecords = hasMore ? records.slice(0, batchSize) : records;
  const metricsByUserId = await getDailyMetricsByUserId(batchRecords, now);

  return {
    users: batchRecords.map((user) =>
      serializeAdminUser(
        user,
        metricsByUserId.get(user.id) || {
          timeZone: "UTC",
          messagesToday: 0,
          creditsToday: 0,
        }
      )
    ),
    nextCursor: hasMore ? batchRecords.at(-1)?.id || null : null,
  };
};
