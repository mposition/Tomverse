"use client";

import { BarChart3 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useUserUsage } from "@/components/chat/useUserUsage";

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
  const { t } = useLanguage();
  const usage = useUserUsage(!isGuestMode);
  const isDailyUnlimited = Boolean(usage && usage.limits.creditsDay <= 0);

  if (isGuestMode) {
    const used = guestMessageCount || 0;
    const limit = maxGuestMessages || 20;
    return (
      <section className="mx-3 mb-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100">
        <div className="flex items-center gap-2 font-black">
          <BarChart3 className="h-4 w-4" />
          {t("usage.guestUsage")}
        </div>
        <div className="mt-2 flex items-center justify-between font-semibold">
          <span>{t("usage.today")}</span>
          <span>{Math.max(0, limit - used)} {t("usage.left")}</span>
        </div>
        <UsageBar used={used} limit={limit} />
      </section>
    );
  }

  if (!usage) return null;
  const planLabel = t(`modelTiers.${usage.plan.toLowerCase()}`);

  return (
    <section className="mx-3 mb-3 rounded-2xl border border-zinc-200 bg-white p-3 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-black">
          <BarChart3 className="h-4 w-4 text-blue-500" />
          {t("usage.plan")}: {planLabel}
        </span>
        <span className="text-zinc-400">
          {isDailyUnlimited
            ? t("usage.unlimited")
            : `${Math.max(0, usage.limits.creditsDay - usage.usage.creditsDay)} ${t("usage.left")}`}
        </span>
      </div>
      <div className="mt-2">
        <div className="flex justify-between font-semibold">
          <span>{t("usage.todayCredits")}</span>
          <span>
            {isDailyUnlimited
              ? t("usage.unlimited")
              : `${usage.usage.creditsDay}/${usage.limits.creditsDay}`}
          </span>
        </div>
        {!isDailyUnlimited && <UsageBar used={usage.usage.creditsDay} limit={usage.limits.creditsDay} />}
      </div>
      <div className="mt-2">
        <div className="flex justify-between font-semibold">
          <span>{t("usage.monthCredits")}</span>
          <span>
            {usage.usage.creditsMonth}/{usage.limits.creditsMonth}
          </span>
        </div>
        <UsageBar used={usage.usage.creditsMonth} limit={usage.limits.creditsMonth} />
      </div>
      {usage.plan === "Free" && usage.limits.proModelResponsesMonth > 0 && (
        <div className="mt-2 flex justify-between font-semibold text-zinc-500 dark:text-zinc-400">
          <span>{t("usage.proResponsesMonth")}</span>
          <span>
            {usage.usage.proModelResponsesMonth}/{usage.limits.proModelResponsesMonth}
          </span>
        </div>
      )}
    </section>
  );
}
