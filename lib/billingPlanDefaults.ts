import type { ModelTier } from "@/lib/models";

// The built-in plan shape, kept out of lib/billingConfig.ts (which is
// `server-only`) so the marketing surface can fall back to the same numbers
// the API would have served instead of hard-coding a second copy of them.
//
// lib/billingConfig.ts re-exports everything here, so server callers keep
// importing from where they always did and there is still exactly one
// definition of what a plan is worth.

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
    dailyMessageLimit: 300,
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

export const getDefaultBillingPlans = (): BillingPlanConfig[] =>
  Object.values(DEFAULT_PLANS).map((plan) => ({ ...plan }));

export const getDefaultBillingPlan = (
  planId: BillingPlanId
): BillingPlanConfig => ({ ...DEFAULT_PLANS[planId] });
