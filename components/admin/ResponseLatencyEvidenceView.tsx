import type { ResponseLatencyEvidence } from "@/lib/responseLatencyCore";

const metricLabels: Record<string, string> = {
  prepareMs: "Submit to dispatch", firstContentMs: "First content",
  completionMs: "Client completion", settlementMs: "Server settlement start",
  routingMs: "Routing", contextMs: "Context", preProviderMs: "Before provider",
  firstReviewMs: "First review", reviewMs: "Review processing",
};
const seconds = (ms: number | null) => ms === null ? "—" : `${(ms / 1_000).toFixed(2)}s`;

export function ResponseLatencyEvidenceView({ evidence }: { evidence?: ResponseLatencyEvidence }) {
  if (!evidence) return null;
  return <details className="mt-3 rounded-xl border border-zinc-800 p-3" data-testid="response-latency-evidence">
    <summary className="cursor-pointer text-xs font-bold text-zinc-300">Response latency · {evidence.windowDays} days</summary>
    {evidence.status === "unavailable" ? <p className="mt-2 text-xs text-zinc-400">Timing evidence is unavailable.</p> : <>
      <p className="mt-2 text-xs text-zinc-400">
        {evidence.sampleCount} measurements · {evidence.truncated ? "Latest samples only" : "Within sample limits"}
        {evidence.omittedGroups > 0 ? ` · ${evidence.omittedGroups} smaller groups omitted` : ""}.
        Browser reports and server timings have different start points. First content means text reached UI state, not browser paint.
        Review timings exclude final persistence. Failed and cancelled runs are separate; fewer than 30 samples are inconclusive.
      </p>
      {evidence.groups.map((group, index) => <div key={index} className="mt-3">
        <p className="text-xs font-bold text-zinc-300">{group.product} · {group.mode} · {group.source} · {group.modelId ?? "Unattributed"} · {group.outcome} · n={group.count}</p>
        <table className="mt-1 w-full text-left text-xs text-zinc-400">
          <caption className="sr-only">{group.product} {group.source} {group.outcome} latency measurements</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">n</th><th scope="col">p50</th><th scope="col">p95</th></tr></thead>
          <tbody>{Object.entries(group.timings).filter(([, distribution]) => distribution.count > 0).map(([metric, distribution]) =>
            <tr key={metric}><th scope="row" className="font-normal">{metricLabels[metric] ?? metric}</th><td>{distribution.count}</td><td>{seconds(distribution.p50Ms)}</td><td>{seconds(distribution.p95Ms)}</td></tr>
          )}</tbody>
        </table>
      </div>)}
    </>}
  </details>;
}
