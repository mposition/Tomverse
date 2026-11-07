"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Coins, Database, Gauge, Loader2, RefreshCw, Save, Server } from "lucide-react";
import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { dispatchAppToast } from "@/lib/appToast";
import { adminInfrastructureMessages } from "@/lib/adminMessages/infrastructure";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import {
  RAILWAY_USAGE_MONITOR_DISABLED_MESSAGE,
  type InfrastructureDashboard,
  type InfrastructureStatus,
} from "@/lib/infrastructureTypes";
import { adminFetch } from "@/lib/adminFetch";
import {
  shouldIssueAdminPoll,
  type AdminPollTrigger,
} from "@/lib/adminPollTick";

const REFRESH_INTERVAL_MS = 10 * 60_000;

// Every status has a tone. `disabled` is an operator's choice, so it is idle
// and never red or amber; `unconfigured` is dashed ("unknown") because nobody
// has set the monitor up, which is not the same as healthy.
const STATUS_TONE: Record<InfrastructureStatus, AdminTone> = {
  healthy: "ok",
  warning: "warn",
  unconfigured: "unknown",
  disabled: "idle",
  error: "bad",
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

function AllowanceBar({ value, label }: { value: number | null; label: string }) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, value));
  const color =
    value !== null && value >= 90
      ? "bg-red-500"
      : value !== null && value >= 70
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : width}
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"
    >
      <div className={`h-full rounded-full ${color}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function StatusBadge({ status }: { status: InfrastructureStatus }) {
  const m = useAdminMessages(adminInfrastructureMessages);
  return <AdminStatusChip tone={STATUS_TONE[status]}>{m.status[status]}</AdminStatusChip>;
}

/** One service at the top of the page: who it is, how it is, and its one number. */
function ServiceCard({
  icon,
  title,
  subtitle,
  status,
  headline,
  detail,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  status: InfrastructureStatus;
  headline: string | null;
  detail: string;
  testId: string;
}) {
  const m = useAdminMessages(adminInfrastructureMessages);
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-200">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold text-white">{title}</h3>
          <p className="truncate text-xs text-zinc-500">{subtitle}</p>
        </div>
        <StatusBadge status={status} />
      </div>
      <p
        className={`truncate font-bold tabular-nums tracking-tight ${
          headline === null ? "text-xl text-zinc-400" : "text-2xl text-white"
        }`}
      >
        {headline ?? m.unavailable}
      </p>
      <p className="text-xs text-zinc-500">{detail}</p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "bad" | "ok" }) {
  return (
    <div className="rounded-xl bg-zinc-950/50 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p
        className={`mt-1 text-lg font-bold tabular-nums ${
          tone === "bad" ? "text-red-300" : tone === "ok" ? "text-emerald-300" : "text-white"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function WarningList({
  title,
  reasons,
}: {
  title: string;
  reasons: ReadonlyArray<{ code: string; detail: string }> | undefined;
}) {
  if (!reasons || reasons.length === 0) return null;
  return (
    <div className="rounded-xl bg-amber-500/10 p-3" role="status">
      <p className="text-xs font-bold text-amber-200">{title}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {reasons.map((reason) => (
          <li key={reason.code} className="text-xs leading-5 text-zinc-300">
            <code className="mr-1 text-[10px] font-bold text-amber-300">{reason.code}</code>
            {reason.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AdminInfrastructurePanel({
  canManageCosts,
}: {
  canManageCosts: boolean;
}) {
  const m = useAdminMessages(adminInfrastructureMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [data, setData] = useState<InfrastructureDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditUsd, setCreditUsd] = useState("");
  const [creditNote, setCreditNote] = useState("");

  // Not state: a re-render must not be able to clear it, and nothing renders
  // from it. Read and written inside one synchronous stretch of `load`.
  const inFlight = useRef(false);

  const load = useCallback(async (trigger: AdminPollTrigger = "manual") => {
    if (
      !shouldIssueAdminPoll({
        inFlight: inFlight.current,
        documentVisible:
          typeof document === "undefined" ||
          document.visibilityState === "visible",
        trigger,
      })
    ) {
      return;
    }
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/infrastructure", {
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
            : messagesRef.current.loadFailed
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
          : messagesRef.current.loadFailed
      );
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load("manual"));
    // Ten minutes, and until now it kept running in a background tab with
    // nobody reading it. `shouldIssueAdminPoll` decides; the timer only asks.
    const timer = window.setInterval(() => void load("interval"), REFRESH_INTERVAL_MS);
    const refresh = () => void load("event");
    window.addEventListener("admin:refresh", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("admin:refresh", refresh);
    };
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
      const response = await adminFetch("/api/admin/infrastructure", {
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
        throw new Error(payload?.error || m.saveCreditFailed);
      }
      dispatchAppToast(m.creditSaved, "success");
      await load();
    } catch (saveError) {
      dispatchAppToast(
        saveError instanceof Error
          ? saveError.message
          : m.saveCreditFailed,
        "error"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminInfrastructureView
      data={data}
      loading={loading}
      error={error}
      saving={saving}
      canManageCosts={canManageCosts}
      creditUsd={creditUsd}
      creditNote={creditNote}
      creditValid={creditValid}
      onCreditUsd={setCreditUsd}
      onCreditNote={setCreditNote}
      onRefresh={() => void load()}
      onSaveCredit={() => void saveCredit()}
    />
  );
}

/** The hook-free half: the four service cards and their detail tiles. */
export function AdminInfrastructureView({
  data,
  loading,
  error,
  saving,
  canManageCosts,
  creditUsd,
  creditNote,
  creditValid,
  onCreditUsd,
  onCreditNote,
  onRefresh,
  onSaveCredit,
}: {
  data: InfrastructureDashboard | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  canManageCosts: boolean;
  creditUsd: string;
  creditNote: string;
  creditValid: boolean;
  onCreditUsd: (value: string) => void;
  onCreditNote: (value: string) => void;
  onRefresh: () => void;
  onSaveCredit: () => void;
}) {
  const m = useAdminMessages(adminInfrastructureMessages);
  const { locale } = useAdminLocale();
  const stamp = data ? formatAestDateTime(data.generatedAt) : null;

  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="admin-infrastructure">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-zinc-400">
          {m.description}
          {stamp ? <span className="ml-2 text-zinc-500">{m.checkedAt(stamp)}</span> : null}
        </p>
        <button
          type="button"
          onClick={() => onRefresh()}
          disabled={loading}
          className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden />
          )}
          {m.refresh}
        </button>
      </div>

      {error ? (
        <AdminStateBlock
          kind="error"
          title={error}
          detail={m.loadFailedDetail}
          onRetry={() => onRefresh()}
        />
      ) : null}
      {!data && !error ? <AdminStateBlock kind="loading" /> : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <ServiceCard
              testId="infra-card-railway"
              icon={<Server className="h-5 w-5" aria-hidden />}
              title={m.railway.title}
              subtitle="Railway"
              status={data.railway.status}
              headline={
                data.railway.projectedMonthCostMicroUsd === null
                  ? null
                  : money(data.railway.projectedMonthCostMicroUsd)
              }
              detail={m.railway.headline}
            />
            <ServiceCard
              testId="infra-card-r2"
              icon={<Cloud className="h-5 w-5" aria-hidden />}
              title={m.r2.title}
              subtitle={
                data.r2.bucketName ? m.r2.subtitle(data.r2.bucketName) : m.r2.bucketNotConfigured
              }
              status={data.r2.status}
              headline={data.r2.storageBytes === null ? null : byteLabel(data.r2.storageBytes)}
              detail={m.r2.storage}
            />
            <ServiceCard
              testId="infra-card-database"
              icon={<Database className="h-5 w-5" aria-hidden />}
              title={m.database.title}
              subtitle={m.database.subtitle}
              status={data.database.status}
              headline={numberLabel(data.database.activeSessions)}
              detail={m.database.activeSessions}
            />
            <ServiceCard
              testId="infra-card-prisma"
              icon={<Gauge className="h-5 w-5" aria-hidden />}
              title={m.prisma.title}
              subtitle={m.prisma.subtitle}
              status={data.prismaUsage.status}
              headline={
                data.prismaUsage.operationsUsed === null
                  ? null
                  : `${numberLabel(data.prismaUsage.operationsUsed)} ${m.prisma.of(numberLabel(data.prismaUsage.operationsLimit))}`
              }
              detail={m.prisma.totalOperations}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <AdminTile title={m.railway.title} description={data.railway.message}>
              {data.railway.status === "disabled" ? (
                <div
                  className="rounded-xl bg-zinc-950/50 p-3"
                  data-testid="railway-usage-monitor-disabled"
                >
                  <p className="text-xs font-bold text-zinc-200">
                    {locale === "ko"
                      ? m.railway.disabledTitle
                      : RAILWAY_USAGE_MONITOR_DISABLED_MESSAGE}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">
                    {m.railway.disabledBefore}
                    <code className="text-[10px] font-bold text-zinc-300">
                      RAILWAY_USAGE_MONITOR_ENABLED=false
                    </code>
                    {m.railway.disabledAfter}
                  </p>
                </div>
              ) : null}
              <WarningList title={m.railway.warningDetails} reasons={data.railway.warningReasons} />
              <div className="grid grid-cols-3 gap-2">
                <Stat
                  label={m.railway.estimatedCost}
                  value={money(data.railway.projectedMonthCostMicroUsd)}
                />
                <Stat label={m.railway.credit} value={money(data.railway.configuredCreditMicroUsd)} />
                <Stat
                  label={m.railway.projectedBalance}
                  value={money(data.railway.projectedBalanceMicroUsd)}
                  tone={
                    data.railway.projectedBalanceMicroUsd === null
                      ? undefined
                      : data.railway.projectedBalanceMicroUsd < 0
                        ? "bad"
                        : "ok"
                  }
                />
              </div>
              {data.railway.measurements.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-zinc-500">{m.railway.measurements}</p>
                  <ul className="mt-2 flex flex-col">
                    {data.railway.measurements.slice(0, 8).map((measurement) => (
                      <li
                        key={`${measurement.projectId || "scope"}-${measurement.measurement}`}
                        className="flex items-center justify-between gap-3 border-t border-zinc-800 py-2 text-xs first:border-t-0"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-zinc-300">
                            {measurement.measurement.replaceAll("_", " ")}
                          </span>
                          <span className="block text-[10px] text-zinc-500">
                            {measurement.estimatedValue.toFixed(3)} {measurement.unit}
                          </span>
                        </span>
                        <span className="shrink-0 font-bold text-zinc-200">
                          {measurement.estimatedCostMicroUsd === null
                            ? m.railway.notPriced
                            : money(measurement.estimatedCostMicroUsd)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-[11px] leading-4 text-zinc-500">{m.railway.estimateNote}</p>
              <AdminTechInfo summary={m.connection}>
                <p>
                  {m.railway.token}: {data.railway.tokenConfigured ? m.configured : m.missing}
                </p>
                <p className="mt-1">
                  {m.railway.scope}: {data.railway.scope}
                </p>
                {data.railway.apiRateLimit.remaining !== null ? (
                  <p className="mt-1">
                    {m.railway.apiQuota(
                      data.railway.apiRateLimit.remaining,
                      data.railway.apiRateLimit.limit ?? "?"
                    )}
                  </p>
                ) : null}
              </AdminTechInfo>
              {canManageCosts ? (
                <div className="rounded-xl bg-zinc-950/50 p-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-zinc-100">
                    <Coins className="h-4 w-4" aria-hidden /> {m.railway.monthlyCredit}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{m.railway.creditHelp}</p>
                  <div className="mt-3 grid gap-2">
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={creditUsd}
                      onChange={(event) => onCreditUsd(event.target.value)}
                      placeholder={m.railway.creditPlaceholder}
                      aria-label={m.railway.creditPlaceholder}
                      className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-400"
                    />
                    <input
                      type="text"
                      maxLength={300}
                      value={creditNote}
                      onChange={(event) => onCreditNote(event.target.value)}
                      placeholder={m.railway.notePlaceholder}
                      aria-label={m.railway.notePlaceholder}
                      className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-400"
                    />
                    <AdminWriteButton
                      onClick={() => onSaveCredit()}
                      disabled={!creditValid || saving}
                    >
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Save className="h-4 w-4" aria-hidden />
                      )}
                      {m.railway.saveCredit}
                    </AdminWriteButton>
                  </div>
                </div>
              ) : null}
            </AdminTile>

            <AdminTile title={m.r2.title} description={data.r2.message}>
              <WarningList title={m.railway.warningDetails} reasons={data.r2.warningReasons} />
              <div className="flex flex-col gap-3">
                {[
                  {
                    label: m.r2.storage,
                    value: `${byteLabel(data.r2.storageBytes)} / ${data.r2.storageAllowancePercent === null ? "-" : data.r2.storageAllowancePercent}%`,
                    percent: data.r2.storageAllowancePercent,
                  },
                  {
                    label: m.r2.classA,
                    value: `${numberLabel(data.r2.classAOperations)} / ${data.r2.classAAllowancePercent === null ? "-" : data.r2.classAAllowancePercent}%`,
                    percent: data.r2.classAAllowancePercent,
                  },
                  {
                    label: m.r2.classB,
                    value: `${numberLabel(data.r2.classBOperations)} / ${data.r2.classBAllowancePercent === null ? "-" : data.r2.classBAllowancePercent}%`,
                    percent: data.r2.classBAllowancePercent,
                  },
                ].map((metric) => (
                  <div key={metric.label}>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-zinc-400">{metric.label}</span>
                      <span className="shrink-0 font-bold text-white">{metric.value}</span>
                    </div>
                    <AllowanceBar value={metric.percent} label={metric.label} />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Stat label={m.r2.objects} value={numberLabel(data.r2.objectCount)} />
                <Stat label={m.r2.pendingUploads} value={numberLabel(data.r2.pendingUploads)} />
              </div>
              <p className="text-[11px] text-zinc-500">{m.r2.analyticsNote}</p>
              <AdminTechInfo summary={m.connection}>
                <p>
                  {m.r2.objectCredentials}:{" "}
                  {data.r2.objectCredentialsConfigured ? m.configured : m.missing}
                </p>
                <p className="mt-1">
                  {m.r2.analyticsToken}: {data.r2.analyticsTokenConfigured ? m.configured : m.missing}
                </p>
                <p className="mt-1">
                  {m.r2.unclassifiedOperations}: {numberLabel(data.r2.unclassifiedOperations)}
                </p>
              </AdminTechInfo>
            </AdminTile>

            <AdminTile title={m.database.title} description={data.database.message}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label={m.database.activeSessions} value={data.database.activeSessions} />
                <Stat label={m.database.conversations} value={data.database.conversations} />
                <Stat label={m.database.messages} value={data.database.messages} />
                <Stat label={m.database.usageBuckets} value={data.database.usageBuckets} />
                <Stat label={m.database.providerErrors24h} value={data.database.providerErrors24h} />
                <Stat
                  label={m.database.errorsPendingCleanup}
                  value={data.database.providerErrorsPendingCleanup}
                />
                <Stat
                  label={m.database.errorsOverdueCleanup}
                  value={data.database.providerErrorsOverdueCleanup}
                  tone={data.database.providerErrorsOverdueCleanup > 0 ? "bad" : undefined}
                />
              </div>
              <p className="text-xs leading-5 text-zinc-500">{m.database.retentionNote}</p>
            </AdminTile>

            <AdminTile title={m.prisma.title} description={data.prismaUsage.message}>
              <WarningList title={m.railway.warningDetails} reasons={data.prismaUsage.warningReasons} />
              <div className="rounded-xl bg-zinc-950/50 p-4">
                <p className="text-xs font-medium text-zinc-500">{m.prisma.totalOperations}</p>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <p className="text-2xl font-bold tabular-nums text-white">
                    {numberLabel(data.prismaUsage.operationsUsed)}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {m.prisma.of(numberLabel(data.prismaUsage.operationsLimit))}
                  </p>
                </div>
                <AllowanceBar
                  value={data.prismaUsage.operationsAllowancePercent}
                  label={m.prisma.totalOperations}
                />
                <p className="mt-2 text-right text-xs font-bold text-zinc-300">
                  {data.prismaUsage.operationsAllowancePercent === null
                    ? "-"
                    : m.prisma.percentUsed(data.prismaUsage.operationsAllowancePercent)}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Stat
                  label={m.prisma.storage}
                  value={
                    data.prismaUsage.storageGiB === null
                      ? "-"
                      : `${data.prismaUsage.storageGiB.toFixed(3)} GiB`
                  }
                />
                <Stat
                  label={m.prisma.periodStart}
                  value={data.prismaUsage.periodStart ? data.prismaUsage.periodStart.slice(0, 10) : "-"}
                />
              </div>
              <p className="text-[11px] text-zinc-500">{m.prisma.limitNote}</p>
              <AdminTechInfo summary={m.connection}>
                <p>
                  {m.prisma.managementToken}: {data.prismaUsage.tokenConfigured ? m.configured : m.missing}
                </p>
                <p className="mt-1">
                  {m.prisma.databaseId}:{" "}
                  {data.prismaUsage.databaseIdConfigured ? m.configured : m.missing}
                </p>
              </AdminTechInfo>
            </AdminTile>
          </div>
        </>
      ) : null}
    </section>
  );
}
