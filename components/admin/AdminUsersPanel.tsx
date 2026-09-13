"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Download,
  Loader2,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { describeAdminApiFailure } from "@/lib/adminApiOutcome";
import { adminDateTimeLabel as dateTimeLabel } from "@/lib/adminDateTime";
import { buildPlanAdjustPayload } from "@/lib/adminPlanAdjustCore";
import type {
  AdminUserRow,
  AdminUserSegment,
  AdminUserStats,
} from "@/lib/adminUserTypes";
import { formatBillingMinor, normalizeBillingCurrency } from "@/lib/billingMarkets";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminUsersMessages } from "@/lib/adminMessages/users";
import { AdminNotesBox } from "@/components/admin/AdminNotesBox";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminUserDeleteButton } from "@/components/admin/AdminUserDeleteButton";
import {
  AdminUserSecurityControls,
  toAdminSecurityUser,
} from "@/components/admin/AdminUserSecurityControls";

type Props = {
  rows: AdminUserRow[];
  initialNextCursor: string | null;
  stats: AdminUserStats;
  currentUserId: string;
  conversationCount: number;
  initialDetailUserId?: string;
  detailMode?: "modal" | "page";
  initialSegment?: AdminUserSegment;
  initialQuery?: string;
  initialPageSize?: PageSize;
  initialPageIndex?: number;
  initialPageCursors?: Array<string | null>;
};

type PageSize = 30 | 50;

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
  accounts: Array<{
    provider: string;
    providerAccountId: string;
    type: string;
  }>;
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
    promotion: {
      code: string;
      discountPercent: number;
      discountAmountCents: number | null;
    };
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
  timeline: Array<{
    id: string;
    type: string;
    title: string;
    detail: string;
    at: string;
  }>;
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

const planClass = (plan: string | null | undefined) => {
  if (plan === "Max") return "border-purple-500/30 bg-purple-500/10 text-purple-200";
  if (plan === "Pro") return "border-blue-500/30 bg-blue-500/10 text-blue-200";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
};

export function AdminUsersPanel({
  rows,
  initialNextCursor,
  stats,
  currentUserId,
  conversationCount,
  initialDetailUserId,
  detailMode = "modal",
  initialSegment = "all",
  initialQuery = "",
  initialPageSize = 30,
  initialPageIndex = 0,
  initialPageCursors = [null],
}: Props) {
  const router = useRouter();
  const m = useAdminMessages(adminUsersMessages);
  const { locale: apiLocale } = useAdminLocale();
  const intl = adminIntlLocale(apiLocale);
  const [items, setItems] = useState(rows);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [statsSnapshot, setStatsSnapshot] = useState(stats);
  const [query, setQuery] = useState(initialQuery);
  const [appliedQuery, setAppliedQuery] = useState(initialQuery);
  const [isSearching, setIsSearching] = useState(false);
  const [detailUser, setDetailUser] = useState<AdminUserDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [billingAction, setBillingAction] = useState<string | null>(null);
  const [adjustPlan, setAdjustPlan] = useState<"Free" | "Pro" | "Max">("Free");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustConfirm, setAdjustConfirm] = useState("");
  const [riskReleaseReason, setRiskReleaseReason] = useState("");
  const [riskReleaseConfirm, setRiskReleaseConfirm] = useState("");
  const [creditRefundReasons, setCreditRefundReasons] = useState<Record<string, string>>({});
  const [creditRefundConfirms, setCreditRefundConfirms] = useState<Record<string, string>>({});
  const [segment, setSegment] = useState<AdminUserSegment>(initialSegment);
  const [pageSize, setPageSize] = useState<PageSize>(initialPageSize);
  const [pageIndex, setPageIndex] = useState(initialPageIndex);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>(initialPageCursors);
  const initialDetailLoadedRef = useRef<string | null>(null);

  const title = useMemo(
    () => (appliedQuery ? m.searchResults : m.segments[segment]),
    [appliedQuery, segment, m]
  );

  const fetchUsers = async ({
    requestedSegment = segment,
    requestedQuery = appliedQuery,
    requestedTake = pageSize,
    cursor = pageCursors[pageIndex] || null,
    targetPageIndex = pageIndex,
    cursorHistory = pageCursors,
    refreshStats = false,
  }: {
    requestedSegment?: AdminUserSegment;
    requestedQuery?: string;
    requestedTake?: PageSize;
    cursor?: string | null;
    targetPageIndex?: number;
    cursorHistory?: Array<string | null>;
    refreshStats?: boolean;
  } = {}) => {
    const normalized = requestedQuery.trim();
    setIsSearching(true);
    try {
      const params = new URLSearchParams({
        q: normalized,
        segment: requestedSegment,
        take: String(requestedTake),
      });
      if (cursor) params.set("cursor", cursor);
      if (refreshStats) params.set("includeStats", "1");
      const response = await fetch(`/api/admin/users?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | {
            users?: AdminUserRow[];
            nextCursor?: string | null;
            stats?: AdminUserStats;
            error?: string;
          }
        | null;
      if (!response.ok || !data?.users) {
        throw new Error(data?.error || m.toast.searchFailed);
      }
      setItems(data.users);
      setNextCursor(data.nextCursor || null);
      setAppliedQuery(normalized);
      setSegment(requestedSegment);
      setPageSize(requestedTake);
      setPageIndex(targetPageIndex);
      setPageCursors(cursorHistory);
      if (data.stats) setStatsSnapshot(data.stats);
      if (detailMode !== "page") {
        const url = new URLSearchParams();
        if (normalized) url.set("q", normalized);
        if (requestedSegment !== "all") url.set("segment", requestedSegment);
        if (requestedTake !== 30) url.set("take", String(requestedTake));
        if (cursor) url.set("cursor", cursor);
        if (targetPageIndex > 0) url.set("page", String(targetPageIndex + 1));
        const serializedCursors = cursorHistory.map((value) => value || "_").join(",");
        if (serializedCursors !== "_") url.set("cursors", serializedCursors);
        router.replace(`/admin/users${url.size ? `?${url.toString()}` : ""}`, { scroll: false });
      }
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.searchFailed,
        "error"
      );
    } finally {
      setIsSearching(false);
    }
  };

  const selectSegment = (nextSegment: AdminUserSegment) => {
    setQuery("");
    void fetchUsers({
      requestedSegment: nextSegment,
      requestedQuery: "",
      cursor: null,
      targetPageIndex: 0,
      cursorHistory: [null],
    });
  };

  const searchUsers = () =>
    fetchUsers({
      requestedQuery: query,
      cursor: null,
      targetPageIndex: 0,
      cursorHistory: [null],
    });

  const showNextPage = () => {
    if (!nextCursor || isSearching) return;
    const targetPageIndex = pageIndex + 1;
    void fetchUsers({
      cursor: nextCursor,
      targetPageIndex,
      cursorHistory: [
        ...pageCursors.slice(0, targetPageIndex),
        nextCursor,
      ],
    });
  };

  const showPreviousPage = () => {
    if (pageIndex === 0 || isSearching) return;
    const targetPageIndex = pageIndex - 1;
    const cursorHistory = pageCursors.slice(0, targetPageIndex + 1);
    void fetchUsers({
      cursor: cursorHistory[targetPageIndex] || null,
      targetPageIndex,
      cursorHistory,
    });
  };

  const changePageSize = (nextPageSize: PageSize) => {
    if (nextPageSize === pageSize || isSearching) return;
    void fetchUsers({
      requestedTake: nextPageSize,
      cursor: null,
      targetPageIndex: 0,
      cursorHistory: [null],
    });
  };

  const loadUserDetail = useCallback(async (userId: string) => {
    setDetailError("");
    setLoadingDetailId(userId);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
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
      const message =
        error instanceof Error ? error.message : m.toast.detailFailed;
      setDetailError(message);
      dispatchAppToast(message, "error");
    } finally {
      setLoadingDetailId(null);
    }
  }, [m.toast.detailFailed]);

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
      `Credit debt: ${user.creditDebtCredits} credits / $${(user.creditDebtCostMicroUsd / 1_000_000).toFixed(2)} funded cost`,
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

  const resyncBilling = async (userId: string) => {
    if (billingAction) return;
    setBillingAction("resync");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/billing-resync`, {
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

  const adjustUserPlan = async (userId: string) => {
    if (billingAction) return;
    setBillingAction("adjust");
    try {
      // Carries no clock-derived value on purpose: a second administrator
      // approves this exact payload, and the requester then has to re-send it
      // byte-for-byte. See buildPlanAdjustPayload.
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/plan-adjust`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildPlanAdjustPayload({
            plan: adjustPlan,
            reason: adjustReason,
            confirmText: adjustConfirm,
          })
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
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.adjustFailed,
        "error"
      );
    } finally {
      setBillingAction(null);
    }
  };

  const releaseBillingHold = async (userId: string) => {
    if (billingAction) return;
    setBillingAction("risk");
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/billing-risk`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "release_hold",
            reason: riskReleaseReason,
            confirmText: riskReleaseConfirm,
          }),
        }
      );
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

  const refundCreditPurchase = async (
    userId: string,
    purchase: AdminUserDetail["creditPurchases"][number]
  ) => {
    if (billingAction) return;
    setBillingAction(`refund:${purchase.id}`);
    try {
      const response = await fetch(
        `/api/admin/credit-purchases/${encodeURIComponent(purchase.id)}/refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: creditRefundReasons[purchase.id] || "",
            confirmReviewed: true,
            confirmText: creditRefundConfirms[purchase.id] || "",
            expectedRemainingCredits: purchase.remainingCredits,
            expectedRemainingFundedCostMicroUsd:
              purchase.remainingFundedCostMicroUsd,
          }),
        }
      );
      const data = (await response.json().catch(() => null)) as
        | {
            success?: boolean;
            error?: string;
            code?: string;
            approvalId?: string;
            stripeRefundId?: string;
          }
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
        return;
      }
      setCreditRefundReasons((current) => ({ ...current, [purchase.id]: "" }));
      setCreditRefundConfirms((current) => ({ ...current, [purchase.id]: "" }));
      await loadUserDetail(userId);
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

  useEffect(() => {
    if (!initialDetailUserId || initialDetailLoadedRef.current === initialDetailUserId) return;
    initialDetailLoadedRef.current = initialDetailUserId;
    void loadUserDetail(initialDetailUserId);
  }, [initialDetailUserId, loadUserDetail]);

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-4 sm:p-5">
      {detailMode !== "page" ? (
      <>
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
              {m.overview.eyebrow}
            </p>
            <h2 className="mt-2 text-xl font-black text-white">{m.overview.title}</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>{m.overview.lastAggregated(dateTimeLabel(statsSnapshot.generatedAt))}</span>
            <button
              type="button"
              onClick={() =>
                void fetchUsers({
                  requestedSegment: segment,
                  requestedQuery: appliedQuery,
                  refreshStats: true,
                })
              }
              disabled={isSearching}
              className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-zinc-800 text-zinc-300 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={m.overview.refresh}
            >
              <RefreshCw className={`h-4 w-4 ${isSearching ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {([
            { segment: "all", ...m.overview.cards.all, value: statsSnapshot.totalAccounts },
            { segment: "free", ...m.overview.cards.free, value: statsSnapshot.freeUsers },
            { segment: "pro", ...m.overview.cards.pro, value: statsSnapshot.proUsers },
            { segment: "max", ...m.overview.cards.max, value: statsSnapshot.maxUsers },
            { segment: "activePaid", ...m.overview.cards.activePaid, value: statsSnapshot.activePaidSubscriptions },
            { segment: "testerPass", ...m.overview.cards.testerPass, value: statsSnapshot.testerPassUsers },
            { segment: "canceling", ...m.overview.cards.canceling, value: statsSnapshot.cancelingSubscriptions },
            { segment: "billingRisk", ...m.overview.cards.billingRisk, value: statsSnapshot.billingRiskUsers },
          ] satisfies Array<{
            segment: AdminUserSegment;
            label: string;
            value: number;
            detail: string;
          }>).map((card) => (
            <button
              key={card.segment}
              type="button"
              onClick={() => selectSegment(card.segment)}
              aria-pressed={segment === card.segment}
              className={`cursor-pointer rounded-2xl border p-3 text-left transition sm:p-4 ${
                segment === card.segment
                  ? "border-blue-500/50 bg-blue-500/15"
                  : "border-zinc-800 bg-zinc-900/70 hover:border-zinc-700 hover:bg-zinc-900"
              }`}
            >
              <span className="block text-xs font-bold text-zinc-400">{card.label}</span>
              <span className="mt-2 block text-2xl font-black text-white">{card.value.toLocaleString(intl)}</span>
              <span className="mt-1 block text-[11px] leading-4 text-zinc-500">{card.detail}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <span className="text-xs text-zinc-500">{m.overview.newAccounts7d}</span>
            <strong className="ml-2 text-sm text-white">{statsSnapshot.newUsers7d.toLocaleString(intl)}</strong>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <span className="text-xs text-zinc-500">{m.overview.newAccounts30d}</span>
            <strong className="ml-2 text-sm text-white">{statsSnapshot.newUsers30d.toLocaleString(intl)}</strong>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <span className="text-xs text-zinc-500">{m.overview.paidConversion}</span>
            <strong className="ml-2 text-sm text-white">{statsSnapshot.paidConversionRatePercent.toFixed(2)}%</strong>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            {m.list.eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            {m.list.description(conversationCount)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/admin/users/export?q=${encodeURIComponent(appliedQuery)}&segment=${encodeURIComponent(segment)}`}
            download
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-900"
          >
            <Download className="h-3.5 w-3.5" />
            {m.list.exportCurrent}
          </a>
          <a
            href="/api/admin/users/export?q=&segment=all"
            download
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-100 transition hover:bg-blue-500/20"
          >
            <Download className="h-3.5 w-3.5" />
            {m.list.exportAll}
          </a>
        </div>
      </div>

      <form
        className="mt-5 grid gap-3 md:grid-cols-[1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void searchUsers();
        }}
      >
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={m.list.searchPlaceholder}
            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <button
          type="submit"
          disabled={isSearching}
          className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {m.list.search}
        </button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 font-bold text-zinc-300">
          {m.list.pageSummary(pageIndex + 1, items.length)}
        </span>
        <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 font-bold text-blue-200">
          {m.list.segment(m.segments[segment])}
        </span>
        {appliedQuery ? (
          <span className="max-w-full truncate rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-zinc-400">
            {m.list.searchChip(appliedQuery)}
          </span>
        ) : null}
        <label className="ml-auto inline-flex items-center gap-2 text-zinc-400">
          <span>{m.list.rowsPerPage}</span>
          <select
            value={pageSize}
            onChange={(event) =>
              changePageSize(Number(event.target.value) as PageSize)
            }
            disabled={isSearching}
            className="h-8 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 px-2 font-bold text-zinc-100 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={m.list.rowsPerPage}
          >
            <option value={30}>30</option>
            <option value={50}>50</option>
          </select>
        </label>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.16em] text-zinc-500">
            <tr>
              <th className="px-3 py-2">{m.list.columns.user}</th>
              <th className="px-3 py-2">{m.list.columns.plan}</th>
              <th className="px-3 py-2">{m.list.columns.subscription}</th>
              <th className="px-3 py-2">{m.list.columns.today}</th>
              <th className="px-3 py-2">{m.list.columns.data}</th>
              <th className="px-3 py-2">{m.list.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id} className="rounded-2xl bg-zinc-900/70 text-zinc-200">
                <td className="rounded-l-2xl px-3 py-3">
                  <div className="font-bold text-zinc-100">
                    {user.name || m.list.nameNotProvided}
                  </div>
                  <Link
                    href={`/admin/users/${encodeURIComponent(user.id)}`}
                    className="mt-1 inline-flex cursor-pointer items-center gap-1.5 text-left text-xs font-bold text-blue-300 underline-offset-4 transition hover:text-blue-200 hover:underline"
                    aria-label={m.list.viewDetailsFor(user.email || user.name || m.list.userFallback)}
                  >
                    {user.email || m.list.noEmailViewDetails}
                  </Link>
                </td>
                <td className="px-3 py-3">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${planClass(user.plan)}`}>
                    {user.plan || "Free"}
                  </span>
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <div>{user.subscriptionStatus || m.list.subscriptionNone}</div>
                  <div>{user.subscriptionBillingInterval || "-"}</div>
                  <div>{dateTimeLabel(user.subscriptionCurrentPeriodEnd, user.timeZone)}</div>
                  {user.subscriptionCancelAtPeriodEnd ? (
                    <div className="mt-1 text-amber-300">{m.list.cancelsAtPeriodEnd}</div>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <div>
                    <span className="font-bold text-zinc-200">{user.messagesToday.toLocaleString(intl)}</span>
                    <span className="ml-1">{m.list.messages}</span>
                  </div>
                  <div className="mt-1">
                    <span className="font-bold text-amber-200">{user.creditsToday.toLocaleString(intl)}</span>
                    <span className="ml-1">{m.list.planCredits}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">{user.timeZone}</div>
                  {(user.creditDebtCredits || 0) > 0 ? (
                    <div className="mt-1 font-bold text-red-300">
                      {m.list.debtCredits((user.creditDebtCredits ?? 0).toLocaleString(intl))}
                    </div>
                  ) : null}
                  {user.billingRiskStatus === "disputed_hold" ? (
                    <div className="mt-1 font-black text-red-300">{m.list.aiAccessHeld}</div>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <div>{m.list.conversations(user._count.conversations)}</div>
                  <div>{m.list.linkedAccounts(user._count.accounts)}</div>
                  <div>{m.list.refundRequests(user._count.refundRequests || 0)}</div>
                  <div>{m.list.promoRedemptions(user._count.promotionRedemptions || 0)}</div>
                </td>
                <td className="rounded-r-2xl px-3 py-3">
                  <div className="flex flex-wrap gap-2">
                    <AdminUserDeleteButton
                      userId={user.id}
                      currentUserId={currentUserId}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            {m.list.empty}
          </div>
        ) : null}
      </div>

      <nav
        className="mt-4 flex flex-wrap items-center justify-center gap-3"
        aria-label={m.list.pagination}
      >
        <button
          type="button"
          onClick={showPreviousPage}
          disabled={pageIndex === 0 || isSearching}
          className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-bold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
          {m.list.previous}
        </button>
        <span className="min-w-24 text-center text-sm font-bold text-zinc-400">
          {isSearching ? (
            <Loader2 className="mx-auto h-4 w-4 animate-spin" />
          ) : (
            m.list.page(pageIndex + 1)
          )}
        </span>
        <button
          type="button"
          onClick={showNextPage}
          disabled={!nextCursor || isSearching}
          className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-bold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {m.list.next}
          <ChevronRight className="h-4 w-4" />
        </button>
      </nav>

      </>
      ) : loadingDetailId ? (
        <div className="flex min-h-80 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/50 text-sm text-zinc-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> {m.detail.loading}
        </div>
      ) : null}

      {detailUser ? (
        <div className={detailMode === "page" ? "relative" : "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"}>
          <div className={detailMode === "page" ? "w-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950" : "max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black"}>
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
                  {m.detail.eyebrow}
                </p>
                <h3 className="mt-2 text-2xl font-black text-white">
                  {detailUser.name || m.list.nameNotProvided}
                </h3>
                <p className="mt-1 text-sm font-medium text-zinc-400">
                  {detailUser.email || m.detail.noEmail}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => copyUserContext(detailUser)}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 hover:bg-zinc-800"
                >
                  <Clipboard className="h-3.5 w-3.5" />
                  {m.detail.copy}
                </button>
                <button
                  type="button"
                  onClick={() => detailMode === "page" ? router.push("/admin/users") : setDetailUser(null)}
                  className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  aria-label={m.detail.close}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid gap-4 p-5 lg:grid-cols-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                  {m.detail.plan}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${planClass(detailUser.plan)}`}>
                    {detailUser.plan}
                  </span>
                  {detailUser.subscriptionCancelAtPeriodEnd ? (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-200">
                      {m.list.cancelsAtPeriodEnd}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 space-y-1 text-xs text-zinc-400">
                  <div>{m.detail.status(detailUser.subscriptionStatus || "-")}</div>
                  <div>{m.detail.billing(detailUser.subscriptionBillingInterval || "-")}</div>
                  <div>{m.detail.periodEnd(dateTimeLabel(detailUser.subscriptionCurrentPeriodEnd, detailUser.usage.timeZone))}</div>
                </div>
                <button
                  type="button"
                  onClick={() => resyncBilling(detailUser.id)}
                  disabled={Boolean(billingAction)}
                  className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-100 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {billingAction === "resync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {m.detail.resyncStripe}
                </button>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                  {m.detail.usage}
                </p>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <div>
                    <div data-testid="admin-user-detail-messages-today" className="text-2xl font-black text-white">{detailUser.usage.messagesToday}</div>
                    <div className="text-xs text-zinc-500">{m.detail.messagesToday}</div>
                  </div>
                  <div>
                    <div data-testid="admin-user-detail-credits-today" className="text-2xl font-black text-amber-200">{detailUser.usage.creditsToday}</div>
                    <div className="text-xs text-zinc-500">{m.detail.planCreditsToday}</div>
                  </div>
                  <div>
                    <div data-testid="admin-user-detail-credits-month" className="text-2xl font-black text-white">{detailUser.usage.creditsMonth}</div>
                    <div className="text-xs text-zinc-500">{m.detail.planCreditsMonth}</div>
                  </div>
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                  {m.detail.dailyWindow(detailUser.usage.timeZone, dateTimeLabel(detailUser.usage.dayEnd, detailUser.usage.timeZone))}
                </p>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                  Stripe
                </p>
                <div className="mt-3 space-y-1 text-xs text-zinc-400">
                  <div className="truncate">{m.detail.stripeCustomer(detailUser.stripeCustomerId || "-")}</div>
                  <div className="truncate">{m.detail.stripeSubscription(detailUser.stripeSubscriptionId || "-")}</div>
                  <div className="truncate">{m.detail.stripePrice(detailUser.stripePriceId || "-")}</div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 px-5 pb-5 lg:grid-cols-2">
              <AdminUserSecurityControls
                user={toAdminSecurityUser(detailUser)}
                busy={Boolean(billingAction)}
                onBusyChange={(busy) => setBillingAction(busy ? "security" : null)}
                onApplied={() => loadUserDetail(detailUser.id)}
              />

              <section className={`rounded-2xl border p-4 lg:col-span-2 ${
                detailUser.billingRiskStatus === "disputed_hold" || detailUser.creditDebtCredits > 0
                  ? "border-red-500/30 bg-red-500/10"
                  : "border-zinc-800 bg-zinc-900/60"
              }`}>
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h4 className="font-black text-white">{m.detail.risk.title}</h4>
                    <p className="mt-1 text-sm text-zinc-400">
                      {m.detail.risk.statusLabel}<strong className={detailUser.billingRiskStatus === "disputed_hold" ? "text-red-300" : "text-emerald-300"}>{detailUser.billingRiskStatus}</strong>
                    </p>
                    {detailUser.billingRiskReason ? <p className="mt-1 text-xs text-red-200">{detailUser.billingRiskReason}</p> : null}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-right">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-zinc-500">{m.detail.risk.unrecovered}</p>
                      <p className="mt-1 text-xl font-black text-white">{m.detail.risk.credits(detailUser.creditDebtCredits.toLocaleString(intl))}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-zinc-500">{m.detail.risk.fundedCost}</p>
                      <p className="mt-1 text-xl font-black text-white">${(detailUser.creditDebtCostMicroUsd / 1_000_000).toFixed(2)}</p>
                    </div>
                  </div>
                </div>
                {detailUser.billingRiskStatus === "disputed_hold" ? (
                  <div className="mt-4 grid gap-3 md:grid-cols-[1fr_13rem_auto]">
                    <input
                      value={riskReleaseReason}
                      onChange={(event) => setRiskReleaseReason(event.target.value)}
                      placeholder={m.detail.risk.reasonPlaceholder}
                      className="h-11 rounded-xl border border-red-500/30 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-red-400"
                    />
                    <input
                      value={riskReleaseConfirm}
                      onChange={(event) => setRiskReleaseConfirm(event.target.value)}
                      placeholder="RELEASE BILLING HOLD"
                      className="h-11 rounded-xl border border-red-500/30 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-red-400"
                    />
                    <button
                      type="button"
                      onClick={() => releaseBillingHold(detailUser.id)}
                      disabled={Boolean(billingAction) || riskReleaseReason.trim().length < 5 || riskReleaseConfirm !== "RELEASE BILLING HOLD"}
                      className="rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {billingAction === "risk" ? m.detail.risk.releasing : m.detail.risk.release}
                    </button>
                  </div>
                ) : null}
                <p className="mt-3 text-xs text-zinc-500">
                  {m.detail.risk.note}
                </p>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">{m.detail.purchases.title}</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.creditPurchases.length === 0 ? (
                    <p className="text-sm text-zinc-500">{m.detail.purchases.empty}</p>
                  ) : detailUser.creditPurchases.map((purchase) => (
                    <div key={purchase.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-black text-white">{purchase.packId} / {purchase.status}</p>
                        <p>{dateTimeLabel(purchase.purchasedAt, detailUser.usage.timeZone)}</p>
                      </div>
                      <p className="mt-2 font-bold text-zinc-200">
                        {m.detail.purchases.paid(
                          formatBillingMinor(
                            purchase.amountPaidCents,
                            normalizeBillingCurrency(purchase.currency) || "USD",
                            "en"
                          ),
                          (purchase.amountPaidUsdMicroUsd / 1_000_000).toFixed(2)
                        )}
                      </p>
                      <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
                        <span>{m.detail.purchases.purchased(purchase.creditsPurchased.toLocaleString(intl), (purchase.fundedCostMicroUsd / 1_000_000).toFixed(2))}</span>
                        <span>{m.detail.purchases.remaining(purchase.remainingCredits.toLocaleString(intl), (purchase.remainingFundedCostMicroUsd / 1_000_000).toFixed(2))}</span>
                        <span>{m.detail.purchases.revoked(purchase.revokedCredits.toLocaleString(intl), (purchase.revokedCostMicroUsd / 1_000_000).toFixed(2))}</span>
                        <span className={purchase.unrecoveredCredits > 0 ? "font-black text-red-300" : ""}>{m.detail.purchases.unrecovered(purchase.unrecoveredCredits.toLocaleString(intl), (purchase.unrecoveredCostMicroUsd / 1_000_000).toFixed(2))}</span>
                      </div>
                      <div className="mt-2 break-all text-zinc-600">
                        {m.detail.purchases.stripeIds(
                          purchase.stripePaymentIntentId || "-",
                          purchase.stripeChargeId || "-",
                          purchase.stripeDisputeId || "-",
                          purchase.disputeStatus ? `(${purchase.disputeStatus})` : ""
                        )}
                      </div>
                      {(purchase.status === "paid" || purchase.status === "partially_refunded") ? (
                        <details className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3">
                          <summary className="cursor-pointer font-black text-red-200">
                            {m.detail.purchases.refundSummary}
                          </summary>
                          <p className="mt-2 text-zinc-500">
                            {m.detail.purchases.refundExplainer}
                          </p>
                          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_14rem_auto]">
                            <input
                              value={creditRefundReasons[purchase.id] || ""}
                              onChange={(event) => setCreditRefundReasons((current) => ({ ...current, [purchase.id]: event.target.value }))}
                              placeholder={m.detail.purchases.refundReasonPlaceholder}
                              className="h-10 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-white outline-none focus:border-red-400"
                            />
                            <input
                              value={creditRefundConfirms[purchase.id] || ""}
                              onChange={(event) => setCreditRefundConfirms((current) => ({ ...current, [purchase.id]: event.target.value }))}
                              placeholder="REFUND CREDIT PURCHASE"
                              className="h-10 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-white outline-none focus:border-red-400"
                            />
                            <button
                              type="button"
                              onClick={() => refundCreditPurchase(detailUser.id, purchase)}
                              disabled={Boolean(billingAction) || (creditRefundReasons[purchase.id] || "").trim().length < 5 || creditRefundConfirms[purchase.id] !== "REFUND CREDIT PURCHASE"}
                              className="rounded-lg bg-red-600 px-3 py-2 font-black text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {billingAction === `refund:${purchase.id}` ? m.detail.purchases.refunding : m.detail.purchases.refund}
                            </button>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">{m.detail.reservations.title}</h4>
                <p className="mt-1 text-xs text-zinc-500">
                  {m.detail.reservations.description}
                </p>
                <div className="mt-3 grid gap-2">
                  {detailUser.chatCreditReservations.length === 0 ? (
                    <p className="text-sm text-zinc-500">{m.detail.reservations.empty}</p>
                  ) : detailUser.chatCreditReservations.map((reservation) => (
                    <div key={reservation.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 font-black ${
                            reservation.status === "reserved"
                              ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                              : reservation.status === "settled"
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                : "border-blue-500/30 bg-blue-500/10 text-blue-200"
                          }`}>{reservation.status}</span>
                          <strong className="text-white">{reservation.provider} / {reservation.modelId}</strong>
                          <span>{reservation.source}</span>
                        </div>
                        <span>{dateTimeLabel(reservation.createdAt, detailUser.usage.timeZone)}</span>
                      </div>
                      <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
                        <span>{m.detail.reservations.credits(reservation.reservedCredits, reservation.settledCredits)}</span>
                        <span>{m.detail.reservations.cost((reservation.reservedCostMicroUsd / 1_000_000).toFixed(4), (reservation.settledCostMicroUsd / 1_000_000).toFixed(4))}</span>
                        <span>{m.detail.reservations.outcome(reservation.outcome || "-")}</span>
                        <span>{reservation.reconciledAt ? m.detail.reservations.autoRefunded(dateTimeLabel(reservation.reconciledAt, detailUser.usage.timeZone)) : m.detail.reservations.expires(dateTimeLabel(reservation.expiresAt, detailUser.usage.timeZone))}</span>
                      </div>
                      <div className="mt-2 break-all text-zinc-600">
                        {m.detail.reservations.ids(reservation.id, reservation.traceId, reservation.providerRequestId || "-", reservation.providerResponseId || "-")}
                      </div>
                      {reservation.lastError ? <p className="mt-2 text-red-300">{reservation.lastError}</p> : null}
                    </div>
                  ))}
                </div>
              </section>

              <div className="lg:col-span-2">
                <AdminNotesBox targetType="User" targetId={detailUser.id} />
              </div>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <h4 className="font-black text-white">{m.detail.linkedAccounts.title}</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.accounts.length === 0 ? (
                    <p className="text-sm text-zinc-500">{m.detail.linkedAccounts.empty}</p>
                  ) : (
                    detailUser.accounts.map((account) => (
                      <div key={`${account.provider}-${account.providerAccountId}`} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
                        <span className="font-bold text-zinc-200">{account.provider}</span>
                        <span className="ml-2">{account.type}</span>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <h4 className="font-black text-white">{m.detail.settings.title}</h4>
                <div className="mt-3 grid gap-2 text-xs text-zinc-400">
                  <div>{m.detail.settings.language(detailUser.settings?.language || "-")}</div>
                  <div>{m.detail.settings.theme(detailUser.settings?.theme || "-")}</div>
                  <div>{m.detail.settings.defaultModel(detailUser.settings?.defaultModel || "-")}</div>
                  <div>{m.detail.settings.timeZone(detailUser.usage.timeZone)}</div>
                  <div>{m.detail.settings.sessions(detailUser._count.sessions)}</div>
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <h4 className="font-black text-white">{m.detail.conversations.title}</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.recentConversations.length === 0 ? (
                    <p className="text-sm text-zinc-500">{m.detail.conversations.empty}</p>
                  ) : (
                    detailUser.recentConversations.map((conversation) => (
                      <div key={conversation.id} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
                        <div className="font-bold text-zinc-200">{conversation.title}</div>
                        <div className="mt-1">
                          {m.detail.conversations.meta(conversation._count.messages, dateTimeLabel(conversation.updatedAt, detailUser.usage.timeZone))}
                          {conversation.shareEnabled ? m.detail.conversations.shared : ""}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <h4 className="font-black text-white">{m.detail.billingHistory.title}</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.promotionRedemptions.map((redemption) => (
                    <div key={redemption.id} className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
                      {m.detail.billingHistory.promo(redemption.promotion.code, redemption.planId, dateTimeLabel(redemption.redeemedAt, detailUser.usage.timeZone))}
                    </div>
                  ))}
                  {detailUser.refundRequests.map((request) => (
                    <div key={request.id} className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                      {m.detail.billingHistory.refund(request.status, request.plan || "-", dateTimeLabel(request.requestedAt, detailUser.usage.timeZone))}
                    </div>
                  ))}
                  {detailUser.promotionRedemptions.length === 0 && detailUser.refundRequests.length === 0 ? (
                    <p className="text-sm text-zinc-500">{m.detail.billingHistory.empty}</p>
                  ) : null}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">{m.detail.adjust.title}</h4>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  {m.detail.adjust.description}
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-[10rem_1fr_10rem_auto]">
                  <select
                    value={adjustPlan}
                    onChange={(event) =>
                      setAdjustPlan(event.target.value as "Free" | "Pro" | "Max")
                    }
                    className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm font-bold text-white outline-none focus:border-blue-500"
                  >
                    <option value="Free">Free</option>
                    <option value="Pro">Pro</option>
                    <option value="Max">Max</option>
                  </select>
                  <input
                    value={adjustReason}
                    onChange={(event) => setAdjustReason(event.target.value)}
                    placeholder={m.detail.adjust.reasonPlaceholder}
                    className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                  />
                  <input
                    value={adjustConfirm}
                    onChange={(event) => setAdjustConfirm(event.target.value)}
                    placeholder="ADJUST PLAN"
                    className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => adjustUserPlan(detailUser.id)}
                    disabled={Boolean(billingAction) || adjustConfirm !== "ADJUST PLAN" || adjustReason.trim().length < 5}
                    className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-amber-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {billingAction === "adjust" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {m.detail.adjust.save}
                  </button>
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">{m.detail.timeline.title}</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.timeline.length === 0 ? (
                    <p className="text-sm text-zinc-500">{m.detail.timeline.empty}</p>
                  ) : (
                    detailUser.timeline.map((event) => (
                      <div key={`${event.type}-${event.id}`} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 font-black text-blue-200">
                            {event.type}
                          </span>
                          <span className="font-black text-zinc-200">{event.title}</span>
                          <span className="text-zinc-600">{dateTimeLabel(event.at, detailUser.usage.timeZone)}</span>
                        </div>
                        {event.detail ? <p className="mt-1 text-zinc-500">{event.detail}</p> : null}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {detailError ? (
        <p className="mt-3 text-xs text-red-300">{detailError}</p>
      ) : null}
    </section>
  );
}
