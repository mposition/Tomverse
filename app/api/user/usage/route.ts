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
      },
    });
    const key = getUserChatUsageKey(session.user.id);
    const now = new Date();
    const dayStart = periodStart("day", now);
    const monthStart = periodStart("month", now);
    const rows = await prisma.chatUsageBucket.findMany({
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
    });
    const count = (period: string) =>
      rows.find((row) => row.period === period)?.count || 0;

    const plan = normalizePlan(user?.plan);
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
      limits,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load usage:", error);
    return NextResponse.json({ error: "Failed to load usage." }, { status: 500 });
  }
}
