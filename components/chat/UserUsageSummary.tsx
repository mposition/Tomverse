"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";

type UsageResponse = {
  plan: string;
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
  };
};

const percent = (used: number, limit: number) =>
  limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

const widthClass = (value: number) => {
  if (value >= 95) return "w-full";
  if (value >= 80) return "w-5/6";
  if (value >= 66) return "w-2/3";
  if (value >= 50) return "w-1/2";
  if (value >= 33) return "w-1/3";
  if (value >= 16) return "w-1/6";
  if (value > 0) return "w-[8%]";
  return "w-0";
};

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const value = percent(used, limit);
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div
        className={`h-full rounded-full ${widthClass(value)} ${
          value >= 90 ? "bg-red-500" : value >= 70 ? "bg-amber-500" : "bg-blue-500"
        }`}
      />
    </div>
  );
}

export function UserUsageSummary({
  isGuestMode,
  guestMessageCount,
  maxGuestMessages,
}: {
  isGuestMode?: boolean;
  guestMessageCount?: number;
  maxGuestMessages?: number;
}) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  useEffect(() => {
    if (isGuestMode) return;
    const controller = new AbortController();
    void fetch("/api/user/usage", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setUsage(data))
      .catch(() => {});
    return () => controller.abort();
  }, [isGuestMode]);

  if (isGuestMode) {
    const used = guestMessageCount || 0;
    const limit = maxGuestMessages || 20;
    return (
      <section className="mx-3 mb-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100">
        <div className="flex items-center gap-2 font-black">
          <BarChart3 className="h-4 w-4" />
          Guest usage
        </div>
        <div className="mt-2 flex items-center justify-between font-semibold">
          <span>Today</span>
          <span>{Math.max(0, limit - used)} left</span>
        </div>
        <UsageBar used={used} limit={limit} />
      </section>
    );
  }

  if (!usage) return null;

  return (
    <section className="mx-3 mb-3 rounded-2xl border border-zinc-200 bg-white p-3 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-black">
          <BarChart3 className="h-4 w-4 text-blue-500" />
          Plan: {usage.plan}
        </span>
        <span className="text-zinc-400">
          {Math.max(0, usage.limits.messagesDay - usage.usage.messagesDay)} left
        </span>
      </div>
      <div className="mt-2">
        <div className="flex justify-between font-semibold">
          <span>Today messages</span>
          <span>
            {usage.usage.messagesDay}/{usage.limits.messagesDay}
          </span>
        </div>
        <UsageBar used={usage.usage.messagesDay} limit={usage.limits.messagesDay} />
      </div>
      <div className="mt-2">
        <div className="flex justify-between font-semibold">
          <span>Month messages</span>
          <span>
            {usage.usage.messagesMonth}/{usage.limits.messagesMonth}
          </span>
        </div>
        <UsageBar used={usage.usage.messagesMonth} limit={usage.limits.messagesMonth} />
      </div>
    </section>
  );
}
