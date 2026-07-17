"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Coins,
  Database,
  HardDrive,
  Gauge,
  Loader2,
  RefreshCw,
  Save,
  Server,
  XCircle,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import type {
  InfrastructureDashboard,
  InfrastructureStatus,
} from "@/lib/infrastructureTypes";

const REFRESH_INTERVAL_MS = 5 * 60_000;

const statusStyle: Record<InfrastructureStatus, string> = {
  healthy: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  unconfigured: "border-zinc-700 bg-zinc-900 text-zinc-300",
  error: "border-red-500/30 bg-red-500/10 text-red-200",
};

const statusIcon = (status: InfrastructureStatus) => {
  if (status === "healthy") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "error") return <XCircle className="h-3.5 w-3.5" />;
  return <AlertTriangle className="h-3.5 w-3.5" />;
};

const money = (microUsd: number | null) =>
  microUsd === null ? "-" : `$${(microUsd / 1_000_000).toFixed(2)}`;

const numberLabel = (value: number | null) =>
  value === null ? "-" : new Intl.NumberFormat("en-US").format(value);

const byteLabel = (value: number | null) => {
  if (value === null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

function AllowanceBar({ value }: { value: number | null }) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, value));
  const color =
    value !== null && value >= 90
      ? "bg-red-500"
      : value !== null && value >= 70
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function StatusBadge({ status }: { status: InfrastructureStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-black capitalize ${statusStyle[status]}`}
    >
      {statusIcon(status)}
      {status}
    </span>
  );
}

export function AdminInfrastructurePanel({
  canManageCosts,
}: {
  canManageCosts: boolean;
}) {
  const [data, setData] = useState<InfrastructureDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditUsd, setCreditUsd] = useState("");
  const [creditNote, setCreditNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/infrastructure", {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | InfrastructureDashboard
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("railway" in payload)) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : "Could not load infrastructure audit."
        );
      }
      setData(payload);
      setCreditUsd(
        payload.railway.configuredCreditMicroUsd === null
          ? ""
          : (payload.railway.configuredCreditMicroUsd / 1_000_000).toFixed(2)
      );
      setCreditNote(payload.railway.creditNote || "");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load infrastructure audit."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const parsedCredit = Number(creditUsd);
  const creditValid =
    creditUsd.trim().length > 0 &&
    Number.isFinite(parsedCredit) &&
    parsedCredit >= 0 &&
    parsedCredit <= 1_000_000;

  const saveCredit = async () => {
    if (!creditValid || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/infrastructure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "railway",
          creditUsd: parsedCredit,
          note: creditNote,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Could not save Railway credit.");
      }
      dispatchAppToast("Railway credit saved.", "success");
      await load();
    } catch (saveError) {
      dispatchAppToast(
        saveError instanceof Error
          ? saveError.message
          : "Could not save Railway credit.",
        "error"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-black uppercase tracking-[0.18em] text-blue-200">
              <Activity className="h-3.5 w-3.5" />
              Infrastructure audit
            </div>
            <h2 className="mt-3 text-2xl font-black text-white">
              Railway, R2, and database operations
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              Read-only external metrics are refreshed every five minutes. Tokens stay on the
              server and are never returned to the browser.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 text-sm font-black text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh audit
          </button>
        </div>
        {error ? (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200">
            {error}
          </div>
        ) : null}
        {!data && !error ? (
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-400">
            Loading infrastructure metrics...
          </div>
        ) : null}
      </div>

      {data ? (
        <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/10 text-purple-200">
                  <Server className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="font-black text-white">Railway</h3>
                  <p className="text-xs text-zinc-500">Projected billing usage</p>
                </div>
              </div>
              <StatusBadge status={data.railway.status} />
            </div>
            <p className="mt-4 text-xs leading-5 text-zinc-400">
              {data.railway.message}
            </p>
            {data.railway.warningReasons.length > 0 ? (
              <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                <p className="text-xs font-black text-amber-200">Warning details</p>
                <div className="mt-2 space-y-2">
                  {data.railway.warningReasons.map((reason) => (
                    <div key={reason.code} className="text-xs leading-5 text-zinc-400">
                      <code className="text-[10px] font-bold text-amber-300">
                        {reason.code}
                      </code>
                      <p>{reason.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-zinc-500">Estimated resource cost</p>
                <p className="mt-1 font-black text-white">
                  {money(data.railway.projectedMonthCostMicroUsd)}
                </p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-zinc-500">Credit</p>
                <p className="mt-1 font-black text-white">
                  {money(data.railway.configuredCreditMicroUsd)}
                </p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-zinc-500">Projected balance</p>
                <p
                  className={`mt-1 font-black ${
                    (data.railway.projectedBalanceMicroUsd !== null
                      ? data.railway.projectedBalanceMicroUsd
                      : 0) < 0
                      ? "text-red-300"
                      : "text-emerald-300"
                  }`}
                >
                  {money(data.railway.projectedBalanceMicroUsd)}
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {data.railway.measurements.slice(0, 8).map((measurement) => (
                <div
                  key={`${measurement.projectId || "scope"}-${measurement.measurement}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-zinc-400">
                      {measurement.measurement.replaceAll("_", " ")}
                    </span>
                    <span className="block text-[10px] text-zinc-600">
                      {measurement.estimatedValue.toFixed(3)} {measurement.unit}
                    </span>
                  </span>
                  <span className="shrink-0 font-black text-zinc-200">
                    {measurement.estimatedCostMicroUsd === null
                      ? "Not priced"
                      : money(measurement.estimatedCostMicroUsd)}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-4 text-zinc-600">
              Resource estimate applies Railway&apos;s published CPU, RAM, egress, and
              volume rates to API usage units. Subscription, included usage,
              discounts, taxes, backups, and unclassified resources are excluded;
              Railway Billing remains authoritative.
            </p>
            <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400">
              <p>Token: {data.railway.tokenConfigured ? "configured" : "missing"}</p>
              <p className="mt-1">Scope: {data.railway.scope}</p>
              {data.railway.apiRateLimit.remaining !== null ? (
                <p className="mt-1">
                  API quota: {data.railway.apiRateLimit.remaining}/
                  {data.railway.apiRateLimit.limit ?? "?"} remaining
                </p>
              ) : null}
            </div>
            {canManageCosts ? (
              <div className="mt-4 rounded-xl border border-purple-500/20 bg-purple-500/5 p-3">
                <div className="flex items-center gap-2 text-xs font-black text-purple-100">
                  <Coins className="h-4 w-4" /> Monthly credit
                </div>
                <div className="mt-3 grid gap-2">
                  <input
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.01"
                    value={creditUsd}
                    onChange={(event) => setCreditUsd(event.target.value)}
                    placeholder="Credit in USD"
                    className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-purple-400"
                  />
                  <input
                    type="text"
                    maxLength={300}
                    value={creditNote}
                    onChange={(event) => setCreditNote(event.target.value)}
                    placeholder="Billing note"
                    className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-purple-400"
                  />
                  <button
                    type="button"
                    onClick={() => void saveCredit()}
                    disabled={!creditValid || saving}
                    className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-purple-600 px-3 text-sm font-black text-white transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Save credit
                  </button>
                </div>
              </div>
            ) : null}
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/10 text-orange-200">
                  <Cloud className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="font-black text-white">Cloudflare R2</h3>
                  <p className="text-xs text-zinc-500">
                    {data.r2.bucketName || "Bucket not configured"}
                  </p>
                </div>
              </div>
              <StatusBadge status={data.r2.status} />
            </div>
            <p className="mt-4 text-xs leading-5 text-zinc-400">{data.r2.message}</p>
            <div className="mt-4 space-y-3">
              {[
                {
                  label: "Current storage / 10 GB free-tier reference",
                  value: `${byteLabel(data.r2.storageBytes)} / ${data.r2.storageAllowancePercent === null ? "-" : data.r2.storageAllowancePercent}%`,
                  percent: data.r2.storageAllowancePercent,
                },
                {
                  label: "Class A operations / 1M monthly",
                  value: `${numberLabel(data.r2.classAOperations)} / ${data.r2.classAAllowancePercent === null ? "-" : data.r2.classAAllowancePercent}%`,
                  percent: data.r2.classAAllowancePercent,
                },
                {
                  label: "Class B operations / 10M monthly",
                  value: `${numberLabel(data.r2.classBOperations)} / ${data.r2.classBAllowancePercent === null ? "-" : data.r2.classBAllowancePercent}%`,
                  percent: data.r2.classBAllowancePercent,
                },
              ].map((metric) => (
                <div key={metric.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-zinc-400">{metric.label}</span>
                    <span className="shrink-0 font-black text-white">{metric.value}</span>
                  </div>
                  <AllowanceBar value={metric.percent} />
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-zinc-500">Objects</p>
                <p className="mt-1 text-lg font-black text-white">
                  {numberLabel(data.r2.objectCount)}
                </p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-zinc-500">Pending uploads</p>
                <p className="mt-1 text-lg font-black text-white">
                  {numberLabel(data.r2.pendingUploads)}
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs leading-5 text-zinc-400">
              <p>
                Object credentials: {data.r2.objectCredentialsConfigured ? "configured" : "missing"}
              </p>
              <p>
                Analytics token: {data.r2.analyticsTokenConfigured ? "configured" : "missing"}
              </p>
              <p>Unclassified operations: {numberLabel(data.r2.unclassifiedOperations)}</p>
              <p className="mt-2 text-zinc-500">
                Analytics is operational telemetry, not a final Cloudflare invoice.
              </p>
            </div>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-200">
                  <Database className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="font-black text-white">Application database</h3>
                  <p className="text-xs text-zinc-500">Operational inventory</p>
                </div>
              </div>
              <StatusBadge status={data.database.status} />
            </div>
            <p className="mt-4 text-xs leading-5 text-zinc-400">
              {data.database.message}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              {[
                ["Active sessions", data.database.activeSessions],
                ["Conversations", data.database.conversations],
                ["Messages", data.database.messages],
                ["Usage buckets", data.database.usageBuckets],
                ["Provider errors / 24h", data.database.providerErrors24h],
                ["Errors pending cleanup", data.database.providerErrorsPendingCleanup],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"
                >
                  <p className="text-zinc-500">{label}</p>
                  <p className="mt-1 text-lg font-black text-white">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/5 p-3">
              <div className="flex items-start gap-2">
                <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                <p className="text-xs leading-5 text-zinc-400">
                  Provider error events retain sanitized diagnostics for 30 days. Admin action
                  logs remain separately available under the Audit tab.
                </p>
              </div>
            </div>
          </article>

          <article className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-200">
                  <Gauge className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="font-black text-white">Prisma Postgres</h3>
                  <p className="text-xs text-zinc-500">Monthly operations</p>
                </div>
              </div>
              <StatusBadge status={data.prismaUsage.status} />
            </div>
            <p className="mt-4 text-xs leading-5 text-zinc-400">
              {data.prismaUsage.message}
            </p>
            <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                Total operations
              </p>
              <div className="mt-2 flex items-end justify-between gap-3">
                <p className="text-2xl font-black text-white">
                  {numberLabel(data.prismaUsage.operationsUsed)}
                </p>
                <p className="text-xs text-zinc-400">
                  of {numberLabel(data.prismaUsage.operationsLimit)}
                </p>
              </div>
              <AllowanceBar value={data.prismaUsage.operationsAllowancePercent} />
              <p className="mt-2 text-right text-xs font-bold text-zinc-300">
                {data.prismaUsage.operationsAllowancePercent === null
                  ? "-"
                  : `${data.prismaUsage.operationsAllowancePercent}% used`}
              </p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-zinc-500">Storage</p>
                <p className="mt-1 text-lg font-black text-white">
                  {data.prismaUsage.storageGiB === null
                    ? "-"
                    : `${data.prismaUsage.storageGiB.toFixed(3)} GiB`}
                </p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-zinc-500">Period start</p>
                <p className="mt-1 font-black text-white">
                  {data.prismaUsage.periodStart
                    ? data.prismaUsage.periodStart.slice(0, 10)
                    : "-"}
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs leading-5 text-zinc-400">
              <p>
                Management token: {data.prismaUsage.tokenConfigured ? "configured" : "missing"}
              </p>
              <p>
                Database ID: {data.prismaUsage.databaseIdConfigured ? "configured" : "missing"}
              </p>
              <p className="mt-2 text-zinc-500">
                The limit is configurable because Prisma plan allowances can change.
              </p>
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
