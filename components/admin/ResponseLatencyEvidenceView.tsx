"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminResponseLatencyMessages } from "@/lib/adminMessages/responseLatency";
import type { ResponseLatencyEvidence } from "@/lib/responseLatencyCore";

export function ResponseLatencyEvidenceView({ evidence, current = false, refreshing = false, onRefresh }: {
  evidence?: ResponseLatencyEvidence;
  current?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const m = useAdminMessages(adminResponseLatencyMessages);
  const metricLabels: Record<string, string> = m.metrics;
  const seconds = (ms: number | null) => ms === null ? "—" : m.seconds((ms / 1_000).toFixed(2));
  if (!evidence) return null;
  return <details open={current || undefined} className="mt-3 rounded-xl border border-zinc-800 p-3" data-testid={current ? "response-latency-current" : "response-latency-evidence"}>
    <summary className="cursor-pointer text-xs font-bold text-zinc-300">{current ? m.currentTitle(evidence.windowDays) : m.title(evidence.windowDays)}</summary>
    {current && <p className="mt-2 text-xs text-zinc-400">{m.currentNote}</p>}
    {onRefresh && <button type="button" disabled={refreshing} aria-busy={refreshing} className="mt-2 min-h-11 rounded-lg border border-zinc-700 px-3 text-xs text-zinc-300 disabled:opacity-50" onClick={onRefresh} data-testid="response-latency-refresh">{m.refresh}</button>}
    {evidence.status === "unavailable" ? <p className="mt-2 text-xs text-zinc-400">{m.unavailable}</p> : <>
      <p className="mt-2 text-xs text-zinc-400">
        {m.measurements(evidence.sampleCount)} · {evidence.truncated ? m.latestOnly : m.withinLimits}
        {evidence.omittedGroups > 0 ? m.omitted(evidence.omittedGroups) : ""}. {m.caveat}
      </p>
      {evidence.groups.map((group, index) => <div key={index} className="mt-3">
        <p className="text-xs font-bold text-zinc-300">{group.product} · {group.mode} · {group.source} · {group.modelId ?? m.unattributed} · {group.outcome} · n={group.count}</p>
        <table className="mt-1 w-full text-left text-xs text-zinc-400">
          <caption className="sr-only">{m.caption(group.product, group.source, group.outcome)}</caption>
          <thead><tr><th scope="col">{m.stage}</th><th scope="col">n</th><th scope="col">p50</th><th scope="col">p95</th></tr></thead>
          <tbody>{Object.entries(group.timings).filter(([, distribution]) => distribution.count > 0).map(([metric, distribution]) =>
            <tr key={metric}><th scope="row" className="font-normal">{metricLabels[metric] ?? metric}</th><td>{distribution.count}</td><td>{seconds(distribution.p50Ms)}</td><td>{seconds(distribution.p95Ms)}</td></tr>
          )}</tbody>
        </table>
      </div>)}
    </>}
  </details>;
}
