"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAdaptiveStatisticsMessages } from "@/lib/adminMessages/adaptiveStatistics";
import { adminFetch } from "@/lib/adminFetch";
import type { getAdaptiveStatisticsReport } from "@/lib/adaptiveStatisticsReport";

type Report = Awaited<ReturnType<typeof getAdaptiveStatisticsReport>>;

function CountList({ title, values }: { title: string; values: Record<string, number> }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
    <h4 className="text-xs font-bold text-zinc-400">{title}</h4>
    <ul className="mt-2 space-y-1 text-sm">
      {Object.entries(values).sort((a, b) => b[1] - a[1]).map(([key, value]) =>
        <li className="flex justify-between gap-3" key={key}><span className="break-all text-zinc-300">{key.replaceAll("_", " ")}</span><strong>{value.toLocaleString()}</strong></li>)}
      {Object.keys(values).length === 0 && <li className="text-zinc-500">—</li>}
    </ul>
  </div>;
}

function Stat({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
    <p className="text-xs text-zinc-400">{title}</p><p className="mt-1 text-lg font-bold text-white">{value}</p>
    {detail && <p className="mt-1 text-xs text-zinc-500">{detail}</p>}
  </div>;
}

const duration = (value: number | null) => value === null ? "—" : `${value.toFixed(1)} ms`;

export function AdminAdaptiveStatisticsPanel() {
  const { locale } = useAdminLocale();
  const m = useAdminMessages(adminAdaptiveStatisticsMessages);
  const [days, setDays] = useState<7 | 30>(7);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await adminFetch(`/api/admin/chat/adaptive-statistics?days=${days}`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as Report;
      if (!signal?.aborted) setReport(body);
    } catch {
      if (!signal?.aborted) { setReport(null); setError(true); }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [days]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  return <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-white" data-testid="admin-adaptive-statistics">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-bold">{m.title}</h2><p className="mt-1 text-sm text-zinc-400">{m.scope}</p></div>
      <div className="flex gap-2">
        {([7, 30] as const).map((windowDays) => <button key={windowDays} type="button" disabled={loading} onClick={() => { setDays(windowDays); setReport(null); setError(false); setLoading(true); }} aria-pressed={days === windowDays} className={`rounded-lg border px-3 py-2 text-sm ${days === windowDays ? "border-blue-500 bg-blue-500/20" : "border-zinc-700"}`}>{windowDays}d</button>)}
        <button type="button" onClick={() => { setError(false); setLoading(true); void load(); }} disabled={loading} className="flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-2 text-sm"><RefreshCw size={14}/>{m.refresh}</button>
      </div>
    </div>
    {loading && <p role="status" className="mt-4 text-sm text-zinc-400">{m.loading}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{m.error}</p>}
    {report && <div className="mt-4 space-y-4">
      <p className="text-xs text-zinc-400">{new Date(report.since).toLocaleString(locale)} – {new Date(report.observedAt).toLocaleString(locale)}</p>
      <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 p-3 text-sm text-amber-100">{m.denominator}</p>
      {(report.coverage.refinerTruncated || report.coverage.autoRouterTruncated || report.coverage.providerUsageTruncated) && <p className="rounded-lg border border-amber-600/40 p-3 text-sm">{m.partial}</p>}
      {report.refiner.requests === 0 && report.autoRouter.recordedRuns === 0 && <p className="text-sm text-zinc-400">{m.noData}</p>}
      <h3 className="text-lg font-bold">{m.refiner}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat title={m.requests} value={String(report.refiner.requests)}/>
        <Stat title={m.dispatchedFailures} value={`${report.refiner.dispatchedFailures} / ${report.refiner.dispatched}`}/>
        <Stat title={m.accepted} value={`${report.refiner.explicitChoice.accepted} / ${report.refiner.explicitChoice.denominator}`}/>
        <Stat title={m.latency} value={`${duration(report.refiner.suggestionLatencyMs.p50)} / ${duration(report.refiner.suggestionLatencyMs.p95)}`} detail={`n=${report.refiner.suggestionLatencyMs.population}`}/>
        <Stat title={m.cost} value={report.refiner.actualCostMicroUsd.total} detail={`${report.refiner.actualCostMicroUsd.reported} / ${report.refiner.actualCostMicroUsd.population} ${m.costCoverage}`}/>
        <Stat title={m.refinerTokens} value={`${report.refiner.inputTokens.reported} / ${report.refiner.outputTokens.reported}`} detail={`n=${report.refiner.requests}`}/>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CountList title={m.modes} values={report.refiner.byMode}/><CountList title={m.refinerOutcomes} values={report.refiner.outcomes}/>
        <CountList title={m.explicitDispositions} values={report.refiner.explicitDispositions}/><CountList title={m.autoDispositions} values={report.refiner.autoDispositions}/>
        <CountList title={m.failures} values={report.refiner.failureCodes}/>
      </div>
      <h3 className="text-lg font-bold">{m.router}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat title={m.autoRuns} value={String(report.autoRouter.recordedRuns)}/>
        <Stat title={m.reroutes} value={String(report.autoRouter.rerouted)}/>
        <Stat title={m.decision} value={`${duration(report.autoRouter.decisionMs.p50)} / ${duration(report.autoRouter.decisionMs.p95)}`}/>
        <Stat title={m.totalLatency} value={`${duration(report.autoRouter.totalLatencyMs.p50)} / ${duration(report.autoRouter.totalLatencyMs.p95)}`} detail={`${report.autoRouter.totalLatencyMs.population} / ${report.autoRouter.recordedRuns} ${m.coverage}`}/>
        <Stat title={m.firstToken} value={`${duration(report.autoRouter.firstTokenMs.p50)} / ${duration(report.autoRouter.firstTokenMs.p95)}`} detail={`${report.autoRouter.firstTokenMs.population} / ${report.autoRouter.recordedRuns} ${m.coverage}`}/>
        <Stat title={m.estimatedTokens} value={report.autoRouter.estimatedInputTokens.total}/>
        <Stat title={m.providerCost} value={report.autoRouter.providerUsage.measuredOrTokenEstimatedCostMicroUsd.total} detail={`${report.autoRouter.providerUsage.measuredOrTokenEstimatedCostMicroUsd.population} ${m.providerCostDetail}`}/>
        <Stat title={m.usageMissing} value={String(report.autoRouter.providerUsage.runsWithoutUsage)}/>
        <Stat title={m.unattributed} value={String(report.coverage.unattributedAutoRuns)}/>
        <Stat title={m.tokenCoverage} value={`${report.autoRouter.providerUsage.inputTokens.reported} / ${report.autoRouter.providerUsage.outputTokens.reported}`} detail={`n=${report.autoRouter.providerUsage.attemptRows}`}/>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CountList title={m.plan} values={report.autoRouter.byPlan}/><CountList title={m.profiles} values={report.autoRouter.byProfile}/>
        <CountList title={m.policies} values={report.autoRouter.policyVersions}/><CountList title={m.reasons} values={report.autoRouter.selectionReasons}/>
        <CountList title={m.rejection} values={report.autoRouter.rejectedReasons}/><CountList title={m.initial} values={report.autoRouter.initialModels}/>
        <CountList title={m.final} values={report.autoRouter.finalModels}/><CountList title={m.fallback} values={report.autoRouter.fallbackStates}/>
        <CountList title={m.settlement} values={report.autoRouter.settlementOutcomes}/><CountList title={m.attempt} values={report.autoRouter.attemptOutcomes}/>
        <CountList title={m.attemptFailures} values={report.autoRouter.attemptFailureLayers}/>
        <CountList title={m.costSources} values={report.autoRouter.providerUsage.costSources}/>
      </div>
      <p className="rounded-lg border border-zinc-700 p-3 text-xs leading-6 text-zinc-400">{m.caveat}</p>
    </div>}
  </section>;
}
