"use client";

import { useEffect, useState } from "react";

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
    messagesDay: number;
    messagesMonth: number;
    tokensDay: number;
    tokensMonth: number;
    costDay: number;
    costMonth: number;
  };
  limits: {
    messagesDay: number;
    messagesMonth: number;
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

    return () => controller.abort();
  }, [enabled]);

  return enabled ? usage : null;
}
