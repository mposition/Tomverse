"use client";

import { useEffect, useState } from "react";

const USER_USAGE_CHANGED_EVENT = "tomverse:user-usage-changed";

export const notifyUserUsageChanged = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(USER_USAGE_CHANGED_EVENT));
  }
};

export type UserPlan = "Free" | "Pro" | "Max";

export type UserUsageResponse = {
  plan: UserPlan;
  subscription?: {
    status: string | null;
    billingInterval: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd?: boolean;
  };
  usage: {
    creditsDay: number;
    creditsMonth: number;
    proModelResponsesMonth: number;
    tokensDay: number;
    tokensMonth: number;
    costDay: number;
    costMonth: number;
  };
  balances: {
    planRemainingCredits: number;
    planResetsAt: string;
    purchasedRemainingCredits: number;
    purchasedFundedCostMicroUsd: number;
    purchasedEarliestExpiry: string | null;
  };
  recommendation: {
    primary: "upgrade_pro" | "upgrade_max" | "add_credits" | "business";
    secondary: "upgrade_pro" | "upgrade_max" | "add_credits" | "business" | null;
  };
  limits: {
    creditsDay: number;
    creditsMonth: number;
    proModelResponsesMonth: number;
    tokensDay: number;
    tokensMonth: number;
    costDay: number;
    costMonth: number;
    maxModels: number;
    allowAttachments: boolean;
    allowSharing: boolean;
    allowDownloads: boolean;
  };
};

export const normalizeUserPlan = (value: unknown): UserPlan =>
  value === "Pro" || value === "Max" || value === "Free" ? value : "Free";

export function useUserUsage(enabled: boolean) {
  const [usage, setUsage] = useState<UserUsageResponse | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      void fetch("/api/user/usage", {
        signal: controller.signal,
        cache: "no-store",
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!data) {
            setUsage(null);
            return;
          }
          setUsage({
            ...data,
            plan: normalizeUserPlan(data.plan),
          });
        })
        .catch(() => {});
    };
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(load, 300);
    };

    load();
    window.addEventListener(USER_USAGE_CHANGED_EVENT, scheduleRefresh);

    return () => {
      controller.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener(USER_USAGE_CHANGED_EVENT, scheduleRefresh);
    };
  }, [enabled]);

  return enabled ? usage : null;
}
