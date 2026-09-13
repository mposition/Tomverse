"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { adminIntlLocale, type AdminMessageShape } from "@/lib/adminLocale";
import { adminProviderUsageSyncMessages } from "@/lib/adminMessages/providerUsageSync";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";

type UsageSyncMessages = AdminMessageShape<
  (typeof adminProviderUsageSyncMessages)["en"]
>;

type SyncResult = {
  provider: string;
  displayName: string;
  status: "synced" | "internal" | "skipped" | "failed";
  reportedCostMicroUsd: number | null;
  internalCostMicroUsd?: number;
  internalUsage?: {
    requestCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  usageSourceLabel?: string;
  reconciliationLabel?: string;
  message: string;
  diagnostic: {
    traceId: string;
    source:
      | "openai_costs"
      | "anthropic_costs"
      | "xai_usage"
      | "google_cloud_billing"
      | "alibaba_cloud_billing"
      | "generic_usage";
    endpoint: string;
    httpStatus: number | null;
    errorType: string | null;
    errorCode: string | null;
    providerRequestId: string | null;
    detail: string | null;
    attemptCount?: number;
    attemptTimeoutMs?: number;
    elapsedMs?: number;
    failureStage?:
      | "connection"
      | "response"
      | "provider_http"
      | "payload"
      | "storage";
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
  internal: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  skipped: "border-zinc-700 bg-zinc-900 text-zinc-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-200",
};

const diagnosticGuidance = (result: SyncResult, g: UsageSyncMessages["guidance"]) => {
  const diagnostic = result.diagnostic;
  if (!diagnostic) return null;
  if (
    diagnostic.errorCode === "OPENAI_COSTS_CONNECT_TIMEOUT" ||
    diagnostic.errorCode === "OPENAI_COSTS_NETWORK_ERROR"
  ) {
    return g.openaiConnect;
  }
  if (diagnostic.errorCode === "OPENAI_COSTS_RESPONSE_TIMEOUT") {
    return g.openaiResponseTimeout;
  }
  if (diagnostic.errorCode === "ANTHROPIC_COSTS_TIMEOUT") {
    return g.anthropicTimeout;
  }
  if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
    return diagnostic.source === "anthropic_costs"
      ? g.anthropicAuth
      : diagnostic.source === "xai_usage"
        ? g.xaiAuth
        : g.openaiAuth;
  }
  if (diagnostic.source === "xai_usage" && diagnostic.httpStatus === 404) {
    return g.xaiTeamNotFound;
  }
  if (diagnostic.source === "google_cloud_billing") {
    if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
      return g.googleAuth;
    }
    if (diagnostic.errorCode === "GOOGLE_BILLING_JOB_INCOMPLETE") {
      return g.googleJobIncomplete;
    }
    return g.googleDefault;
  }
  if (diagnostic.source === "alibaba_cloud_billing") {
    if (diagnostic.errorCode === "ALIBABA_BILLING_NON_USD") {
      return g.alibabaNonUsd;
    }
    if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
      return g.alibabaAuth;
    }
    return g.alibabaDefault;
  }
  if (diagnostic.errorCode === "XAI_USAGE_LIMIT_REACHED") {
    return g.xaiLimitReached;
  }
  if (diagnostic.httpStatus === 429) {
    return diagnostic.source === "openai_costs"
      ? g.openaiRateLimited
      : g.rateLimited;
  }
  if (diagnostic.httpStatus !== null && diagnostic.httpStatus >= 500) {
    return diagnostic.source === "anthropic_costs"
      ? g.anthropicServerError
      : g.openaiServerError;
  }
  return null;
};

export function AdminProviderUsageSyncPanel() {
  const m = useAdminMessages(adminProviderUsageSyncMessages);
  const { locale } = useAdminLocale();
  const intlLocale = adminIntlLocale(locale);
  const [date, setDate] = useState(yesterdayIso);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SyncResponse | null>(null);

  const summary = useMemo(() => {
    if (!response) return null;
    return {
      synced: response.results.filter((result) => result.status === "synced").length,
      internal: response.results.filter((result) => result.status === "internal").length,
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
        throw new Error("error" in data && data.error ? data.error : m.syncFailed);
      }
      setResponse(data as SyncResponse);
      window.dispatchEvent(new Event("tomverse:provider-health-refresh"));
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : m.syncFailed);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            {m.eyebrow}
          </p>
          <h3 className="mt-2 text-xl font-black text-white">
            {m.title}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            {m.description}
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
            className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? m.syncing : m.syncNow}
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
              {m.synced(summary.synced)}
            </span>
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sky-200">
              {m.internal(summary.internal)}
            </span>
            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1">
              {m.skipped(summary.skipped)}
            </span>
            <span className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-red-200">
              {m.failed(summary.failed)}
            </span>
            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1">
              {m.date(response.date)}
            </span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {response.results.map((result) => {
              const guidance = diagnosticGuidance(result, m.guidance);
              return (
                <div
                  key={result.provider}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-sm"
                >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-black text-white">{result.displayName}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusClass[result.status]}`}>
                    {result.status}
                  </span>
                </div>
                <p className="mt-2 font-bold text-zinc-300">
                  {result.status === "internal"
                    ? m.internalCost(money(result.internalCostMicroUsd || 0))
                    : m.reportedCost(money(result.reportedCostMicroUsd))}
                </p>
                {result.usageSourceLabel && (
                  <p className="mt-1 text-xs text-sky-200">
                    {m.usageSource(result.usageSourceLabel)}
                  </p>
                )}
                {result.reconciliationLabel && (
                  <p className="mt-1 text-xs text-zinc-400">
                    {m.reconciliation(result.reconciliationLabel)}
                  </p>
                )}
                {result.internalUsage && (
                  <p className="mt-1 text-xs text-zinc-500">
                    {m.internalUsage(
                      result.internalUsage.requestCount,
                      result.internalUsage.inputTokens.toLocaleString(intlLocale),
                      result.internalUsage.cachedInputTokens.toLocaleString(intlLocale),
                      result.internalUsage.outputTokens.toLocaleString(intlLocale)
                    )}
                  </p>
                )}
                <p className="mt-1 text-xs leading-5 text-zinc-500">{result.message}</p>
                {result.status === "failed" && result.diagnostic && (
                  <details className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs">
                    <summary className="cursor-pointer font-black text-red-200">
                      {m.viewFailureDetails}
                    </summary>
                    <dl className="mt-3 grid gap-2 text-zinc-400">
                      <div>
                        <dt className="font-bold text-zinc-500">{m.source}</dt>
                        <dd>{result.diagnostic.source}</dd>
                      </div>
                      <div>
                        <dt className="font-bold text-zinc-500">{m.endpoint}</dt>
                        <dd className="break-all font-mono text-[11px]">
                          {result.diagnostic.endpoint}
                        </dd>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <dt className="font-bold text-zinc-500">{m.http}</dt>
                          <dd>{result.diagnostic.httpStatus ?? m.noResponse}</dd>
                        </div>
                        <div>
                          <dt className="font-bold text-zinc-500">{m.code}</dt>
                          <dd>{result.diagnostic.errorCode || m.unknown}</dd>
                        </div>
                      </div>
                      {(result.diagnostic.attemptCount !== undefined ||
                        result.diagnostic.elapsedMs !== undefined) && (
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <dt className="font-bold text-zinc-500">{m.requestsAttempted}</dt>
                            <dd>{result.diagnostic.attemptCount ?? m.unknown}</dd>
                          </div>
                          <div>
                            <dt className="font-bold text-zinc-500">{m.elapsed}</dt>
                            <dd>
                              {result.diagnostic.elapsedMs === undefined
                                ? m.unknown
                                : `${(result.diagnostic.elapsedMs / 1_000).toFixed(1)}s`}
                            </dd>
                          </div>
                        </div>
                      )}
                      {(result.diagnostic.attemptTimeoutMs !== undefined ||
                        result.diagnostic.failureStage !== undefined) && (
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <dt className="font-bold text-zinc-500">{m.perRequestTimeout}</dt>
                            <dd>
                              {result.diagnostic.attemptTimeoutMs === undefined
                                ? m.unknown
                                : `${result.diagnostic.attemptTimeoutMs / 1_000}s`}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-bold text-zinc-500">{m.failureStageLabel}</dt>
                            <dd>
                              {result.diagnostic.failureStage
                                ? m.failureStage[result.diagnostic.failureStage]
                                : m.unknown}
                            </dd>
                          </div>
                        </div>
                      )}
                      {result.diagnostic.detail && (
                        <div>
                          <dt className="font-bold text-zinc-500">{m.providerDetail}</dt>
                          <dd className="break-words leading-5">
                            {result.diagnostic.detail}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="font-bold text-zinc-500">{m.providerRequestId}</dt>
                        <dd className="break-all font-mono text-[11px]">
                          {result.diagnostic.providerRequestId || m.notReturned}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-bold text-zinc-500">{m.tomverseTrace}</dt>
                        <dd className="break-all font-mono text-[11px]">
                          {result.diagnostic.traceId}
                        </dd>
                      </div>
                      {guidance && (
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-amber-100">
                          <dt className="font-black">{m.recommendedCheck}</dt>
                          <dd className="mt-1 leading-5">{guidance}</dd>
                        </div>
                      )}
                    </dl>
                  </details>
                )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
