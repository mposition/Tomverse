"use client";

import { useEffect, useMemo, useState } from "react";
import {
  billingCurrencyFractionDigits,
  formatBillingAmount,
  getBillingMarketQuery,
  type BillingCurrency,
} from "@/lib/billingMarkets";

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
    return {
      config,
      formatPlanPrice,
      formatUsdPlanPrice,
    };
  }, [config]);
}
