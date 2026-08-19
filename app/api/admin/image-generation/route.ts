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
  imageProviderBudgetBucketKey,
  resolveActiveImageProviderBudgets,
  resolveImageProviderBudget,
  worstImageCostPerCreditMicroUsd,
} from "@/lib/imageProviderBudget";
import { IMAGE_MODEL_REGISTRY } from "@/lib/imageModelRegistry";
import { prisma } from "@/lib/prisma";
import { usageBucketCount as narrowBucketCount } from "@/lib/chatUsageBucketCount";

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
      providerBudgetUsage,
      statusCounts,
      failureCounts,
      reservationTotals,
      settledByOption,
      settledByProviderModel,
      dimensionCoverage,
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
      // Every image provider's bucket for the two windows that matter, in one
      // query keyed by prefix rather than by a provider list -- a provider
      // activated between this deploy and the next still shows up.
      //
      // The two `findUnique` calls above stay: they feed the legacy
      // OpenAI-only `budget` block that predates per-provider budgets, and
      // removing it would break every consumer reading that shape.
      prisma.chatUsageBucket.findMany({
        where: {
          key: { startsWith: "image-provider:" },
          OR: [
            { period: "provider-cost-day", periodStart: dayStartUtc(now) },
            { period: "provider-cost-month", periodStart: monthStartUtc(now) },
          ],
        },
        select: { key: true, period: true, count: true },
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
      // Budgets are enforced per provider (policy section 8), so spend has to
      // be readable per provider too. Without this the report shows one total
      // and an operator cannot tell which provider's budget is being consumed
      // -- which is precisely the question a second provider creates.
      prisma.imageCreditReservation.groupBy({
        by: ["provider", "modelId"],
        where: { status: "settled" },
        _count: { _all: true },
        _sum: {
          settledCredits: true,
          settledCostMicroUsd: true,
        },
      }),
      // Whether the decoded-dimension reader is actually working in
      // production. A succeeded generation with no dimensions means the
      // header could not be read, which is recorded honestly as null and is
      // therefore invisible unless counted (policy section 12.1).
      prisma.imageGeneration.groupBy({
        by: ["provider"],
        where: { status: "succeeded" },
        _count: { _all: true },
      }),
      prisma.imageAsset.groupBy({
        by: ["role"],
        where: { deletedAt: null },
        _count: { _all: true },
        _sum: { byteSize: true },
      }),
      auditImageGenerationInvariants(now),
    ]);

    const succeededWithDimensions = await prisma.imageGeneration.groupBy({
      by: ["provider"],
      where: { status: "succeeded", outputWidth: { not: null } },
      _count: { _all: true },
    });
    const measuredByProvider = new Map(
      succeededWithDimensions.map((row) => [row.provider, row._count._all])
    );

    const budget = resolveImageProviderBudget(process.env, {
      production: process.env.NODE_ENV === "production",
    });
    const providerBudgets = resolveActiveImageProviderBudgets(process.env, {
      production: process.env.NODE_ENV === "production",
    });
    // `count` is a BigInt column; narrowed here rather than at render, because
    // `NextResponse.json()` is `JSON.stringify` and throws on one.
    const providerUsage = new Map(
      providerBudgetUsage.map((row) => [
        `${row.key}|${row.period}`,
        narrowBucketCount(row.count),
      ])
    );

    return NextResponse.json({
      flagEnabled,
      pricing: {
        pricingVersion: IMAGE_PRICING_VERSION,
        priceVerifiedAt: PRICE_VERIFICATION.verifiedAt,
        ceilingMicroUsdPerCredit: IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
        worstCostMicroUsdPerCredit: worstImageCostPerCreditMicroUsd(),
        ceilingHeadroomMicroUsd: imageCostCeilingHeadroomMicroUsd(),
      },
      settledByProviderModel: settledByProviderModel.map((row) => ({
        provider: row.provider,
        modelId: row.modelId,
        settlements: row._count._all,
        settledCredits: row._sum.settledCredits ?? 0,
        settledCostMicroUsd: Number(row._sum.settledCostMicroUsd ?? 0),
      })),
      dimensionCoverage: dimensionCoverage.map((row) => ({
        provider: row.provider,
        succeeded: row._count._all,
        measured: measuredByProvider.get(row.provider) ?? 0,
      })),
      models: IMAGE_MODEL_REGISTRY.map((model) => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
        lifecycle: model.lifecycle,
        disabledReason: model.disabledReason,
        disabledNote: model.disabledNote ?? null,
        pricingVersion: model.pricingVersion,
        priceVerifiedAt: model.priceVerification.verifiedAt,
        optionCount: model.prices.length,
      })),
      providerBudgets: providerBudgets.map((entry) => ({
        provider: entry.provider,
        source: entry.resolved.source,
        limits: entry.resolved.limits,
        floorMicroUsd: entry.resolved.floorMicroUsd,
        problems: entry.resolved.problems,
        advisories: entry.resolved.advisories,
        clamped: entry.resolved.clamped,
        // What the provider has actually spent against its own ceiling.
        //
        // Without these the endpoint reported a per-provider *limit* and a
        // single-provider *usage*, so xAI and fal had a budget nobody could
        // read -- and the 2026-08-16 defect, where their settlement
        // differences were refunded to OpenAI's bucket, was invisible from
        // the admin surface that exists to watch exactly this.
        //
        // A provider with no row has spent nothing, so it reports 0 rather
        // than null: absent and zero are the same fact for a bucket that only
        // exists once something is charged to it.
        usedTodayMicroUsd: providerUsage.get(
          `${imageProviderBudgetBucketKey(entry.provider)}|provider-cost-day`
        ) ?? 0,
        usedThisMonthMicroUsd: providerUsage.get(
          `${imageProviderBudgetBucketKey(entry.provider)}|provider-cost-month`
        ) ?? 0,
      })),
      budget: {
        source: budget.source,
        floorMicroUsd: budget.floorMicroUsd,
        limits: budget.limits,
        clamped: budget.clamped,
        problems: budget.problems,
        advisories: budget.advisories,
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
