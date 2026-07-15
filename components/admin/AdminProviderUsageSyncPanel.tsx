"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

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

const failureStageLabel: Record<
  NonNullable<NonNullable<SyncResult["diagnostic"]>["failureStage"]>,
  string
> = {
  connection: "Waiting for response headers",
  response: "Reading provider response",
  provider_http: "Provider HTTP response",
  payload: "Validating provider payload",
  storage: "Saving reconciliation",
};

const diagnosticGuidance = (result: SyncResult) => {
  const diagnostic = result.diagnostic;
  if (!diagnostic) return null;
  if (
    diagnostic.errorCode === "OPENAI_COSTS_CONNECT_TIMEOUT" ||
    diagnostic.errorCode === "OPENAI_COSTS_NETWORK_ERROR"
  ) {
    return "Tomverse did not receive an HTTP response after automatic retries. Authentication cannot be diagnosed from this result. If it repeats after deployment, verify Railway outbound DNS/TLS and HTTPS access to api.openai.com before rotating the Admin API key.";
  }
  if (diagnostic.errorCode === "OPENAI_COSTS_RESPONSE_TIMEOUT") {
    return "OpenAI responded, but the response body did not finish in time. Retry once; if it repeats, use the provider request ID and Tomverse trace when escalating.";
  }
  if (diagnostic.errorCode === "ANTHROPIC_COSTS_TIMEOUT") {
    return "Anthropic Cost API did not finish within 10 seconds. Retry once; if it repeats, use the provider request ID and Tomverse trace when escalating.";
  }
  if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
    return diagnostic.source === "anthropic_costs"
      ? "Replace ANTHROPIC_ADMIN_API_KEY with an Admin API key for the Claude Console organization, then redeploy. A standard ANTHROPIC_API_KEY cannot access cost reports."
      : diagnostic.source === "xai_usage"
        ? "Verify that XAI_MANAGEMENT_API_KEY is a Management Key with the required team permission and that XAI_TEAM_ID belongs to the same xAI team. A standard XAI_API_KEY cannot access Management Usage."
        : "Replace OPENAI_ADMIN_API_KEY with an Organization Admin API key created by an Organization Owner, then redeploy.";
  }
  if (diagnostic.source === "xai_usage" && diagnostic.httpStatus === 404) {
    return "Copy the Team ID from the active xAI Console team settings into XAI_TEAM_ID, then redeploy.";
  }
  if (diagnostic.source === "google_cloud_billing") {
    if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
      return "Grant the configured service account BigQuery Job User on the query project and BigQuery Data Viewer on the billing-export dataset, then retry yesterday's sync.";
    }
    if (diagnostic.errorCode === "GOOGLE_BILLING_JOB_INCOMPLETE") {
      return "The bounded BigQuery job did not finish. Retry once; if it repeats, verify that the export table is partitioned and contains billing rows for the selected date.";
    }
    return "Verify GOOGLE_CLOUD_BILLING_EXPORT_TABLE and the billing service-account JSON. Billing export data can arrive several hours late.";
  }
  if (diagnostic.source === "alibaba_cloud_billing") {
    if (diagnostic.errorCode === "ALIBABA_BILLING_NON_USD") {
      return "Tomverse will not guess a foreign-exchange rate. Use the international USD billing account or reconcile the non-USD Alibaba bill separately.";
    }
    if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
      return "Grant the RAM identity AliyunBSSReadOnlyAccess (or bssapi:QueryInstanceBill) and verify the AccessKey pair.";
    }
    return "Verify the Singapore BSS endpoint and optional ALIBABA_CLOUD_BILLING_PRODUCT_CODE. Daily instance bills can be delayed by about one day.";
  }
  if (diagnostic.errorCode === "XAI_USAGE_LIMIT_REACHED") {
    return "xAI returned only a subset of the requested usage series, so Tomverse did not store the partial total. Retry the single-day sync; if it repeats, review the xAI Usage Explorer and retain the Tomverse trace.";
  }
  if (diagnostic.httpStatus === 429) {
    return diagnostic.source === "openai_costs"
      ? "The automatic retry policy was exhausted. Wait for the provider retry window, then run the sync again."
      : "Wait for the provider retry window, then run the sync again.";
  }
  if (diagnostic.httpStatus !== null && diagnostic.httpStatus >= 500) {
    return diagnostic.source === "anthropic_costs"
      ? "Anthropic returned a server error. Retry later and retain the provider request ID and Tomverse trace for support."
      : "OpenAI returned a server error after automatic retries. Retry later and retain both request IDs for support.";
  }
  return null;
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
            Providers with supported response-level accounting show internal usage when an aggregate
            cost API is unavailable; remaining providers without a configured usage endpoint are skipped.
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
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-sky-200">
              {summary.internal} internal
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
            {response.results.map((result) => {
              const guidance = diagnosticGuidance(result);
              return (
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
                  {result.status === "internal"
                    ? `Internal estimated cost ${money(result.internalCostMicroUsd || 0)}`
                    : `Reported net cost ${money(result.reportedCostMicroUsd)}`}
                </p>
                {result.usageSourceLabel && (
                  <p className="mt-1 text-xs text-sky-200">
                    Usage source: {result.usageSourceLabel}
                  </p>
                )}
                {result.reconciliationLabel && (
                  <p className="mt-1 text-xs text-zinc-400">
                    Provider reconciliation: {result.reconciliationLabel}
                  </p>
                )}
                {result.internalUsage && (
                  <p className="mt-1 text-xs text-zinc-500">
                    {result.internalUsage.requestCount} requests · {result.internalUsage.inputTokens.toLocaleString()} input · {result.internalUsage.cachedInputTokens.toLocaleString()} cached · {result.internalUsage.outputTokens.toLocaleString()} output tokens
                  </p>
                )}
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
                      {(result.diagnostic.attemptCount !== undefined ||
                        result.diagnostic.elapsedMs !== undefined) && (
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <dt className="font-bold text-zinc-500">Requests attempted</dt>
                            <dd>{result.diagnostic.attemptCount ?? "Unknown"}</dd>
                          </div>
                          <div>
                            <dt className="font-bold text-zinc-500">Elapsed</dt>
                            <dd>
                              {result.diagnostic.elapsedMs === undefined
                                ? "Unknown"
                                : `${(result.diagnostic.elapsedMs / 1_000).toFixed(1)}s`}
                            </dd>
                          </div>
                        </div>
                      )}
                      {(result.diagnostic.attemptTimeoutMs !== undefined ||
                        result.diagnostic.failureStage !== undefined) && (
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <dt className="font-bold text-zinc-500">Per-request timeout</dt>
                            <dd>
                              {result.diagnostic.attemptTimeoutMs === undefined
                                ? "Unknown"
                                : `${result.diagnostic.attemptTimeoutMs / 1_000}s`}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-bold text-zinc-500">Failure stage</dt>
                            <dd>
                              {result.diagnostic.failureStage
                                ? failureStageLabel[result.diagnostic.failureStage]
                                : "Unknown"}
                            </dd>
                          </div>
                        </div>
                      )}
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
                      {guidance && (
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-amber-100">
                          <dt className="font-black">Recommended check</dt>
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
