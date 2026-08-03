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
  storage: {
    byRole: Record<string, { count: number; byteSize: number }>;
  };
  invariants: {
    emptyImageConversations: number;
    staleGenerations: number;
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
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/image-generation", { cache: "no-store" });
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
    void load();
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
            onClick={() => void load()}
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
              detail={`${report.invariants.emptyImageConversations} empty conversations · ${report.invariants.staleGenerations} stale · ${report.invariants.cleanupBacklog} cleanup backlog`}
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
        </div>
      )}
    </section>
  );
}
