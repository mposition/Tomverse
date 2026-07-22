"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { CreditPackPurchaseButton } from "@/components/billing/CreditPackPurchaseButton";
import { UpgradeCtaLink } from "@/components/billing/UpgradeCtaLink";
import type { UserPlan } from "@/components/chat/useUserUsage";

const interpolateCopy = (
  template: string,
  values: Record<string, string | number>
) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

type UsageLimitModalProps = {
  open: boolean;
  onClose: () => void;
  isGuestMode: boolean;
  isAccountMonthlyLimitReached: boolean;
  accountPlan: UserPlan | null | undefined;
  dailyCreditLimit: number;
  planCreditsRemaining: number;
  purchasedCreditsRemaining: number;
  dailyResetLabel: string;
  estimatedRequestCredits: number;
  totalAvailableCredits: number;
  creditShortfall: number;
  signInCallbackUrl: string;
};

export function UsageLimitModal({
  open,
  onClose,
  isGuestMode,
  isAccountMonthlyLimitReached,
  accountPlan,
  dailyCreditLimit,
  planCreditsRemaining,
  purchasedCreditsRemaining,
  dailyResetLabel,
  estimatedRequestCredits,
  totalAvailableCredits,
  creditShortfall,
  signInCallbackUrl,
}: UsageLimitModalProps) {
  const { t, lang } = useLanguage();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const focusFrame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid="usage-limit-modal"
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="usage-limit-modal-title"
    >
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={onClose}
        aria-label={t("auth.cancel")}
      />
      <div className="relative z-10 w-full max-w-sm rounded-t-3xl border border-zinc-200 bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 sm:rounded-3xl sm:pb-5">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <h2
            id="usage-limit-modal-title"
            className="text-base font-black text-zinc-900 dark:text-zinc-100"
          >
            {isGuestMode ? t("chat.guestLimitReachedTitle") : t("chat.accountLimitReachedTitle")}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            data-testid="usage-limit-modal-close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
            aria-label={t("auth.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {isGuestMode
            ? t("chat.guestLimitReachedBody")
            : isAccountMonthlyLimitReached
              ? t("chat.monthlyLimitReachedBody")
              : interpolateCopy(t("chat.dailyPlanLimitReachedBody"), {
                  limit: dailyCreditLimit,
                  monthly: planCreditsRemaining,
                  reset: dailyResetLabel,
                })}
        </p>

        {!isGuestMode && isAccountMonthlyLimitReached && (
          <p className="mt-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            {lang === "ko"
              ? `예상 차감 ${estimatedRequestCredits} · 현재 잔액 ${totalAvailableCredits} · ${creditShortfall} 크레딧 부족`
              : `Estimated ${estimatedRequestCredits} · Balance ${totalAvailableCredits} · ${creditShortfall} credits short`}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          {isGuestMode ? (
            <a
              href={`/auth/signin?callbackUrl=${encodeURIComponent(signInCallbackUrl)}`}
              className="flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-blue-500"
            >
              {t("auth.login")}
            </a>
          ) : (
            <>
              <CreditPackPurchaseButton
                trigger="limit_hit"
                className="flex items-center justify-center rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-black text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {t("chat.continueWithAdditionalCredits")}
              </CreditPackPurchaseButton>
              {accountPlan !== "Max" && (
                <UpgradeCtaLink
                  targetPlan={accountPlan === "Pro" ? "Max" : "Pro"}
                  currentPlan={accountPlan || "Free"}
                  trigger="limit_hit"
                  ctaLocation="credit_limit_banner"
                  planCreditsRemaining={planCreditsRemaining}
                  addonCreditsRemaining={purchasedCreditsRemaining}
                  className="flex items-center justify-center rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-black text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
                >
                  {accountPlan === "Pro" ? t("chat.viewMaxPlan") : t("chat.viewProPlan")}
                </UpgradeCtaLink>
              )}
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold text-zinc-500 transition hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            {t("chat.waitForResetInstead")}
          </button>
        </div>
      </div>
    </div>
  );
}
