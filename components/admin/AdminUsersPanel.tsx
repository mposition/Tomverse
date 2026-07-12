"use client";

import { useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
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

export function AdminUsersPanel({
  rows,
  currentUserId,
  paidUserCount,
  conversationCount,
}: Props) {
  const [items, setItems] = useState(rows);
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  const title = useMemo(
    () => (query.trim() ? "Search results" : "Recent accounts"),
    [query]
  );

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
            {items.map((user) => (
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
                </td>
                <td className="px-3 py-3 text-xs text-zinc-400">
                  <div>{user._count.conversations} conversations</div>
                  <div>{user._count.accounts} linked accounts</div>
                  <div>{user._count.refundRequests || 0} refund requests</div>
                  <div>{user._count.promotionRedemptions || 0} promo redemptions</div>
                </td>
                <td className="rounded-r-2xl px-3 py-3">
                  <AdminUserDeleteButton
                    userId={user.id}
                    currentUserId={currentUserId}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No users found.
          </div>
        ) : null}
      </div>
    </section>
  );
}
