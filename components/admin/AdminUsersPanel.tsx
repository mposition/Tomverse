"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, RefreshCw, Search } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import type { AdminUserRow, AdminUserSegment, AdminUserStats } from "@/lib/adminUserTypes";
import { ADMIN_USER_SEGMENTS } from "@/lib/adminUserTypes";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminUsersMessages } from "@/lib/adminMessages/users";
import { adminDateTimeLabel as dateTimeLabel } from "@/lib/adminDateTime";
import { formatAestDate } from "@/lib/adminUiCore";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminUserDeleteButton } from "@/components/admin/AdminUserDeleteButton";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminInitialAvatar } from "@/components/admin/ui/AdminInitialAvatar";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminMeter } from "@/components/admin/ui/AdminMeter";
import { AdminPlanChip } from "@/components/admin/ui/AdminPlanChip";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { adminFetch } from "@/lib/adminFetch";
import { adminUsersExportHref } from "@/lib/adminUsersExportHref";
import type { AdminTone } from "@/lib/adminUiCore";

type PageSize = 30 | 50;

type Props = {
  rows: AdminUserRow[];
  initialNextCursor: string | null;
  /** `null` when the counts could not be read; the cards then say so. */
  stats: AdminUserStats | null;
  currentUserId: string;
  /** Daily plan-credit limit by plan name, for the "credits today" bar. */
  dailyCreditLimits?: Record<string, number>;
  initialSegment?: AdminUserSegment;
  initialQuery?: string;
  initialPageSize?: PageSize;
  initialPageIndex?: number;
  initialPageCursors?: Array<string | null>;
};

const CARD_SEGMENTS = ["all", "activePaid", "testerPass", "canceling", "billingRisk"] as const;

/**
 * The Users list: five counts that filter it, a search, and one table.
 *
 * The customer's own page (`/admin/users/[userId]`) is `AdminUserDetailView`;
 * this panel only lists and links. Filtering, search and paging still go to
 * `/api/admin/users` and the address bar, as before.
 */
export function AdminUsersPanel({
  rows,
  initialNextCursor,
  stats,
  currentUserId,
  dailyCreditLimits = {},
  initialSegment = "all",
  initialQuery = "",
  initialPageSize = 30,
  initialPageIndex = 0,
  initialPageCursors = [null],
}: Props) {
  const router = useRouter();
  const m = useAdminMessages(adminUsersMessages);
  const { locale } = useAdminLocale();
  const intl = adminIntlLocale(locale);
  const [items, setItems] = useState(rows);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [statsSnapshot, setStatsSnapshot] = useState(stats);
  const [query, setQuery] = useState(initialQuery);
  const [appliedQuery, setAppliedQuery] = useState(initialQuery);
  const [isSearching, setIsSearching] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [segment, setSegment] = useState<AdminUserSegment>(initialSegment);
  const [pageSize, setPageSize] = useState<PageSize>(initialPageSize);
  const [pageIndex, setPageIndex] = useState(initialPageIndex);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>(initialPageCursors);

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
      const response = await adminFetch(`/api/admin/users?${params.toString()}`, {
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
      setListError(null);
      if (data.stats) setStatsSnapshot(data.stats);
      const url = new URLSearchParams();
      if (normalized) url.set("q", normalized);
      if (requestedSegment !== "all") url.set("segment", requestedSegment);
      if (requestedTake !== 30) url.set("take", String(requestedTake));
      if (cursor) url.set("cursor", cursor);
      if (targetPageIndex > 0) url.set("page", String(targetPageIndex + 1));
      const serializedCursors = cursorHistory.map((value) => value || "_").join(",");
      if (serializedCursors !== "_") url.set("cursors", serializedCursors);
      router.replace(`/admin/users${url.size ? `?${url.toString()}` : ""}`, { scroll: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : m.toast.searchFailed;
      setListError(message);
      dispatchAppToast(message, "error");
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
    fetchUsers({ requestedQuery: query, cursor: null, targetPageIndex: 0, cursorHistory: [null] });

  const showNextPage = () => {
    if (!nextCursor || isSearching) return;
    const targetPageIndex = pageIndex + 1;
    void fetchUsers({
      cursor: nextCursor,
      targetPageIndex,
      cursorHistory: [...pageCursors.slice(0, targetPageIndex), nextCursor],
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

  const counts: Record<(typeof CARD_SEGMENTS)[number], number | null> = {
    all: statsSnapshot?.totalAccounts ?? null,
    activePaid: statsSnapshot?.activePaidSubscriptions ?? null,
    testerPass: statsSnapshot?.testerPassUsers ?? null,
    canceling: statsSnapshot?.cancelingSubscriptions ?? null,
    billingRisk: statsSnapshot?.billingRiskUsers ?? null,
  };

  const subscriptionTone = (status: string | null): AdminTone => {
    if (status === "active" || status === "trialing") return "ok";
    if (status === "past_due" || status === "unpaid") return "bad";
    if (status === "incomplete") return "warn";
    return "idle";
  };

  const dailyLimit = (user: AdminUserRow) => {
    const limit = dailyCreditLimits[user.plan || "Free"];
    return typeof limit === "number" && limit > 0 ? limit : null;
  };

  const displayName = (user: AdminUserRow) => user.name || m.list.nameNotProvided;

  const openLink = (user: AdminUserRow) => (
    <Link
      href={`/admin/users/${encodeURIComponent(user.id)}`}
      aria-label={m.list.openFor(user.email || user.name || m.list.userFallback)}
      className="inline-flex min-h-9 items-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
    >
      {m.list.open}
    </Link>
  );

  const columns: AdminDataColumn<AdminUserRow>[] = [
    {
      key: "user",
      header: m.list.columns.user,
      render: (user) => (
        <div className="flex min-w-0 items-center gap-3">
          <AdminInitialAvatar id={user.id} name={user.name} email={user.email} />
          <div className="min-w-0">
            <div className="truncate font-bold text-zinc-100">{displayName(user)}</div>
            <Link
              href={`/admin/users/${encodeURIComponent(user.id)}`}
              className="block truncate text-xs font-medium text-blue-300 underline-offset-4 hover:underline"
            >
              {user.email || m.list.noEmail}
            </Link>
          </div>
        </div>
      ),
    },
    {
      key: "plan",
      header: m.list.columns.plan,
      render: (user) => <AdminPlanChip plan={user.plan} />,
    },
    {
      key: "subscription",
      header: m.list.columns.subscription,
      render: (user) => (
        <div className="flex flex-col items-start gap-1">
          {user.subscriptionStatus ? (
            <AdminStatusChip tone={subscriptionTone(user.subscriptionStatus)}>
              {(m.list.subscriptionStatus as Record<string, string>)[user.subscriptionStatus] ??
                user.subscriptionStatus}
            </AdminStatusChip>
          ) : (
            <span className="text-xs text-zinc-500">{m.list.subscriptionNone}</span>
          )}
          {user.subscriptionCurrentPeriodEnd ? (
            <span className="text-xs text-zinc-500">
              {dateTimeLabel(user.subscriptionCurrentPeriodEnd, user.timeZone)}
            </span>
          ) : null}
          {user.subscriptionCancelAtPeriodEnd ? (
            <span className="text-xs font-bold text-amber-300">{m.list.cancelsAtPeriodEnd}</span>
          ) : null}
          {user.billingRiskStatus === "disputed_hold" ? (
            <span className="text-xs font-bold text-red-300">{m.list.aiAccessHeld}</span>
          ) : null}
          {(user.creditDebtCredits || 0) > 0 ? (
            <span className="text-xs font-bold text-red-300">
              {m.list.debtCredits((user.creditDebtCredits ?? 0).toLocaleString(intl))}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "today",
      header: m.list.columns.today,
      render: (user) => {
        const limit = dailyLimit(user);
        return (
          <div className="flex min-w-32 flex-col gap-1">
            <span className="text-xs font-bold text-zinc-200">
              {limit
                ? m.list.creditsOfLimit(user.creditsToday.toLocaleString(intl), limit.toLocaleString(intl))
                : m.list.creditsToday(user.creditsToday.toLocaleString(intl))}
            </span>
            <AdminMeter fraction={limit ? user.creditsToday / limit : null} label={m.list.columns.today} />
            <span className="text-xs text-zinc-500">
              {m.list.messagesToday(user.messagesToday.toLocaleString(intl))}
            </span>
          </div>
        );
      },
    },
    {
      key: "joined",
      header: m.list.columns.joined,
      render: (user) => (
        <div className="flex flex-col text-xs">
          <span className="font-bold text-zinc-200">{formatAestDate(user.createdAt) ?? "-"}</span>
          <span className="text-zinc-500">{user.timeZone}</span>
        </div>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">{m.list.open}</span>,
      align: "right",
      hideOnCard: true,
      render: (user) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {openLink(user)}
          <AdminUserDeleteButton userId={user.id} currentUserId={currentUserId} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">{m.list.description}</p>
        <div className="flex flex-wrap items-center gap-2">
          {statsSnapshot ? (
            <span className="text-xs text-zinc-500">
              {m.list.lastAggregated(dateTimeLabel(statsSnapshot.generatedAt))}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() =>
              void fetchUsers({ requestedSegment: segment, requestedQuery: appliedQuery, refreshStats: true })
            }
            disabled={isSearching}
            aria-label={m.list.refresh}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isSearching ? "animate-spin" : ""}`} aria-hidden />
          </button>
          <a
            href={adminUsersExportHref(appliedQuery, segment)}
            download
            className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {m.list.exportCurrent}
          </a>
          <a
            href={adminUsersExportHref("", "all")}
            download
            className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {m.list.exportAll}
          </a>
        </div>
      </div>

      <div role="group" aria-label={m.list.cardsLabel} className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {CARD_SEGMENTS.map((key) => {
          const count = counts[key];
          const active = segment === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => selectSegment(key)}
              aria-pressed={active}
              disabled={isSearching}
              className={`min-w-0 rounded-2xl text-left outline-none transition focus-visible:ring-4 focus-visible:ring-blue-500/30 disabled:cursor-wait ${
                active ? "ring-2 ring-blue-500" : ""
              }`}
            >
              <AdminKpiCard
                label={m.list.cards[key].label}
                value={count === null ? null : count.toLocaleString(intl)}
                detail={m.list.cards[key].detail}
                tone={key === "billingRisk" && (count ?? 0) > 0 ? "warn" : "neutral"}
                className="h-full"
              />
            </button>
          );
        })}
      </div>

      {listError && items.length > 0 ? (
        <AdminStateBlock
          kind="error"
          title={m.toast.searchFailed}
          detail={listError}
          onRetry={() => void fetchUsers()}
        />
      ) : null}

      <AdminDataTable
        columns={columns}
        rows={items}
        rowKey={(user) => user.id}
        caption={appliedQuery ? m.searchResults : m.segments[segment]}
        cardTitle={(user) => (
          <span className="flex items-center gap-2">
            <AdminInitialAvatar id={user.id} name={user.name} email={user.email} />
            <span className="min-w-0 truncate">{displayName(user)}</span>
          </span>
        )}
        cardMeta={(user) => (
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate">{user.email || m.list.noEmail}</span>
            <AdminPlanChip plan={user.plan} />
            <span>{m.list.creditsToday(user.creditsToday.toLocaleString(intl))}</span>
          </span>
        )}
        cardAside={(user) => openLink(user)}
        toolbar={
          <>
            <form
              className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void searchUsers();
              }}
            >
              <label className="relative block min-w-52 flex-1">
                <span className="sr-only">{m.list.searchLabel}</span>
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={m.list.searchPlaceholder}
                  className="h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                />
              </label>
              <button
                type="submit"
                disabled={isSearching}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSearching ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Search className="h-4 w-4" aria-hidden />
                )}
                {m.list.search}
              </button>
            </form>
            <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <span>{m.list.planFilter}</span>
              <select
                value={segment}
                onChange={(event) => selectSegment(event.target.value as AdminUserSegment)}
                disabled={isSearching}
                className="h-9 rounded-xl border border-zinc-700 bg-zinc-900 px-2 text-xs font-bold text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50"
              >
                {ADMIN_USER_SEGMENTS.map((value) => (
                  <option key={value} value={value}>
                    {m.segments[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <span>{m.list.rowsPerPage}</span>
              <select
                value={pageSize}
                onChange={(event) => changePageSize(Number(event.target.value) as PageSize)}
                disabled={isSearching}
                aria-label={m.list.rowsPerPage}
                className="h-9 rounded-xl border border-zinc-700 bg-zinc-900 px-2 text-xs font-bold text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50"
              >
                <option value={30}>30</option>
                <option value={50}>50</option>
              </select>
            </label>
            {appliedQuery ? (
              <span className="max-w-full truncate rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">
                {m.list.searchChip(appliedQuery)}
              </span>
            ) : null}
          </>
        }
        emptyState={
          listError ? (
            <AdminStateBlock
              kind="error"
              title={m.toast.searchFailed}
              detail={listError}
              onRetry={() => void fetchUsers()}
            />
          ) : (
            <AdminStateBlock kind="empty" title={m.list.emptyTitle} detail={m.list.empty} />
          )
        }
        footer={
          <nav className="flex w-full flex-wrap items-center justify-between gap-3" aria-label={m.list.pagination}>
            <span className="text-xs text-zinc-500">{m.list.pageSummary(pageIndex + 1, items.length)}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={showPreviousPage}
                disabled={pageIndex === 0 || isSearching}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
                {m.list.previous}
              </button>
              <span className="min-w-16 text-center text-xs font-bold text-zinc-400">
                {isSearching ? (
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  m.list.page(pageIndex + 1)
                )}
              </span>
              <button
                type="button"
                onClick={showNextPage}
                disabled={!nextCursor || isSearching}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {m.list.next}
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </nav>
        }
      />
    </div>
  );
}
