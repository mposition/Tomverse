"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bell,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

export type AdminNotificationRow = {
  id: string;
  channel: string;
  title: string;
  detail: string | null;
  status: string;
  targetType: string | null;
  targetId: string | null;
  error: string | null;
  acknowledgedAt?: string | null;
  acknowledgedByEmail?: string | null;
  createdAt: string;
};

type NotificationStats = {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  unacknowledged: number;
};

const EMPTY_STATS: NotificationStats = {
  total: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  unacknowledged: 0,
};
const PAGE_SIZE = 20;
const STATUSES = ["all", "sent", "failed", "skipped"] as const;
type StatusFilter = (typeof STATUSES)[number];

const readNavigationState = (searchParams: URLSearchParams) => {
  const requestedStatus = searchParams.get("status");
  const status = STATUSES.includes(requestedStatus as StatusFilter)
    ? (requestedStatus as StatusFilter)
    : "all";
  const requestedPage = Number.parseInt(searchParams.get("page") || "0", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0;
  const cursor = searchParams.get("cursor");
  let cursors: Array<string | null> = [null];
  try {
    const parsed = JSON.parse(searchParams.get("cursors") || "[]") as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => value === null || typeof value === "string")
    ) {
      cursors = parsed as Array<string | null>;
    }
  } catch {
    // Invalid shared URL state falls back to the first page.
  }
  if (!cursors.length) cursors = [null];
  while (cursors.length <= page) cursors.push(null);
  cursors[page] = cursor || cursors[page] || null;
  return { status, page, cursor: cursors[page], cursors };
};

const dateLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const statusClass = (status: string) => {
  if (status === "sent") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  }
  if (status === "skipped") {
    return "border-zinc-700 bg-zinc-900 text-zinc-400";
  }
  return "border-red-500/30 bg-red-500/10 text-red-200";
};

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

export function AdminNotificationsPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() =>
    readNavigationState(new URLSearchParams(searchParams.toString()))
  );
  const [items, setItems] = useState<AdminNotificationRow[]>([]);
  const [stats, setStats] = useState<NotificationStats>(EMPTY_STATS);
  const [filteredCount, setFilteredCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    initialNavigation.status
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>(
    initialNavigation.cursors
  );
  const [pageIndex, setPageIndex] = useState(initialNavigation.page);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const updateLocation = (
    status: StatusFilter,
    cursor: string | null,
    page: number,
    cursors: Array<string | null>
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    if (status === "all") params.delete("status");
    else params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    else params.delete("cursor");
    if (page > 0) params.set("page", String(page));
    else params.delete("page");
    if (page > 0) params.set("cursors", JSON.stringify(cursors));
    else params.delete("cursors");
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };

  const loadPage = useCallback(
    async (status: StatusFilter, cursor: string | null, targetPage: number) => {
      const version = ++requestVersion.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          take: String(PAGE_SIZE),
          status,
        });
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/admin/notifications?${params}`, {
          cache: "no-store",
        });
        const data = (await response.json().catch(() => null)) as
          | {
              logs?: AdminNotificationRow[];
              nextCursor?: string | null;
              filteredCount?: number;
              stats?: NotificationStats;
              error?: string;
            }
          | null;
        if (!response.ok || !data?.logs || !data.stats) {
          throw new Error(data?.error || "Could not load notification logs.");
        }
        if (version !== requestVersion.current) return;
        setItems(data.logs);
        setNextCursor(data.nextCursor || null);
        setFilteredCount(data.filteredCount || 0);
        setStats(data.stats);
        setPageIndex(targetPage);
      } catch (error) {
        if (version !== requestVersion.current) return;
        dispatchAppToast(
          error instanceof Error
            ? error.message
            : "Could not load notification logs.",
          "error"
        );
      } finally {
        if (version === requestVersion.current) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    queueMicrotask(() =>
      void loadPage(
        initialNavigation.status,
        initialNavigation.cursor,
        initialNavigation.page
      )
    );
  }, [initialNavigation, loadPage]);

  useEffect(() => {
    const refresh = () => void loadPage(statusFilter, cursorHistory[pageIndex] || null, pageIndex);
    window.addEventListener("admin:refresh", refresh);
    return () => window.removeEventListener("admin:refresh", refresh);
  }, [cursorHistory, loadPage, pageIndex, statusFilter]);

  const selectStatus = (status: StatusFilter) => {
    setStatusFilter(status);
    setCursorHistory([null]);
    updateLocation(status, null, 0, [null]);
    void loadPage(status, null, 0);
  };

  const goNext = () => {
    if (!nextCursor || loading) return;
    const targetPage = pageIndex + 1;
    const nextHistory = [
      ...cursorHistory.slice(0, targetPage),
      nextCursor,
    ];
    setCursorHistory(nextHistory);
    updateLocation(statusFilter, nextCursor, targetPage, nextHistory);
    void loadPage(statusFilter, nextCursor, targetPage);
  };

  const goPrevious = () => {
    if (pageIndex <= 0 || loading) return;
    const targetPage = pageIndex - 1;
    const cursor = cursorHistory[targetPage] || null;
    updateLocation(statusFilter, cursor, targetPage, cursorHistory);
    void loadPage(statusFilter, cursor, targetPage);
  };

  const refresh = () => {
    void loadPage(
      statusFilter,
      cursorHistory[pageIndex] || null,
      pageIndex
    );
  };

  const acknowledge = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const response = await fetch(`/api/admin/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge" }),
      });
      const data = (await response.json().catch(() => null)) as
        | { notification?: AdminNotificationRow; error?: string }
        | null;
      if (!response.ok || !data?.notification) {
        throw new Error(data?.error || "Could not acknowledge alert.");
      }
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, ...data.notification } : item
        )
      );
      setStats((current) => ({
        ...current,
        unacknowledged: Math.max(0, current.unacknowledged - 1),
      }));
      dispatchAppToast("Alert acknowledged.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not acknowledge alert.",
        "error"
      );
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = () => {
    const csv = [
      ["createdAt", "channel", "status", "title", "targetType", "targetId", "error"],
      ...items.map((row) => [
        row.createdAt,
        row.channel,
        row.status,
        row.title,
        row.targetType || "",
        row.targetId || "",
        row.error || "",
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tomverse-admin-notifications-page-${pageIndex + 1}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const pageStart = filteredCount === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const pageEnd = Math.min((pageIndex + 1) * PAGE_SIZE, filteredCount);
  const statusCounts: Record<StatusFilter, number> = {
    all: stats.total,
    sent: stats.sent,
    failed: stats.failed,
    skipped: stats.skipped,
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Alerts
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            Notification delivery log
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Track all Slack, Discord, and email delivery records. Results are
            loaded from the database in pages of {PAGE_SIZE}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-black text-zinc-200">
            {stats.total} total
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-black text-emerald-200">
            <Bell className="h-3.5 w-3.5" />
            {stats.sent} sent
          </span>
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-black text-red-200">
            {stats.failed} failed
          </span>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-200">
            {stats.unacknowledged} unacknowledged
          </span>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => selectStatus(status)}
              disabled={loading && statusFilter === status}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-black capitalize transition disabled:cursor-wait ${
                statusFilter === status
                  ? "border-blue-500/40 bg-blue-500/20 text-blue-100"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"
              }`}
            >
              {status} {statusCounts[status]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={items.length === 0}
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            Export this page
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
        <span>
          Showing {pageStart}-{pageEnd} of {filteredCount} {statusFilter} records
        </span>
        <span>Page {pageIndex + 1}</span>
      </div>

      <div className="relative mt-5 grid min-h-32 gap-3">
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-start justify-center rounded-2xl bg-zinc-950/70 pt-8 text-sm font-bold text-zinc-300 backdrop-blur-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading logs...
          </div>
        ) : null}
        {items.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No notification logs match this filter.
          </div>
        ) : (
          items.map((row) => (
            <article
              key={row.id}
              className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(row.status)}`}
                    >
                      {row.status}
                    </span>
                    <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs font-black uppercase text-blue-200">
                      {row.channel}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {dateLabel(row.createdAt)} UTC
                    </span>
                  </div>
                  <h3 className="mt-3 text-sm font-black text-white">{row.title}</h3>
                  {row.detail ? (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                      {row.detail}
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-1 text-xs text-zinc-500 md:min-w-64">
                  <span>
                    Target: {row.targetType || "-"} {row.targetId || ""}
                  </span>
                  <span>Error: {row.error || "-"}</span>
                  <span>
                    Ack:{" "}
                    {row.acknowledgedAt
                      ? `${dateLabel(row.acknowledgedAt)} / ${row.acknowledgedByEmail || "admin"}`
                      : "-"}
                  </span>
                  {!row.acknowledgedAt && row.status === "failed" ? (
                    <button
                      type="button"
                      onClick={() => acknowledge(row.id)}
                      disabled={busyId === row.id}
                      className="mt-2 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-black text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busyId === row.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      Acknowledge
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          ))
        )}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-zinc-800 pt-4">
        <button
          type="button"
          onClick={goPrevious}
          disabled={pageIndex === 0 || loading}
          className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" /> Previous
        </button>
        <span className="text-xs font-bold text-zinc-500">
          {pageStart}-{pageEnd} / {filteredCount}
        </span>
        <button
          type="button"
          onClick={goNext}
          disabled={!nextCursor || loading}
          className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-black text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
