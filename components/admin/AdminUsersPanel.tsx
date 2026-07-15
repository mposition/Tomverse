"use client";

import { useMemo, useState } from "react";
import { Clipboard, Download, Loader2, RefreshCw, Save, Search, X } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { AdminNotesBox } from "@/components/admin/AdminNotesBox";
import { AdminUserDeleteButton } from "@/components/admin/AdminUserDeleteButton";

export type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  plan: string | null;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  subscriptionBillingInterval: string | null;
  subscriptionCancelAtPeriodEnd?: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId?: string | null;
  usageToday?: number;
  creditDebtCredits?: number;
  creditDebtCostMicroUsd?: number;
  billingRiskStatus?: string;
  _count: {
    conversations: number;
    accounts: number;
    refundRequests?: number;
    promotionRedemptions?: number;
  };
};

type Props = {
  rows: AdminUserRow[];
  currentUserId: string;
  paidUserCount: number;
  conversationCount: number;
};

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
  settings: {
    language: string;
    theme: string;
    defaultModel: string;
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
    today: number;
    month: number;
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

const dateTimeLabel = (value: string | null | undefined) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

export function AdminUsersPanel({
  rows,
  currentUserId,
  paidUserCount,
  conversationCount,
}: Props) {
  const [items, setItems] = useState(rows);
  const [query, setQuery] = useState("");
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
  const [segment, setSegment] = useState<
    "all" | "paid" | "free" | "canceling" | "refund" | "promo" | "highUsage" | "billingRisk"
  >("all");

  const title = useMemo(
    () => (query.trim() ? "Search results" : "Recent accounts"),
    [query]
  );

  const filteredItems = useMemo(() => {
    return items.filter((user) => {
      if (segment === "paid") return user.plan === "Pro" || user.plan === "Max";
      if (segment === "free") return !user.plan || user.plan === "Free";
      if (segment === "canceling") return Boolean(user.subscriptionCancelAtPeriodEnd);
      if (segment === "refund") return Boolean(user._count.refundRequests);
      if (segment === "promo") return Boolean(user._count.promotionRedemptions);
      if (segment === "highUsage") return (user.usageToday || 0) >= 50;
      if (segment === "billingRisk") {
        return user.billingRiskStatus === "disputed_hold" || (user.creditDebtCredits || 0) > 0;
      }
      return true;
    });
  }, [items, segment]);

  const searchUsers = async () => {
    const normalized = query.trim();
    setIsSearching(true);
    try {
      const response = await fetch(
        `/api/admin/users?q=${encodeURIComponent(normalized)}&take=30`,
        { cache: "no-store" }
      );
      const data = (await response.json().catch(() => null)) as
        | { users?: AdminUserRow[]; error?: string }
        | null;
      if (!response.ok || !data?.users) {
        throw new Error(data?.error || "Failed to search users.");
      }
      setItems(data.users);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Failed to search users.",
        "error"
      );
    } finally {
      setIsSearching(false);
    }
  };

  const loadUserDetail = async (userId: string) => {
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
        throw new Error(data?.error || "Failed to load user detail.");
      }
      setDetailUser(data.user);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load user detail.";
      setDetailError(message);
      dispatchAppToast(message, "error");
    } finally {
      setLoadingDetailId(null);
    }
  };

  const copyUserContext = async (user: AdminUserDetail) => {
    const text = [
      "Tomverse User Context",
      `User: ${user.email || user.name || user.id}`,
      `ID: ${user.id}`,
      `Plan: ${user.plan}`,
      `Subscription: ${user.subscriptionStatus || "-"}`,
      `Billing: ${user.subscriptionBillingInterval || "-"}`,
      `Period end: ${dateTimeLabel(user.subscriptionCurrentPeriodEnd)}`,
      `Usage: ${user.usage.today} today / ${user.usage.month} month`,
      `Credit debt: ${user.creditDebtCredits} credits / $${(user.creditDebtCostMicroUsd / 1_000_000).toFixed(2)} funded cost`,
      `Billing risk: ${user.billingRiskStatus}`,
      `Stripe customer: ${user.stripeCustomerId || "-"}`,
      `Stripe subscription: ${user.stripeSubscriptionId || "-"}`,
      `Linked accounts: ${user.accounts.map((account) => account.provider).join(", ") || "-"}`,
      `Conversations: ${user._count.conversations}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      dispatchAppToast("User context copied.", "success");
    } catch {
      dispatchAppToast("Could not copy user context.", "error");
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
        | { user?: Partial<AdminUserDetail>; error?: string }
        | null;
      if (!response.ok || !data?.user) {
        throw new Error(data?.error || "Stripe resync failed.");
      }
      setDetailUser((current) => (current ? { ...current, ...data.user } : current));
      dispatchAppToast("Stripe billing resynced.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Stripe resync failed.",
        "error"
      );
    } finally {
      setBillingAction(null);
    }
  };

  const adjustUserPlan = async (userId: string) => {
    if (billingAction) return;
    setBillingAction("adjust");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/plan-adjust`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: adjustPlan,
          reason: adjustReason,
          confirmText: adjustConfirm,
          subscriptionStatus: "manually_adjusted",
          billingInterval: adjustPlan === "Free" ? null : "monthly",
          periodEnd:
            adjustPlan === "Free"
              ? null
              : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { user?: Partial<AdminUserDetail>; error?: string }
        | null;
      if (!response.ok || !data?.user) {
        throw new Error(data?.error || "Plan adjustment failed.");
      }
      setDetailUser((current) => (current ? { ...current, ...data.user } : current));
      setAdjustReason("");
      setAdjustConfirm("");
      dispatchAppToast("User plan adjusted.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Plan adjustment failed.",
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
        | { user?: Partial<AdminUserDetail>; error?: string }
        | null;
      if (!response.ok || !data?.user) {
        throw new Error(data?.error || "Billing hold release failed.");
      }
      setDetailUser((current) => (current ? { ...current, ...data.user } : current));
      setRiskReleaseReason("");
      setRiskReleaseConfirm("");
      dispatchAppToast("Billing dispute hold released. Credit debt remains enforceable.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Billing hold release failed.",
        "error"
      );
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
        | { success?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Credit purchase refund failed.");
      }
      setCreditRefundReasons((current) => ({ ...current, [purchase.id]: "" }));
      setCreditRefundConfirms((current) => ({ ...current, [purchase.id]: "" }));
      await loadUserDetail(userId);
      dispatchAppToast("Credit purchase refunded and balances reconciled.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Credit purchase refund failed.",
        "error"
      );
    } finally {
      setBillingAction(null);
    }
  };

  const exportUsersCsv = () => {
    const csv = [
      ["id", "email", "name", "plan", "subscriptionStatus", "periodEnd", "stripeCustomerId", "conversations", "usageToday"],
      ...filteredItems.map((user) => [
        user.id,
        user.email || "",
        user.name || "",
        user.plan || "Free",
        user.subscriptionStatus || "",
        user.subscriptionCurrentPeriodEnd || "",
        user.stripeCustomerId || "",
        user._count.conversations,
        user.usageToday ?? "",
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tomverse-admin-users.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Users
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Search by email, name, user ID, or Stripe customer ID. {conversationCount} conversations are stored across the workspace.
          </p>
        </div>
        <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-black text-blue-200">
          {paidUserCount} active paid users
        </span>
        <button
          type="button"
          onClick={exportUsersCsv}
          className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-900"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      <form
        className="mt-5 grid gap-3 md:grid-cols-[1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          searchUsers();
        }}
      >
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search users by email, ID, name, or Stripe customer..."
            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <button
          type="submit"
          disabled={isSearching}
          className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Search
        </button>
      </form>

      <div className="mt-4 flex flex-wrap gap-2">
        {[
          ["all", `All ${items.length}`],
          ["paid", `Paid ${items.filter((user) => user.plan === "Pro" || user.plan === "Max").length}`],
          ["free", `Free ${items.filter((user) => !user.plan || user.plan === "Free").length}`],
          ["canceling", `Canceling ${items.filter((user) => user.subscriptionCancelAtPeriodEnd).length}`],
          ["refund", `Refund ${items.filter((user) => user._count.refundRequests).length}`],
          ["promo", `Promo ${items.filter((user) => user._count.promotionRedemptions).length}`],
          ["highUsage", `High usage ${items.filter((user) => (user.usageToday || 0) >= 50).length}`],
          ["billingRisk", `Billing risk ${items.filter((user) => user.billingRiskStatus === "disputed_hold" || (user.creditDebtCredits || 0) > 0).length}`],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setSegment(value as typeof segment)}
            className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-black transition ${
              segment === value
                ? "border-blue-500/40 bg-blue-500/20 text-blue-100"
                : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.16em] text-zinc-500">
            <tr>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Subscription</th>
              <th className="px-3 py-2">Usage today</th>
              <th className="px-3 py-2">Data</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((user) => (
              <tr key={user.id} className="rounded-2xl bg-zinc-900/70 text-zinc-200">
                <td className="rounded-l-2xl px-3 py-3">
                  <div className="font-bold">{user.email || user.name || "No email"}</div>
                  <div className="mt-1 text-xs text-zinc-500">{user.id}</div>
                  <div className="mt-1 text-xs text-zinc-600">{user.stripeCustomerId || "No Stripe customer"}</div>
                </td>
                <td className="px-3 py-3">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${planClass(user.plan)}`}>
                    {user.plan || "Free"}
                  </span>
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <div>{user.subscriptionStatus || "none"}</div>
                  <div>{user.subscriptionBillingInterval || "-"}</div>
                  <div>{dateTimeLabel(user.subscriptionCurrentPeriodEnd)}</div>
                  {user.subscriptionCancelAtPeriodEnd ? (
                    <div className="mt-1 text-amber-300">Cancels at period end</div>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <span className="font-bold text-zinc-200">{user.usageToday ?? "-"}</span>
                  <span className="ml-1">messages</span>
                  {(user.creditDebtCredits || 0) > 0 ? (
                    <div className="mt-1 font-bold text-red-300">
                      Debt {user.creditDebtCredits?.toLocaleString()} credits
                    </div>
                  ) : null}
                  {user.billingRiskStatus === "disputed_hold" ? (
                    <div className="mt-1 font-black text-red-300">AI access held</div>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <div>{user._count.conversations} conversations</div>
                  <div>{user._count.accounts} linked accounts</div>
                  <div>{user._count.refundRequests || 0} refund requests</div>
                  <div>{user._count.promotionRedemptions || 0} promo redemptions</div>
                </td>
                <td className="rounded-r-2xl px-3 py-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => loadUserDetail(user.id)}
                      disabled={loadingDetailId === user.id}
                      className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loadingDetailId === user.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      Details
                    </button>
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
        {filteredItems.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No users match the current segment.
          </div>
        ) : null}
      </div>

      {detailUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
                  Customer detail
                </p>
                <h3 className="mt-2 text-2xl font-black text-white">
                  {detailUser.email || detailUser.name || "No email"}
                </h3>
                <p className="mt-1 text-xs text-zinc-500">{detailUser.id}</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => copyUserContext(detailUser)}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 hover:bg-zinc-800"
                >
                  <Clipboard className="h-3.5 w-3.5" />
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => setDetailUser(null)}
                  className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  aria-label="Close user detail"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid gap-4 p-5 lg:grid-cols-3">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                  Plan
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${planClass(detailUser.plan)}`}>
                    {detailUser.plan}
                  </span>
                  {detailUser.subscriptionCancelAtPeriodEnd ? (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-black text-amber-200">
                      Cancels at period end
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 space-y-1 text-xs text-zinc-400">
                  <div>Status: {detailUser.subscriptionStatus || "-"}</div>
                  <div>Billing: {detailUser.subscriptionBillingInterval || "-"}</div>
                  <div>Period end: {dateTimeLabel(detailUser.subscriptionCurrentPeriodEnd)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => resyncBilling(detailUser.id)}
                  disabled={Boolean(billingAction)}
                  className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-black text-blue-100 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {billingAction === "resync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Resync Stripe
                </button>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                  Usage
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-2xl font-black text-white">{detailUser.usage.today}</div>
                    <div className="text-xs text-zinc-500">today</div>
                  </div>
                  <div>
                    <div className="text-2xl font-black text-white">{detailUser.usage.month}</div>
                    <div className="text-xs text-zinc-500">this month</div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                  Stripe
                </p>
                <div className="mt-3 space-y-1 text-xs text-zinc-400">
                  <div className="truncate">Customer: {detailUser.stripeCustomerId || "-"}</div>
                  <div className="truncate">Subscription: {detailUser.stripeSubscriptionId || "-"}</div>
                  <div className="truncate">Price: {detailUser.stripePriceId || "-"}</div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 px-5 pb-5 lg:grid-cols-2">
              <section className={`rounded-2xl border p-4 lg:col-span-2 ${
                detailUser.billingRiskStatus === "disputed_hold" || detailUser.creditDebtCredits > 0
                  ? "border-red-500/30 bg-red-500/10"
                  : "border-zinc-800 bg-zinc-900/60"
              }`}>
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h4 className="font-black text-white">Credit debt & billing risk</h4>
                    <p className="mt-1 text-sm text-zinc-400">
                      Risk status: <strong className={detailUser.billingRiskStatus === "disputed_hold" ? "text-red-300" : "text-emerald-300"}>{detailUser.billingRiskStatus}</strong>
                    </p>
                    {detailUser.billingRiskReason ? <p className="mt-1 text-xs text-red-200">{detailUser.billingRiskReason}</p> : null}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-right">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Unrecovered</p>
                      <p className="mt-1 text-xl font-black text-white">{detailUser.creditDebtCredits.toLocaleString()} credits</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Funded cost</p>
                      <p className="mt-1 text-xl font-black text-white">${(detailUser.creditDebtCostMicroUsd / 1_000_000).toFixed(2)}</p>
                    </div>
                  </div>
                </div>
                {detailUser.billingRiskStatus === "disputed_hold" ? (
                  <div className="mt-4 grid gap-3 md:grid-cols-[1fr_13rem_auto]">
                    <input
                      value={riskReleaseReason}
                      onChange={(event) => setRiskReleaseReason(event.target.value)}
                      placeholder="Verified resolution reason"
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
                      className="rounded-xl bg-red-600 px-4 py-2 text-sm font-black text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {billingAction === "risk" ? "Releasing..." : "Release hold"}
                    </button>
                  </div>
                ) : null}
                <p className="mt-3 text-xs text-zinc-500">
                  Releasing the AI hold does not forgive outstanding debt. Future plan and purchased credits continue to offset it first.
                </p>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">Additional credit purchases</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.creditPurchases.length === 0 ? (
                    <p className="text-sm text-zinc-500">No additional credit purchases.</p>
                  ) : detailUser.creditPurchases.map((purchase) => (
                    <div key={purchase.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-black text-white">{purchase.packId} / {purchase.status}</p>
                        <p>{dateTimeLabel(purchase.purchasedAt)} UTC</p>
                      </div>
                      <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
                        <span>Purchased: {purchase.creditsPurchased.toLocaleString()} / ${(purchase.fundedCostMicroUsd / 1_000_000).toFixed(2)}</span>
                        <span>Remaining: {purchase.remainingCredits.toLocaleString()} / ${(purchase.remainingFundedCostMicroUsd / 1_000_000).toFixed(2)}</span>
                        <span>Revoked: {purchase.revokedCredits.toLocaleString()} / ${(purchase.revokedCostMicroUsd / 1_000_000).toFixed(2)}</span>
                        <span className={purchase.unrecoveredCredits > 0 ? "font-black text-red-300" : ""}>Unrecovered: {purchase.unrecoveredCredits.toLocaleString()} / ${(purchase.unrecoveredCostMicroUsd / 1_000_000).toFixed(2)}</span>
                      </div>
                      <div className="mt-2 break-all text-zinc-600">
                        Payment: {purchase.stripePaymentIntentId || "-"} / Charge: {purchase.stripeChargeId || "-"} / Dispute: {purchase.stripeDisputeId || "-"} {purchase.disputeStatus ? `(${purchase.disputeStatus})` : ""}
                      </div>
                      {(purchase.status === "paid" || purchase.status === "partially_refunded") ? (
                        <details className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3">
                          <summary className="cursor-pointer font-black text-red-200">
                            Review and refund remaining Stripe charge
                          </summary>
                          <p className="mt-2 text-zinc-500">
                            Confirm the remaining balance and estimated consumed cost above. If the customer already used credits, the unrecovered portion becomes credit debt.
                          </p>
                          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_14rem_auto]">
                            <input
                              value={creditRefundReasons[purchase.id] || ""}
                              onChange={(event) => setCreditRefundReasons((current) => ({ ...current, [purchase.id]: event.target.value }))}
                              placeholder="Refund reason for audit log"
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
                              {billingAction === `refund:${purchase.id}` ? "Refunding..." : "Refund"}
                            </button>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">Durable credit reservations</h4>
                <p className="mt-1 text-xs text-zinc-500">
                  Recent reserved → settled/refunded transitions with provider correlation IDs.
                </p>
                <div className="mt-3 grid gap-2">
                  {detailUser.chatCreditReservations.length === 0 ? (
                    <p className="text-sm text-zinc-500">No credit reservations.</p>
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
                        <span>{dateTimeLabel(reservation.createdAt)} UTC</span>
                      </div>
                      <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
                        <span>Credits: {reservation.reservedCredits} reserved / {reservation.settledCredits} settled</span>
                        <span>Cost: ${(reservation.reservedCostMicroUsd / 1_000_000).toFixed(4)} / ${(reservation.settledCostMicroUsd / 1_000_000).toFixed(4)}</span>
                        <span>Outcome: {reservation.outcome || "-"}</span>
                        <span>{reservation.reconciledAt ? `Auto-refunded ${dateTimeLabel(reservation.reconciledAt)}` : `Expires ${dateTimeLabel(reservation.expiresAt)}`}</span>
                      </div>
                      <div className="mt-2 break-all text-zinc-600">
                        Reservation: {reservation.id} / Trace: {reservation.traceId} / Provider request: {reservation.providerRequestId || "-"} / Response: {reservation.providerResponseId || "-"}
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
                <h4 className="font-black text-white">Linked accounts</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.accounts.length === 0 ? (
                    <p className="text-sm text-zinc-500">No OAuth accounts linked.</p>
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
                <h4 className="font-black text-white">Settings</h4>
                <div className="mt-3 grid gap-2 text-xs text-zinc-400">
                  <div>Language: {detailUser.settings?.language || "-"}</div>
                  <div>Theme: {detailUser.settings?.theme || "-"}</div>
                  <div>Default model: {detailUser.settings?.defaultModel || "-"}</div>
                  <div>Sessions: {detailUser._count.sessions}</div>
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <h4 className="font-black text-white">Recent conversations</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.recentConversations.length === 0 ? (
                    <p className="text-sm text-zinc-500">No conversations yet.</p>
                  ) : (
                    detailUser.recentConversations.map((conversation) => (
                      <div key={conversation.id} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
                        <div className="font-bold text-zinc-200">{conversation.title}</div>
                        <div className="mt-1">
                          {conversation._count.messages} messages / updated {dateTimeLabel(conversation.updatedAt)}
                          {conversation.shareEnabled ? " / shared" : ""}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <h4 className="font-black text-white">Billing history</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.promotionRedemptions.map((redemption) => (
                    <div key={redemption.id} className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
                      Promo {redemption.promotion.code} / {redemption.planId} / {dateTimeLabel(redemption.redeemedAt)}
                    </div>
                  ))}
                  {detailUser.refundRequests.map((request) => (
                    <div key={request.id} className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                      Refund {request.status} / {request.plan || "-"} / {dateTimeLabel(request.requestedAt)}
                    </div>
                  ))}
                  {detailUser.promotionRedemptions.length === 0 && detailUser.refundRequests.length === 0 ? (
                    <p className="text-sm text-zinc-500">No promotion or refund history.</p>
                  ) : null}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">Manual plan adjustment</h4>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Use only for billing support recovery. Type ADJUST PLAN to confirm.
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-[10rem_1fr_10rem_auto]">
                  <select
                    value={adjustPlan}
                    onChange={(event) => setAdjustPlan(event.target.value as "Free" | "Pro" | "Max")}
                    className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm font-bold text-white outline-none focus:border-blue-500"
                  >
                    <option value="Free">Free</option>
                    <option value="Pro">Pro</option>
                    <option value="Max">Max</option>
                  </select>
                  <input
                    value={adjustReason}
                    onChange={(event) => setAdjustReason(event.target.value)}
                    placeholder="Reason for audit log"
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
                    className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-amber-600 px-3 py-2 text-sm font-black text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {billingAction === "adjust" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </button>
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 lg:col-span-2">
                <h4 className="font-black text-white">Customer timeline</h4>
                <div className="mt-3 grid gap-2">
                  {detailUser.timeline.length === 0 ? (
                    <p className="text-sm text-zinc-500">No customer timeline events yet.</p>
                  ) : (
                    detailUser.timeline.map((event) => (
                      <div key={`${event.type}-${event.id}`} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 font-black text-blue-200">
                            {event.type}
                          </span>
                          <span className="font-black text-zinc-200">{event.title}</span>
                          <span className="text-zinc-600">{dateTimeLabel(event.at)} UTC</span>
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
