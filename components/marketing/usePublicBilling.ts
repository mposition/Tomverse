"use client";

import { useEffect, useMemo, useState } from "react";
import {
  billingCurrencyFractionDigits,
  formatBillingAmount,
  getBillingMarketQuery,
  type BillingCurrency,
} from "@/lib/billingMarkets";
import { getDefaultBillingPlan } from "@/lib/billingPlanDefaults";

type BillingPlan = {
  id: "free" | "pro" | "max";
  name: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  currency: string;
  baseCurrency?: string;
  baseMonthlyPriceCents?: number;
  baseAnnualPriceCents?: number;
  displayCurrency?: string;
  displayMonthlyPriceMinor?: number;
  displayAnnualPriceMinor?: number;
  displayMonthlyPriceAmount?: number;
  displayAnnualPriceAmount?: number;
  displayExchangeRate?: number;
  monthlyMessageLimit?: number;
  dailyMessageLimit?: number;
};

/**
 * A plan's credit allowances, as the API reported them.
 *
 * `dailyCredits` is 0 when the plan has no daily pacing limit at all, which is
 * a Max-plan selling point rather than a missing value -- callers must not
 * treat it as "unknown".
 */
export type PublicPlanLimits = {
  monthlyCredits: number;
  dailyCredits: number;
  /** False when the numbers came from the built-in defaults, not the API. */
  fromLiveConfig: boolean;
};

export type PublicCreditPack = {
  id: "starter_500" | "project_1500" | "power_4000";
  name: string;
  credits: number;
  priceMinor: number;
  priceCents: number;
  currency: string;
  validityDays: number;
  allowedPlans: Array<"Free" | "Pro" | "Max">;
};

export type FeaturedBillingPromotion = {
  code: string;
  discountPercent: number;
  discountAmountCents?: number | null;
  durationMonths: number;
  appliesToPlanIds: Array<"free" | "pro" | "max">;
  billingIntervals: Array<"monthly" | "annual">;
  endsAt: string;
};

type BillingConfig = {
  plans: BillingPlan[];
  creditPacks?: PublicCreditPack[];
  featuredPromotion?: FeaturedBillingPromotion | null;
  promotionPolicy?: {
    codesListed: false;
    validation: "server_only";
    annualDiscountStacking: "promotion_specific_default_denied";
  };
  displayCurrency?: string;
  displayCountry?: string;
  baseCurrency?: "USD";
  exchangeRateUpdatedAt?: string | null;
};

export function getBillingConfigUrl() {
  if (typeof window === "undefined") return "/api/billing/config";
  return `/api/billing/config?${getBillingMarketQuery()}`;
}

export function usePublicBilling() {
  const [config, setConfig] = useState<BillingConfig | null>(null);

  useEffect(() => {
    fetch(getBillingConfigUrl())
      .then((response) => (response.ok ? response.json() : null))
      .then((data: BillingConfig | null) => {
        if (data) setConfig(data);
      })
      .catch(() => undefined);
  }, []);

  return useMemo(() => {
    const planById = new Map(config?.plans.map((plan) => [plan.id, plan]));
    // RECON-UX-001: the display locale is decided per billing market inside
    // formatBillingAmount, so nothing here -- and no caller -- can make the
    // price depend on the visitor's browser locale again.
    const formatPlanPrice = (
      planId: "free" | "pro" | "max",
      billingInterval: "monthly" | "annual" = "monthly"
    ) => {
      const plan = planById.get(planId);
      if (!plan) return null;
      const displayAmount =
        billingInterval === "annual"
          ? plan.displayAnnualPriceAmount
          : plan.displayMonthlyPriceAmount;
      if (
        plan.displayCurrency &&
        typeof displayAmount === "number"
      ) {
        const digits = billingCurrencyFractionDigits(
          plan.displayCurrency as BillingCurrency
        );
        return formatBillingAmount(
          displayAmount,
          plan.displayCurrency as BillingCurrency,
          undefined,
          digits
        );
      }
      const cents =
        billingInterval === "annual"
          ? plan.annualPriceCents
          : plan.monthlyPriceCents;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: plan.currency || "USD",
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
      }).format(cents / 100);
    };
    const formatUsdPlanPrice = (
      planId: "free" | "pro" | "max",
      billingInterval: "monthly" | "annual" = "monthly"
    ) => {
      const plan = planById.get(planId);
      if (!plan) return null;
      const cents =
        billingInterval === "annual"
          ? plan.baseAnnualPriceCents ?? plan.annualPriceCents
          : plan.baseMonthlyPriceCents ?? plan.monthlyPriceCents;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
      }).format(cents / 100);
    };
    // The landing page used to state each plan's monthly credits as a
    // hard-coded sentence beside a price it fetched live, so an admin change
    // to a plan's allowance left the two halves of one card disagreeing.
    // Both halves now come from here; the fallback is the same built-in plan
    // table the API itself falls back to, not a second copy of the numbers.
    const planLimits = (planId: "free" | "pro" | "max"): PublicPlanLimits => {
      const plan = planById.get(planId);
      const fallback = getDefaultBillingPlan(planId);
      // Per field rather than all-or-nothing: the API has carried
      // `monthlyMessageLimit` for longer than `dailyMessageLimit`, and a
      // response missing one is no reason to discard the other.
      const monthly = plan?.monthlyMessageLimit;
      const daily = plan?.dailyMessageLimit;
      return {
        monthlyCredits:
          typeof monthly === "number" ? monthly : fallback.monthlyMessageLimit,
        dailyCredits:
          typeof daily === "number" ? daily : fallback.dailyMessageLimit,
        fromLiveConfig: typeof monthly === "number",
      };
    };

    const formatPlanPriceOrDefault = (
      planId: "free" | "pro" | "max",
      billingInterval: "monthly" | "annual" = "monthly"
    ) => {
      const live = formatPlanPrice(planId, billingInterval);
      if (live) return live;
      const fallback = getDefaultBillingPlan(planId);
      const cents =
        billingInterval === "annual"
          ? fallback.annualPriceCents
          : fallback.monthlyPriceCents;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: fallback.currency || "USD",
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
      }).format(cents / 100);
    };

    return {
      config,
      formatPlanPrice,
      formatPlanPriceOrDefault,
      formatUsdPlanPrice,
      planLimits,
    };
  }, [config]);
}
