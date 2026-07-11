"use client";

import { useEffect, useMemo, useState } from "react";

type BillingPlan = {
  id: "free" | "pro" | "max";
  name: string;
  monthlyPriceCents: number;
  currency: string;
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
};

export function usePublicBilling() {
  const [config, setConfig] = useState<BillingConfig | null>(null);

  useEffect(() => {
    fetch("/api/billing/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: BillingConfig | null) => {
        if (data) setConfig(data);
      })
      .catch(() => undefined);
  }, []);

  return useMemo(() => {
    const planById = new Map(config?.plans.map((plan) => [plan.id, plan]));
    const formatPlanPrice = (planId: "free" | "pro" | "max") => {
      const plan = planById.get(planId);
      if (!plan) return null;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: plan.currency || "USD",
        maximumFractionDigits: plan.monthlyPriceCents % 100 === 0 ? 0 : 2,
      }).format(plan.monthlyPriceCents / 100);
    };
    return {
      config,
      formatPlanPrice,
    };
  }, [config]);
}
