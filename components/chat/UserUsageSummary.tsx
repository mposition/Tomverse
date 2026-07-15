"use client";

import Link from "next/link";
import { BarChart3, Coins } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useUserUsage } from "@/components/chat/useUserUsage";
import { CreditPackPurchaseButton } from "@/components/billing/CreditPackPurchaseButton";

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
  const { t, lang } = useLanguage();
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
  const monthlyPercent = percent(usage.usage.creditsMonth, usage.limits.creditsMonth);
  const warningLevel = monthlyPercent >= 100 ? 100 : monthlyPercent >= 95 ? 95 : monthlyPercent >= 80 ? 80 : 0;
  const preferUpgrade = usage.recommendation.primary === "upgrade_pro" || usage.recommendation.primary === "upgrade_max";
  const upgradeLabel = usage.recommendation.primary === "upgrade_max"
    ? (lang === "ko" ? "Max로 업그레이드" : "Upgrade to Max")
    : (lang === "ko" ? "Pro로 업그레이드" : "Upgrade to Pro");
  const addCreditLabel = lang === "ko" ? "추가 크레딧 구매" : "Buy additional credits";
  const expiryLabel = usage.balances.purchasedEarliestExpiry
    ? new Date(usage.balances.purchasedEarliestExpiry).toLocaleDateString(lang)
    : null;

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
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-zinc-100 p-2 dark:bg-zinc-950/70">
          <span className="block text-[10px] font-bold uppercase text-zinc-400">
            {lang === "ko" ? "플랜 크레딧" : "Plan credits"}
          </span>
          <strong>{usage.balances.planRemainingCredits.toLocaleString(lang)}</strong>
          <span className="mt-0.5 block text-[10px] text-zinc-400">
            {lang === "ko" ? "다음 달 초기화" : "Resets next month"}
          </span>
        </div>
        <div className="rounded-xl bg-emerald-50 p-2 dark:bg-emerald-950/20">
          <span className="flex items-center gap-1 text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-300">
            <Coins className="h-3 w-3" /> {lang === "ko" ? "구매 크레딧" : "Purchased"}
          </span>
          <strong>{usage.balances.purchasedRemainingCredits.toLocaleString(lang)}</strong>
          <span className="mt-0.5 block text-[10px] text-zinc-400">
            {expiryLabel ? `${lang === "ko" ? "만료" : "Expires"} ${expiryLabel}` : (lang === "ko" ? "구매 내역 없음" : "No purchases")}
          </span>
        </div>
      </div>
      {warningLevel > 0 && (
        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-black">
            {lang === "ko"
              ? warningLevel >= 100 ? "이번 달 플랜 크레딧을 모두 사용했습니다." : `이번 달 플랜 크레딧의 ${warningLevel}% 이상을 사용했습니다.`
              : warningLevel >= 100 ? "You have used all plan credits for this month." : `You have used at least ${warningLevel}% of this month's plan credits.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {preferUpgrade ? (
              <>
                <Link href="/pricing" className="rounded-lg bg-blue-600 px-2.5 py-1.5 font-black text-white">{upgradeLabel}</Link>
                <CreditPackPurchaseButton className="rounded-lg border border-amber-400 px-2.5 py-1.5 font-black">{addCreditLabel}</CreditPackPurchaseButton>
              </>
            ) : (
              <>
                <CreditPackPurchaseButton className="rounded-lg bg-emerald-600 px-2.5 py-1.5 font-black text-white">{addCreditLabel}</CreditPackPurchaseButton>
                {usage.plan === "Pro" && <Link href="/pricing" className="rounded-lg border border-amber-400 px-2.5 py-1.5 font-black">{lang === "ko" ? "Max 비교" : "Compare Max"}</Link>}
                {usage.recommendation.secondary === "business" && <Link href="/support" className="rounded-lg border border-amber-400 px-2.5 py-1.5 font-black">Business</Link>}
              </>
            )}
          </div>
        </div>
      )}
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
