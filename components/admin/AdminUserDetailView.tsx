"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Clipboard, FileText, RefreshCw } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { describeAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminDateTimeLabel as dateTimeLabel } from "@/lib/adminDateTime";
import { buildPlanAdjustPayload } from "@/lib/adminPlanAdjustCore";
import { formatBillingMinor, normalizeBillingCurrency } from "@/lib/billingMarkets";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminUsersMessages } from "@/lib/adminMessages/users";
import { AdminNotesBox } from "@/components/admin/AdminNotesBox";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  AdminUserSecurityControls,
  toAdminSecurityUser,
} from "@/components/admin/AdminUserSecurityControls";
import { AdminRing } from "@/components/admin/ui/AdminCharts";
import { AdminInitialAvatar } from "@/components/admin/ui/AdminInitialAvatar";
import { AdminPlanChip } from "@/components/admin/ui/AdminPlanChip";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";
import { ADMIN_USER_DETAIL_TABS, type AdminUserDetailTab } from "@/lib/adminUserDetailTabs";
import type { AdminTone } from "@/lib/adminUiCore";

export type AdminUserPlanLimits = Record<string, { daily: number; monthly: number }>;

type AdminUserDetail = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  plan: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  subscriptionBillingInterval: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
  creditDebtCredits: number;
  creditDebtCostMicroUsd: number;
  billingRiskStatus: string;
  billingRiskReason: string | null;
  billingRiskAt: string | null;
  accountStatus: string;
  accountDeletionRequestedAt: string | null;
  accountDeletionScheduledFor: string | null;
  accountSuspendedAt: string | null;
  accountSuspendedUntil: string | null;
  accountSuspensionReason: string | null;
  aiUsageRestricted: boolean;
  aiUsageRestrictedAt: string | null;
  aiUsageRestrictedUntil: string | null;
  aiUsageRestrictionReason: string | null;
  securityIncidentNote: string | null;
  lastLoginAt: string | null;
  settings: {
    language: string;
    theme: string;
    defaultModel: string;
    timeZone: string;
    updatedAt: string;
  } | null;
  accounts: Array<{ provider: string; providerAccountId: string; type: string }>;
  refundRequests: Array<{
    id: string;
    status: string;
    plan: string | null;
    reason: string | null;
    requestedAt: string;
    reviewedAt: string | null;
    stripeRefundStatus: string | null;
    refundAmountCents: number | null;
  }>;
  promotionRedemptions: Array<{
    id: string;
    planId: string;
    billingInterval: string;
    redeemedAt: string;
    stripeCheckoutSessionId: string | null;
    promotion: { code: string; discountPercent: number; discountAmountCents: number | null };
  }>;
  creditPurchases: Array<{
    id: string;
    packId: string;
    creditsPurchased: number;
    fundedCostMicroUsd: number;
    amountPaidCents: number;
    amountPaidUsdMicroUsd: number;
    currency: string;
    refundedAmountCents: number;
    revokedCredits: number;
    revokedCostMicroUsd: number;
    unrecoveredCredits: number;
    unrecoveredCostMicroUsd: number;
    remainingCredits: number;
    remainingFundedCostMicroUsd: number;
    stripeCheckoutSessionId: string;
    stripePaymentIntentId: string | null;
    stripeChargeId: string | null;
    stripeDisputeId: string | null;
    disputeStatus: string | null;
    status: string;
    purchasedAt: string;
    expiresAt: string;
  }>;
  creditDebtEntries: Array<{
    id: string;
    purchaseId: string | null;
    type: string;
    creditsDelta: number;
    fundedCostMicroUsdDelta: number;
    balanceAfterCredits: number;
    balanceAfterCostMicroUsd: number;
    createdAt: string;
  }>;
  chatCreditReservations: Array<{
    id: string;
    traceId: string;
    source: string;
    provider: string;
    modelId: string;
    status: string;
    outcome: string | null;
    providerRequestId: string | null;
    providerResponseId: string | null;
    reservedCredits: number;
    settledCredits: number;
    reservedCostMicroUsd: number;
    settledCostMicroUsd: number;
    expiresAt: string;
    settledAt: string | null;
    reconciledAt: string | null;
    lastError: string | null;
    createdAt: string;
  }>;
  recentConversations: Array<{
    id: string;
    title: string;
    shareEnabled: boolean;
    createdAt: string;
    updatedAt: string;
    _count: { messages: number };
  }>;
  usage: {
    timeZone: string;
    dayStart: string;
    dayEnd: string;
    messagesToday: number;
    creditsToday: number;
    creditsMonth: number;
  };
  timeline: Array<{ id: string; type: string; title: string; detail: string; at: string }>;
  _count: {
    conversations: number;
    accounts: number;
    refundRequests: number;
    promotionRedemptions: number;
    sessions: number;
    creditPurchases: number;
    chatCreditReservations: number;
  };
};

type Props = {
  userId: string;
  tab: AdminUserDetailTab;
  currentUserId: string;
  /** Plan limits by plan name; empty when the plans could not be read. */
  planLimits: AdminUserPlanLimits;
  /** What the viewer's role may write, per kind of write; the routes still decide. */
  access: AdminUserAccess;
};

export type AdminUserAccess = {
  /** Resync, plan change, hold release, credit refund (`billing:write`). */
  billing: boolean;
  /** Restrict, suspend, sign out, restore (`support:write` or `ops:write`). */
  security: boolean;
  /** Unlink a sign-in (`user:delete`). */
  unlink: boolean;
};

const fieldClass =
  "h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10";

const dollars = (micro: number, digits = 2) => (micro / 1_000_000).toFixed(digits);

/**
 * One customer: who they are, then five sections (`?tab=`) -- overview,
 * billing, security, conversations, notes and timeline.
 *
 * The detail is read once from `/api/admin/users/:id` and kept while the
 * operator moves between sections, because the sections are links and the
 * page above this component renders the same tree for each of them. Every
 * write below is the call the old modal made, with the same payload.
 */
export function AdminUserDetailView({ userId, tab, currentUserId, planLimits, access }: Props) {
  const m = useAdminMessages(adminUsersMessages);
  const { locale: apiLocale } = useAdminLocale();
  const intl = adminIntlLocale(apiLocale);
  const pathname = usePathname();
  const [apiFailure, setApiFailure] = useState<AdminApiFailure | null>(null);
  const [detailUser, setDetailUser] = useState<AdminUserDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [billingAction, setBillingAction] = useState<string | null>(null);
  const [adjustPlan, setAdjustPlan] = useState<"Free" | "Pro" | "Max">("Free");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustConfirm, setAdjustConfirm] = useState("");
  const [riskReleaseReason, setRiskReleaseReason] = useState("");
  const [riskReleaseConfirm, setRiskReleaseConfirm] = useState("");
  const [creditRefundReasons, setCreditRefundReasons] = useState<Record<string, string>>({});
  const [creditRefundConfirms, setCreditRefundConfirms] = useState<Record<string, string>>({});
  const loadedRef = useRef<string | null>(null);

  const loadUserDetail = useCallback(
    async (id: string) => {
      setDetailError("");
      setLoading(true);
      try {
        const response = await adminFetch(`/api/admin/users/${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        const data = (await response.json().catch(() => null)) as
          | { user?: AdminUserDetail; error?: string }
          | null;
        if (!response.ok || !data?.user) {
          throw new Error(data?.error || m.toast.detailFailed);
        }
        setDetailUser(data.user);
      } catch (error) {
        const message = error instanceof Error ? error.message : m.toast.detailFailed;
        setDetailError(message);
        dispatchAppToast(message, "error");
      } finally {
        setLoading(false);
      }
    },
    [m.toast.detailFailed]
  );

  useEffect(() => {
    if (loadedRef.current === userId) return;
    loadedRef.current = userId;
    void loadUserDetail(userId);
  }, [userId, loadUserDetail]);

  const copyUserContext = async (user: AdminUserDetail) => {
    const text = [
      "Tomverse User Context",
      `User: ${user.email || user.name || user.id}`,
      `ID: ${user.id}`,
      `Plan: ${user.plan}`,
      `Subscription: ${user.subscriptionStatus || "-"}`,
      `Billing: ${user.subscriptionBillingInterval || "-"}`,
      `Period end: ${dateTimeLabel(user.subscriptionCurrentPeriodEnd, user.usage.timeZone)}`,
      `Time zone: ${user.usage.timeZone}`,
      `Messages today: ${user.usage.messagesToday}`,
      `Plan credits today: ${user.usage.creditsToday}`,
      `Plan credits this month: ${user.usage.creditsMonth}`,
      `Credit debt: ${user.creditDebtCredits} credits / $${dollars(user.creditDebtCostMicroUsd)} funded cost`,
      `Billing risk: ${user.billingRiskStatus}`,
      `Stripe customer: ${user.stripeCustomerId || "-"}`,
      `Stripe subscription: ${user.stripeSubscriptionId || "-"}`,
      `Linked accounts: ${user.accounts.map((account) => account.provider).join(", ") || "-"}`,
      `Conversations: ${user._count.conversations}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      dispatchAppToast(m.toast.contextCopied, "success");
    } catch {
      dispatchAppToast(m.toast.contextCopyFailed, "error");
    }
  };

  const resyncBilling = async (id: string) => {
    if (billingAction) return;
    setBillingAction("resync");
    try {
      const response = await adminFetch(`/api/admin/users/${encodeURIComponent(id)}/billing-resync`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as
        | { user?: Partial<AdminUserDetail>; error?: string; code?: string; approvalId?: string }
        | null;
      if (!response.ok || !data?.user) {
        const failure = describeAdminApiFailure({
          status: response.status,
          error: data?.error,
          code: data?.code,
          approvalId: data?.approvalId,
          fallback: m.toast.resyncFallback,
          locale: apiLocale,
        });
        dispatchAppToast(failure.message, failure.tone);
        setApiFailure(failure);
        return;
      }
      setDetailUser((current) => (current ? { ...current, ...data.user } : current));
      // The route reads Stripe and writes the plan, subscription and price it
      // found -- it does not change anything in Stripe.
      dispatchAppToast(m.toast.resyncDone, "success");
    } catch {
      dispatchAppToast(m.toast.resyncNetwork, "error");
    } finally {
      setBillingAction(null);
    }
  };

  const adjustUserPlan = async (id: string) => {
    if (billingAction) return;
    setBillingAction("adjust");
    try {
      // Carries no clock-derived value on purpose: a second administrator
      // approves this exact payload, and the requester then has to re-send it
      // byte-for-byte. See buildPlanAdjustPayload.
      const response = await adminFetch(`/api/admin/users/${encodeURIComponent(id)}/plan-adjust`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildPlanAdjustPayload({ plan: adjustPlan, reason: adjustReason, confirmText: adjustConfirm })
        ),
      });
      const data = (await response.json().catch(() => null)) as
        | { user?: Partial<AdminUserDetail>; error?: string }
        | null;
      if (!response.ok || !data?.user) {
        throw new Error(data?.error || m.toast.adjustFailed);
      }
      setDetailUser((current) => (current ? { ...current, ...data.user } : current));
      setAdjustReason("");
      setAdjustConfirm("");
      dispatchAppToast(m.toast.adjustDone, "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.toast.adjustFailed, "error");
    } finally {
      setBillingAction(null);
    }
  };

  const releaseBillingHold = async (id: string) => {
    if (billingAction) return;
    setBillingAction("risk");
    try {
      const response = await adminFetch(`/api/admin/users/${encodeURIComponent(id)}/billing-risk`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "release_hold",
          reason: riskReleaseReason,
          confirmText: riskReleaseConfirm,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { user?: Partial<AdminUserDetail>; error?: string; code?: string; approvalId?: string }
        | null;
      if (!response.ok || !data?.user) {
        const failure = describeAdminApiFailure({
          status: response.status,
          error: data?.error,
          code: data?.code,
          approvalId: data?.approvalId,
          fallback: m.toast.releaseFallback,
          locale: apiLocale,
        });
        dispatchAppToast(failure.message, failure.tone);
        setApiFailure(failure);
        return;
      }
      setDetailUser((current) => (current ? { ...current, ...data.user } : current));
      setRiskReleaseReason("");
      setRiskReleaseConfirm("");
      dispatchAppToast(m.toast.releaseDone, "success");
    } catch {
      dispatchAppToast(m.toast.releaseNetwork, "error");
    } finally {
      setBillingAction(null);
    }
  };

  const refundCreditPurchase = async (id: string, purchase: AdminUserDetail["creditPurchases"][number]) => {
    if (billingAction) return;
    setBillingAction(`refund:${purchase.id}`);
    try {
      const response = await adminFetch(
        `/api/admin/credit-purchases/${encodeURIComponent(purchase.id)}/refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: creditRefundReasons[purchase.id] || "",
            confirmReviewed: true,
            confirmText: creditRefundConfirms[purchase.id] || "",
            expectedRemainingCredits: purchase.remainingCredits,
            expectedRemainingFundedCostMicroUsd: purchase.remainingFundedCostMicroUsd,
          }),
        }
      );
      const data = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string; code?: string; approvalId?: string; stripeRefundId?: string }
        | null;
      if (!response.ok || !data?.success) {
        const failure = describeAdminApiFailure({
          status: response.status,
          error: data?.error,
          code: data?.code,
          approvalId: data?.approvalId,
          fallback: m.toast.refundFallback,
          locale: apiLocale,
        });
        dispatchAppToast(failure.message, failure.tone);
        setApiFailure(failure);
        return;
      }
      setCreditRefundReasons((current) => ({ ...current, [purchase.id]: "" }));
      setCreditRefundConfirms((current) => ({ ...current, [purchase.id]: "" }));
      await loadUserDetail(id);
      // The route only reaches `success` after Stripe accepted the refund, so
      // this may claim the money moved -- and consumed credits that could not
      // be revoked are now debt, which the reloaded detail shows above.
      dispatchAppToast(m.toast.refundDone, "success");
    } catch {
      dispatchAppToast(m.toast.refundNetwork, "error");
    } finally {
      setBillingAction(null);
    }
  };

  if (loading && !detailUser) {
    return <AdminStateBlock kind="loading" title={m.detail.loading} />;
  }
  if (!detailUser) {
    return (
      <AdminStateBlock
        kind="error"
        title={m.detail.loadFailed}
        detail={detailError || m.toast.detailFailed}
        onRetry={() => void loadUserDetail(userId)}
      />
    );
  }

  const user = detailUser;
  const planLimit = planLimits[user.plan];
  const monthlyLimit = planLimit && planLimit.monthly > 0 ? planLimit.monthly : null;
  const dailyLimit = planLimit && planLimit.daily > 0 ? planLimit.daily : null;
  const monthFraction = monthlyLimit ? user.usage.creditsMonth / monthlyLimit : null;
  const hasRisk = user.billingRiskStatus === "disputed_hold" || user.creditDebtCredits > 0;
  const accountTone: AdminTone =
    user.accountStatus === "active" ? "ok" : user.accountStatus === "suspended" || user.accountStatus === "pending_deletion" ? "bad" : "warn";
  const statusLabel =
    user.accountStatus === "active"
      ? m.detail.status.active
      : user.accountStatus === "suspended"
        ? m.detail.status.suspended
        : user.accountStatus === "pending_deletion"
          ? m.detail.status.pending_deletion
          : m.detail.status.other(user.accountStatus);
  const providers = user.accounts.map((account) => account.provider).join(", ");
  const busy = Boolean(billingAction);

  const timelineRows = (rows: AdminUserDetail["timeline"]) =>
    rows.length === 0 ? null : (
      <ul className="flex flex-col">
        {rows.map((event) => (
          <li key={`${event.type}-${event.id}`} className="flex items-start gap-3 border-t border-zinc-800 py-3 first:border-t-0 first:pt-0">
            <span aria-hidden className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-zinc-100">{event.title}</p>
              <p className="text-xs text-zinc-500">
                {dateTimeLabel(event.at, user.usage.timeZone)}
                {event.detail ? ` · ${event.detail}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>
    );

  const tabHref = (id: AdminUserDetailTab) => `${pathname}?tab=${id}`;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {apiFailure ? <AdminApiFailureNotice failure={apiFailure} returnTo={tabHref(tab)} /> : null}

      <header data-testid="admin-user-detail-header" className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <AdminInitialAvatar id={user.id} name={user.name} email={user.email} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-2xl font-bold tracking-tight text-white">
                {user.name || m.detail.noName}
              </h2>
              <AdminPlanChip plan={user.plan} />
              <AdminStatusChip tone={accountTone}>{statusLabel}</AdminStatusChip>
              {user.subscriptionCancelAtPeriodEnd ? (
                <AdminStatusChip tone="warn">{m.detail.cancelsAtPeriodEnd}</AdminStatusChip>
              ) : null}
            </div>
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-400">
              <span className="break-all">{user.email || m.detail.noEmail}</span>
              <span>{providers ? m.detail.signInWith(providers) : m.detail.noSignIn}</span>
              <span>{m.detail.timeZone(user.usage.timeZone)}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={tabHref("notes")}
            scroll={false}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
          >
            <FileText className="h-4 w-4" aria-hidden />
            {m.detail.leaveNote}
          </Link>
          <button
            type="button"
            onClick={() => void copyUserContext(user)}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
          >
            <Clipboard className="h-4 w-4" aria-hidden />
            {m.detail.copy}
          </button>
        </div>
      </header>

      <nav aria-label={m.detail.tabsLabel} className="min-w-0">
        <ul className="flex min-w-0 flex-wrap gap-1 border-b border-zinc-800">
          {ADMIN_USER_DETAIL_TABS.map((id) => {
            const active = id === tab;
            return (
              <li key={id}>
                <Link
                  href={tabHref(id)}
                  scroll={false}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px flex min-h-11 items-center border-b-2 px-3 py-2 text-sm transition ${
                    active
                      ? "border-blue-500 font-semibold text-white"
                      : "border-transparent font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-100"
                  }`}
                >
                  {m.detail.tabs[id]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {tab === "overview" ? (
        <div className="flex flex-col gap-4">
          {hasRisk ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
              <p>{m.detail.riskBanner(user.creditDebtCredits.toLocaleString(intl))}</p>
              <Link
                href={tabHref("billing")}
                scroll={false}
                className="inline-flex min-h-9 items-center rounded-xl border border-red-400/50 px-3 text-xs font-bold text-red-100 hover:bg-red-500/20"
              >
                {m.detail.openBilling}
              </Link>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-3">
            <AdminTile title={m.detail.credits.title} className="lg:col-span-2">
              <div className="flex flex-wrap items-center gap-6">
                {monthFraction !== null ? (
                  <AdminRing
                    fraction={Math.min(1, monthFraction)}
                    size={104}
                    stroke={12}
                    color={monthFraction >= 0.8 ? "amber" : "blue"}
                    label={m.detail.credits.usedPercent(Math.round(Math.min(1, monthFraction) * 100))}
                  >
                    <span className="text-sm font-bold text-white">
                      {Math.round(Math.min(1, monthFraction) * 100)}%
                    </span>
                  </AdminRing>
                ) : null}
                <div className="min-w-0">
                  <p className="text-xs text-zinc-500">{m.detail.credits.usedLabel}</p>
                  <p data-testid="admin-user-detail-credits-month" className="text-3xl font-bold tabular-nums text-white">
                    {user.usage.creditsMonth}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {monthlyLimit
                      ? m.detail.credits.ofLimit(monthlyLimit.toLocaleString(intl))
                      : planLimit
                        ? m.detail.credits.noLimit
                        : m.detail.credits.unknownLimit}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-zinc-500">{m.detail.credits.today}</p>
                  <p data-testid="admin-user-detail-credits-today" className="text-3xl font-bold tabular-nums text-white">
                    {user.usage.creditsToday}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {dailyLimit
                      ? m.detail.credits.todayOfLimit(String(user.usage.creditsToday), dailyLimit.toLocaleString(intl))
                      : m.detail.credits.todayNoLimit(String(user.usage.creditsToday))}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-zinc-500">{m.detail.credits.messagesToday}</p>
                  <p data-testid="admin-user-detail-messages-today" className="text-3xl font-bold tabular-nums text-white">
                    {user.usage.messagesToday}
                  </p>
                </div>
              </div>
              <p className="text-xs text-zinc-500">
                {m.detail.credits.dailyWindow(user.usage.timeZone, dateTimeLabel(user.usage.dayEnd, user.usage.timeZone))}
              </p>
            </AdminTile>

            <AdminTile title={m.detail.subscription.title}>
              <div className="flex flex-wrap items-center gap-2">
                <AdminPlanChip plan={user.plan} />
                {user.subscriptionStatus ? (
                  <AdminStatusChip
                    tone={
                      user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing"
                        ? "ok"
                        : user.subscriptionStatus === "past_due" || user.subscriptionStatus === "unpaid"
                          ? "bad"
                          : "idle"
                    }
                  >
                    {user.subscriptionStatus}
                  </AdminStatusChip>
                ) : (
                  <span className="text-sm text-zinc-400">{m.detail.subscription.none}</span>
                )}
              </div>
              {user.subscriptionBillingInterval ? (
                <p className="text-sm text-zinc-300">{m.detail.subscription.interval(user.subscriptionBillingInterval)}</p>
              ) : null}
              {user.subscriptionCurrentPeriodEnd ? (
                <p className="text-sm text-zinc-400">
                  {m.detail.subscription.nextPayment(dateTimeLabel(user.subscriptionCurrentPeriodEnd, user.usage.timeZone))}
                </p>
              ) : null}
              <div>
                <AdminWriteButton
                  variant="secondary"
                  size="sm"
                  writable={access.billing}
                  requiredRole="billing"
                  disabled={busy}
                  onClick={() => void resyncBilling(user.id)}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${billingAction === "resync" ? "animate-spin" : ""}`} aria-hidden />
                  {billingAction === "resync" ? m.detail.subscription.resyncing : m.detail.subscription.resync}
                </AdminWriteButton>
              </div>
            </AdminTile>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <AdminTile title={m.detail.recent.title} className="lg:col-span-2">
              {user.timeline.length === 0 ? (
                <p className="text-sm text-zinc-500">{m.detail.recent.empty}</p>
              ) : (
                timelineRows(user.timeline.slice(0, 5))
              )}
              {user.timeline.length > 5 ? (
                <Link href={tabHref("notes")} scroll={false} className="text-xs font-bold text-blue-300 hover:underline">
                  {m.detail.recent.seeAll}
                </Link>
              ) : null}
            </AdminTile>

            <AdminTile title={m.detail.account.title}>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-zinc-500">{m.detail.account.language}</dt>
                <dd className="text-zinc-200">{user.settings?.language || "-"}</dd>
                <dt className="text-zinc-500">{m.detail.account.theme}</dt>
                <dd className="text-zinc-200">{user.settings?.theme || "-"}</dd>
                <dt className="text-zinc-500">{m.detail.account.defaultModel}</dt>
                <dd className="break-all text-zinc-200">{user.settings?.defaultModel || "-"}</dd>
                <dt className="text-zinc-500">{m.detail.account.sessions}</dt>
                <dd className="text-zinc-200">{user._count.sessions}</dd>
                <dt className="text-zinc-500">{m.detail.account.conversations}</dt>
                <dd className="text-zinc-200">{user._count.conversations}</dd>
                <dt className="text-zinc-500">{m.detail.account.linked}</dt>
                <dd className="text-zinc-200">{providers || "-"}</dd>
              </dl>
            </AdminTile>
          </div>
        </div>
      ) : null}

      {tab === "billing" ? (
        <div className="flex flex-col gap-4">
          <AdminTile
            title={m.detail.risk.title}
            className={hasRisk ? "border-red-500/40" : ""}
            action={
              <AdminStatusChip tone={user.billingRiskStatus === "disputed_hold" ? "bad" : "ok"}>
                {user.billingRiskStatus === "disputed_hold" ? m.detail.risk.held : m.detail.risk.healthy}
              </AdminStatusChip>
            }
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-zinc-500">{m.detail.risk.unrecovered}</p>
                <p className="mt-1 text-xl font-bold text-white">
                  {m.detail.risk.credits(user.creditDebtCredits.toLocaleString(intl))}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">{m.detail.risk.fundedCost}</p>
                <p className="mt-1 text-xl font-bold text-white">${dollars(user.creditDebtCostMicroUsd)}</p>
              </div>
            </div>
            {user.billingRiskReason ? <p className="text-xs text-red-200">{user.billingRiskReason}</p> : null}
            {user.billingRiskStatus === "disputed_hold" ? (
              <div className="grid gap-3 md:grid-cols-[1fr_14rem_auto] md:items-end">
                <label className="block text-xs font-bold text-zinc-300">
                  <span className="sr-only">{m.detail.risk.reasonPlaceholder}</span>
                  <input
                    value={riskReleaseReason}
                    onChange={(event) => setRiskReleaseReason(event.target.value)}
                    placeholder={m.detail.risk.reasonPlaceholder}
                    className={fieldClass}
                  />
                </label>
                <label className="block text-xs font-bold text-zinc-300">
                  <span className="sr-only">{m.detail.risk.confirmLabel}</span>
                  <input
                    value={riskReleaseConfirm}
                    onChange={(event) => setRiskReleaseConfirm(event.target.value)}
                    placeholder="RELEASE BILLING HOLD"
                    aria-label={m.detail.risk.confirmLabel}
                    className={fieldClass}
                  />
                </label>
                <AdminWriteButton
                  variant="danger"
                  writable={access.billing}
                  requiredRole="billing"
                  onClick={() => void releaseBillingHold(user.id)}
                  disabled={busy || riskReleaseReason.trim().length < 5 || riskReleaseConfirm !== "RELEASE BILLING HOLD"}
                >
                  {billingAction === "risk" ? m.detail.risk.releasing : m.detail.risk.release}
                </AdminWriteButton>
              </div>
            ) : null}
            <p className="text-xs text-zinc-500">{m.detail.risk.note}</p>
          </AdminTile>

          <AdminTile title={m.detail.purchases.title}>
            {user.creditPurchases.length === 0 ? (
              <p className="text-sm text-zinc-500">{m.detail.purchases.empty}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {user.creditPurchases.map((purchase) => (
                  <li key={purchase.id} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 text-xs text-zinc-400">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-bold text-white">
                        {purchase.packId} <AdminStatusChip tone={purchase.status === "paid" ? "ok" : "idle"}>{purchase.status}</AdminStatusChip>
                      </p>
                      <p>{dateTimeLabel(purchase.purchasedAt, user.usage.timeZone)}</p>
                    </div>
                    <p className="mt-2 font-bold text-zinc-200">
                      {m.detail.purchases.paid(
                        formatBillingMinor(
                          purchase.amountPaidCents,
                          normalizeBillingCurrency(purchase.currency) || "USD",
                          "en"
                        ),
                        dollars(purchase.amountPaidUsdMicroUsd)
                      )}
                    </p>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
                      <span>{m.detail.purchases.purchased(purchase.creditsPurchased.toLocaleString(intl), dollars(purchase.fundedCostMicroUsd))}</span>
                      <span>{m.detail.purchases.remaining(purchase.remainingCredits.toLocaleString(intl), dollars(purchase.remainingFundedCostMicroUsd))}</span>
                      <span>{m.detail.purchases.revoked(purchase.revokedCredits.toLocaleString(intl), dollars(purchase.revokedCostMicroUsd))}</span>
                      <span className={purchase.unrecoveredCredits > 0 ? "font-bold text-red-300" : ""}>
                        {m.detail.purchases.unrecovered(purchase.unrecoveredCredits.toLocaleString(intl), dollars(purchase.unrecoveredCostMicroUsd))}
                      </span>
                    </div>
                    <div className="mt-3">
                      <AdminTechInfo>
                        <p className="break-all">
                          {m.detail.purchases.stripeIds(
                            purchase.stripePaymentIntentId || "-",
                            purchase.stripeChargeId || "-",
                            purchase.stripeDisputeId || "-",
                            purchase.disputeStatus ? `(${purchase.disputeStatus})` : ""
                          )}
                        </p>
                      </AdminTechInfo>
                    </div>
                    {purchase.status === "paid" || purchase.status === "partially_refunded" ? (
                      <details className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
                        <summary className="cursor-pointer font-bold text-red-200">{m.detail.purchases.refundSummary}</summary>
                        <p className="mt-2 text-zinc-500">{m.detail.purchases.refundExplainer}</p>
                        <div className="mt-3 grid gap-2 md:grid-cols-[1fr_14rem_auto] md:items-end">
                          <input
                            value={creditRefundReasons[purchase.id] || ""}
                            onChange={(event) =>
                              setCreditRefundReasons((current) => ({ ...current, [purchase.id]: event.target.value }))
                            }
                            placeholder={m.detail.purchases.refundReasonPlaceholder}
                            aria-label={m.detail.purchases.refundReasonPlaceholder}
                            className={fieldClass}
                          />
                          <input
                            value={creditRefundConfirms[purchase.id] || ""}
                            onChange={(event) =>
                              setCreditRefundConfirms((current) => ({ ...current, [purchase.id]: event.target.value }))
                            }
                            placeholder="REFUND CREDIT PURCHASE"
                            aria-label={m.detail.purchases.refundConfirmLabel}
                            className={fieldClass}
                          />
                          <AdminWriteButton
                            variant="danger"
                            writable={access.billing}
                            requiredRole="billing"
                            stepUp
                            onClick={() => void refundCreditPurchase(user.id, purchase)}
                            disabled={
                              busy ||
                              (creditRefundReasons[purchase.id] || "").trim().length < 5 ||
                              creditRefundConfirms[purchase.id] !== "REFUND CREDIT PURCHASE"
                            }
                          >
                            {billingAction === `refund:${purchase.id}` ? m.detail.purchases.refunding : m.detail.purchases.refund}
                          </AdminWriteButton>
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </AdminTile>

          <AdminTile title={m.detail.billingHistory.title}>
            {user.promotionRedemptions.length === 0 && user.refundRequests.length === 0 ? (
              <p className="text-sm text-zinc-500">{m.detail.billingHistory.empty}</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm text-zinc-300">
                {user.promotionRedemptions.map((redemption) => (
                  <li key={redemption.id} className="rounded-xl bg-blue-500/10 px-3 py-2 text-blue-200">
                    {m.detail.billingHistory.promo(
                      redemption.promotion.code,
                      redemption.planId,
                      dateTimeLabel(redemption.redeemedAt, user.usage.timeZone)
                    )}
                  </li>
                ))}
                {user.refundRequests.map((request) => (
                  <li key={request.id} className="rounded-xl bg-amber-500/10 px-3 py-2 text-amber-200">
                    {m.detail.billingHistory.refund(
                      request.status,
                      request.plan || "-",
                      dateTimeLabel(request.requestedAt, user.usage.timeZone)
                    )}
                  </li>
                ))}
              </ul>
            )}
          </AdminTile>

          <AdminTile title={m.detail.adjust.title} description={m.detail.adjust.description}>
            <div className="grid gap-3 md:grid-cols-[10rem_1fr_12rem_auto] md:items-end">
              <select
                value={adjustPlan}
                onChange={(event) => setAdjustPlan(event.target.value as "Free" | "Pro" | "Max")}
                aria-label={m.list.columns.plan}
                className={fieldClass}
              >
                <option value="Free">Free</option>
                <option value="Pro">Pro</option>
                <option value="Max">Max</option>
              </select>
              <input
                value={adjustReason}
                onChange={(event) => setAdjustReason(event.target.value)}
                placeholder={m.detail.adjust.reasonPlaceholder}
                aria-label={m.detail.adjust.reasonPlaceholder}
                className={fieldClass}
              />
              <input
                value={adjustConfirm}
                onChange={(event) => setAdjustConfirm(event.target.value)}
                placeholder="ADJUST PLAN"
                aria-label={m.detail.adjust.confirmLabel}
                className={fieldClass}
              />
              <AdminWriteButton
                variant="primary"
                writable={access.billing}
                requiredRole="billing"
                onClick={() => void adjustUserPlan(user.id)}
                disabled={busy || adjustConfirm !== "ADJUST PLAN" || adjustReason.trim().length < 5}
              >
                {billingAction === "adjust" ? m.detail.adjust.saving : m.detail.adjust.save}
              </AdminWriteButton>
            </div>
          </AdminTile>

          <AdminTile title={m.detail.reservations.title} description={m.detail.reservations.description}>
            {user.chatCreditReservations.length === 0 ? (
              <p className="text-sm text-zinc-500">{m.detail.reservations.empty}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {user.chatCreditReservations.map((reservation) => (
                  <li key={reservation.id} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <AdminStatusChip
                          tone={reservation.status === "reserved" ? "warn" : reservation.status === "settled" ? "ok" : "info"}
                        >
                          {reservation.status}
                        </AdminStatusChip>
                        <strong className="text-white">
                          {reservation.provider} / {reservation.modelId}
                        </strong>
                      </div>
                      <span>{dateTimeLabel(reservation.createdAt, user.usage.timeZone)}</span>
                    </div>
                    <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
                      <span>{m.detail.reservations.credits(reservation.reservedCredits, reservation.settledCredits)}</span>
                      <span>{m.detail.reservations.cost(dollars(reservation.reservedCostMicroUsd, 4), dollars(reservation.settledCostMicroUsd, 4))}</span>
                      <span>{m.detail.reservations.outcome(reservation.outcome || "-")}</span>
                      <span>
                        {reservation.reconciledAt
                          ? m.detail.reservations.autoRefunded(dateTimeLabel(reservation.reconciledAt, user.usage.timeZone))
                          : m.detail.reservations.expires(dateTimeLabel(reservation.expiresAt, user.usage.timeZone))}
                      </span>
                    </div>
                    {reservation.lastError ? <p className="mt-2 text-red-300">{reservation.lastError}</p> : null}
                    <div className="mt-2">
                      <AdminTechInfo>
                        <p className="break-all">
                          {m.detail.reservations.ids(
                            reservation.id,
                            reservation.traceId,
                            reservation.providerRequestId || "-",
                            reservation.providerResponseId || "-"
                          )}
                        </p>
                      </AdminTechInfo>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </AdminTile>

          <AdminTechInfo summary={user.stripeCustomerId || undefined}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt>{m.detail.stripe.customer}</dt>
              <dd className="break-all">{user.stripeCustomerId || "-"}</dd>
              <dt>{m.detail.stripe.subscription}</dt>
              <dd className="break-all">{user.stripeSubscriptionId || "-"}</dd>
              <dt>{m.detail.stripe.price}</dt>
              <dd className="break-all">{user.stripePriceId || "-"}</dd>
            </dl>
          </AdminTechInfo>
        </div>
      ) : null}

      {tab === "security" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <AdminUserSecurityControls
              user={toAdminSecurityUser(user)}
              busy={busy}
              onBusyChange={(next) => setBillingAction(next ? "security" : null)}
              onApplied={() => loadUserDetail(user.id)}
              currentUserId={currentUserId}
              canWrite={access.security}
              canUnlink={access.unlink}
              returnTo={tabHref("security")}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <AdminTile title={m.detail.security.signIns} description={m.detail.security.sessions(user._count.sessions)}>
              {user.accounts.length === 0 ? (
                <p className="text-sm text-zinc-500">{m.detail.security.signInsEmpty}</p>
              ) : (
                <ul className="flex flex-col">
                  {user.accounts.map((account) => (
                    <li
                      key={`${account.provider}-${account.providerAccountId}`}
                      className="flex items-center justify-between gap-2 border-t border-zinc-800 py-2 text-sm first:border-t-0"
                    >
                      <span className="font-medium text-zinc-100">{account.provider}</span>
                      <span className="text-xs text-zinc-500">{account.type}</span>
                    </li>
                  ))}
                </ul>
              )}
            </AdminTile>
            <AdminTile title={m.detail.security.history}>
              {(() => {
                const events = user.timeline.filter((event) => event.type === "audit" || event.type === "login");
                return events.length === 0 ? (
                  <p className="text-sm text-zinc-500">{m.detail.security.historyEmpty}</p>
                ) : (
                  timelineRows(events)
                );
              })()}
            </AdminTile>
          </div>
        </div>
      ) : null}

      {tab === "conversations" ? (
        <AdminTile title={m.detail.conversations.title}>
          {user.recentConversations.length === 0 ? (
            <p className="text-sm text-zinc-500">{m.detail.conversations.empty}</p>
          ) : (
            <ul className="flex flex-col">
              {user.recentConversations.map((conversation) => (
                <li key={conversation.id} className="border-t border-zinc-800 py-3 first:border-t-0 first:pt-0">
                  <p className="break-words text-sm font-bold text-zinc-100">{conversation.title}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {m.detail.conversations.meta(
                      conversation._count.messages,
                      dateTimeLabel(conversation.updatedAt, user.usage.timeZone)
                    )}
                    {conversation.shareEnabled ? m.detail.conversations.shared : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </AdminTile>
      ) : null}

      {tab === "notes" ? (
        <div className="flex flex-col gap-4">
          <AdminNotesBox targetType="User" targetId={user.id} />
          <AdminTile title={m.detail.timeline.title}>
            {user.timeline.length === 0 ? (
              <p className="text-sm text-zinc-500">{m.detail.timeline.empty}</p>
            ) : (
              timelineRows(user.timeline)
            )}
          </AdminTile>
        </div>
      ) : null}
    </div>
  );
}
