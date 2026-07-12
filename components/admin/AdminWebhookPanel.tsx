"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Webhook } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

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

const dateLabel = (value: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const statusClass = (status: string) => {
  if (status === "processed") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "failed") return "border-red-500/30 bg-red-500/10 text-red-200";
  return "border-amber-500/30 bg-amber-500/10 text-amber-200";
};

export function AdminWebhookPanel() {
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/webhooks", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { webhooks?: WebhookRow[]; error?: string }
        | null;
      if (!response.ok || !data?.webhooks) {
        throw new Error(data?.error || "Could not load webhook logs.");
      }
      setRows(data.webhooks);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not load webhook logs.",
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

  const failedCount = rows.filter((row) => row.status === "failed").length;

  const reprocess = useCallback(async (row: WebhookRow) => {
    if (!row.stripeEventId) return;
    setReprocessingId(row.id);
    try {
      const response = await fetch(`/api/admin/webhooks/${row.id}/reprocess`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as
        | { webhook?: WebhookRow; error?: string }
        | null;
      if (!response.ok || !data?.webhook) {
        throw new Error(data?.error || "Could not reprocess webhook.");
      }
      setRows((current) =>
        current.map((item) => (item.id === data.webhook?.id ? data.webhook : item))
      );
      dispatchAppToast("Stripe webhook was reprocessed.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not reprocess webhook.",
        "error"
      );
    } finally {
      setReprocessingId(null);
    }
  }, []);

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Stripe webhooks
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Billing event monitor</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Track recent Stripe webhook delivery and processing failures before they become plan sync issues.
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

      <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-sm font-black text-white">
            <Webhook className="h-4 w-4 text-blue-300" />
            Recent webhook events
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${failedCount ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}`}>
            {failedCount} failed
          </span>
        </div>
        <div className="mt-4 grid gap-2">
          {rows.slice(0, 8).map((row) => (
            <div key={row.id} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 font-black ${statusClass(row.status)}`}>
                    {row.status}
                  </span>
                  <span className="font-black text-white">{row.eventType}</span>
                  <span className="text-zinc-600">{dateLabel(row.receivedAt)} UTC</span>
                  {row.replayedAt ? (
                    <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 font-black text-blue-200">
                      replayed
                    </span>
                  ) : null}
                </div>
                {row.status === "failed" && row.stripeEventId ? (
                  <button
                    type="button"
                    onClick={() => void reprocess(row)}
                    disabled={reprocessingId === row.id}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2 py-1 font-black text-blue-100 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {reprocessingId === row.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Reprocess
                  </button>
                ) : null}
              </div>
              <p className="mt-1 break-all text-zinc-500">
                {row.stripeEventId || row.id}
              </p>
              {row.error ? <p className="mt-1 text-red-200">{row.error}</p> : null}
            </div>
          ))}
          {!loading && rows.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-4 text-sm text-zinc-500">
              No Stripe webhook events recorded yet.
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
