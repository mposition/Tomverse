"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, RefreshCw } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

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

const dateLabel = (value: string | null) => {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
};

export function AdminScheduledJobsPanel() {
  const [rows, setRows] = useState<ScheduledJobRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/scheduled-jobs", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { jobs?: ScheduledJobRow[]; error?: string }
        | null;
      if (!response.ok || !data?.jobs) {
        throw new Error(data?.error || "Could not load scheduled jobs.");
      }
      setRows(data.jobs);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not load scheduled jobs.",
        "error"
      );
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
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">Automation health</p>
          <h2 className="mt-2 text-2xl font-black text-white">Scheduled jobs</h2>
          <p className="mt-2 text-sm text-zinc-400">
            A job is marked delayed when Railway has not called it within its expected interval.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 px-3 text-xs font-black text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>
      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        {loading && rows.length === 0 ? (
          <div className="text-sm text-zinc-500">Loading job history…</div>
        ) : rows.map((row) => {
          const healthy = !row.delayed && row.status === "succeeded";
          return (
            <article
              key={row.key}
              className={`rounded-2xl border p-4 ${
                healthy
                  ? "border-emerald-500/20 bg-emerald-500/5"
                  : "border-amber-500/30 bg-amber-500/10"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-black text-white">{row.name}</h3>
                  <p className="mt-1 text-xs text-zinc-500">{row.schedule}</p>
                </div>
                {healthy ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                ) : row.delayed ? (
                  <AlertTriangle className="h-5 w-5 text-amber-300" />
                ) : (
                  <Clock3 className="h-5 w-5 text-blue-300" />
                )}
              </div>
              <dl className="mt-4 grid gap-2 text-xs text-zinc-400">
                <div><dt className="inline text-zinc-600">Status: </dt><dd className="inline font-black text-zinc-200">{row.status}</dd></div>
                <div><dt className="inline text-zinc-600">Last run: </dt><dd className="inline">{dateLabel(row.lastRunAt)}</dd></div>
                <div><dt className="inline text-zinc-600">Last success: </dt><dd className="inline">{dateLabel(row.lastSuccessAt)}</dd></div>
                <div><dt className="inline text-zinc-600">Next expected: </dt><dd className="inline">{dateLabel(row.nextScheduledAt)}</dd></div>
                <div><dt className="inline text-zinc-600">Processed: </dt><dd className="inline">{row.lastProcessedCount ?? "-"}</dd></div>
                <div><dt className="inline text-zinc-600">Consecutive failures: </dt><dd className="inline">{row.consecutiveFailures}</dd></div>
              </dl>
              {row.lastError ? (
                <p className="mt-3 max-h-24 overflow-auto rounded-xl border border-red-500/20 bg-red-500/5 p-2 text-xs text-red-200">
                  {row.lastError}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
