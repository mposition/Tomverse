"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminAdaptiveStatisticsMessages } from "@/lib/adminMessages/adaptiveStatistics";
import { adminRoutingScreensMessages } from "@/lib/adminMessages/routingScreens";
import { adminFetch } from "@/lib/adminFetch";
import type { getAdaptiveStatisticsReport } from "@/lib/adaptiveStatisticsReport";

type Report = Awaited<ReturnType<typeof getAdaptiveStatisticsReport>>;

type Measure = { key: string; title: string; value: string; detail?: string };

function CountList({ title, values }: { title: string; values: Record<string, number> }) {
  const screens = useAdminMessages(adminRoutingScreensMessages);
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return (
    <AdminTile title={title}>
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-500">{screens.stats.none}</p>
      ) : (
        <ul className="flex flex-col text-sm">
          {entries.map(([key, value]) => (
            <li className="flex justify-between gap-3 border-t border-zinc-800 py-2 first:border-t-0" key={key}>
              <span className="break-all text-zinc-300">{key.replaceAll("_", " ")}</span>
              <strong className="tabular-nums text-white">{value.toLocaleString()}</strong>
            </li>
          ))}
        </ul>
      )}
    </AdminTile>
  );
}

function MeasureTable({ caption, measures }: { caption: string; measures: Measure[] }) {
  const screens = useAdminMessages(adminRoutingScreensMessages);
  return (
    <AdminDataTable
      caption={caption}
      rows={measures}
      rowKey={(row) => row.key}
      columns={[
        { key: "metric", header: screens.stats.metric, render: (row) => row.title },
        {
          key: "value",
          header: screens.stats.value,
          align: "right",
          render: (row) => <strong className="tabular-nums text-white">{row.value}</strong>,
        },
        {
          key: "detail",
          header: screens.stats.detail,
          render: (row) => <span className="text-xs text-zinc-500">{row.detail ?? ""}</span>,
        },
      ]}
      cardTitle={(row) => row.title}
      cardMeta={(row) => row.detail}
      cardAside={(row) => <strong className="tabular-nums text-white">{row.value}</strong>}
    />
  );
}

const duration = (value: number | null) => value === null ? "—" : `${value.toFixed(1)} ms`;

export function AdminAdaptiveStatisticsPanel() {
  const m = useAdminMessages(adminAdaptiveStatisticsMessages);
  const screens = useAdminMessages(adminRoutingScreensMessages);
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

  const refinerMeasures: Measure[] = report ? [
    { key: "requests", title: m.requests, value: String(report.refiner.requests) },
    { key: "failures", title: m.dispatchedFailures, value: `${report.refiner.dispatchedFailures} / ${report.refiner.dispatched}` },
    { key: "accepted", title: m.accepted, value: `${report.refiner.explicitChoice.accepted} / ${report.refiner.explicitChoice.denominator}` },
    { key: "latency", title: m.latency, value: `${duration(report.refiner.suggestionLatencyMs.p50)} / ${duration(report.refiner.suggestionLatencyMs.p95)}`, detail: `n=${report.refiner.suggestionLatencyMs.population}` },
    { key: "cost", title: m.cost, value: String(report.refiner.actualCostMicroUsd.total), detail: `${report.refiner.actualCostMicroUsd.reported} / ${report.refiner.actualCostMicroUsd.population} ${m.costCoverage}` },
    { key: "tokens", title: m.refinerTokens, value: `${report.refiner.inputTokens.reported} / ${report.refiner.outputTokens.reported}`, detail: `n=${report.refiner.requests}` },
  ] : [];
  const routerMeasures: Measure[] = report ? [
    { key: "runs", title: m.autoRuns, value: String(report.autoRouter.recordedRuns) },
    { key: "reroutes", title: m.reroutes, value: String(report.autoRouter.rerouted) },
    { key: "decision", title: m.decision, value: `${duration(report.autoRouter.decisionMs.p50)} / ${duration(report.autoRouter.decisionMs.p95)}` },
    { key: "total", title: m.totalLatency, value: `${duration(report.autoRouter.totalLatencyMs.p50)} / ${duration(report.autoRouter.totalLatencyMs.p95)}`, detail: `${report.autoRouter.totalLatencyMs.population} / ${report.autoRouter.recordedRuns} ${m.coverage}` },
    { key: "first", title: m.firstToken, value: `${duration(report.autoRouter.firstTokenMs.p50)} / ${duration(report.autoRouter.firstTokenMs.p95)}`, detail: `${report.autoRouter.firstTokenMs.population} / ${report.autoRouter.recordedRuns} ${m.coverage}` },
    { key: "estimated", title: m.estimatedTokens, value: String(report.autoRouter.estimatedInputTokens.total) },
    { key: "provider", title: m.providerCost, value: String(report.autoRouter.providerUsage.measuredOrTokenEstimatedCostMicroUsd.total), detail: `${report.autoRouter.providerUsage.measuredOrTokenEstimatedCostMicroUsd.population} ${m.providerCostDetail}` },
    { key: "missing", title: m.usageMissing, value: String(report.autoRouter.providerUsage.runsWithoutUsage) },
    { key: "unattributed", title: m.unattributed, value: String(report.coverage.unattributedAutoRuns) },
    { key: "coverage", title: m.tokenCoverage, value: `${report.autoRouter.providerUsage.inputTokens.reported} / ${report.autoRouter.providerUsage.outputTokens.reported}`, detail: `n=${report.autoRouter.providerUsage.attemptRows}` },
  ] : [];

  return <div className="flex min-w-0 flex-col gap-4" data-testid="admin-adaptive-statistics">
    <AdminTile
      title={m.title}
      description={m.scope}
      action={<>
        {([7, 30] as const).map((windowDays) => <button key={windowDays} type="button" disabled={loading} onClick={() => { setDays(windowDays); setReport(null); setError(false); setLoading(true); }} aria-pressed={days === windowDays} className={`min-h-9 rounded-xl border px-3 text-xs font-bold ${days === windowDays ? "border-blue-500 bg-blue-500/15 text-blue-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>{windowDays}d</button>)}
        <button type="button" onClick={() => { setError(false); setLoading(true); void load(); }} disabled={loading} className="flex min-h-9 items-center gap-1 rounded-xl border border-zinc-700 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"><RefreshCw size={14} aria-hidden />{m.refresh}</button>
      </>}
    >
      {loading && <AdminStateBlock kind="loading" title={m.loading} />}
      {/* A failed read is an alert with a retry, never an empty report. */}
      {error && <AdminStateBlock kind="error" title={m.error} onRetry={() => { setError(false); setLoading(true); void load(); }} />}
      {report && <>
        <p className="text-xs text-zinc-400">{formatAestDateTime(report.since, { seconds: true }) ?? "-"} – {formatAestDateTime(report.observedAt, { seconds: true }) ?? "-"}</p>
        <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200">{m.denominator}</p>
        {(report.coverage.refinerTruncated || report.coverage.autoRouterTruncated || report.coverage.providerUsageTruncated) && <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200">{m.partial}</p>}
        {report.refiner.requests === 0 && report.autoRouter.recordedRuns === 0 && <AdminStateBlock kind="empty" title={m.noData} />}
      </>}
    </AdminTile>
    {report && <>
      <AdminTile title={m.refiner} description={screens.stats.window(days)}>
        <MeasureTable caption={screens.stats.refinerTable} measures={refinerMeasures} />
      </AdminTile>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <CountList title={m.modes} values={report.refiner.byMode}/><CountList title={m.refinerOutcomes} values={report.refiner.outcomes}/>
        <CountList title={m.explicitDispositions} values={report.refiner.explicitDispositions}/><CountList title={m.autoDispositions} values={report.refiner.autoDispositions}/>
        <CountList title={m.failures} values={report.refiner.failureCodes}/>
      </div>
      <AdminTile title={m.router} description={screens.stats.window(days)}>
        <MeasureTable caption={screens.stats.routerTable} measures={routerMeasures} />
      </AdminTile>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <CountList title={m.plan} values={report.autoRouter.byPlan}/><CountList title={m.profiles} values={report.autoRouter.byProfile}/>
        <CountList title={m.policies} values={report.autoRouter.policyVersions}/><CountList title={m.reasons} values={report.autoRouter.selectionReasons}/>
        <CountList title={m.rejection} values={report.autoRouter.rejectedReasons}/><CountList title={m.initial} values={report.autoRouter.initialModels}/>
        <CountList title={m.final} values={report.autoRouter.finalModels}/><CountList title={m.fallback} values={report.autoRouter.fallbackStates}/>
        <CountList title={m.settlement} values={report.autoRouter.settlementOutcomes}/><CountList title={m.attempt} values={report.autoRouter.attemptOutcomes}/>
        <CountList title={m.attemptFailures} values={report.autoRouter.attemptFailureLayers}/>
        <CountList title={m.costSources} values={report.autoRouter.providerUsage.costSources}/>
      </div>
      <p className="rounded-xl border border-zinc-800 p-3 text-xs leading-6 text-zinc-400">{m.caveat}</p>
    </>}
  </div>;
}
