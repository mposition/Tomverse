import "server-only";

import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { FOUNDING_TESTER_PASS_STATUS, INTERNAL_PASS_FULFILLMENT } from "@/lib/foundingTesterPassCore";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
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
  usageToday: number
): AdminUserRow => ({
  ...user,
  createdAt: user.createdAt?.toISOString() || null,
  subscriptionCurrentPeriodEnd:
    user.subscriptionCurrentPeriodEnd?.toISOString() || null,
  creditDebtCostMicroUsd: Number(user.creditDebtCostMicroUsd),
  usageToday,
});

const getUsageTodayByUserId = async (
  users: AdminUserRecord[],
  now: Date
) => {
  const usageKeys = new Map(
    users.map((user) => [user.id, getUserChatUsageKey(user.id)])
  );
  if (usageKeys.size === 0) return new Map<string, number>();

  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const usageRows = await prisma.chatUsageBucket.findMany({
    where: {
      key: { in: Array.from(usageKeys.values()) },
      period: "day",
      periodStart,
    },
    select: { key: true, count: true },
  });
  const usageByKey = new Map(usageRows.map((row) => [row.key, row.count]));
  return new Map(
    users.map((user) => [
      user.id,
      usageByKey.get(usageKeys.get(user.id) || "") || 0,
    ])
  );
};

const queryAdminUserStats = async (
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

const getCachedAdminUserStats = unstable_cache(
  async () => queryAdminUserStats(new Date()),
  ["admin-user-stats-v1"],
  {
    revalidate: 60,
    tags: ["admin-user-stats"],
  }
);

export const getAdminUserStats = (): Promise<AdminUserStats> =>
  getCachedAdminUserStats();

export const getFreshAdminUserStats = (
  now = new Date()
): Promise<AdminUserStats> => queryAdminUserStats(now);

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

  const usageByUserId = await getUsageTodayByUserId(pageRecords, now);

  return {
    users: pageRecords.map((user) =>
      serializeAdminUser(user, usageByUserId.get(user.id) || 0)
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
  const usageByUserId = await getUsageTodayByUserId(batchRecords, now);

  return {
    users: batchRecords.map((user) =>
      serializeAdminUser(user, usageByUserId.get(user.id) || 0)
    ),
    nextCursor: hasMore ? batchRecords.at(-1)?.id || null : null,
  };
};
