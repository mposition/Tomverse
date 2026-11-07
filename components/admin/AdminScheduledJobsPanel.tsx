"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { adminScheduledJobsMessages } from "@/lib/adminMessages/scheduledJobs";
import { adminFetch } from "@/lib/adminFetch";

type ScheduledJobRow = {
  key: string;
  name: string;
  schedule: string;
  status: string;
  delayed: boolean;
  nextScheduledAt: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastProcessedCount: number | null;
  consecutiveFailures: number;
};

const dateLabel = (value: string | null, never: string, unknown: string) => {
  if (!value) return never;
  return formatAestDateTime(value) ?? unknown;
};

/** A job that never ran is idle, not healthy: nothing has proved it works. */
const toneOf = (status: string): AdminTone => {
  if (status === "succeeded") return "ok";
  if (status === "running") return "info";
  if (status === "delayed") return "warn";
  if (status === "failed" || status === "stuck") return "bad";
  return "idle";
};

export function AdminScheduledJobsPanel() {
  const m = useAdminMessages(adminScheduledJobsMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [rows, setRows] = useState<ScheduledJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/scheduled-jobs", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { jobs?: ScheduledJobRow[]; error?: string }
        | null;
      if (!response.ok || !data?.jobs) {
        throw new Error(data?.error || messagesRef.current.loadFailed);
      }
      setRows(data.jobs);
      setError(null);
    } catch (loadError) {
      // A failed read is an alert, never an empty table.
      setError(loadError instanceof Error ? loadError.message : messagesRef.current.loadFailed);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
    const refresh = () => void load();
    window.addEventListener("admin:refresh", refresh);
    return () => window.removeEventListener("admin:refresh", refresh);
  }, [load]);

  return (
    <AdminScheduledJobsView
      rows={rows}
      loading={loading}
      error={error}
      onRefresh={() => void load()}
    />
  );
}

/** The hook-free half: what the jobs table shows for a read, a failed read or no rows. */
export function AdminScheduledJobsView({
  rows,
  loading,
  error,
  onRefresh,
}: {
  rows: ScheduledJobRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const m = useAdminMessages(adminScheduledJobsMessages);
  const label = (value: string | null) => dateLabel(value, m.never, m.unknown);
  const statusText = (status: string) =>
    (m.status as Record<string, string>)[status] ?? status;

  const columns: AdminDataColumn<ScheduledJobRow>[] = [
    {
      key: "job",
      header: m.columns.job,
      render: (row) => (
        <span className="flex flex-col">
          <span className={`font-bold ${row.consecutiveFailures > 0 ? "text-red-200" : "text-zinc-100"}`}>
            {row.name}
          </span>
          <code className="text-[11px] text-zinc-500">{row.key}</code>
        </span>
      ),
    },
    { key: "schedule", header: m.columns.schedule, render: (row) => row.schedule },
    {
      key: "lastRun",
      header: m.columns.lastRun,
      render: (row) => (
        <span className="flex flex-col">
          <span>{label(row.lastRunAt)}</span>
          {row.lastProcessedCount !== null ? (
            <span className="text-[11px] text-zinc-500">{m.processed(row.lastProcessedCount)}</span>
          ) : null}
        </span>
      ),
    },
    { key: "lastSuccess", header: m.columns.lastSuccess, render: (row) => label(row.lastSuccessAt), hideOnCard: true },
    { key: "nextRun", header: m.columns.nextRun, render: (row) => label(row.nextScheduledAt), hideOnCard: true },
    {
      key: "status",
      header: m.columns.status,
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <AdminStatusChip tone={toneOf(row.status)}>{statusText(row.status)}</AdminStatusChip>
          {row.consecutiveFailures > 0 ? (
            <span className="text-[11px] font-bold text-red-300">
              {m.failedInARow(row.consecutiveFailures)}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  const failing = rows.filter((row) => row.consecutiveFailures > 0 && row.lastError);

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="admin-scheduled-jobs">
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
        {error ? (
          <AdminStateBlock
            kind="error"
            title={error}
            detail={m.loadFailedDetail}
            onRetry={() => onRefresh()}
          />
        ) : loading && rows.length === 0 ? (
          <AdminStateBlock kind="loading" />
        ) : (
          <AdminDataTable
            caption={m.title}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.key}
            cardTitle={(row) => row.name}
            cardMeta={(row) => `${row.schedule} · ${label(row.lastRunAt)}`}
            cardAside={(row) => (
              <AdminStatusChip tone={toneOf(row.status)}>{statusText(row.status)}</AdminStatusChip>
            )}
            emptyState={<AdminStateBlock kind="empty" title={m.empty.title} detail={m.empty.detail} />}
          />
        )}
      </AdminTile>

      {failing.map((row) => (
        <div
          key={row.key}
          role="alert"
          data-testid="scheduled-job-failure"
          className="flex min-w-0 items-start gap-3 rounded-2xl bg-red-500/10 p-4"
        >
          <AdminPixelAvatar team="sre" unit={3} body={false} tile={48} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-red-200">
              {m.explainer.title(row.name, row.consecutiveFailures)}
            </p>
            <p className="mt-0.5 text-xs text-zinc-400">
              {m.explainer.detail(label(row.lastFailureAt), label(row.nextScheduledAt))}
            </p>
            <div className="mt-3">
              <AdminTechInfo summary={row.key}>
                <p className="mb-1 text-zinc-500">{m.explainer.errorSummary}</p>
                <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{row.lastError}</p>
              </AdminTechInfo>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
