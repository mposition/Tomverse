"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type RetentionItem = {
  key: string;
  label: string;
  policy: string;
  /**
   * What the sweep does with these rows. Optional because a client must not
   * blank the panel against a server that has not deployed it yet.
   */
  action?: "delete" | "clear" | "refund" | "keep";
  staleCount: number;
  oldestAt: string | null;
};

type RetentionResponse = {
  generatedAt: string;
  items: RetentionItem[];
};

/**
 * The dry run the operator is looking at.
 *
 * Kept because the execution is bound to it: a single-administrator
 * organisation cannot satisfy the two-person rule, so the preview's digest is
 * what stands in for the second reviewer (lib/adminSoleApproverCore.ts). With
 * two administrators configured the server ignores these and asks for the
 * usual approval, so the panel sends them either way rather than trying to
 * work out which path applies.
 */
type DryRunPreview = {
  id: string;
  digest: string;
  ranAt: string;
  result: unknown;
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
  const [running, setRunning] = useState<"dry-run" | "execute" | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<DryRunPreview | null>(null);

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

  const runCleanup = async (mode: "dry-run" | "execute") => {
    if (running) return;
    setRunning(mode);
    try {
      const response = await fetch("/api/admin/maintenance/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          confirmText: mode === "execute" ? confirmText : undefined,
          dryRunId: mode === "execute" ? preview?.id : undefined,
          dryRunDigest: mode === "execute" ? preview?.digest : undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            run?: { id?: string; result?: unknown; createdAt?: string };
            resultDigest?: string;
            error?: string;
          }
        | null;
      if (!response.ok || !payload?.run) {
        throw new Error(payload?.error || "Cleanup operation failed.");
      }
      dispatchAppToast(
        mode === "execute" ? "Cleanup executed." : "Cleanup dry run completed.",
        "success"
      );
      setConfirmText("");
      // A dry run replaces the preview; an execution consumes it. Either way
      // the old one is gone, and the server would refuse it as superseded
      // rather than act on numbers nobody is still looking at.
      setPreview(
        mode === "dry-run" && payload.run.id && payload.resultDigest
          ? {
              id: payload.run.id,
              digest: payload.resultDigest,
              ranAt: payload.run.createdAt || new Date().toISOString(),
              result: payload.run.result ?? null,
            }
          : null
      );
      await load();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Cleanup operation failed.",
        "error"
      );
    } finally {
      setRunning(null);
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            Retention
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            Data retention operations
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Monitor expired credit reservations, usage buckets, request leases, share snapshots, product analytics, provider checks, alert logs, and audit retention.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
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
                <h3 className="text-sm font-bold text-white">{item.label}</h3>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{item.policy}</p>
              </div>
              <Database className="h-4 w-4 shrink-0 text-blue-300" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
                {/*
                  A `keep` policy's number is history, not a queue. Calling it a
                  cleanup count told an operator that running the cleanup would
                  move it, and for the audit log nothing ever will.
                */}
                <p className="font-bold text-zinc-500">
                  {item.action === "keep" ? "Beyond the floor" : "Cleanup count"}
                </p>
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

      <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
        <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-amber-100">
          Manual cleanup
        </h3>
        <p className="mt-2 text-sm leading-6 text-amber-100/75">
          Run a dry run first. To execute cleanup, type RUN CLEANUP exactly.
        </p>
        {preview ? (
          <div className="mt-4 rounded-xl border border-zinc-700 bg-zinc-950/80 p-3">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              Dry run {dateLabel(preview.ranAt)} UTC
            </p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-zinc-300">
              {JSON.stringify(preview.result, null, 2)}
            </pre>
          </div>
        ) : null}
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder="RUN CLEANUP"
            className="h-11 rounded-xl border border-amber-500/30 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-amber-300"
          />
          <button
            type="button"
            onClick={() => runCleanup("dry-run")}
            disabled={Boolean(running)}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-100 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running === "dry-run" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Dry run
          </button>
          <button
            type="button"
            onClick={() => runCleanup("execute")}
            disabled={Boolean(running) || confirmText !== "RUN CLEANUP"}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-amber-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running === "execute" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Execute cleanup
          </button>
        </div>
      </div>
    </section>
  );
}
