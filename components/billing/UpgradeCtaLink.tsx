"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  getAnalyticsAttributionSnapshot,
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import type { PurchaseAnalyticsTrigger } from "@/lib/productAnalyticsShared";
import {
  PRICING_PLANS_ANCHOR,
  buildPricingIntentHref,
} from "@/lib/purchaseIntent";

type UpgradePlan = "Pro" | "Max";
type CurrentPlan = "Free" | "Pro" | "Max";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;

const isCampaignValue = (value: string | null | undefined) =>
  Boolean(value && !value.startsWith("("));

const subscribeToLocation = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
};

const getLocationSearch = () => window.location.search;
const getServerLocationSearch = () => "";

export function UpgradeCtaLink({
  targetPlan,
  currentPlan,
  trigger,
  ctaLocation,
  planCreditsRemaining = 0,
  addonCreditsRemaining = 0,
  className,
  children,
  onClick,
  testId,
}: {
  targetPlan: UpgradePlan;
  currentPlan: CurrentPlan;
  trigger: PurchaseAnalyticsTrigger;
  ctaLocation: string;
  planCreditsRemaining?: number;
  addonCreditsRemaining?: number;
  className?: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
}) {
  const { lang } = useLanguage();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const locationSearch = useSyncExternalStore(
    subscribeToLocation,
    getLocationSearch,
    getServerLocationSearch
  );
  const analyticsProperties = useMemo(
    () => ({
      cta_location: ctaLocation,
      current_plan: currentPlan.toLowerCase() as "free" | "pro" | "max",
      plan_id: targetPlan.toLowerCase() as "pro" | "max",
      trigger,
      plan_credits_remaining: Math.max(0, Math.floor(planCreditsRemaining)),
      addon_credits_remaining: Math.max(0, Math.floor(addonCreditsRemaining)),
    }),
    [
      addonCreditsRemaining,
      ctaLocation,
      currentPlan,
      planCreditsRemaining,
      targetPlan,
      trigger,
    ]
  );

  // The link used to say only "go to /pricing", with the plan the visitor
  // actually asked for left behind. The pricing page then had to guess, and
  // showed all three cards identically -- so a Pro subscriber who clicked
  // "Upgrade" landed on a page that offered them Pro again.
  const href = useMemo(() => {
    const current = new URLSearchParams(locationSearch);
    const attribution = getAnalyticsAttributionSnapshot();
    const attributionValues = {
      utm_source: attribution?.utm_source,
      utm_medium: attribution?.utm_medium,
      utm_campaign: attribution?.utm_campaign,
    };
    const utm: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
    UTM_KEYS.forEach((key) => {
      const currentValue = current.get(key);
      const fallbackValue = attributionValues[key];
      if (isCampaignValue(currentValue)) {
        utm[key] = currentValue!;
      } else if (isCampaignValue(fallbackValue)) {
        utm[key] = fallbackValue!;
      }
    });

    return buildPricingIntentHref({
      lang,
      intent: "subscription",
      targetPlan: targetPlan === "Max" ? "max" : "pro",
      trigger,
      ctaLocation,
      utm,
      anchor: PRICING_PLANS_ANCHOR,
    });
  }, [ctaLocation, lang, locationSearch, targetPlan, trigger]);

  useEffect(() => {
    const link = linkRef.current;
    if (!link) return;
    const trackImpression = () =>
      trackProductEventOnce(
        `upgrade_prompt_view:${ctaLocation}:${currentPlan}:${targetPlan}`,
        "upgrade_prompt_view",
        0,
        analyticsProperties
      );
    if (!("IntersectionObserver" in window)) {
      trackImpression();
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        trackImpression();
        observer.disconnect();
      },
      { threshold: 0.5 }
    );
    observer.observe(link);
    return () => observer.disconnect();
  }, [analyticsProperties, ctaLocation, currentPlan, targetPlan]);

  return (
    <Link
      ref={linkRef}
      href={href}
      data-testid={testId}
      className={className}
      onClick={(event) => {
        trackProductEvent("cta_start_click", 0, analyticsProperties);
        onClick?.(event);
      }}
    >
      {children}
    </Link>
  );
}
