export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import {
  getPlanEstimatedCostLimits,
  getUserChatUsageKey,
} from "@/lib/chatSecurity";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { getBillingPlanByTier } from "@/lib/billingConfig";
import { effectivePlanModelLimit } from "@/lib/billingEntitlements";
import { getPurchasedCreditSummary } from "@/lib/creditLedger";
import { recommendCreditAction } from "@/lib/creditPacks";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizePlan = (value: unknown) =>
  value === "Pro" || value === "Max" || value === "Free" ? value : "Free";

const periodStart = (period: "day" | "month", now = new Date()) =>
  period === "day"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    await consumeApiRateLimit(req, session.user.id, "usage-read", {
      minute: 60,
      day: 2_000,
    });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        plan: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        subscriptionStatus: true,
        subscriptionCancelAtPeriodEnd: true,
        creditDebtCredits: true,
        creditDebtCostMicroUsd: true,
        billingRiskStatus: true,
        billingRiskReason: true,
        billingRiskAt: true,
      },
    });
    const key = getUserChatUsageKey(session.user.id);
    const now = new Date();
    const dayStart = periodStart("day", now);
    const monthStart = periodStart("month", now);
    const historyStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const [rows, monthlyRows, purchasedBalance, addOnPurchasesLast90Days] = await Promise.all([
      prisma.chatUsageBucket.findMany({
      where: {
        key,
        OR: [
          { period: "day", periodStart: dayStart },
          { period: "month", periodStart: monthStart },
          { period: "tokens-day", periodStart: dayStart },
          { period: "tokens-month", periodStart: monthStart },
          { period: "cost-day", periodStart: dayStart },
          { period: "cost-month", periodStart: monthStart },
          { period: "pro-model-month", periodStart: monthStart },
        ],
      },
      select: { period: true, count: true },
      }),
      prisma.chatUsageBucket.findMany({
        where: {
          key,
          period: "month",
          periodStart: { gte: historyStart, lte: monthStart },
        },
        orderBy: { periodStart: "asc" },
        select: { periodStart: true, count: true },
      }),
      getPurchasedCreditSummary(session.user.id, now),
      prisma.creditPurchase.count({
        where: {
          userId: session.user.id,
          status: { in: ["paid", "partially_refunded"] },
          purchasedAt: { gte: new Date(now.getTime() - 90 * 86_400_000) },
        },
      }),
    ]);
    const count = (period: string) =>
      rows.find((row) => row.period === period)?.count || 0;

    const plan = normalizePlan(
      effectivePlanForAccess(
        {
          plan: user?.plan,
          subscriptionStatus: user?.subscriptionStatus,
          subscriptionCurrentPeriodEnd: user?.subscriptionCurrentPeriodEnd,
        },
        now
      )
    );
    const billingPlan = await getBillingPlanByTier(plan);
    const estimatedCostLimits = getPlanEstimatedCostLimits(plan);
    const limits = {
      creditsDay: billingPlan.dailyMessageLimit,
      creditsMonth: billingPlan.monthlyMessageLimit,
      proModelResponsesMonth:
        plan === "Free"
          ? positiveInteger(
              process.env.CHAT_FREE_PRO_MODEL_RESPONSES_PER_MONTH,
              30
            )
          : 0,
      tokensDay: positiveInteger(process.env.CHAT_USER_TOKENS_PER_DAY, 1_000_000),
      tokensMonth: positiveInteger(process.env.CHAT_USER_TOKENS_PER_MONTH, 20_000_000),
      costDay: estimatedCostLimits.day,
      costMonth: estimatedCostLimits.month,
      maxModels: effectivePlanModelLimit(billingPlan),
      allowAttachments: billingPlan.allowAttachments,
      allowSharing: billingPlan.allowSharing,
      allowDownloads: billingPlan.allowDownloads,
    };
    const monthlyUsagePercents = monthlyRows.map((row) =>
      limits.creditsMonth > 0
        ? Math.round((row.count / limits.creditsMonth) * 100)
        : 0
    );
    const recommendation = recommendCreditAction({
      plan,
      monthlyUsagePercents,
      addOnPurchasesLast90Days,
    });
    const nextMonthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    );
    const nextDayStart = new Date(dayStart.getTime() + 86_400_000);

    return NextResponse.json({
      plan,
      subscription: {
        status: user?.subscriptionStatus || null,
        billingInterval: user?.subscriptionBillingInterval || null,
        currentPeriodEnd: user?.subscriptionCurrentPeriodEnd?.toISOString() || null,
        cancelAtPeriodEnd: user?.subscriptionCancelAtPeriodEnd || false,
      },
      generatedAt: now.toISOString(),
      usage: {
        creditsDay: count("day"),
        creditsMonth: count("month"),
        proModelResponsesMonth: count("pro-model-month"),
        tokensDay: count("tokens-day"),
        tokensMonth: count("tokens-month"),
        costDay: count("cost-day"),
        costMonth: count("cost-month"),
      },
      balances: {
        dailyRemainingCredits:
          limits.creditsDay > 0
            ? Math.max(0, limits.creditsDay - count("day"))
            : null,
        dailyResetsAt: nextDayStart.toISOString(),
        planRemainingCredits: Math.max(
          0,
          limits.creditsMonth - count("month") - (user?.creditDebtCredits || 0)
        ),
        planResetsAt: nextMonthStart.toISOString(),
        purchasedRemainingCredits: purchasedBalance.remainingCredits,
        purchasedFundedCostMicroUsd: purchasedBalance.remainingFundedCostMicroUsd,
        purchasedEarliestExpiry: purchasedBalance.earliestExpiry?.toISOString() || null,
      },
      creditDebt: {
        credits: user?.creditDebtCredits || 0,
        fundedCostMicroUsd: Number(user?.creditDebtCostMicroUsd || BigInt(0)),
        riskStatus: user?.billingRiskStatus || "normal",
        riskReason: user?.billingRiskReason || null,
        riskAt: user?.billingRiskAt?.toISOString() || null,
      },
      recommendation,
      limits,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load usage:", error);
    return NextResponse.json({ error: "Failed to load usage." }, { status: 500 });
  }
}
