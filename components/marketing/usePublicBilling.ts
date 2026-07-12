"use client";

import { useEffect, useMemo, useState } from "react";

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
  displayMonthlyPriceAmount?: number;
  displayAnnualPriceAmount?: number;
  displayExchangeRate?: number;
};

type BillingPromotion = {
  code: string;
  discountPercent: number;
  durationMonths: number;
  appliesToPlanIds: Array<"pro" | "max">;
};

type BillingConfig = {
  plans: BillingPlan[];
  promotions: BillingPromotion[];
  displayCurrency?: string;
  baseCurrency?: "USD";
  exchangeRateUpdatedAt?: string | null;
};

const REGION_TO_CURRENCY: Record<string, string> = {
  AU: "AUD",
  BR: "BRL",
  CA: "CAD",
  CN: "CNY",
  DE: "EUR",
  ES: "EUR",
  FR: "EUR",
  GB: "GBP",
  JP: "JPY",
  KR: "KRW",
  NZ: "NZD",
  PT: "EUR",
  US: "USD",
};

const TIMEZONE_TO_CURRENCY: Array<[string, string]> = [
  ["Australia/", "AUD"],
  ["Pacific/Auckland", "NZD"],
  ["Asia/Seoul", "KRW"],
  ["Asia/Tokyo", "JPY"],
  ["Europe/", "EUR"],
  ["America/New_York", "USD"],
  ["America/Chicago", "USD"],
  ["America/Denver", "USD"],
  ["America/Los_Angeles", "USD"],
  ["America/Toronto", "CAD"],
  ["America/Vancouver", "CAD"],
];

export function getBillingConfigUrl() {
  if (typeof window === "undefined") return "/api/billing/config";

  const locale = navigator.languages?.[0] || navigator.language || "";
  let currency: string | undefined;
  try {
    const region = locale ? new Intl.Locale(locale).region?.toUpperCase() : undefined;
    currency = region ? REGION_TO_CURRENCY[region] : undefined;
  } catch {
    currency = undefined;
  }

  if (!currency) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    currency = TIMEZONE_TO_CURRENCY.find(([prefix]) => timeZone.startsWith(prefix))?.[1];
  }

  if (!currency) return "/api/billing/config";
  return `/api/billing/config?currency=${encodeURIComponent(currency)}`;
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
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: plan.displayCurrency,
          maximumFractionDigits: 0,
          minimumFractionDigits: 0,
        }).format(displayAmount);
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
