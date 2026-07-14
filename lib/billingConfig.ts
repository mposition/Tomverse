import "server-only";

import type { BillingPromotion as PrismaBillingPromotion } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ModelTier } from "@/lib/models";
import { promotionEligibilityFailure } from "@/lib/billingPromotionCore";

export type BillingPlanId = "free" | "pro" | "max";

export type BillingPlanConfig = {
  id: BillingPlanId;
  name: string;
  tier: ModelTier;
  monthlyPriceCents: number;
  annualPriceCents: number;
  currency: string;
  stripeProductId: string | null;
  stripePriceId: string | null;
  stripeAnnualPriceId: string | null;
  dailyMessageLimit: number;
  monthlyMessageLimit: number;
  maxModels: number;
  allowAttachments: boolean;
  allowSharing: boolean;
  allowDownloads: boolean;
  isActive: boolean;
  sortOrder: number;
  updatedAt?: string | null;
};

export type BillingPromotionConfig = {
  id: string;
  code: string;
  discountPercent: number;
  discountAmountCents: number | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  durationMonths: number;
  appliesToPlanIds: BillingPlanId[];
  stripeCouponId: string | null;
  stripePromotionCodeId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allowAnnualStacking: boolean;
  isActive: boolean;
  updatedAt?: string | null;
};

const DEFAULT_PLANS: Record<BillingPlanId, BillingPlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    tier: "Free",
    monthlyPriceCents: 0,
    annualPriceCents: 0,
    currency: "USD",
    stripeProductId: null,
    stripePriceId: null,
    stripeAnnualPriceId: null,
    dailyMessageLimit: 30,
    monthlyMessageLimit: 300,
    maxModels: 3,
    allowAttachments: true,
    allowSharing: true,
    allowDownloads: true,
    isActive: true,
    sortOrder: 10,
    updatedAt: null,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tier: "Pro",
    monthlyPriceCents: 1_500,
    annualPriceCents: 14_400,
    currency: "USD",
    stripeProductId: null,
    stripePriceId: null,
    stripeAnnualPriceId: null,
    dailyMessageLimit: 150,
    monthlyMessageLimit: 3_000,
    maxModels: 3,
    allowAttachments: true,
    allowSharing: true,
    allowDownloads: true,
    isActive: true,
    sortOrder: 20,
    updatedAt: null,
  },
  max: {
    id: "max",
    name: "Max",
    tier: "Max",
    monthlyPriceCents: 2_500,
    annualPriceCents: 24_000,
    currency: "USD",
    stripeProductId: null,
    stripePriceId: null,
    stripeAnnualPriceId: null,
    dailyMessageLimit: 0,
    monthlyMessageLimit: 10_000,
    maxModels: 3,
    allowAttachments: true,
    allowSharing: true,
    allowDownloads: true,
    isActive: true,
    sortOrder: 30,
    updatedAt: null,
  },
};

const normalizePlanId = (value: string): BillingPlanId | null =>
  value === "free" || value === "pro" || value === "max" ? value : null;

export const planIdForTier = (tier: ModelTier): BillingPlanId =>
  tier === "Max" ? "max" : tier === "Pro" ? "pro" : "free";

export const tierForPlanId = (planId: BillingPlanId): ModelTier =>
  planId === "max" ? "Max" : planId === "pro" ? "Pro" : "Free";

const parsePlanIds = (value: string): BillingPlanId[] => {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? normalizePlanId(item) : null))
      .filter((item): item is BillingPlanId => Boolean(item));
  } catch {
    return [];
  }
};

export async function getBillingPlans(): Promise<BillingPlanConfig[]> {
  const rows = await prisma.billingPlan.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const merged = new Map<BillingPlanId, BillingPlanConfig>(
    Object.values(DEFAULT_PLANS).map((plan) => [plan.id, plan])
  );

  for (const row of rows) {
    const id = normalizePlanId(row.id);
    if (!id) continue;
    merged.set(id, {
      id,
      name: row.name,
      tier: tierForPlanId(id),
      monthlyPriceCents: row.monthlyPriceCents,
      annualPriceCents:
        row.annualPriceCents ?? Math.round(row.monthlyPriceCents * 12 * 0.8),
      currency: row.currency,
      stripeProductId: row.stripeProductId,
      stripePriceId: row.stripePriceId,
      stripeAnnualPriceId: row.stripeAnnualPriceId,
      dailyMessageLimit: row.dailyMessageLimit,
      monthlyMessageLimit: row.monthlyMessageLimit,
      maxModels: row.maxModels,
      allowAttachments: row.allowAttachments,
      allowSharing: row.allowSharing,
      allowDownloads: row.allowDownloads,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  return Array.from(merged.values()).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function syncBillingDefaultsToDatabase() {
  const existingPlans = await prisma.billingPlan.findMany({
    select: { id: true },
  });
  const existingPlanIds = new Set(existingPlans.map((plan) => plan.id));

  for (const plan of Object.values(DEFAULT_PLANS)) {
    if (existingPlanIds.has(plan.id)) continue;
    await prisma.billingPlan.create({
      data: {
        id: plan.id,
        name: plan.name,
        tier: plan.tier,
        monthlyPriceCents: plan.monthlyPriceCents,
        annualPriceCents: plan.annualPriceCents,
        currency: plan.currency,
        stripeProductId: plan.stripeProductId,
        stripePriceId: plan.stripePriceId,
        stripeAnnualPriceId: plan.stripeAnnualPriceId,
        dailyMessageLimit: plan.dailyMessageLimit,
        monthlyMessageLimit: plan.monthlyMessageLimit,
        maxModels: plan.maxModels,
        allowAttachments: plan.allowAttachments,
        allowSharing: plan.allowSharing,
        allowDownloads: plan.allowDownloads,
        isActive: plan.isActive,
        sortOrder: plan.sortOrder,
      },
    });
  }

}

export async function getBillingPlanByTier(tier: ModelTier) {
  const plans = await getBillingPlans();
  return plans.find((plan) => plan.id === planIdForTier(tier)) || DEFAULT_PLANS.free;
}

export async function getBillingPromotions(): Promise<BillingPromotionConfig[]> {
  const rows = await prisma.billingPromotion.findMany({
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
  return rows.map(toBillingPromotionConfig);
}

const toBillingPromotionConfig = (
  row: PrismaBillingPromotion
): BillingPromotionConfig => ({
    id: row.id,
    code: row.code,
    discountPercent: row.discountPercent,
    discountAmountCents: row.discountAmountCents,
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    durationMonths: row.durationMonths,
    appliesToPlanIds: parsePlanIds(row.appliesToPlanIds),
    stripeCouponId: row.stripeCouponId,
    stripePromotionCodeId: row.stripePromotionCodeId,
    startsAt: row.startsAt?.toISOString() || null,
    endsAt: row.endsAt?.toISOString() || null,
    allowAnnualStacking: row.allowAnnualStacking,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  });

export async function getBillingPromotionByCode(code: string) {
  const row = await prisma.billingPromotion.findUnique({ where: { code } });
  return row ? toBillingPromotionConfig(row) : null;
}

export function isBillingPromotionRedeemable(
  promotion: BillingPromotionConfig,
  now = new Date()
) {
  return promotionEligibilityFailure({ promotion, now }) === null;
}

export async function getPublicBillingConfig() {
  const [plans, featuredPromotion] = await Promise.all([
    getBillingPlans(),
    getBillingPromotionByCode("TOMVERSE50"),
  ]);
  const publicFeaturedPromotion =
    featuredPromotion && isBillingPromotionRedeemable(featuredPromotion)
      ? {
          code: featuredPromotion.code,
          discountPercent: featuredPromotion.discountPercent,
          discountAmountCents: featuredPromotion.discountAmountCents,
          durationMonths: featuredPromotion.durationMonths,
          appliesToPlanIds: featuredPromotion.appliesToPlanIds,
          billingIntervals: featuredPromotion.allowAnnualStacking
            ? (["monthly", "annual"] as const)
            : (["monthly"] as const),
          endsAt: featuredPromotion.endsAt,
        }
      : null;
  return {
    plans: plans.filter((plan) => plan.isActive),
    featuredPromotion: publicFeaturedPromotion,
    promotionPolicy: {
      codesListed: false as const,
      validation: "server_only" as const,
      annualDiscountStacking: "promotion_specific_default_denied" as const,
    },
  };
}
