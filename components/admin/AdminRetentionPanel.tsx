"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type RetentionItem = {
  key: string;
  label: string;
  policy: string;
  staleCount: number;
  oldestAt: string | null;
};

type RetentionResponse = {
  generatedAt: string;
  items: RetentionItem[];
};

const dateLabel = (value: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function AdminRetentionPanel() {
  const [data, setData] = useState<RetentionResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/retention");
      const payload = (await response.json().catch(() => null)) as
        | RetentionResponse
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("items" in payload)) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : "Could not load retention status."
        );
      }
      setData(payload);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not load retention status.",
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Retention
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            Data retention operations
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Monitor cleanup targets for usage buckets, request leases, share snapshots, provider checks, alert logs, and audit retention.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-black text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.items.map((item) => (
          <article key={item.key} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-black text-white">{item.label}</h3>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{item.policy}</p>
              </div>
              <Database className="h-4 w-4 shrink-0 text-blue-300" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
                <p className="font-bold text-zinc-500">Cleanup count</p>
                <p className="mt-1 text-xl font-black text-white">{item.staleCount}</p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
                <p className="font-bold text-zinc-500">Oldest record</p>
                <p className="mt-1 font-black text-white">{dateLabel(item.oldestAt)}</p>
              </div>
            </div>
          </article>
        ))}
        {!data && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            {loading ? "Loading retention status..." : "Retention status has not loaded yet."}
          </div>
        )}
      </div>
    </section>
  );
}
