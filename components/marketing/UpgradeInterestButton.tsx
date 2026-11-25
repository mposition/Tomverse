"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { dispatchAppToast } from "@/lib/appToast";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import {
  getBillingConfigUrl,
  type FeaturedBillingPromotion,
} from "@/components/marketing/usePublicBilling";
import {
  getAnalyticsAttributionSnapshot,
  trackProductEvent,
} from "@/lib/productAnalyticsClient";
import {
  normalizePurchaseAnalyticsTrigger,
  type PurchaseAnalyticsTrigger,
} from "@/lib/productAnalyticsShared";
import {
  BILLING_CURRENCIES,
  billingCurrencyFractionDigits,
  billingMinorToMajor,
  formatBillingAmount,
  getClientBillingMarket,
  type BillingCurrency,
} from "@/lib/billingMarkets";
import { discardResponseBody } from "@/lib/discardResponseBody";
import {
  calculateDiscountedDisplayMinor,
  checkoutCopy,
  checkoutLegalCopy,
  foundingTesterPassCopy,
  promotionAppliesToCurrency,
  promotionPolicyCopy,
  type BillingPromotion,
  type CheckoutCopy,
} from "@/components/billing/checkoutCopy";

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
  monthlyMessageLimit: number;
};

type BillingConfig = {
  plans: BillingPlan[];
  featuredPromotion?: FeaturedBillingPromotion | null;
  promotionPolicy?: {
    codesListed: false;
    validation: "server_only";
    annualDiscountStacking: "promotion_specific_default_denied";
  };
  displayCurrency?: string;
  displayCountry?: string;
  baseCurrency?: "USD";
};

type BillingInterval = "monthly" | "annual";

type PurchaseAnalyticsContext = {
  currentPlan: "free" | "pro" | "max";
  planCreditsRemaining: number;
  addonCreditsRemaining: number;
};

type PromotionValidationPayload = {
  valid?: boolean;
  promotion?: BillingPromotion;
  code?: string;
  error?: string;
};

/**
 * A refusal from the validation endpoint, carrying the server's stable code.
 *
 * The code is what gets localised. The server's `error` is English and exists
 * for API consumers; showing it in a Korean toast was how "Fixed-amount
 * promotion codes are currently available only for USD checkout" reached a
 * Korean customer verbatim. It stays as the last-resort fallback for codes this
 * client has no copy for.
 */
class PromotionValidationFailure extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
    this.name = "PromotionValidationFailure";
  }
}

/**
 * The market a request is made against.
 *
 * A plain function of the config rather than a value the component closes over,
 * so the effect that loads the config can pass the market that config describes
 * -- not one derived from state React has not committed yet. Neither is
 * authoritative: the server decides from the trusted edge country and refuses a
 * mismatch. Sending it lets that refusal happen at validation instead of at the
 * button.
 */
const billingMarketForRequest = (
  config: BillingConfig | null | undefined,
  planId: "pro" | "max"
) => {
  const plan = config?.plans.find((item) => item.id === planId);
  return config?.displayCountry && plan?.displayCurrency
    ? {
        country: config.displayCountry,
        currency: plan.displayCurrency as BillingCurrency,
      }
    : getClientBillingMarket();
};

/** Server code first, server English last. */
const promotionFailureMessage = (error: unknown, copy: CheckoutCopy) => {
  if (
    error instanceof PromotionValidationFailure &&
    error.code === "PROMOTION_CURRENCY_NOT_SUPPORTED"
  ) {
    return copy.promotionCurrencyNotSupported;
  }
  return error instanceof Error ? error.message : copy.invalidPromo;
};

const formatMoney = (
  amount: number,
  currency = "USD",
  fractionDigits = 0
) => {
  const supportedCurrency = BILLING_CURRENCIES.includes(
    currency as BillingCurrency
  )
    ? (currency as BillingCurrency)
    : "USD";
  return formatBillingAmount(
    amount,
    supportedCurrency,
    undefined,
    fractionDigits
  );
};

const formatUsdCents = (cents: number, fractionDigits = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(cents / 100);

const calculateDiscountedCents = (
  cents: number,
  promotion: BillingPromotion | null | undefined
) => {
  if (!promotion) return cents;
  if (promotion.discountPercent > 0) {
    return Math.max(0, Math.round(cents * (1 - promotion.discountPercent / 100)));
  }
  return Math.max(0, cents - (promotion.discountAmountCents || 0));
};

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
    const currency = planConfig.displayCurrency as BillingCurrency;
    return formatMoney(
      displayAmount,
      currency,
      billingCurrencyFractionDigits(currency)
    );
  }
  const cents =
    billingInterval === "annual"
      ? planConfig.annualPriceCents
      : planConfig.monthlyPriceCents;
  return formatMoney(cents / 100, planConfig.currency || "USD");
};

export function UpgradeInterestButton({
  plan,
  className,
  children,
  trigger,
  initialBillingInterval,
  returnTo,
  autoOpen = false,
}: {
  plan: "Pro" | "Max";
  className: string;
  children: ReactNode;
  trigger?: PurchaseAnalyticsTrigger;
  initialBillingInterval?: BillingInterval;
  returnTo?: string;
  /**
   * Opens the checkout dialog once, without a click. Set by the pricing page
   * when a visitor comes back from sign-in with a subscription intent for this
   * plan. Nothing is charged and no promotion code is filled in: the visitor
   * still enters any code and confirms the purchase themselves.
   */
  autoOpen?: boolean;
}) {
  const { lang, t } = useLanguage();
  const router = useRouter();
  const copy = checkoutCopy[lang] || checkoutCopy.en;
  const legalCopy = checkoutLegalCopy[lang] || checkoutLegalCopy.en;
  const [isSending, setIsSending] = useState(false);
  const [isValidatingPromotion, setIsValidatingPromotion] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromoCode, setAppliedPromoCode] = useState<string | null>(null);
  const [appliedPromotion, setAppliedPromotion] =
    useState<BillingPromotion | null>(null);
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>(initialBillingInterval ?? "monthly");
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null);
  const [purchaseAnalyticsContext, setPurchaseAnalyticsContext] =
    useState<PurchaseAnalyticsContext | null>(null);
  const billingIntervalRef = useRef<BillingInterval>(initialBillingInterval ?? "monthly");
  const autoPromotionRequestRef = useRef(0);
  const inputId = useId();
  const planId = plan === "Max" ? "max" : "pro";
  const planConfig = billingConfig?.plans.find((item) => item.id === planId);
  const priceLabel = formatPrice(planConfig, billingInterval);
  const monthlyPriceLabel = formatPrice(planConfig, "monthly");
  const annualPriceLabel = formatPrice(planConfig, "annual");
  const checkoutCurrency = (planConfig?.displayCurrency || "USD") as BillingCurrency;
  // The market both requests are made against. Hoisted out of `submit` so
  // promotion validation and Checkout quote the same one -- validating against
  // a different market than the button posts is the shape of the defect this
  // whole path exists to prevent. Neither is authoritative: the server decides
  // from the trusted edge country and refuses a mismatch.
  const requestMarket = billingMarketForRequest(billingConfig, planId);
  // The promotion the summary is allowed to draw. `appliedPromotion` should
  // never hold a code this market refuses -- validation rejects it before it is
  // applied -- but the summary decides what to show from what it can charge,
  // not from what happens to be in state. A currency change between validation
  // and render must not leave a discount row behind.
  const chargeablePromotion = promotionAppliesToCurrency(
    appliedPromotion,
    checkoutCurrency
  )
    ? appliedPromotion
    : null;
  const discountLabel = chargeablePromotion?.discountPercent
    ? `-${chargeablePromotion.discountPercent}%`
    : chargeablePromotion?.discountAmountCents
      ? `-${formatUsdCents(chargeablePromotion.discountAmountCents)}`
      : null;
  const baseCents =
    billingInterval === "annual"
      ? planConfig?.baseAnnualPriceCents ?? planConfig?.annualPriceCents ?? 0
      : planConfig?.baseMonthlyPriceCents ?? planConfig?.monthlyPriceCents ?? 0;
  const dueUsdCents = calculateDiscountedCents(baseCents, chargeablePromotion);
  const dueUsdLabel = formatUsdCents(dueUsdCents, 1);
  const displayAmountMinor =
    billingInterval === "annual"
      ? planConfig?.displayAnnualPriceMinor
      : planConfig?.displayMonthlyPriceMinor;
  const dueDisplayMinor =
    typeof displayAmountMinor === "number"
      ? calculateDiscountedDisplayMinor(
          displayAmountMinor,
          chargeablePromotion,
          checkoutCurrency
        )
      : dueUsdCents;
  const dueLabel =
    planConfig?.displayCurrency && typeof displayAmountMinor === "number"
      ? formatMoney(
          billingMinorToMajor(dueDisplayMinor, checkoutCurrency),
          checkoutCurrency,
          billingCurrencyFractionDigits(checkoutCurrency)
        )
      : dueUsdLabel;
  const displayedDueLabel = isValidatingPromotion ? "…" : dueLabel;
  // A discount without its period reads as a one-month offer (owner report
  // 2026-11-16: "OZB50 -50%" next to "renews every month at A$20.00").
  const promotionMonths =
    chargeablePromotion && chargeablePromotion.durationMonths > 0
      ? chargeablePromotion.durationMonths
      : null;
  const foundingPass =
    appliedPromotion?.fulfillmentType === "internal_pass"
      ? appliedPromotion
      : null;
  const passCopy = foundingTesterPassCopy[lang] || foundingTesterPassCopy.en;

  const checkoutDialogRef = useRef<HTMLDivElement | null>(null);
  const checkoutPanelRef = useRef<HTMLFormElement | null>(null);
  // UX-010. Escape alone is not the modal contract: this dialog takes payment
  // details, and focus stayed on the trigger behind the overlay while Tab walked
  // the obscured page underneath.
  const closeCheckout = useCallback(() => setIsOpen(false), []);
  useModalDialog({
    open: isOpen,
    onClose: closeCheckout,
    dialogRef: checkoutDialogRef,
    panelRef: checkoutPanelRef,
  });

  const requestPromotionValidation = useCallback(
    async (
      normalizedCode: string,
      interval: BillingInterval,
      market: { currency: BillingCurrency; country: string }
    ) => {
      const response = await fetch("/api/billing/promotion/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          billingInterval: interval,
          promoCode: normalizedCode,
          currency: market.currency,
          country: market.country,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | PromotionValidationPayload
        | null;
      if (!response.ok || !data?.valid || !data.promotion) {
        throw new PromotionValidationFailure(
          data?.error || copy.invalidPromo,
          data?.code || null
        );
      }
      return data.promotion;
    },
    [copy.invalidPromo, planId]
  );


  const applyFeaturedPromotion = useCallback(async (
    featured: FeaturedBillingPromotion,
    interval: BillingInterval,
    market: { currency: BillingCurrency; country: string }
  ) => {
    const normalizedFeaturedCode = featured.code.trim().toUpperCase();
    const requestId = autoPromotionRequestRef.current + 1;
    autoPromotionRequestRef.current = requestId;
    const eligible =
      featured.appliesToPlanIds.includes(planId) &&
      featured.billingIntervals.includes(interval);
    if (!eligible) {
      setPromoCode("");
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      setIsValidatingPromotion(false);
      return;
    }

    setPromoCode(normalizedFeaturedCode);
    setAppliedPromoCode(null);
    setAppliedPromotion(null);
    setIsValidatingPromotion(true);
    try {
      const promotion = await requestPromotionValidation(
        normalizedFeaturedCode,
        interval,
        market
      );
      if (autoPromotionRequestRef.current !== requestId) return;
      setAppliedPromoCode(normalizedFeaturedCode);
      setAppliedPromotion(promotion);
    } catch (error) {
      if (autoPromotionRequestRef.current !== requestId) return;
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      setPromoCode("");
      dispatchAppToast(promotionFailureMessage(error, copy), "error");
    } finally {
      if (autoPromotionRequestRef.current === requestId) {
        setIsValidatingPromotion(false);
      }
    }
  }, [copy, planId, requestPromotionValidation]);

  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    // Deferred so the effect body stays free of synchronous setState.
    queueMicrotask(() => setIsOpen(true));
  }, [autoOpen]);

  useEffect(() => {
    if (!isOpen || billingConfig) return;
    fetch(getBillingConfigUrl())
      .then((response) =>
        response.ok ? response.json() : discardResponseBody(response).then(() => null)
      )
      .then((data: BillingConfig | null) => {
        if (!data) return;
        setBillingConfig(data);
        if (data.featuredPromotion) {
          void applyFeaturedPromotion(
            data.featuredPromotion,
            billingIntervalRef.current,
            billingMarketForRequest(data, planId)
          );
        }
      })
      .catch(() => undefined);
  }, [applyFeaturedPromotion, billingConfig, isOpen, planId]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    void fetch("/api/user/usage", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? response.json() : discardResponseBody(response).then(() => null)
      )
      .then((data) => {
        if (!data) return;
        setPurchaseAnalyticsContext({
          currentPlan:
            data.plan === "Max" ? "max" : data.plan === "Pro" ? "pro" : "free",
          planCreditsRemaining: Math.max(
            0,
            Number(data.balances?.planRemainingCredits) || 0
          ),
          addonCreditsRemaining: Math.max(
            0,
            Number(data.balances?.purchasedRemainingCredits) || 0
          ),
        });
      })
      .catch((requestError) => {
        if ((requestError as Error).name !== "AbortError") {
          setPurchaseAnalyticsContext(null);
        }
      });
    return () => controller.abort();
  }, [isOpen]);

  const submit = async () => {
    if (isSending || isValidatingPromotion) return;
    // One id per submission, so the server can give Stripe an idempotency key
    // for the Checkout Session. A retry of *this* request reuses it and gets
    // the same Session back; pressing the button again is a new purchase
    // attempt and must get a new one -- a key that never changes would keep
    // replaying a Session that expired 31 minutes in for the rest of the day.
    const purchaseAttemptId = crypto.randomUUID();
    const normalizedInputCode = promoCode.trim().toUpperCase();
    let failureStage: "promotion_validation" | "checkout_session" =
      "checkout_session";
    setIsSending(true);
    try {
      let checkoutPromoCode = appliedPromoCode;
      let promotionForCheckout = appliedPromotion;
      if (
        normalizedInputCode &&
        (normalizedInputCode !== appliedPromoCode || !appliedPromotion)
      ) {
        failureStage = "promotion_validation";
        setIsValidatingPromotion(true);
        promotionForCheckout = await requestPromotionValidation(
          normalizedInputCode,
          billingInterval,
          requestMarket
        );
        checkoutPromoCode = normalizedInputCode;
        setAppliedPromoCode(normalizedInputCode);
        setAppliedPromotion(promotionForCheckout);
        dispatchAppToast(copy.promoApplied, "success");
      }

      failureStage = "checkout_session";
      const checkoutDueMinor = calculateDiscountedDisplayMinor(
        displayAmountMinor ?? baseCents,
        promotionForCheckout,
        requestMarket.currency
      );
      const analytics = getAnalyticsAttributionSnapshot();
      const purchaseTrigger = normalizePurchaseAnalyticsTrigger(
        trigger ||
          (typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("trigger")
            : null)
      );
      const analyticsContext = purchaseAnalyticsContext || {
        currentPlan: "free" as const,
        planCreditsRemaining: 0,
        addonCreditsRemaining: 0,
      };
      const monthlyCreditsIncluded = Math.max(
        0,
        planConfig?.monthlyMessageLimit || (planId === "max" ? 10_000 : 3_000)
      );
      if (promotionForCheckout?.fulfillmentType !== "internal_pass") {
        trackProductEvent("checkout_started", 0, {
          billing_interval: billingInterval,
          plan_id: planId,
          purchase_type: "subscription",
          product_id: `subscription_${planId}_${billingInterval}`,
          monthly_credits_included: monthlyCreditsIncluded,
          current_plan: analyticsContext.currentPlan,
          trigger: purchaseTrigger,
          plan_credits_remaining: analyticsContext.planCreditsRemaining,
          addon_credits_remaining: analyticsContext.addonCreditsRemaining,
          value: billingMinorToMajor(checkoutDueMinor, requestMarket.currency),
          currency: requestMarket.currency,
        });
      }
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          billingInterval,
          language: lang,
          promoCode: checkoutPromoCode || undefined,
          currency: requestMarket.currency,
          country: requestMarket.country,
          trigger: purchaseTrigger,
          purchaseAttemptId,
          ...(returnTo ? { returnTo } : {}),
          ...(analytics ? { analytics } : {}),
        }),
      });
      if (response.status === 401) {
        await discardResponseBody(response);
        router.push(
          `/auth/signin?callbackUrl=${encodeURIComponent(window.location.pathname)}`
        );
        return;
      }
      const data = (await response.json().catch(() => null)) as
        | { url?: string; redirectUrl?: string; success?: boolean; error?: string }
        | null;
      if (response.ok && data?.success && data.redirectUrl) {
        window.location.assign(data.redirectUrl);
        return;
      }
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || "Checkout failed");
      }
      window.location.assign(data.url);
    } catch (error) {
      const errorCode =
        error instanceof TypeError
          ? "network_error"
          : failureStage === "promotion_validation"
            ? "promotion_invalid"
            : "checkout_request_failed";
      trackProductEvent("checkout_failed", 0, {
        billing_interval: billingInterval,
        plan_id: planId,
        failure_stage: failureStage,
        error_code: errorCode,
      });
      dispatchAppToast(
        error instanceof PromotionValidationFailure
          ? promotionFailureMessage(error, copy)
          : error instanceof Error
            ? error.message
            : t("billing.waitlistFailed"),
        "error"
      );
    } finally {
      setIsSending(false);
      setIsValidatingPromotion(false);
    }
  };

  const applyPromotion = async () => {
    const normalizedCode = promoCode.trim().toUpperCase();
    if (!normalizedCode) {
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      return;
    }
    if (isValidatingPromotion) return;
    // The same counter the featured auto-apply uses, so the two cannot land out
    // of order. A featured code applied on open and a code the customer typed
    // a moment later are two answers to one question, and the later request is
    // the one that was asked -- whichever reply arrives first.
    const requestId = autoPromotionRequestRef.current + 1;
    autoPromotionRequestRef.current = requestId;
    const requestedInterval = billingInterval;
    setIsValidatingPromotion(true);
    try {
      const promotion = await requestPromotionValidation(
        normalizedCode,
        requestedInterval,
        requestMarket
      );
      // A late reply must not overwrite newer state, and a promotion validated
      // against an interval the customer has since changed is not an answer
      // about the interval they are now buying.
      if (
        autoPromotionRequestRef.current !== requestId ||
        billingIntervalRef.current !== requestedInterval
      ) {
        return;
      }
      setAppliedPromoCode(normalizedCode);
      setAppliedPromotion(promotion);
      dispatchAppToast(copy.promoApplied, "success");
    } catch (error) {
      if (autoPromotionRequestRef.current !== requestId) return;
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      dispatchAppToast(promotionFailureMessage(error, copy), "error");
    } finally {
      if (autoPromotionRequestRef.current === requestId) {
        setIsValidatingPromotion(false);
      }
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          const selectedInterval = initialBillingInterval ?? billingInterval;
          if (selectedInterval !== billingInterval) {
            autoPromotionRequestRef.current++;
            billingIntervalRef.current = selectedInterval;
            setBillingInterval(selectedInterval);
            setAppliedPromoCode(null);
            setAppliedPromotion(null);
            setIsValidatingPromotion(false);
          }
          trackProductEvent("plan_selected", 0, {
            cta_location: `upgrade_${planId}`,
            plan_id: planId,
          });
          trackProductEvent("cta_start_click", 0, {
            cta_location: `upgrade_${planId}`,
            plan_id: planId,
          });
          setIsOpen(true);
          if (billingConfig?.featuredPromotion) {
            void applyFeaturedPromotion(
              billingConfig.featuredPromotion,
              selectedInterval,
              billingMarketForRequest(billingConfig, planId)
            );
          }
        }}
        disabled={isSending}
        className={className}
      >
        {isSending ? t("billing.sending") : children}
      </button>
      {isOpen ? (
        <div
          ref={checkoutDialogRef}
          className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 px-3 py-3 backdrop-blur-sm sm:items-center sm:py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${inputId}-title`}
        >
          <form
            ref={checkoutPanelRef}
            className="grid max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl overflow-y-auto rounded-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 md:max-h-[92vh] md:grid-cols-[1.1fr_0.9fr] md:overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="p-5 pb-3 sm:p-6 md:overflow-y-auto">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">
                    {foundingPass ? passCopy.title : copy.secureCheckout}
                  </p>
                  <h2
                    id={`${inputId}-title`}
                    className="mt-2 text-2xl font-black text-zinc-950 dark:text-white"
                  >
                    {copy.upgradeTo(plan)}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {foundingPass
                      ? passCopy.detail(foundingPass.accessDurationDays || 60)
                      : copy.description}
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
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                  {copy.billingCycle}
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {([
                    ["monthly", copy.monthly, monthlyPriceLabel, copy.monthlyDescription],
                    ["annual", copy.annual, annualPriceLabel, copy.annualDescription],
                  ] as const).map(([value, label, amount, description]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={isValidatingPromotion}
                      onClick={() => {
                        billingIntervalRef.current = value;
                        setBillingInterval(value);
                        if (billingConfig?.featuredPromotion) {
                          void applyFeaturedPromotion(
                            billingConfig.featuredPromotion,
                            value,
                            billingMarketForRequest(billingConfig, planId)
                          );
                        } else {
                          setAppliedPromoCode(null);
                          setAppliedPromotion(null);
                        }
                      }}
                      className={`rounded-2xl border p-4 text-left transition ${
                        billingInterval === value
                          ? "border-blue-500 bg-blue-50 ring-4 ring-blue-500/15 dark:bg-blue-500/10"
                          : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-zinc-700"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-zinc-950 dark:text-white">
                          {label}
                        </span>
                        {value === "annual" ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-300">
                            {copy.annualOff}
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

              {foundingPass ? (
                <div className="mt-6 rounded-2xl border border-blue-500/30 bg-blue-500/10 p-4">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                    {passCopy.title}
                  </p>
                  <p className="mt-2 text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                    {passCopy.detail(foundingPass.accessDurationDays || 60)}
                  </p>
                </div>
              ) : null}

              <label
                htmlFor={inputId}
                className="mt-6 block text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400"
              >
                {copy.promoLabel}
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id={inputId}
                  value={promoCode}
                  disabled={isValidatingPromotion}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setPromoCode(nextValue);
                    if (appliedPromoCode !== nextValue.trim().toUpperCase()) {
                      setAppliedPromoCode(null);
                      setAppliedPromotion(null);
                    }
                  }}
                  className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-base font-bold uppercase text-zinc-950 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                  placeholder={copy.promoPlaceholder}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={applyPromotion}
                  disabled={isValidatingPromotion}
                  aria-busy={isValidatingPromotion}
                  className="rounded-xl border border-zinc-200 px-4 py-3 text-sm font-bold text-zinc-700 hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {copy.apply}
                </button>
              </div>
              <p className="mt-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                {foundingPass
                  ? passCopy.detail(foundingPass.accessDurationDays || 60)
                  : `${copy.promoFinePrint} ${
                      promotionPolicyCopy[lang] || promotionPolicyCopy.en
                    }`}
              </p>
            </div>

            <aside className="flex flex-col border-t border-zinc-200 bg-zinc-50 p-5 pb-3 dark:border-zinc-800 dark:bg-zinc-900/70 md:border-l md:border-t-0 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                    {copy.orderSummary}
                  </p>
                  <h3 className="mt-2 text-xl font-black text-zinc-950 dark:text-white">
                    Tomverse {plan}
                  </h3>
                </div>
                <span className="rounded-full bg-blue-600 px-3 py-1 text-xs font-bold text-white">
                  {billingInterval === "annual" ? copy.annual : copy.monthly}
                </span>
              </div>

              <div className="mt-6 space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    {copy.plan}
                  </span>
                  <span className="font-bold text-zinc-950 dark:text-white">
                    {plan}
                  </span>
                </div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    {copy.billing}
                  </span>
                  <span className="font-bold text-zinc-950 dark:text-white">
                    {foundingPass
                      ? passCopy.billingLabel
                      : billingInterval === "annual"
                        ? copy.yearly
                        : copy.monthly}
                  </span>
                </div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    {copy.subtotal}
                  </span>
                  <span className="font-bold text-zinc-950 dark:text-white">
                    {priceLabel || "-"}
                  </span>
                </div>
                {billingInterval === "annual" ? (
                  <div className="flex justify-between gap-4 text-sm text-emerald-600 dark:text-emerald-300">
                    <span className="font-semibold">{copy.annualSavings}</span>
                    <span className="font-bold">20%</span>
                  </div>
                ) : null}
                {chargeablePromotion ? (
                  <div
                    data-testid="checkout-promotion-row"
                    className="flex justify-between gap-4 text-sm text-blue-600 dark:text-blue-300"
                  >
                    <span className="font-semibold">
                      {appliedPromoCode}
                      {promotionMonths ? (
                        <span
                          data-testid="checkout-promotion-period"
                          className="block text-xs font-semibold"
                        >
                          {copy.promotionPeriod(promotionMonths)}
                        </span>
                      ) : null}
                    </span>
                    <span className="font-bold">{discountLabel || copy.appliedAtCheckout}</span>
                  </div>
                ) : null}
                <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
                  <div className="flex justify-between gap-4">
                    <span className="font-bold text-zinc-950 dark:text-white">
                      {copy.dueToday}
                    </span>
                    <span
                      data-testid="checkout-due-today"
                      className="text-2xl font-black text-zinc-950 dark:text-white"
                    >
                      {displayedDueLabel || priceLabel || "-"}
                    </span>
                  </div>
                  {planConfig?.displayCurrency && !foundingPass ? (
                    <p className="mt-2 text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                      {copy.localPriceNote(
                        displayedDueLabel || priceLabel || "-"
                      )}
                    </p>
                  ) : null}
                </div>
              </div>

              <div
                data-testid="checkout-renewal-note"
                className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-xs font-semibold leading-5 text-blue-700 dark:text-blue-200"
              >
                {foundingPass
                  ? passCopy.detail(foundingPass.accessDurationDays || 60)
                  : promotionMonths && billingInterval === "monthly" && dueLabel && monthlyPriceLabel
                    ? copy.promotionRenewalNote(promotionMonths, dueLabel, monthlyPriceLabel)
                    : copy.renewalNote(
                      billingInterval,
                      billingInterval === "annual"
                        ? annualPriceLabel || "-"
                        : monthlyPriceLabel || "-"
                    )}
              </div>

              <p className="mt-3 text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                {legalCopy.prefix}
                <Link
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-blue-700 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
                >
                  {legalCopy.terms}
                </Link>
                {legalCopy.conjunction}
                <Link
                  href="/refund"
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-blue-700 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
                >
                  {legalCopy.refund}
                </Link>
                {legalCopy.suffix}
              </p>

              <div className="mt-auto hidden flex-col gap-2 pt-6 md:flex">
                <button
                  type="submit"
                  disabled={isSending || isValidatingPromotion}
                  className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSending
                    ? t("billing.sending")
                    : foundingPass
                      ? passCopy.activate
                      : copy.continueToCheckout}
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-xl border border-zinc-200 px-4 py-3 text-sm font-bold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {t("billing.cancel")}
                </button>
              </div>
            </aside>
            <div className="sticky bottom-0 z-20 border-t border-zinc-200 bg-white/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                  {copy.dueToday}
                </span>
                <span className="text-xl font-black text-zinc-950 dark:text-white">
                  {displayedDueLabel || priceLabel || "-"}
                </span>
              </div>
              <button
                type="submit"
                disabled={isSending || isValidatingPromotion}
                className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-950/20 hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSending
                  ? t("billing.sending")
                  : foundingPass
                    ? passCopy.activate
                    : copy.continueToCheckout}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
