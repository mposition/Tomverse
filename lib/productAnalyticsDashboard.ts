import "server-only";

import { prisma } from "@/lib/prisma";
import { PRODUCT_ANALYTICS_EVENT_NAMES } from "@/lib/productAnalyticsShared";

type ActorRow = {
  userId: string | null;
  anonymousIdHash: string;
};

type ActivationRow = ActorRow & {
  eventName: string;
  modelCount: number;
  occurredAt: Date;
};

const actorKey = (row: ActorRow, identityLinks?: Map<string, string>) =>
  row.userId
    ? `user:${row.userId}`
    : identityLinks?.get(row.anonymousIdHash) ||
      `anonymous:${row.anonymousIdHash}`;

export type ProductAnalyticsDashboard = {
  available: boolean;
  generatedAt: string;
  configured: {
    measurementId: boolean;
    apiSecret: boolean;
  };
  funnel30d: Array<{ eventName: string; count: number }>;
  weeklyActiveComparisonUsers: number;
  activatedUsers30d: number;
  signupUsers30d: number;
  activationRate30d: number;
  returnDay1Users30d: number;
  returnDay7Users30d: number;
  topCampaigns30d: Array<{
    source: string;
    medium: string;
    campaign: string;
    landingViews: number;
  }>;
};

const emptyDashboard = (): ProductAnalyticsDashboard => ({
  available: false,
  generatedAt: new Date().toISOString(),
  configured: {
    measurementId: /^G-[A-Z0-9]+$/.test(
      process.env.GA4_MEASUREMENT_ID?.trim() || ""
    ),
    apiSecret: Boolean(process.env.GA4_API_SECRET?.trim()),
  },
  funnel30d: PRODUCT_ANALYTICS_EVENT_NAMES.map((eventName) => ({
    eventName,
    count: 0,
  })),
  weeklyActiveComparisonUsers: 0,
  activatedUsers30d: 0,
  signupUsers30d: 0,
  activationRate30d: 0,
  returnDay1Users30d: 0,
  returnDay7Users30d: 0,
  topCampaigns30d: [],
});

export async function getProductAnalyticsDashboard(): Promise<ProductAnalyticsDashboard> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  try {
    const [
      countGroups,
      weeklyActorGroups,
      activationRows,
      day1ActorGroups,
      day7ActorGroups,
      campaignGroups,
      identityLinkGroups,
    ] = await Promise.all([
      prisma.productAnalyticsEvent.groupBy({
        by: ["eventName"],
        where: { occurredAt: { gte: thirtyDaysAgo } },
        _count: { _all: true },
      }),
      prisma.productAnalyticsEvent.groupBy({
        by: ["userId", "anonymousIdHash"],
        where: {
          eventName: "multi_model_compare_completed",
          occurredAt: { gte: sevenDaysAgo },
        },
      }),
      prisma.productAnalyticsEvent.findMany({
        where: {
          eventName: {
            in: [
              "signup_completed",
              "multi_model_compare_completed",
              "followup_sent",
              "conversation_saved",
              "share_created",
            ],
          },
          occurredAt: { gte: thirtyDaysAgo },
        },
        orderBy: { occurredAt: "asc" },
        select: {
          eventName: true,
          modelCount: true,
          userId: true,
          anonymousIdHash: true,
          occurredAt: true,
        },
      }),
      prisma.productAnalyticsEvent.groupBy({
        by: ["userId", "anonymousIdHash"],
        where: { eventName: "return_day_1", occurredAt: { gte: thirtyDaysAgo } },
      }),
      prisma.productAnalyticsEvent.groupBy({
        by: ["userId", "anonymousIdHash"],
        where: { eventName: "return_day_7", occurredAt: { gte: thirtyDaysAgo } },
      }),
      prisma.productAnalyticsEvent.groupBy({
        by: ["utmSource", "utmMedium", "utmCampaign"],
        where: { eventName: "landing_view", occurredAt: { gte: thirtyDaysAgo } },
        _count: { _all: true },
      }),
      prisma.productAnalyticsEvent.groupBy({
        by: ["userId", "anonymousIdHash"],
        where: {
          userId: { not: null },
          occurredAt: { gte: thirtyDaysAgo },
        },
      }),
    ]);

    const identityLinks = new Map(
      identityLinkGroups.flatMap((group) =>
        group.userId
          ? [[group.anonymousIdHash, `user:${group.userId}`] as const]
          : []
      )
    );
    const counts = new Map(
      countGroups.map((group) => [group.eventName, group._count._all])
    );
    const weeklyComparisonActors = new Set(
      weeklyActorGroups.map((row) => actorKey(row, identityLinks))
    );
    const day1Actors = new Set(
      day1ActorGroups.map((row) => actorKey(row, identityLinks))
    );
    const day7Actors = new Set(
      day7ActorGroups.map((row) => actorKey(row, identityLinks))
    );
    const actorEvents = new Map<string, ActivationRow[]>();
    for (const row of activationRows) {
      const actor = actorKey(row, identityLinks);
      const existing = actorEvents.get(actor) || [];
      existing.push(row);
      actorEvents.set(actor, existing);
    }

    let signupUsers30d = 0;
    let activatedUsers30d = 0;
    const activationActions = new Set([
      "followup_sent",
      "conversation_saved",
      "share_created",
    ]);

    for (const events of actorEvents.values()) {
      const signup = events.find((event) => event.eventName === "signup_completed");
      if (!signup) continue;
      signupUsers30d += 1;
      const activationDeadline = signup.occurredAt.getTime() + 24 * 60 * 60 * 1000;
      const inActivationWindow = events.filter(
        (event) =>
          event.occurredAt >= signup.occurredAt &&
          event.occurredAt.getTime() <= activationDeadline
      );
      const hasComparison = inActivationWindow.some(
        (event) =>
          event.eventName === "multi_model_compare_completed" &&
          event.modelCount >= 2
      );
      const hasAction = inActivationWindow.some((event) =>
        activationActions.has(event.eventName)
      );
      if (hasComparison && hasAction) activatedUsers30d += 1;
    }

    return {
      available: true,
      generatedAt: now.toISOString(),
      configured: {
        measurementId: /^G-[A-Z0-9]+$/.test(
          process.env.GA4_MEASUREMENT_ID?.trim() || ""
        ),
        apiSecret: Boolean(process.env.GA4_API_SECRET?.trim()),
      },
      funnel30d: PRODUCT_ANALYTICS_EVENT_NAMES.map((eventName) => ({
        eventName,
        count: counts.get(eventName) || 0,
      })),
      weeklyActiveComparisonUsers: weeklyComparisonActors.size,
      activatedUsers30d,
      signupUsers30d,
      activationRate30d:
        signupUsers30d > 0 ? (activatedUsers30d / signupUsers30d) * 100 : 0,
      returnDay1Users30d: day1Actors.size,
      returnDay7Users30d: day7Actors.size,
      topCampaigns30d: campaignGroups
        .map((group) => ({
          source: group.utmSource,
          medium: group.utmMedium,
          campaign: group.utmCampaign,
          landingViews: group._count._all,
        }))
        .sort((left, right) => right.landingViews - left.landingViews)
        .slice(0, 10),
    };
  } catch (error) {
    console.error("Product analytics dashboard query failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return emptyDashboard();
  }
}
