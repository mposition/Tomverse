"use client";

import { useCallback, useEffect, useState } from "react";
import { Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";

// The operations view over GET /api/admin/image-generation (PR 4): budget
// configuration vs enforcement vs usage, reservation vs settlement, failure
// phases, storage growth, and the invariants the maintenance sweep audits.
// Internal micro-USD is shown on purpose -- this is the admin surface.

type AdminImageGenerationReport = {
  flagEnabled: boolean;
  pricing: {
    pricingVersion: string;
    priceVerifiedAt: string;
    ceilingMicroUsdPerCredit: number;
    worstCostMicroUsdPerCredit: number;
    ceilingHeadroomMicroUsd: number;
  };
  models: Array<{
    id: string;
    provider: string;
    name: string;
    lifecycle: string;
    disabledReason: string | null;
    disabledNote: string | null;
    pricingVersion: string;
    priceVerifiedAt: string | null;
    optionCount: number;
  }>;
  budget: {
    source: string;
    floorMicroUsd: number;
    limits: { day: number; month: number } | null;
    clamped: Array<{
      window: string;
      configuredMicroUsd: number;
      effectiveMicroUsd: number;
    }>;
    problems: Array<{ window: string; reason: string; message: string }>;
    usedTodayMicroUsd: number;
    usedThisMonthMicroUsd: number;
  };
  generations: {
    byStatus: Record<string, number>;
    failuresByPhase: Record<string, number>;
  };
  reservations: {
    total: number;
    reservedCredits: number;
    settledCredits: number;
    reservedCostMicroUsd: number;
    settledCostMicroUsd: number;
    reservedFundedCostMicroUsd: number;
    settledFundedCostMicroUsd: number;
    settledByOption: Array<{
      quality: string;
      size: string;
      count: number;
      averageSettledCostMicroUsd: number;
    }>;
  };
  settledByProviderModel: Array<{
    provider: string;
    modelId: string;
    settlements: number;
    settledCredits: number;
    settledCostMicroUsd: number;
  }>;
  dimensionCoverage: Array<{
    provider: string;
    succeeded: number;
    measured: number;
  }>;
  storage: {
    byRole: Record<string, { count: number; byteSize: number }>;
  };
  invariants: {
    emptyImageConversations: number;
    staleGenerations: number;
    strandedSettlements: number;
    cleanupBacklog: number;
  };
};

const usd = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;
const micro = (microUsd: number) => `${microUsd.toLocaleString()}µ`;
const bytes = (value: number) => {
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(2)} GB`;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${value} B`;
};
const percentOf = (used: number, limit: number | undefined) =>
  !limit || limit <= 0 ? null : Math.round((used / limit) * 1000) / 10;

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-black text-white">{value}</p>
      {detail && <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>}
    </div>
  );
}

export function AdminImageGenerationPanel() {
  const [report, setReport] = useState<AdminImageGenerationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts true: the mount effect immediately loads, and setting it there
  // synchronously would be a set-state-in-effect violation -- every state
  // write in load() happens after the first await instead.
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/image-generation", { cache: "no-store" });
      setError(null);
      const data = (await response.json().catch(() => null)) as
        | AdminImageGenerationReport
        | { error?: string }
        | null;
      if (!response.ok || !data || "error" in data || !("budget" in data)) {
        throw new Error(
          (data && "error" in data && data.error) || "Failed to load the image generation report."
        );
      }
      setReport(data as AdminImageGenerationReport);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load the image generation report."
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so no state write is synchronous within the effect --
    // the same idiom the other admin panels use for their mount load.
    queueMicrotask(() => void load());
  }, [load]);

  const invariantIssues = report
    ? report.invariants.emptyImageConversations +
      report.invariants.staleGenerations
    : 0;

  return (
    <section
      data-testid="admin-image-generation-panel"
      className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 shadow-2xl shadow-black/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 p-5">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-200">
            <ImageIcon className="h-3.5 w-3.5" />
            Image generation
          </div>
          <h2 className="mt-3 text-2xl font-black text-white">Budget, billing and lifecycle</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Provider budget enforcement vs usage, reservation vs settlement, failure phases,
            storage growth, and the maintenance-sweep invariants (docs/policy/image-generation.md).
          </p>
        </div>
        <div className="flex items-center gap-3">
          {report && (
            <span
              className={`rounded-full border px-3 py-1 text-xs font-bold ${
                report.flagEnabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400"
              }`}
            >
              {report.flagEnabled ? "Flag ON" : "Flag OFF"}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setIsLoading(true);
              void load();
            }}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="border-b border-red-900/50 bg-red-950/30 px-5 py-3 text-sm font-semibold text-red-300">
          {error}
        </p>
      )}

      {report && (
        <div className="grid gap-5 p-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Budget today"
              value={`${usd(report.budget.usedTodayMicroUsd)} / ${
                report.budget.limits ? usd(report.budget.limits.day) : "unconfigured"
              }`}
              detail={
                percentOf(report.budget.usedTodayMicroUsd, report.budget.limits?.day) !== null
                  ? `${percentOf(report.budget.usedTodayMicroUsd, report.budget.limits?.day)}% of the daily cap · source: ${report.budget.source}`
                  : `source: ${report.budget.source}`
              }
            />
            <Stat
              label="Budget this month"
              value={`${usd(report.budget.usedThisMonthMicroUsd)} / ${
                report.budget.limits ? usd(report.budget.limits.month) : "unconfigured"
              }`}
              detail={`floor ${usd(report.budget.floorMicroUsd)}${
                report.budget.clamped.length > 0
                  ? ` · ${report.budget.clamped.length} override(s) raised to the floor`
                  : ""
              }`}
            />
            <Stat
              label="Per-credit cost ceiling"
              value={`${micro(report.pricing.worstCostMicroUsdPerCredit)} / ${micro(report.pricing.ceilingMicroUsdPerCredit)}`}
              detail={`${micro(report.pricing.ceilingHeadroomMicroUsd)} headroom · ${report.pricing.pricingVersion} · verified ${report.pricing.priceVerifiedAt.slice(0, 10)}`}
            />
            <Stat
              label="Invariants"
              value={invariantIssues === 0 ? "clean" : `${invariantIssues} issue(s)`}
              detail={`${report.invariants.emptyImageConversations} empty conversations · ${report.invariants.staleGenerations} stale (${report.invariants.strandedSettlements} stranded mid-settlement) · ${report.invariants.cleanupBacklog} cleanup backlog`}
            />
          </div>

          {report.budget.problems.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
              {report.budget.problems.map((problem) => (
                <p key={`${problem.window}:${problem.reason}`}>{problem.message}</p>
              ))}
            </div>
          )}

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
              <h3 className="text-sm font-black uppercase tracking-[0.14em] text-zinc-400">
                Generations
              </h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(report.generations.byStatus).length === 0 && (
                  <p className="text-sm text-zinc-500">No generations yet.</p>
                )}
                {Object.entries(report.generations.byStatus).map(([status, count]) => (
                  <span
                    key={status}
                    className={`rounded-full border px-3 py-1 text-xs font-bold ${
                      status === "succeeded"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : status === "failed"
                          ? "border-red-500/30 bg-red-500/10 text-red-300"
                          : "border-zinc-700 bg-zinc-900 text-zinc-300"
                    }`}
                  >
                    {status} · {count}
                  </span>
                ))}
              </div>
              {Object.entries(report.generations.failuresByPhase).length > 0 && (
                <dl className="mt-4 grid gap-1 text-sm">
                  {Object.entries(report.generations.failuresByPhase).map(([phase, count]) => (
                    <div key={phase} className="flex items-center justify-between gap-3">
                      <dt className="font-mono text-xs text-zinc-400">{phase}</dt>
                      <dd className="font-bold text-zinc-200">{count}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-4 border-t border-zinc-800 pt-3 text-sm text-zinc-400">
                {Object.entries(report.storage.byRole).length === 0 ? (
                  <p>No stored assets.</p>
                ) : (
                  Object.entries(report.storage.byRole).map(([role, row]) => (
                    <p key={role}>
                      <span className="font-mono text-xs">{role}</span>: {row.count} asset(s) ·{" "}
                      {bytes(row.byteSize)}
                    </p>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
              <h3 className="text-sm font-black uppercase tracking-[0.14em] text-zinc-400">
                Reservations vs settlement
              </h3>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <Stat
                  label="Credits"
                  value={`${report.reservations.settledCredits} / ${report.reservations.reservedCredits}`}
                  detail="settled / reserved"
                />
                <Stat
                  label="Provider cost"
                  value={`${usd(report.reservations.settledCostMicroUsd)} / ${usd(report.reservations.reservedCostMicroUsd)}`}
                  detail="settled / reserved"
                />
              </div>
              {report.reservations.settledByOption.length > 0 && (
                <table className="mt-4 w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                      <th className="py-1 font-bold">Option</th>
                      <th className="py-1 text-right font-bold">Count</th>
                      <th className="py-1 text-right font-bold">Avg settled cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.reservations.settledByOption.map((row) => (
                      <tr key={`${row.quality}:${row.size}`} className="border-t border-zinc-800/60">
                        <td className="py-1.5 font-mono text-xs text-zinc-300">
                          {row.quality} · {row.size}
                        </td>
                        <td className="py-1.5 text-right font-bold text-zinc-200">{row.count}</td>
                        <td className="py-1.5 text-right text-zinc-300">
                          {micro(row.averageSettledCostMicroUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/*
            Budgets are enforced per provider, so spend is read per provider.
            One combined total cannot answer "whose budget is this consuming",
            which is the only question that matters once a second provider is
            running.
          */}
          {/*
            The registry as an operator sees it. A held model states which of
            the three holds applies and why -- the reasons are not
            interchangeable labels, and the one that applies is what says what
            has to happen next.
          */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
            <h3 className="text-sm font-bold text-zinc-200">Model registry</h3>
            <ul className="mt-3 space-y-3">
              {report.models.map((model) => (
                <li key={model.id} className="border-t border-zinc-800/60 pt-3 first:border-0 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-zinc-200">{model.name}</span>
                    <span className="font-mono text-[11px] text-zinc-500">
                      {model.provider}/{model.id}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        model.disabledReason
                          ? "bg-amber-500/10 text-amber-400"
                          : "bg-emerald-500/10 text-emerald-400"
                      }`}
                    >
                      {model.disabledReason ?? "enabled"}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-zinc-500">
                    {model.pricingVersion} ·{" "}
                    {model.priceVerifiedAt
                      ? `verified ${model.priceVerifiedAt}`
                      : "price unverified"}{" "}
                    · {model.optionCount} priced option(s)
                  </p>
                  {model.disabledNote && (
                    <p className="mt-1 text-xs leading-5 text-zinc-400">
                      {model.disabledNote}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {report.settledByProviderModel.length > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <h3 className="text-sm font-bold text-zinc-200">
                Settled spend by provider
              </h3>
              <table className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                    <th className="py-1 font-bold">Provider · model</th>
                    <th className="py-1 text-right font-bold">Settlements</th>
                    <th className="py-1 text-right font-bold">Credits</th>
                    <th className="py-1 text-right font-bold">Settled cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.settledByProviderModel.map((row) => (
                    <tr
                      key={`${row.provider}:${row.modelId}`}
                      className="border-t border-zinc-800/60"
                    >
                      <td className="py-1.5 font-mono text-xs text-zinc-300">
                        {row.provider} · {row.modelId}
                      </td>
                      <td className="py-1.5 text-right font-bold text-zinc-200">
                        {row.settlements}
                      </td>
                      <td className="py-1.5 text-right text-zinc-300">
                        {row.settledCredits}
                      </td>
                      <td className="py-1.5 text-right text-zinc-300">
                        {usd(row.settledCostMicroUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/*
            A succeeded generation with no recorded dimensions means the
            header could not be read. That is recorded honestly as null, which
            makes it invisible unless it is counted -- so it is counted.
          */}
          {report.dimensionCoverage.length > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <h3 className="text-sm font-bold text-zinc-200">
                Measured output dimensions
              </h3>
              <ul className="mt-3 space-y-1.5 text-sm">
                {report.dimensionCoverage.map((row) => {
                  const missing = row.succeeded - row.measured;
                  return (
                    <li
                      key={row.provider}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="font-mono text-xs text-zinc-300">
                        {row.provider}
                      </span>
                      <span
                        className={
                          missing > 0
                            ? "font-bold text-amber-400"
                            : "text-zinc-300"
                        }
                      >
                        {row.measured}/{row.succeeded} measured
                        {missing > 0 ? ` · ${missing} unreadable` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
