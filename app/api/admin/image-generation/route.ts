export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { isImageGenerationEnabled } from "@/lib/appSettings";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import { auditImageGenerationInvariants } from "@/lib/imageAssetLifecycle";
import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_PRICING_VERSION,
  PRICE_VERIFICATION,
} from "@/lib/imageGenerationPricing";
import {
  imageCostCeilingHeadroomMicroUsd,
  resolveActiveImageProviderBudgets,
  resolveImageProviderBudget,
  worstImageCostPerCreditMicroUsd,
} from "@/lib/imageProviderBudget";
import { IMAGE_MODEL_REGISTRY } from "@/lib/imageModelRegistry";
import { prisma } from "@/lib/prisma";

// The image generation operations surface: budget configuration vs effective
// enforcement, reservation vs settlement, failure phases, storage growth and
// the invariants. Internal micro-USD is included on purpose -- this is the
// admin surface; the user-facing errors carry none of it.
// Policy: docs/policy/image-generation.md sections 4, 8-9.

const monthStartUtc = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const dayStartUtc = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-image-generation", {
      minute: 30,
      day: 1_000,
    });

    const now = new Date();
    const [
      flagEnabled,
      dayBudgetUsage,
      monthBudgetUsage,
      statusCounts,
      failureCounts,
      reservationTotals,
      settledByOption,
      storageByRole,
      invariants,
    ] = await Promise.all([
      isImageGenerationEnabled(),
      prisma.chatUsageBucket.findUnique({
        where: {
          key_period_periodStart: {
            key: "image-provider:openai",
            period: "provider-cost-day",
            periodStart: dayStartUtc(now),
          },
        },
        select: { count: true },
      }),
      prisma.chatUsageBucket.findUnique({
        where: {
          key_period_periodStart: {
            key: "image-provider:openai",
            period: "provider-cost-month",
            periodStart: monthStartUtc(now),
          },
        },
        select: { count: true },
      }),
      prisma.imageGeneration.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.imageGeneration.groupBy({
        by: ["failurePhase"],
        where: { status: "failed" },
        _count: { _all: true },
      }),
      prisma.imageCreditReservation.aggregate({
        _count: { _all: true },
        _sum: {
          reservedCredits: true,
          settledCredits: true,
          reservedCostMicroUsd: true,
          settledCostMicroUsd: true,
          reservedFundedCostMicroUsd: true,
          settledFundedCostMicroUsd: true,
        },
      }),
      prisma.imageCreditReservation.groupBy({
        by: ["quality", "size"],
        where: { status: "settled", outcome: "completed" },
        _count: { _all: true },
        _avg: { settledCostMicroUsd: true },
      }),
      prisma.imageAsset.groupBy({
        by: ["role"],
        where: { deletedAt: null },
        _count: { _all: true },
        _sum: { byteSize: true },
      }),
      auditImageGenerationInvariants(now),
    ]);

    const budget = resolveImageProviderBudget(process.env, {
      production: process.env.NODE_ENV === "production",
    });
    const providerBudgets = resolveActiveImageProviderBudgets(process.env, {
      production: process.env.NODE_ENV === "production",
    });

    return NextResponse.json({
      flagEnabled,
      pricing: {
        pricingVersion: IMAGE_PRICING_VERSION,
        priceVerifiedAt: PRICE_VERIFICATION.verifiedAt,
        ceilingMicroUsdPerCredit: IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
        worstCostMicroUsdPerCredit: worstImageCostPerCreditMicroUsd(),
        ceilingHeadroomMicroUsd: imageCostCeilingHeadroomMicroUsd(),
      },
      models: IMAGE_MODEL_REGISTRY.map((model) => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
        lifecycle: model.lifecycle,
        disabledReason: model.disabledReason,
        disabledNote: model.disabledNote ?? null,
        priceVerifiedAt: model.priceVerification.verifiedAt,
        optionCount: model.prices.length,
      })),
      providerBudgets: providerBudgets.map((entry) => ({
        provider: entry.provider,
        source: entry.resolved.source,
        limits: entry.resolved.limits,
        floorMicroUsd: entry.resolved.floorMicroUsd,
        problems: entry.resolved.problems,
        clamped: entry.resolved.clamped,
      })),
      budget: {
        source: budget.source,
        floorMicroUsd: budget.floorMicroUsd,
        limits: budget.limits,
        clamped: budget.clamped,
        problems: budget.problems,
        usedTodayMicroUsd: usageBucketCount(dayBudgetUsage?.count),
        usedThisMonthMicroUsd: usageBucketCount(monthBudgetUsage?.count),
      },
      generations: {
        byStatus: Object.fromEntries(
          statusCounts.map((row) => [row.status, row._count._all])
        ),
        failuresByPhase: Object.fromEntries(
          failureCounts.map((row) => [
            row.failurePhase ?? "unknown",
            row._count._all,
          ])
        ),
      },
      reservations: {
        total: reservationTotals._count._all,
        reservedCredits: reservationTotals._sum.reservedCredits ?? 0,
        settledCredits: reservationTotals._sum.settledCredits ?? 0,
        reservedCostMicroUsd: Number(
          reservationTotals._sum.reservedCostMicroUsd ?? 0
        ),
        settledCostMicroUsd: Number(
          reservationTotals._sum.settledCostMicroUsd ?? 0
        ),
        reservedFundedCostMicroUsd: Number(
          reservationTotals._sum.reservedFundedCostMicroUsd ?? 0
        ),
        settledFundedCostMicroUsd: Number(
          reservationTotals._sum.settledFundedCostMicroUsd ?? 0
        ),
        settledByOption: settledByOption.map((row) => ({
          quality: row.quality,
          size: row.size,
          count: row._count._all,
          averageSettledCostMicroUsd: Math.round(
            Number(row._avg.settledCostMicroUsd ?? 0)
          ),
        })),
      },
      storage: {
        byRole: Object.fromEntries(
          storageByRole.map((row) => [
            row.role,
            { count: row._count._all, byteSize: Number(row._sum.byteSize ?? 0) },
          ])
        ),
      },
      invariants,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin image generation report failed:", error);
    return NextResponse.json(
      { error: "Failed to load image generation report." },
      { status: 500 }
    );
  }
}
