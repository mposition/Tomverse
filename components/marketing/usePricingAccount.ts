"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import type {
  AccountPlanTier,
  PricingBillingInterval,
} from "@/lib/purchaseIntent";

/**
 * What the pricing page needs to know about the visitor before it can render a
 * single purchase CTA.
 *
 * The session alone is not enough. `session.user.plan` is whatever was baked
 * into the JWT when it was issued, so it survives a plan change, a cancelled
 * subscription and a lapsed Founding Tester Pass unchanged -- and the pricing
 * page is exactly the screen where acting on a stale plan produces a dead CTA.
 * `/api/user/usage` recomputes the effective plan per request, so it is the
 * authority here and the session is only used to decide whether to ask.
 */

export type PricingAccountState = {
  /** Resolved auth state. Never guessed: "loading" is a real, rendered state. */
  status: "loading" | "authenticated" | "unauthenticated";
  /** Authoritative plan, or null while it is still being fetched. */
  plan: AccountPlanTier | null;
  /**
   * True when a Stripe subscription is live. An upgrade from here is a
   * *change* to that subscription, which this product has no flow for, so the
   * CTA must offer management rather than a checkout that would be rejected.
   */
  hasActiveSubscription: boolean;
  /**
   * The interval the live subscription bills on. A plan change is only offered
   * between plans on the *same* interval, so a CTA that does not know this
   * cannot offer one.
   */
  billingInterval: PricingBillingInterval | null;
  /** Set when the subscription is running out at the end of the paid period. */
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  planCreditsRemaining: number;
  addonCreditsRemaining: number;
  /** The usage request came back 401: the session is present but no longer valid. */
  sessionExpired: boolean;
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

const normalizePlan = (value: unknown): AccountPlanTier | null =>
  value === "Pro" || value === "Max" || value === "Free" ? value : null;

const normalizeInterval = (value: unknown): PricingBillingInterval | null =>
  value === "monthly" || value === "annual" ? value : null;

const nonNegative = (value: unknown) => Math.max(0, Number(value) || 0);

export function usePricingAccount(): PricingAccountState {
  const { status: sessionStatus } = useSession();
  const [account, setAccount] = useState<Omit<PricingAccountState, "status">>({
    plan: null,
    hasActiveSubscription: false,
    billingInterval: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    planCreditsRemaining: 0,
    addonCreditsRemaining: 0,
    sessionExpired: false,
  });

  useEffect(() => {
    if (sessionStatus !== "authenticated") {
      // Deferred rather than set inline: a synchronous setState in an effect
      // body cascades an extra render, which the repo's React Compiler lint
      // rejects. This is the same queueMicrotask shape ChatPageClient uses
      // when it reads a billing outcome out of the URL.
      queueMicrotask(() =>
        setAccount((current) =>
          current.plan === null && !current.sessionExpired
            ? current
            : {
                plan: null,
                hasActiveSubscription: false,
                billingInterval: null,
                cancelAtPeriodEnd: false,
                currentPeriodEnd: null,
                planCreditsRemaining: 0,
                addonCreditsRemaining: 0,
                sessionExpired: false,
              }
        )
      );
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    void fetch("/api/user/usage", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          if (!cancelled) {
            setAccount((current) => ({ ...current, sessionExpired: true }));
          }
          return null;
        }
        return response.ok ? response.json() : null;
      })
      .then((data) => {
        if (cancelled || !data) return;
        const subscriptionStatus = data.subscription?.status;
        setAccount({
          plan: normalizePlan(data.plan) || "Free",
          hasActiveSubscription:
            typeof subscriptionStatus === "string" &&
            ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus),
          billingInterval: normalizeInterval(data.subscription?.billingInterval),
          cancelAtPeriodEnd: Boolean(data.subscription?.cancelAtPeriodEnd),
          currentPeriodEnd:
            typeof data.subscription?.currentPeriodEnd === "string"
              ? data.subscription.currentPeriodEnd
              : null,
          planCreditsRemaining: nonNegative(data.balances?.planRemainingCredits),
          addonCreditsRemaining: nonNegative(
            data.balances?.purchasedRemainingCredits
          ),
          sessionExpired: false,
        });
      })
      .catch((requestError) => {
        // A failed usage request must not be reported as "you are on Free":
        // the plan stays null, which keeps every CTA in its loading state
        // rather than showing an upgrade the account cannot complete.
        if ((requestError as Error).name === "AbortError") return;
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionStatus]);

  return { status: sessionStatus, ...account };
}
