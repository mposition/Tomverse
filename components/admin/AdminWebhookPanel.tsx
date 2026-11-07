"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { dispatchAppToast } from "@/lib/appToast";
import { adminWebhooksMessages } from "@/lib/adminMessages/webhooks";
import { adminFetch } from "@/lib/adminFetch";

type WebhookRow = {
  id: string;
  stripeEventId: string | null;
  eventType: string;
  status: string;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
  replayedAt?: string | null;
};

const dateLabel = (value: string | null) => formatAestDateTime(value) ?? "-";

export function AdminWebhookPanel() {
  const m = useAdminMessages(adminWebhooksMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  // `null` until the first read: an unread list is not an empty one.
  const [rows, setRows] = useState<WebhookRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/webhooks", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { webhooks?: WebhookRow[]; error?: string }
        | null;
      if (!response.ok || !data?.webhooks) {
        throw new Error(data?.error || messagesRef.current.loadFailed);
      }
      setRows(data.webhooks);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : messagesRef.current.loadFailed);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const reprocess = useCallback(async (row: WebhookRow) => {
    if (!row.stripeEventId) return;
    setReprocessingId(row.id);
    try {
      const response = await adminFetch(`/api/admin/webhooks/${row.id}/reprocess`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as
        | { webhook?: WebhookRow; error?: string }
        | null;
      if (!response.ok || !data?.webhook) {
        throw new Error(data?.error || m.reprocessFailed);
      }
      setRows((current) =>
        (current ?? []).map((item) => (item.id === data.webhook?.id ? data.webhook : item))
      );
      dispatchAppToast(m.reprocessed, "success");
    } catch (reprocessError) {
      dispatchAppToast(
        reprocessError instanceof Error ? reprocessError.message : m.reprocessFailed,
        "error"
      );
    } finally {
      setReprocessingId(null);
    }
  }, [m]);

  return (
    <AdminWebhookView
      rows={rows}
      loading={loading}
      error={error}
      reprocessingId={reprocessingId}
      onRefresh={() => void load()}
      onReprocess={(row) => void reprocess(row)}
    />
  );
}

/** The hook-free half: counts, the event table, and the states around them. */
export function AdminWebhookView({
  rows,
  loading,
  error,
  reprocessingId,
  onRefresh,
  onReprocess,
}: {
  /** `null` until the first read: an unread list is not an empty one. */
  rows: WebhookRow[] | null;
  loading: boolean;
  error: string | null;
  reprocessingId: string | null;
  onRefresh: () => void;
  onReprocess: (row: WebhookRow) => void;
}) {
  const m = useAdminMessages(adminWebhooksMessages);
  const list = rows ?? [];
  const failedCount = list.filter((row) => row.status === "failed").length;
  const processedCount = list.filter((row) => row.status === "processed").length;
  const waitingCount = list.length - failedCount - processedCount;

  const statusChip = (row: WebhookRow) => (
    <span className="flex flex-wrap items-center gap-1.5">
      <AdminStatusChip
        tone={row.status === "processed" ? "ok" : row.status === "failed" ? "bad" : "warn"}
      >
        {(m.status as Record<string, string>)[row.status] ?? row.status}
      </AdminStatusChip>
      {row.replayedAt ? <AdminStatusChip tone="info">{m.replayed}</AdminStatusChip> : null}
    </span>
  );

  const columns: AdminDataColumn<WebhookRow>[] = [
    {
      key: "event",
      header: m.columns.event,
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-bold text-zinc-100">{row.eventType}</span>
          <span className="break-all text-[11px] text-zinc-500">{row.stripeEventId || row.id}</span>
          {row.error ? <span className="mt-1 text-xs text-red-300">{row.error}</span> : null}
        </span>
      ),
    },
    { key: "received", header: m.columns.received, render: (row) => dateLabel(row.receivedAt) },
    { key: "status", header: m.columns.status, render: statusChip },
    {
      key: "action",
      header: <span className="sr-only">{m.reprocess}</span>,
      align: "right",
      render: (row) =>
        row.status === "failed" && row.stripeEventId ? (
          <AdminWriteButton
            variant="ghost"
            size="sm"
            onClick={() => onReprocess(row)}
            disabled={reprocessingId === row.id}
          >
            {reprocessingId === row.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            {m.reprocess}
          </AdminWriteButton>
        ) : null,
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="admin-webhooks">
      {rows !== null || error ? (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard
          label={m.stats.received}
          value={rows === null ? null : list.length}
          detail={m.stats.receivedDetail(list.length)}
          onRetry={error ? () => onRefresh() : undefined}
        />
        <AdminKpiCard
          label={m.stats.processed}
          value={rows === null ? null : processedCount}
          onRetry={error ? () => onRefresh() : undefined}
        />
        <AdminKpiCard
          label={m.stats.failed}
          value={rows === null ? null : failedCount}
          detail={failedCount > 0 ? m.stats.failedDetail : undefined}
          tone={failedCount > 0 ? "bad" : "neutral"}
          onRetry={error ? () => onRefresh() : undefined}
        />
        <AdminKpiCard
          label={m.stats.waiting}
          value={rows === null ? null : waitingCount}
          tone={waitingCount > 0 ? "warn" : "neutral"}
          onRetry={error ? () => onRefresh() : undefined}
        />
      </div>
      ) : null}

      <AdminTile
        title={m.title}
        description={m.description}
        action={
          <button
            type="button"
            onClick={() => onRefresh()}
            disabled={loading}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            {m.refresh}
          </button>
        }
      >
        {error && rows === null ? (
          <AdminStateBlock
            kind="error"
            title={error}
            detail={m.loadFailedDetail}
            onRetry={() => onRefresh()}
          />
        ) : rows === null ? (
          <AdminStateBlock kind="loading" />
        ) : (
          <AdminDataTable
            caption={m.recentEvents}
            columns={columns}
            rows={list.slice(0, 8)}
            rowKey={(row) => row.id}
            cardTitle={(row) => row.eventType}
            cardMeta={(row) => (
              <span className="flex flex-col gap-1">
                <span className="break-all">{row.stripeEventId || row.id}</span>
                <span>{dateLabel(row.receivedAt)}</span>
                {row.error ? <span className="text-red-300">{row.error}</span> : null}
              </span>
            )}
            cardAside={(row) => (
              <span className="flex flex-col items-end gap-2">
                {statusChip(row)}
                {row.status === "failed" && row.stripeEventId ? (
                  <AdminWriteButton
                    variant="ghost"
                    size="sm"
                    onClick={() => onReprocess(row)}
                    disabled={reprocessingId === row.id}
                  >
                    {m.reprocess}
                  </AdminWriteButton>
                ) : null}
              </span>
            )}
            emptyState={<AdminStateBlock kind="empty" title={m.empty.title} detail={m.empty.detail} />}
          />
        )}
      </AdminTile>
    </div>
  );
}
