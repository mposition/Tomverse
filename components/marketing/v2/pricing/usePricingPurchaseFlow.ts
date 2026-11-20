"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Language } from "@/lib/language";
import type { PricingAccountState } from "@/components/marketing/usePricingAccount";
import {
  PRICING_CREDIT_PACKS_ANCHOR,
  PRICING_PLANS_ANCHOR,
  buildPricingIntentHref,
  buildPurchaseSignInHref,
  normalizeCreditPackId,
  parsePurchaseIntent,
  resolvePlanCtaState,
  type PurchaseCreditPackId,
  type PurchaseIntent,
} from "@/lib/purchaseIntent";
import { getPricingStarterLabelKey } from "@/lib/pricingStarterNotice";
import { trackProductEvent, trackProductEventOnce } from "@/lib/productAnalyticsClient";

/**
 * The purchase flow of the pricing page: what the URL asked for, what Stripe sent the
 * visitor back with, and the modals those two drive. This is the previous page's logic
 * (components/marketing/PricingPageContent.tsx) moved here unchanged, so the V2 layout
 * can change without touching how a purchase starts, resumes or is measured.
 */
export type BillingOutcome = {
  status: "credits-success" | "credits-cancelled" | "cancelled";
  packId: PurchaseCreditPackId | null;
  planId: "pro" | "max" | null;
};

export function usePricingPurchaseFlow(lang: Language, account: PricingAccountState) {
  const pricingViewTrackedRef = useRef(false);
  // The purchase intent, the billing outcome, and the modal it drives.
  //
  // These are read from `window.location` in an effect rather than through
  // `useSearchParams`, because this route's layout is `force-static`: calling
  // that hook would opt the whole prerendered tree into client-side rendering
  // up to the nearest Suspense boundary. Reading after hydration keeps the
  // static HTML intact and cannot produce a hydration mismatch, and it is the
  // pattern UpgradeCtaLink already uses for the same reason.
  const [pageIntent, setPageIntent] = useState<PurchaseIntent | null>(null);
  const [starterLabelKey, setStarterLabelKey] = useState<string | null>(null);
  const [subscriptionInterval, setSubscriptionInterval] = useState<"monthly" | "annual">("monthly");
  const [billingOutcome, setBillingOutcome] = useState<BillingOutcome | null>(
    null
  );
  const [creditModal, setCreditModal] = useState<{
    open: boolean;
    packId: PurchaseCreditPackId | null;
    ctaLocation: string;
  }>({ open: false, packId: null, ctaLocation: "pricing_credit_pack_section" });
  // The plan the visitor asked to move to, or null when the change screen is
  // closed. One at a time: two cards can offer a change, but a subscriber has
  // exactly one subscription to change.
  const [planChangeTarget, setPlanChangeTarget] = useState<"Pro" | "Max" | null>(
    null
  );
  const planChangeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const purchaseResumedRef = useRef(false);
  // The plan whose checkout dialog opens on its own after sign-in.
  const [resumedSubscriptionPlan, setResumedSubscriptionPlan] = useState<
    "pro" | "max" | null
  >(null);
  const creditPackCtaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (pricingViewTrackedRef.current) return;
    pricingViewTrackedRef.current = true;
    trackProductEvent("pricing_view");
  }, []);

  // One read of the URL, on mount. A billing outcome is consumed here and
  // stripped from the address bar: leaving `?billing=credits-success` in place
  // meant a refresh -- or a shared link -- re-announced a purchase that had
  // already happened.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const search = window.location.search;
    const intent = parsePurchaseIntent(search);
    const params = new URLSearchParams(search);
    const starterLabelKeyFromUrl = getPricingStarterLabelKey(params.get("starter"));
    const billingParam = params.get("billing");
    const planParam = params.get("plan");
    const outcome: BillingOutcome | null =
      billingParam === "credits-success" ||
      billingParam === "credits-cancelled" ||
      billingParam === "cancelled"
        ? {
            status: billingParam,
            packId: normalizeCreditPackId(params.get("pack")),
            planId: planParam === "pro" || planParam === "max" ? planParam : null,
          }
        : null;
    // Deferred so the effect body stays free of synchronous setState, which is
    // the shape the repo's React Compiler lint rejects.
    queueMicrotask(() => {
      setPageIntent(intent);
      setStarterLabelKey(starterLabelKeyFromUrl);
      if (intent.billingInterval) setSubscriptionInterval(intent.billingInterval);
      if (outcome) setBillingOutcome(outcome);
    });
    if (!outcome) return;
    for (const key of ["billing", "pack", "plan", "interval"]) params.delete(key);
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
        window.location.hash
      }`
    );
  }, []);

  // Stripe sent the visitor back through `cancel_url`. That is a decision, not
  // a failure, and reporting it as `checkout_failed` made the funnel's error
  // rate unreadable.
  useEffect(() => {
    if (!billingOutcome) return;
    if (billingOutcome.status === "credits-success") return;
    trackProductEvent("checkout_cancelled", 0, {
      cta_location: "pricing_checkout_return",
      purchase_type:
        billingOutcome.status === "credits-cancelled"
          ? "credit_pack"
          : "subscription",
      ...(billingOutcome.packId ? { pack_id: billingOutcome.packId } : {}),
      ...(billingOutcome.planId ? { target_plan: billingOutcome.planId } : {}),
      ...(account.plan
        ? { current_plan: account.plan.toLowerCase() as "free" | "pro" | "max" }
        : {}),
      authentication_state:
        account.status === "loading" ? "loading" : account.status,
    });
    // The outcome is a one-shot announcement; re-firing it whenever the
    // account state settles would count one cancellation several times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingOutcome]);

  // A visitor who signed in mid-purchase comes back with their intent intact.
  // The modal is reopened on the pack they chose -- and nothing is charged:
  // they still have to confirm the purchase themselves.
  useEffect(() => {
    if (purchaseResumedRef.current) return;
    if (!pageIntent || pageIntent.intent !== "credit_pack") return;
    if (account.status !== "authenticated" || !account.plan) return;
    purchaseResumedRef.current = true;
    trackProductEvent("purchase_intent_resumed", 0, {
      cta_location: pageIntent.ctaLocation || "pricing_credit_pack_section",
      purchase_type: "credit_pack",
      authentication_state: "authenticated",
      current_plan: account.plan.toLowerCase() as "free" | "pro" | "max",
      ...(pageIntent.packId ? { pack_id: pageIntent.packId } : {}),
      ...(pageIntent.trigger ? { trigger: pageIntent.trigger } : {}),
      plan_credits_remaining: account.planCreditsRemaining,
      addon_credits_remaining: account.addonCreditsRemaining,
    });
    queueMicrotask(() =>
      setCreditModal({
        open: true,
        packId: pageIntent.packId,
        ctaLocation: pageIntent.ctaLocation || "pricing_credit_pack_resume",
      })
    );

    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    params.delete("intent");
    params.delete("target");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
        window.location.hash
      }`
    );
  }, [
    account.addonCreditsRemaining,
    account.plan,
    account.planCreditsRemaining,
    account.status,
    pageIntent,
  ]);

  // The same round trip for a subscription: "Sign in or join to start Pro"
  // comes back here with `intent=subscription&target=pro`, and the visitor
  // goes straight to that plan's checkout dialog instead of having to find and
  // press "Upgrade" again. Only when the card would offer a fresh upgrade -- a
  // Pro subscriber returning with a Pro intent gets the page as it is. The
  // dialog opens empty: a promotion code is never carried in the link.
  useEffect(() => {
    if (purchaseResumedRef.current) return;
    if (!pageIntent || pageIntent.intent !== "subscription") return;
    const targetPlan = pageIntent.targetPlan;
    if (!targetPlan) return;
    if (account.status !== "authenticated" || !account.plan) return;
    const ctaState = resolvePlanCtaState({
      sessionStatus: account.status,
      currentPlan: account.plan,
      cardPlan: targetPlan === "max" ? "Max" : "Pro",
      hasActiveSubscription: account.hasActiveSubscription,
      currentBillingInterval: account.billingInterval,
    });
    if (ctaState !== "upgrade") return;
    purchaseResumedRef.current = true;
    trackProductEvent("purchase_intent_resumed", 0, {
      cta_location: pageIntent.ctaLocation || `pricing_plan_card_${targetPlan}`,
      purchase_type: "subscription",
      target_plan: targetPlan,
      authentication_state: "authenticated",
      current_plan: account.plan.toLowerCase() as "free" | "pro" | "max",
      ...(pageIntent.trigger ? { trigger: pageIntent.trigger } : {}),
      plan_credits_remaining: account.planCreditsRemaining,
      addon_credits_remaining: account.addonCreditsRemaining,
    });
    queueMicrotask(() => setResumedSubscriptionPlan(targetPlan));

    if (typeof window === "undefined") return;
    // A reload after closing the dialog must not reopen it.
    const params = new URLSearchParams(window.location.search);
    params.delete("intent");
    params.delete("target");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
        window.location.hash
      }`
    );
  }, [
    account.addonCreditsRemaining,
    account.billingInterval,
    account.hasActiveSubscription,
    account.plan,
    account.planCreditsRemaining,
    account.status,
    pageIntent,
  ]);

  // The add-on CTA's impression, recorded once per resolved auth state. It is
  // deliberately not fired while the session is still loading: an impression
  // whose `authentication_state` is "loading" cannot be compared against the
  // clicks that follow it.
  useEffect(() => {
    const node = creditPackCtaRef.current;
    if (!node || account.status === "loading") return;
    const authenticationState = account.status;
    const fire = () =>
      trackProductEventOnce(
        `credit_pack_cta_view:${authenticationState}`,
        "credit_pack_cta_view",
        0,
        {
          cta_location: "pricing_credit_pack_section",
          purchase_type: "credit_pack",
          authentication_state: authenticationState,
          ...(account.plan
            ? {
                current_plan: account.plan.toLowerCase() as
                  | "free"
                  | "pro"
                  | "max",
              }
            : {}),
        }
      );
    if (!("IntersectionObserver" in window)) {
      fire();
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        fire();
        observer.disconnect();
      },
      { threshold: 0.4 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [account.plan, account.status]);

  // Where Stripe returns a credit-pack purchase. The server re-validates this
  // against its own allowlist, so it is a proposal, not an instruction.
  const creditPackReturnTo = useMemo(
    () => `/pricing?lang=${encodeURIComponent(lang)}#${PRICING_CREDIT_PACKS_ANCHOR}`,
    [lang]
  );

  const creditPackSignInHref = useCallback(
    (packId: PurchaseCreditPackId | null, ctaLocation: string) =>
      buildPurchaseSignInHref(
        buildPricingIntentHref({
          lang,
          intent: "credit_pack",
          packId,
          trigger: pageIntent?.trigger,
          ctaLocation,
          utm: pageIntent?.utm,
          anchor: PRICING_CREDIT_PACKS_ANCHOR,
        })
      ),
    [lang, pageIntent]
  );

  const planSignInHref = useCallback(
    (targetPlan: "pro" | "max") =>
      buildPurchaseSignInHref(
        buildPricingIntentHref({
          lang,
          intent: "subscription",
          targetPlan,
          billingInterval: lang === "ko" ? subscriptionInterval : undefined,
          trigger: pageIntent?.trigger,
          ctaLocation: `pricing_plan_card_${targetPlan}`,
          utm: pageIntent?.utm,
          anchor: PRICING_PLANS_ANCHOR,
        })
      ),
    [lang, pageIntent, subscriptionInterval]
  );

  const trackCreditPackCtaClick = useCallback(
    (packId: PurchaseCreditPackId | null, ctaLocation: string) => {
      trackProductEvent("credit_pack_cta_click", 0, {
        cta_location: ctaLocation,
        purchase_type: "credit_pack",
        authentication_state:
          account.status === "loading" ? "loading" : account.status,
        ...(packId ? { pack_id: packId } : {}),
        ...(account.plan
          ? {
              current_plan: account.plan.toLowerCase() as "free" | "pro" | "max",
            }
          : {}),
      });
    },
    [account.plan, account.status]
  );

  return {
    pageIntent,
    starterLabelKey,
    subscriptionInterval,
    setSubscriptionInterval,
    billingOutcome,
    creditModal,
    setCreditModal,
    planChangeTarget,
    setPlanChangeTarget,
    planChangeTriggerRef,
    resumedSubscriptionPlan,
    creditPackCtaRef,
    creditPackReturnTo,
    creditPackSignInHref,
    planSignInHref,
    trackCreditPackCtaClick,
  };
}
