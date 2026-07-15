import "server-only";

import { prisma } from "@/lib/prisma";
import {
  isGa4DebugModeEnabled,
  PRODUCT_ANALYTICS_EVENT_NAMES,
} from "@/lib/productAnalyticsShared";

type ActorRow = {
  userId: string | null;
  anonymousIdHash: string;
};

type ActivationRow = ActorRow & {
  eventName: string;
  modelCount: number;
  occurredAt: Date;
};

type ReviewFunnelRow = ActorRow & {
  eventName: string;
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
    debugMode: boolean;
  };
  funnel30d: Array<{ eventName: string; count: number }>;
  weeklyActiveComparisonUsers: number;
  activatedUsers30d: number;
  signupUsers30d: number;
  activationRate30d: number;
  returnDay1Users30d: number;
  returnDay7Users30d: number;
  reviewFunnel30d: {
    startedUsers: number;
    completedUsers: number;
    completionRate: number;
    upgradeIntentUsers: number;
    upgradeIntentRate: number;
    checkoutUsers: number;
    checkoutRate: number;
    purchaseUsers: number;
    purchaseRate: number;
  };
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
    debugMode: isGa4DebugModeEnabled(
      process.env.NEXT_PUBLIC_GA4_DEBUG_MODE
    ),
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
  reviewFunnel30d: {
    startedUsers: 0,
    completedUsers: 0,
    completionRate: 0,
    upgradeIntentUsers: 0,
    upgradeIntentRate: 0,
    checkoutUsers: 0,
    checkoutRate: 0,
    purchaseUsers: 0,
    purchaseRate: 0,
  },
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
      reviewFunnelRows,
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
      prisma.productAnalyticsEvent.findMany({
        where: {
          eventName: {
            in: [
              "comparison_review_started",
              "comparison_review_completed",
              "upgrade_prompt_view",
              "checkout_started",
              "purchase_completed",
            ],
          },
          occurredAt: { gte: thirtyDaysAgo },
        },
        orderBy: { occurredAt: "asc" },
        select: {
          eventName: true,
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

    const reviewActorEvents = new Map<string, ReviewFunnelRow[]>();
    for (const row of reviewFunnelRows) {
      const actor = actorKey(row, identityLinks);
      const existing = reviewActorEvents.get(actor) || [];
      existing.push(row);
      reviewActorEvents.set(actor, existing);
    }
    let reviewStartedUsers = 0;
    let reviewCompletedUsers = 0;
    let reviewUpgradeIntentUsers = 0;
    let reviewCheckoutUsers = 0;
    let reviewPurchaseUsers = 0;
    for (const events of reviewActorEvents.values()) {
      const started = events.find(
        (event) => event.eventName === "comparison_review_started"
      );
      if (!started) continue;
      reviewStartedUsers += 1;
      const completed = events.find(
        (event) =>
          event.eventName === "comparison_review_completed" &&
          event.occurredAt >= started.occurredAt
      );
      if (!completed) continue;
      reviewCompletedUsers += 1;
      const afterCompletion = events.filter(
        (event) => event.occurredAt >= completed.occurredAt
      );
      if (
        afterCompletion.some(
          (event) => event.eventName === "upgrade_prompt_view"
        )
      ) {
        reviewUpgradeIntentUsers += 1;
      }
      if (
        afterCompletion.some((event) => event.eventName === "checkout_started")
      ) {
        reviewCheckoutUsers += 1;
      }
      if (
        afterCompletion.some((event) => event.eventName === "purchase_completed")
      ) {
        reviewPurchaseUsers += 1;
      }
    }
    const reviewRate = (count: number) =>
      reviewCompletedUsers > 0 ? (count / reviewCompletedUsers) * 100 : 0;

    return {
      available: true,
      generatedAt: now.toISOString(),
      configured: {
        measurementId: /^G-[A-Z0-9]+$/.test(
          process.env.GA4_MEASUREMENT_ID?.trim() || ""
        ),
        apiSecret: Boolean(process.env.GA4_API_SECRET?.trim()),
        debugMode: isGa4DebugModeEnabled(
          process.env.NEXT_PUBLIC_GA4_DEBUG_MODE
        ),
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
      reviewFunnel30d: {
        startedUsers: reviewStartedUsers,
        completedUsers: reviewCompletedUsers,
        completionRate:
          reviewStartedUsers > 0
            ? (reviewCompletedUsers / reviewStartedUsers) * 100
            : 0,
        upgradeIntentUsers: reviewUpgradeIntentUsers,
        upgradeIntentRate: reviewRate(reviewUpgradeIntentUsers),
        checkoutUsers: reviewCheckoutUsers,
        checkoutRate: reviewRate(reviewCheckoutUsers),
        purchaseUsers: reviewPurchaseUsers,
        purchaseRate: reviewRate(reviewPurchaseUsers),
      },
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
