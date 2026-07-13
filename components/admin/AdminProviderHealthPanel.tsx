"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  CircleDollarSign,
  RefreshCw,
  Save,
} from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { getEnabledModel, type AiProvider } from "@/lib/models";
import type {
  ProviderHealthDashboard,
  ProviderHealthRow,
  ProviderHealthStatus,
} from "@/lib/providerMonitoring";

const REFRESH_INTERVAL_MS = 30_000;

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;
const optionalMoney = (microUsd: number | null) =>
  microUsd === null ? "Not synced" : money(microUsd);
const dateLabel = (value: string | null, fallback = "No success yet") => {
  if (!value) return fallback;
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
};
const statusCopy: Record<ProviderHealthStatus, string> = {
  available: "Available",
  limited: "Limited",
  outage: "Outage",
};
const statusClass: Record<ProviderHealthStatus, string> = {
  available: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  limited: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  outage: "border-red-500/30 bg-red-500/10 text-red-300",
};
const statusPanelClass: Record<ProviderHealthStatus, string> = {
  available: "border-emerald-500/20 bg-emerald-500/5",
  limited: "border-amber-500/25 bg-amber-500/5",
  outage: "border-red-500/25 bg-red-500/5",
};
const balanceSourceCopy: Record<ProviderHealthRow["balanceSource"], string> = {
  api: "provider API",
  db_estimate: "DB estimate",
  env_manual: "environment value",
  unavailable: "not configured",
};
const budgetClass = (value: number) => {
  if (value >= 95) return "text-red-300";
  if (value >= 80) return "text-amber-300";
  if (value >= 50) return "text-sky-300";
  return "text-emerald-300";
};
const apiKeyClass = (configured: boolean) =>
  configured
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-zinc-700 bg-zinc-900 text-zinc-400";

type SaveCredit = (
  provider: AiProvider,
  creditUsd: number,
  note: string
) => Promise<boolean>;

function ProviderRow({
  provider,
  canManageCredits,
  savingCredit,
  onSaveCredit,
}: {
  provider: ProviderHealthRow;
  canManageCredits: boolean;
  savingCredit: boolean;
  onSaveCredit: SaveCredit;
}) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [creditEditorOpen, setCreditEditorOpen] = useState(false);
  const [creditUsd, setCreditUsd] = useState(
    provider.credit.configuredCreditMicroUsd === null
      ? ""
      : (provider.credit.configuredCreditMicroUsd / 1_000_000).toFixed(2)
  );
  const [creditNote, setCreditNote] = useState(provider.credit.note || "");
  const fallbackModels = provider.fallback.recommendedModelIds
    .map((id) => getEnabledModel(id))
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .map((model) => model.name);
  const varianceLabel =
    provider.usageVariancePercent === null
      ? "No reconciliation yet"
      : `${provider.usageVariancePercent > 0 ? "+" : ""}${provider.usageVariancePercent}%`;
  const statusDetailsId = `provider-status-${provider.provider}`;
  const parsedCreditUsd = Number(creditUsd);
  const creditIsValid =
    creditUsd.trim().length > 0 &&
    Number.isFinite(parsedCreditUsd) &&
    parsedCreditUsd >= 0 &&
    parsedCreditUsd <= 1_000_000;
  const estimatedBalance = provider.credit.estimatedBalanceMicroUsd;

  const toggleCreditEditor = () => {
    if (!creditEditorOpen) {
      setCreditUsd(
        provider.credit.configuredCreditMicroUsd === null
          ? ""
          : (provider.credit.configuredCreditMicroUsd / 1_000_000).toFixed(2)
      );
      setCreditNote(provider.credit.note || "");
    }
    setCreditEditorOpen((open) => !open);
  };

  const submitCredit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!creditIsValid || savingCredit) return;
    const saved = await onSaveCredit(
      provider.provider,
      parsedCreditUsd,
      creditNote
    );
    if (saved) setCreditEditorOpen(false);
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <ModelLogo provider={provider.provider} size="lg" className="ring-zinc-800" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-white">
                {provider.displayName}
              </h2>
              <button
                type="button"
                onClick={() => setStatusOpen((open) => !open)}
                aria-expanded={statusOpen}
                aria-controls={statusDetailsId}
                title="Show the status decision details"
                className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-125 ${statusClass[provider.status]}`}
              >
                {statusCopy[provider.status]}
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${statusOpen ? "rotate-180" : ""}`}
                />
              </button>
              <span
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${apiKeyClass(provider.apiKeyConfigured)}`}
              >
                {provider.apiKeyConfigured ? "API key set" : "API key missing"}
              </span>
            </div>
            <p className="mt-2 text-sm text-zinc-400">
              Last good response: {dateLabel(provider.lastSuccessAt)}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:min-w-[520px]">
          <Metric
            label="Success rate"
            value={
              provider.successRate24h === null
                ? "No traffic"
                : `${provider.successRate24h}%`
            }
          />
          <Metric
            label="24h calls"
            value={`${provider.successCount24h} / ${provider.failureCount24h}`}
          />
          <Metric label="Recent error" value={provider.recentErrorCode || "None"} />
          <Metric
            label="Budget used"
            value={`${provider.budgetUsagePercent}%`}
            valueClass={budgetClass(provider.budgetUsagePercent)}
          />
        </div>
      </div>

      {statusOpen && (
        <div
          id={statusDetailsId}
          className={`mt-4 rounded-2xl border p-4 ${statusPanelClass[provider.status]}`}
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-zinc-300" />
            <h3 className="text-sm font-bold text-white">
              Why {provider.displayName} is {statusCopy[provider.status]}
            </h3>
          </div>
          <div className="mt-3 grid gap-2">
            {provider.statusReasons.map((reason) => (
              <div
                key={reason.code}
                className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-100">
                    {reason.title}
                  </span>
                  <code className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {reason.code}
                  </code>
                </div>
                <p className="mt-1 text-xs leading-5 text-zinc-400">
                  {reason.detail}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-zinc-500">
            Policy: Limited when any provider failure is recorded or monthly
            internal budget reaches 80%. Outage when the API key is missing,
            budget reaches 100%, or failures reach max(5, successful calls).
          </p>
        </div>
      )}

      <div className="mt-5 grid gap-4 border-t border-zinc-800 pt-5 lg:grid-cols-3">
        <div>
          <PanelLabel>Usage / Cost</PanelLabel>
          <p className="mt-2 text-sm font-semibold text-zinc-200">
            Today internal {money(provider.todayCostMicroUsd)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Month internal {money(provider.monthCostMicroUsd)} of{" "}
            {money(provider.monthBudgetMicroUsd)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Provider reported {optionalMoney(provider.providerReportedMonthCostMicroUsd)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Balance{" "}
            {provider.balanceUsd === null
              ? "Not configured"
              : `$${provider.balanceUsd.toFixed(2)}`} ({balanceSourceCopy[provider.balanceSource]})
          </p>
          <p className="mt-1 text-xs text-zinc-500">Variance {varianceLabel}</p>
          <p className="mt-1 text-xs text-zinc-500">Source: {provider.usageSource}</p>
          <p className="mt-1 text-xs text-zinc-500">
            Last usage sync {dateLabel(provider.lastUsageSyncAt)}
          </p>
        </div>
        <div>
          <PanelLabel>Alerts</PanelLabel>
          <p className="mt-2 text-sm text-zinc-300">
            Alert threshold:{" "}
            {provider.alertLevel === "none"
              ? "below 50%"
              : `${provider.alertLevel}% reached`}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Failure surge status is based on recent provider errors.
          </p>
        </div>
        <div>
          <PanelLabel>Fallback Policy</PanelLabel>
          <p className="mt-2 text-sm text-zinc-300">{provider.fallback.reason}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {fallbackModels.join(" / ") || "No fallback model configured"}
          </p>
        </div>
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <CircleDollarSign className="mt-0.5 h-5 w-5 text-emerald-300" />
            <div>
              <PanelLabel>Manual credit checkpoint</PanelLabel>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                Saves an opening credit in DB and subtracts internal estimated
                usage recorded after the checkpoint. This estimate does not
                change provider routing or health status.
              </p>
            </div>
          </div>
          {canManageCredits && (
            <button
              type="button"
              onClick={toggleCreditEditor}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800"
            >
              {creditEditorOpen ? "Close editor" : "Set credit"}
            </button>
          )}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Metric
            label="Opening credit"
            value={
              provider.credit.configuredCreditMicroUsd === null
                ? "Not configured"
                : money(provider.credit.configuredCreditMicroUsd)
            }
          />
          <Metric
            label="Tracked usage"
            value={money(provider.credit.usedSinceCheckpointMicroUsd)}
          />
          <Metric
            label="Estimated remaining"
            value={estimatedBalance === null ? "Not configured" : money(estimatedBalance)}
            valueClass={
              estimatedBalance !== null && estimatedBalance < 0
                ? "text-red-300"
                : "text-emerald-300"
            }
          />
        </div>
        {provider.credit.checkpointAt && (
          <p className="mt-2 text-[11px] text-zinc-500">
            Checkpoint {dateLabel(provider.credit.checkpointAt, "Not configured")}
            {provider.credit.note ? ` · ${provider.credit.note}` : ""}
          </p>
        )}
        {!canManageCredits && (
          <p className="mt-2 text-[11px] text-zinc-600">
            Billing write permission is required to change provider credit.
          </p>
        )}
        {creditEditorOpen && canManageCredits && (
          <form
            onSubmit={submitCredit}
            className="mt-4 grid gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto] md:items-end"
          >
            <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
              Current credit (USD)
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="1000000"
                step="0.01"
                value={creditUsd}
                onChange={(event) => setCreditUsd(event.target.value)}
                placeholder="100.00"
                className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-emerald-500"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-zinc-300">
              Note (optional)
              <input
                type="text"
                maxLength={300}
                value={creditNote}
                onChange={(event) => setCreditNote(event.target.value)}
                placeholder="Anthropic console balance checked"
                className="h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-emerald-500"
              />
            </label>
            <button
              type="submit"
              disabled={!creditIsValid || savingCredit}
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {savingCredit ? "Saving" : "Save checkpoint"}
            </button>
          </form>
        )}
      </div>

      <div className="mt-5 grid gap-4 border-t border-zinc-800 pt-5 lg:grid-cols-2">
        <div>
          <PanelLabel>Recent error log</PanelLabel>
          {provider.recentErrors.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              No provider errors recorded today.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {provider.recentErrors.map((error) => (
                <div
                  key={`${error.code}-${error.updatedAt}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 truncate font-semibold text-zinc-200">
                    {error.code}
                  </span>
                  <span className="shrink-0 text-zinc-500">
                    {error.count} / {dateLabel(error.updatedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <PanelLabel>Model 5-minute incidents</PanelLabel>
          {provider.modelIncidents.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              No model-specific incidents in the current 5-minute window.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {provider.modelIncidents.map((incident) => (
                <div
                  key={incident.modelId}
                  className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-semibold text-red-100">
                      {incident.modelName}
                    </span>
                    <span className="shrink-0 text-red-200">
                      {incident.failureCount5m} failures
                    </span>
                  </div>
                  <p className="mt-1 truncate text-red-200/70">
                    {incident.recentErrorCode || "UNKNOWN"} /{" "}
                    {dateLabel(incident.updatedAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  valueClass = "text-white",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="text-zinc-500">{label}</div>
      <div className={`mt-1 truncate font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
      {children}
    </div>
  );
}

export function AdminProviderHealthPanel({
  initialDashboard,
  canManageCredits,
}: {
  initialDashboard: ProviderHealthDashboard;
  canManageCredits: boolean;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [refreshing, setRefreshing] = useState(false);
  const [savingProvider, setSavingProvider] = useState<AiProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/admin/provider-health", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Provider API returned ${response.status}.`);
      }
      const nextDashboard = (await response.json()) as ProviderHealthDashboard;
      setDashboard(nextDashboard);
      setError(null);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Provider data refresh failed."
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  const saveProviderCredit = useCallback<SaveCredit>(
    async (provider, creditUsd, note) => {
      setSavingProvider(provider);
      try {
        const response = await fetch("/api/admin/provider-credits", {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ provider, creditUsd, note: note || null }),
        });
        const data = (await response.json().catch(() => null)) as
          | ProviderHealthDashboard
          | { error?: string }
          | null;
        if (!response.ok) {
          throw new Error(
            data && "error" in data && data.error
              ? data.error
              : `Credit API returned ${response.status}.`
          );
        }
        setDashboard(data as ProviderHealthDashboard);
        setError(null);
        return true;
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Provider credit update failed."
        );
        return false;
      } finally {
        setSavingProvider(null);
      }
    },
    []
  );

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshDashboard();
    };
    const initialRefresh = window.setTimeout(refreshWhenVisible, 0);
    const interval = window.setInterval(refreshWhenVisible, REFRESH_INTERVAL_MS);
    window.addEventListener("tomverse:provider-health-refresh", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(initialRefresh);
      window.removeEventListener(
        "tomverse:provider-health-refresh",
        refreshWhenVisible
      );
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [refreshDashboard]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold text-zinc-200">Live admin API panel</p>
          <p className="mt-1 text-xs text-zinc-500">
            Admin API refreshes every 30 seconds · Updated{" "}
            {dateLabel(dashboard.generatedAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshDashboard()}
          disabled={refreshing}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing" : "Refresh now"}
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-200"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error} Showing the last successful snapshot.
        </div>
      )}
      {dashboard.providers.map((provider) => (
        <ProviderRow
          key={provider.provider}
          provider={provider}
          canManageCredits={canManageCredits}
          savingCredit={savingProvider === provider.provider}
          onSaveCredit={saveProviderCredit}
        />
      ))}
    </div>
  );
}
