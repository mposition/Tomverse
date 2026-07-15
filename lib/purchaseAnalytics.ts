import "server-only";

import type { ModelTier } from "@/lib/models";
import { getBillingPlanByTier } from "@/lib/billingConfig";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { getPurchasedCreditSummary } from "@/lib/creditLedger";
import { prisma } from "@/lib/prisma";
import {
  purchaseAnalyticsTriggerSchema,
  type PurchaseAnalyticsTrigger,
} from "@/lib/productAnalyticsShared";

export type PurchaseAnalyticsContext = {
  currentPlan: "free" | "pro" | "max";
  planCreditsRemaining: number;
  addonCreditsRemaining: number;
};

const planId = (plan: ModelTier): PurchaseAnalyticsContext["currentPlan"] =>
  plan === "Max" ? "max" : plan === "Pro" ? "pro" : "free";

const monthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const safeInteger = (value: string | null | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export async function getPurchaseAnalyticsSnapshot({
  userId,
  currentPlan,
  creditDebtCredits = 0,
  now = new Date(),
}: {
  userId: string;
  currentPlan: ModelTier;
  creditDebtCredits?: number;
  now?: Date;
}) {
  const [billingPlan, usage, purchasedBalance] = await Promise.all([
    getBillingPlanByTier(currentPlan),
    prisma.chatUsageBucket.findUnique({
      where: {
        key_period_periodStart: {
          key: getUserChatUsageKey(userId),
          period: "month",
          periodStart: monthStart(now),
        },
      },
      select: { count: true },
    }),
    getPurchasedCreditSummary(userId, now),
  ]);

  return {
    context: {
      currentPlan: planId(currentPlan),
      planCreditsRemaining: Math.max(
        0,
        billingPlan.monthlyMessageLimit -
          (usage?.count || 0) -
          Math.max(0, creditDebtCredits)
      ),
      addonCreditsRemaining: Math.max(0, purchasedBalance.remainingCredits),
    } satisfies PurchaseAnalyticsContext,
    purchasedBalance,
  };
}

export const purchaseAnalyticsMetadata = ({
  context,
  trigger,
  productId,
  creditsPurchased,
}: {
  context: PurchaseAnalyticsContext;
  trigger: PurchaseAnalyticsTrigger;
  productId: string;
  creditsPurchased: number;
}) => ({
  analyticsPurchaseTrigger: trigger,
  analyticsProductId: productId,
  analyticsCreditsPurchased: String(Math.max(0, Math.trunc(creditsPurchased))),
  analyticsCurrentPlan: context.currentPlan,
  analyticsPlanCreditsRemaining: String(context.planCreditsRemaining),
  analyticsAddonCreditsRemaining: String(context.addonCreditsRemaining),
});

export const purchaseAnalyticsFromMetadata = (
  metadata: Record<string, string> | null | undefined,
  fallback: {
    currentPlan: PurchaseAnalyticsContext["currentPlan"];
    trigger?: PurchaseAnalyticsTrigger;
    productId: string;
    creditsPurchased: number;
  }
) => ({
  currentPlan:
    metadata?.analyticsCurrentPlan === "pro" ||
    metadata?.analyticsCurrentPlan === "max" ||
    metadata?.analyticsCurrentPlan === "free"
      ? metadata.analyticsCurrentPlan
      : fallback.currentPlan,
  trigger:
    purchaseAnalyticsTriggerSchema.safeParse(
      metadata?.analyticsPurchaseTrigger
    ).data || fallback.trigger || "proactive",
  productId: metadata?.analyticsProductId || fallback.productId,
  creditsPurchased: safeInteger(
    metadata?.analyticsCreditsPurchased,
    fallback.creditsPurchased
  ),
  planCreditsRemaining: safeInteger(
    metadata?.analyticsPlanCreditsRemaining,
    0
  ),
  addonCreditsRemaining: safeInteger(
    metadata?.analyticsAddonCreditsRemaining,
    0
  ),
});
