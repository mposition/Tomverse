import "server-only";

import { prisma } from "@/lib/prisma";
import type { ModelTier } from "@/lib/models";

export type BillingPlanId = "free" | "pro" | "max";

export type BillingPlanConfig = {
  id: BillingPlanId;
  name: string;
  tier: ModelTier;
  monthlyPriceCents: number;
  currency: string;
  stripeProductId: string | null;
  stripePriceId: string | null;
  dailyMessageLimit: number;
  monthlyMessageLimit: number;
  maxModels: number;
  allowAttachments: boolean;
  allowSharing: boolean;
  allowDownloads: boolean;
  isActive: boolean;
  sortOrder: number;
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
  isActive: boolean;
};

const DEFAULT_PLANS: Record<BillingPlanId, BillingPlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    tier: "Free",
    monthlyPriceCents: 0,
    currency: "USD",
    stripeProductId: null,
    stripePriceId: null,
    dailyMessageLimit: 100,
    monthlyMessageLimit: 2_000,
    maxModels: 3,
    allowAttachments: true,
    allowSharing: true,
    allowDownloads: true,
    isActive: true,
    sortOrder: 10,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tier: "Pro",
    monthlyPriceCents: 1_500,
    currency: "USD",
    stripeProductId: null,
    stripePriceId: null,
    dailyMessageLimit: 500,
    monthlyMessageLimit: 10_000,
    maxModels: 3,
    allowAttachments: true,
    allowSharing: true,
    allowDownloads: true,
    isActive: true,
    sortOrder: 20,
  },
  max: {
    id: "max",
    name: "Max",
    tier: "Max",
    monthlyPriceCents: 2_500,
    currency: "USD",
    stripeProductId: null,
    stripePriceId: null,
    dailyMessageLimit: 0,
    monthlyMessageLimit: 50_000,
    maxModels: 3,
    allowAttachments: true,
    allowSharing: true,
    allowDownloads: true,
    isActive: true,
    sortOrder: 30,
  },
};

const DEFAULT_PROMOTION: BillingPromotionConfig = {
  id: "promo_tomverse50",
  code: "TOMVERSE50",
  discountPercent: 50,
  discountAmountCents: null,
  maxRedemptions: null,
  redeemedCount: 0,
  durationMonths: 3,
  appliesToPlanIds: ["pro", "max"],
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: null,
  endsAt: null,
  isActive: true,
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
      currency: row.currency,
      stripeProductId: row.stripeProductId,
      stripePriceId: row.stripePriceId,
      dailyMessageLimit: row.dailyMessageLimit,
      monthlyMessageLimit: row.monthlyMessageLimit,
      maxModels: row.maxModels,
      allowAttachments: row.allowAttachments,
      allowSharing: row.allowSharing,
      allowDownloads: row.allowDownloads,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    });
  }

  return Array.from(merged.values()).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getBillingPlanByTier(tier: ModelTier) {
  const plans = await getBillingPlans();
  return plans.find((plan) => plan.id === planIdForTier(tier)) || DEFAULT_PLANS.free;
}

export async function getBillingPromotions(): Promise<BillingPromotionConfig[]> {
  const rows = await prisma.billingPromotion.findMany({
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
  if (rows.length === 0) return [DEFAULT_PROMOTION];
  return rows.map((row) => ({
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
    isActive: row.isActive,
  }));
}

export function isBillingPromotionRedeemable(
  promotion: BillingPromotionConfig,
  now = new Date()
) {
  if (!promotion.isActive) return false;
  if (promotion.startsAt && new Date(promotion.startsAt) > now) return false;
  if (promotion.endsAt && new Date(promotion.endsAt) < now) return false;
  if (
    promotion.maxRedemptions &&
    promotion.redeemedCount >= promotion.maxRedemptions
  ) {
    return false;
  }
  return promotion.discountPercent > 0 || Boolean(promotion.discountAmountCents);
}

export async function getPublicBillingConfig() {
  const [plans, promotions] = await Promise.all([
    getBillingPlans(),
    getBillingPromotions(),
  ]);
  return {
    plans: plans.filter((plan) => plan.isActive),
    promotions: promotions.filter((promotion) =>
      isBillingPromotionRedeemable(promotion)
    ),
  };
}
