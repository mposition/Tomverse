"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { dispatchAppToast } from "@/lib/appToast";
import { useLanguage } from "@/components/LanguageProvider";

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
};

type BillingPromotion = {
  code: string;
  discountPercent: number;
  discountAmountCents?: number | null;
  maxRedemptions?: number | null;
  redeemedCount?: number;
  durationMonths: number;
  appliesToPlanIds: Array<"pro" | "max">;
};

type BillingConfig = {
  plans: BillingPlan[];
  promotions: BillingPromotion[];
  displayCurrency?: string;
  baseCurrency?: "USD";
};

type BillingInterval = "monthly" | "annual";

const formatMoney = (amount: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(amount);

const formatUsdCents = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(cents / 100);

const formatPrice = (
  planConfig: BillingPlan | undefined,
  billingInterval: BillingInterval
) => {
  if (!planConfig) return null;
  const displayAmount =
    billingInterval === "annual"
      ? planConfig.displayAnnualPriceAmount
      : planConfig.displayMonthlyPriceAmount;
  if (planConfig.displayCurrency && typeof displayAmount === "number") {
    return formatMoney(displayAmount, planConfig.displayCurrency);
  }
  const cents =
    billingInterval === "annual"
      ? planConfig.annualPriceCents
      : planConfig.monthlyPriceCents;
  return formatMoney(cents / 100, planConfig.currency || "USD");
};

const formatUsdPrice = (
  planConfig: BillingPlan | undefined,
  billingInterval: BillingInterval
) => {
  if (!planConfig) return null;
  const cents =
    billingInterval === "annual"
      ? planConfig.baseAnnualPriceCents ?? planConfig.annualPriceCents
      : planConfig.baseMonthlyPriceCents ?? planConfig.monthlyPriceCents;
  return formatUsdCents(cents);
};

const formatDiscount = (promotion: BillingPromotion | undefined) => {
  if (!promotion) return null;
  if (promotion.discountPercent > 0) {
    return `${promotion.discountPercent}% off for ${promotion.durationMonths} months.`;
  }
  if (promotion.discountAmountCents && promotion.discountAmountCents > 0) {
    const amount = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(promotion.discountAmountCents / 100);
    return `${amount} off for ${promotion.durationMonths} months.`;
  }
  return null;
};

export function UpgradeInterestButton({
  plan,
  className,
  children,
}: {
  plan: "Pro" | "Max";
  className: string;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const [isSending, setIsSending] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [promoCode, setPromoCode] = useState("TOMVERSE50");
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("monthly");
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null);
  const inputId = useId();
  const planId = plan === "Max" ? "max" : "pro";
  const planConfig = billingConfig?.plans.find((item) => item.id === planId);
  const activePromo = billingConfig?.promotions.find((item) =>
    item.appliesToPlanIds.includes(planId)
  );
  const priceLabel = formatPrice(planConfig, billingInterval);
  const monthlyPriceLabel = formatPrice(planConfig, "monthly");
  const annualPriceLabel = formatPrice(planConfig, "annual");
  const usdPriceLabel = formatUsdPrice(planConfig, billingInterval);
  const usdMonthlyPriceLabel = formatUsdPrice(planConfig, "monthly");
  const usdAnnualPriceLabel = formatUsdPrice(planConfig, "annual");
  const discountLabel = formatDiscount(activePromo);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || billingConfig) return;
    fetch("/api/billing/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: BillingConfig | null) => {
        if (data) setBillingConfig(data);
      })
      .catch(() => undefined);
  }, [billingConfig, isOpen]);

  const submit = async () => {
    if (isSending) return;
    const normalizedCode = promoCode.trim().toUpperCase();
    setIsSending(true);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          billingInterval,
          promoCode: normalizedCode || undefined,
        }),
      });
      if (response.status === 401) {
        window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const data = (await response.json().catch(() => null)) as
        | { url?: string; error?: string }
        | null;
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || "Checkout failed");
      }
      window.location.href = data.url;
    } catch {
      dispatchAppToast(t("billing.waitlistFailed"), "error");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        disabled={isSending}
        className={className}
      >
        {isSending ? t("billing.sending") : children}
      </button>
      {isOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${inputId}-title`}
        >
          <form
            className="grid max-h-[92vh] w-full max-w-4xl overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 md:grid-cols-[1.1fr_0.9fr]"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="overflow-y-auto p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">
                    Secure checkout
                  </p>
                  <h2
                    id={`${inputId}-title`}
                    className="mt-2 text-2xl font-black text-zinc-950 dark:text-white"
                  >
                    Upgrade to {plan}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    Choose your billing cycle, apply a promotion code, then continue to Stripe checkout.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-full border border-zinc-200 px-3 py-1 text-sm font-bold text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-white"
                  aria-label={t("billing.close")}
                >
                  x
                </button>
              </div>

              <div className="mt-6">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                  Billing cycle
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {([
                    ["monthly", "Monthly", monthlyPriceLabel, "Pay month to month."],
                    ["annual", "Annual", annualPriceLabel, "Save 20% with yearly billing."],
                  ] as const).map(([value, label, amount, description]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setBillingInterval(value)}
                      className={`rounded-2xl border p-4 text-left transition ${
                        billingInterval === value
                          ? "border-blue-500 bg-blue-50 ring-4 ring-blue-500/15 dark:bg-blue-500/10"
                          : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-zinc-700"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-black text-zinc-950 dark:text-white">
                          {label}
                        </span>
                        {value === "annual" ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-black text-emerald-600 dark:text-emerald-300">
                            20% off
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-3 block text-2xl font-black text-zinc-950 dark:text-white">
                        {amount || "-"}
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                        {description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6 grid gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                  Payment methods
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {["PayPal", "GPay", "Apple Pay", "Card"].map((method) => (
                    <span
                      key={method}
                      className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-center text-xs font-black text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                    >
                      {method}
                    </span>
                  ))}
                </div>
                <p className="text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                  Stripe shows wallets and PayPal when available for your device, browser, region, and Stripe account settings.
                </p>
              </div>

              <label
                htmlFor={inputId}
                className="mt-6 block text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400"
              >
                {t("billing.promoLabel")}
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id={inputId}
                  value={promoCode}
                  onChange={(event) => setPromoCode(event.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-base font-black uppercase text-zinc-950 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                  placeholder={activePromo?.code || "TOMVERSE50"}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setPromoCode(activePromo?.code || "")}
                  className="rounded-xl border border-zinc-200 px-4 py-3 text-sm font-black text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  Apply
                </button>
              </div>
              <p className="mt-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                {t("billing.promoFinePrint")}
              </p>
            </div>

            <aside className="flex flex-col border-t border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/70 md:border-l md:border-t-0 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                    Order summary
                  </p>
                  <h3 className="mt-2 text-xl font-black text-zinc-950 dark:text-white">
                    Tomverse AI {plan}
                  </h3>
                </div>
                <span className="rounded-full bg-blue-600 px-3 py-1 text-xs font-black text-white">
                  {billingInterval === "annual" ? "Annual" : "Monthly"}
                </span>
              </div>

              <div className="mt-6 space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    Plan
                  </span>
                  <span className="font-black text-zinc-950 dark:text-white">
                    {plan}
                  </span>
                </div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    Billing
                  </span>
                  <span className="font-black text-zinc-950 dark:text-white">
                    {billingInterval === "annual" ? "Yearly" : "Monthly"}
                  </span>
                </div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    Subtotal
                  </span>
                  <span className="font-black text-zinc-950 dark:text-white">
                    {priceLabel || "-"}
                  </span>
                </div>
                {billingInterval === "annual" ? (
                  <div className="flex justify-between gap-4 text-sm text-emerald-600 dark:text-emerald-300">
                    <span className="font-semibold">Annual savings</span>
                    <span className="font-black">20%</span>
                  </div>
                ) : null}
                {activePromo ? (
                  <div className="flex justify-between gap-4 text-sm text-blue-600 dark:text-blue-300">
                    <span className="font-semibold">{activePromo.code}</span>
                    <span className="font-black">{discountLabel || "Applied at checkout"}</span>
                  </div>
                ) : null}
                <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
                  <div className="flex justify-between gap-4">
                    <span className="font-black text-zinc-950 dark:text-white">
                      Due today
                    </span>
                    <span className="text-2xl font-black text-zinc-950 dark:text-white">
                      {priceLabel || "-"}
                    </span>
                  </div>
                  {usdPriceLabel ? (
                    <p className="mt-2 text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                      Displayed local price is converted from {usdPriceLabel}. Checkout is charged in USD.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-xs font-semibold leading-5 text-blue-700 dark:text-blue-200">
                {billingInterval === "annual"
                  ? `Annual checkout renews every year. Base USD price: ${usdAnnualPriceLabel || "-"} per year.`
                  : `Monthly checkout renews every month. Base USD price: ${usdMonthlyPriceLabel || "-"} per month.`}
              </div>

              <div className="mt-auto flex flex-col gap-2 pt-6">
                <button
                  type="submit"
                  disabled={isSending}
                  className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSending ? t("billing.sending") : "Continue to checkout"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-xl border border-zinc-200 px-4 py-3 text-sm font-black text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {t("billing.cancel")}
                </button>
              </div>
            </aside>
          </form>
        </div>
      ) : null}
    </>
  );
}
