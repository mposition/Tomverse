"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

type SyncResult = {
  provider: string;
  displayName: string;
  status: "synced" | "skipped" | "failed";
  reportedCostMicroUsd: number | null;
  message: string;
  diagnostic: {
    traceId: string;
    source: "openai_costs" | "generic_usage";
    endpoint: string;
    httpStatus: number | null;
    errorType: string | null;
    errorCode: string | null;
    providerRequestId: string | null;
    detail: string | null;
  } | null;
};

type SyncResponse = {
  date: string;
  results: SyncResult[];
};

const yesterdayIso = () => {
  const date = new Date(Date.now() - 86_400_000);
  return date.toISOString().slice(0, 10);
};

const money = (microUsd: number | null) =>
  microUsd === null
    ? "-"
    : `${microUsd < 0 ? "-" : ""}$${Math.abs(microUsd / 1_000_000).toFixed(2)}`;

const statusClass: Record<SyncResult["status"], string> = {
  synced: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  skipped: "border-zinc-700 bg-zinc-900 text-zinc-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-200",
};

export function AdminProviderUsageSyncPanel() {
  const [date, setDate] = useState(yesterdayIso);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SyncResponse | null>(null);

  const summary = useMemo(() => {
    if (!response) return null;
    return {
      synced: response.results.filter((result) => result.status === "synced").length,
      skipped: response.results.filter((result) => result.status === "skipped").length,
      failed: response.results.filter((result) => result.status === "failed").length,
    };
  }, [response]);

  const runSync = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetch("/api/admin/provider-usage/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const data = (await result.json()) as SyncResponse | { error?: string };
      if (!result.ok) {
        throw new Error("error" in data && data.error ? data.error : "Sync failed.");
      }
      setResponse(data as SyncResponse);
      window.dispatchEvent(new Event("tomverse:provider-health-refresh"));
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Sync failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Usage reconciliation
          </p>
          <h3 className="mt-2 text-xl font-black text-white">
            Sync provider usage APIs
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            Pull provider-reported spend for a day and store it beside Tomverse internal metering.
            Providers without a configured usage endpoint are skipped.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-bold text-white outline-none transition focus:border-blue-500"
          />
          <button
            type="button"
            onClick={runSync}
            disabled={loading}
            className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Syncing" : "Sync now"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200">
          {error}
        </div>
      )}

      {summary && response && (
        <div className="mt-4">
          <div className="flex flex-wrap gap-2 text-xs font-bold text-zinc-300">
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-200">
              {summary.synced} synced
            </span>
            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1">
              {summary.skipped} skipped
            </span>
            <span className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-red-200">
              {summary.failed} failed
            </span>
            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1">
              Date {response.date}
            </span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {response.results.map((result) => (
              <div
                key={result.provider}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-black text-white">{result.displayName}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-black ${statusClass[result.status]}`}>
                    {result.status}
                  </span>
                </div>
                <p className="mt-2 font-bold text-zinc-300">
                  Reported net cost {money(result.reportedCostMicroUsd)}
                </p>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{result.message}</p>
                {result.status === "failed" && result.diagnostic && (
                  <details className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs">
                    <summary className="cursor-pointer font-black text-red-200">
                      View failure details
                    </summary>
                    <dl className="mt-3 grid gap-2 text-zinc-400">
                      <div>
                        <dt className="font-bold text-zinc-500">Source</dt>
                        <dd>{result.diagnostic.source}</dd>
                      </div>
                      <div>
                        <dt className="font-bold text-zinc-500">Endpoint</dt>
                        <dd className="break-all font-mono text-[11px]">
                          {result.diagnostic.endpoint}
                        </dd>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <dt className="font-bold text-zinc-500">HTTP</dt>
                          <dd>{result.diagnostic.httpStatus ?? "No response"}</dd>
                        </div>
                        <div>
                          <dt className="font-bold text-zinc-500">Code</dt>
                          <dd>{result.diagnostic.errorCode || "Unknown"}</dd>
                        </div>
                      </div>
                      {result.diagnostic.detail && (
                        <div>
                          <dt className="font-bold text-zinc-500">Provider detail</dt>
                          <dd className="break-words leading-5">
                            {result.diagnostic.detail}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="font-bold text-zinc-500">Provider request ID</dt>
                        <dd className="break-all font-mono text-[11px]">
                          {result.diagnostic.providerRequestId || "Not returned"}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-bold text-zinc-500">Tomverse trace</dt>
                        <dd className="break-all font-mono text-[11px]">
                          {result.diagnostic.traceId}
                        </dd>
                      </div>
                    </dl>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
