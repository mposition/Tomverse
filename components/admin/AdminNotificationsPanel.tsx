"use client";

import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminNotificationsMessages } from "@/lib/adminMessages/notifications";
import { dispatchAppToast } from "@/lib/appToast";
import { adminFetch } from "@/lib/adminFetch";
import { adminNotificationNeedsAcknowledgement } from "@/lib/adminNotificationAttention";

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

const dateLabel = (value: string) => formatAestDateTime(value) ?? "-";

const statusTone = (status: string): AdminTone =>
  status === "sent" ? "ok" : status === "skipped" ? "idle" : "bad";

const escapeCsv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

export function AdminNotificationsPanel() {
  const m = useAdminMessages(adminNotificationsMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
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
  const [loadFailed, setLoadFailed] = useState(false);
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
      setLoadFailed(false);
      try {
        const params = new URLSearchParams({
          take: String(PAGE_SIZE),
          status,
        });
        if (cursor) params.set("cursor", cursor);
        const response = await adminFetch(`/api/admin/notifications?${params}`, {
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
          throw new Error(data?.error || messagesRef.current.loadFailed);
        }
        if (version !== requestVersion.current) return;
        setItems(data.logs);
        setNextCursor(data.nextCursor || null);
        setFilteredCount(data.filteredCount || 0);
        setStats(data.stats);
        setPageIndex(targetPage);
      } catch {
        if (version !== requestVersion.current) return;
        // A failed read is an error block, never an empty list.
        setLoadFailed(true);
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
      const response = await adminFetch(`/api/admin/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge" }),
      });
      const data = (await response.json().catch(() => null)) as
        | { notification?: AdminNotificationRow; error?: string }
        | null;
      if (!response.ok || !data?.notification) {
        throw new Error(data?.error || m.acknowledgeFailed);
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
      dispatchAppToast(m.acknowledged, "success");
      router.refresh();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.acknowledgeFailed,
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
    <div className="flex min-w-0 flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminKpiCard label={m.kpi.total} value={loadFailed ? null : stats.total} onRetry={refresh} />
        <AdminKpiCard label={m.kpi.sent} value={loadFailed ? null : stats.sent} onRetry={refresh} />
        <AdminKpiCard
          label={m.kpi.failed}
          value={loadFailed ? null : stats.failed}
          tone={stats.failed > 0 ? "bad" : "neutral"}
          onRetry={refresh}
        />
        <AdminKpiCard
          label={m.kpi.unacknowledged}
          value={loadFailed ? null : stats.unacknowledged}
          tone={stats.unacknowledged > 0 ? "warn" : "neutral"}
          onRetry={refresh}
        />
      </div>

      <AdminTile
        title={m.title}
        description={m.description(PAGE_SIZE)}
        action={
          <>
            <AdminWriteButton variant="secondary" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
              {m.refresh}
            </AdminWriteButton>
            <AdminWriteButton
              variant="secondary"
              size="sm"
              onClick={exportCsv}
              disabled={items.length === 0}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {m.exportPage}
            </AdminWriteButton>
          </>
        }
      >
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => selectStatus(status)}
              disabled={loading && statusFilter === status}
              aria-pressed={statusFilter === status}
              className={`min-h-9 cursor-pointer rounded-full border px-3.5 text-xs font-bold transition disabled:cursor-wait ${
                statusFilter === status
                  ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {m.filter[status]} {statusCounts[status]}
            </button>
          ))}
        </div>

        {loadFailed ? (
          <AdminStateBlock
            kind="error"
            title={m.loadFailed}
            detail={m.loadFailedDetail}
            onRetry={refresh}
          />
        ) : (
          <div className="relative flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
              <span>{m.showing(pageStart, pageEnd, filteredCount, m.filter[statusFilter])}</span>
              <span>{m.page(pageIndex + 1)}</span>
            </div>
            {loading ? (
              <div
                role="status"
                className="absolute inset-0 z-10 flex items-start justify-center rounded-2xl bg-zinc-950/70 pt-8 text-sm font-bold text-zinc-300"
              >
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> {m.loading}
              </div>
            ) : null}
            <AdminDataTable
              caption={m.tableCaption}
              rows={items}
              rowKey={(row) => row.id}
              emptyState={<AdminStateBlock kind="empty" title={m.empty} />}
              columns={[
                {
                  key: "when",
                  header: m.columns.when,
                  render: (row) => (
                    <span className="whitespace-nowrap text-xs text-zinc-400">{dateLabel(row.createdAt)}</span>
                  ),
                },
                {
                  key: "channel",
                  header: m.columns.channel,
                  render: (row) => (
                    <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-xs font-bold uppercase text-zinc-200">
                      {row.channel}
                    </span>
                  ),
                },
                {
                  key: "message",
                  header: m.columns.message,
                  render: (row) => (
                    <div className="min-w-0">
                      <p className="font-bold text-white">{row.title}</p>
                      {row.detail ? (
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{row.detail}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-zinc-500">
                        {m.target}
                        {row.targetType || "-"} {row.targetId || ""}
                      </p>
                      {row.error ? (
                        <p className="mt-1 text-xs text-red-300">
                          {m.error}
                          {row.error}
                        </p>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "status",
                  header: m.columns.status,
                  render: (row) => (
                    <AdminStatusChip tone={statusTone(row.status)}>
                      {m.statusLabel[row.status as keyof typeof m.statusLabel] ?? row.status}
                    </AdminStatusChip>
                  ),
                },
                {
                  key: "action",
                  header: m.columns.action,
                  render: (row) =>
                    row.acknowledgedAt ? (
                      <span className="text-xs text-zinc-400">
                        {m.ack}
                        {dateLabel(row.acknowledgedAt)} / {row.acknowledgedByEmail || m.adminFallback}
                      </span>
                    ) : adminNotificationNeedsAcknowledgement(row) ? (
                      <AdminWriteButton
                        variant="secondary"
                        size="sm"
                        onClick={() => acknowledge(row.id)}
                        disabled={busyId === row.id}
                      >
                        {busyId === row.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                        )}
                        {m.acknowledge}
                      </AdminWriteButton>
                    ) : (
                      <span className="text-xs text-zinc-600">-</span>
                    ),
                },
              ]}
              footer={
                <>
                  <AdminWriteButton
                    variant="secondary"
                    size="sm"
                    onClick={goPrevious}
                    disabled={pageIndex === 0 || loading}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden /> {m.previous}
                  </AdminWriteButton>
                  <span className="flex-1 text-center text-xs font-bold text-zinc-500">
                    {pageStart}-{pageEnd} / {filteredCount}
                  </span>
                  <AdminWriteButton
                    variant="secondary"
                    size="sm"
                    onClick={goNext}
                    disabled={!nextCursor || loading}
                  >
                    {m.next} <ChevronRight className="h-4 w-4" aria-hidden />
                  </AdminWriteButton>
                </>
              }
            />
          </div>
        )}
      </AdminTile>
    </div>
  );
}
