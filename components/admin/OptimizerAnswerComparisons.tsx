"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";

export type OptimizerAnswerComparison = {
  kind: string | null;
  a: string | null;
  b: string | null;
  verdict: string;
  answerMs?: { a: number | null; b: number | null };
};

/** Quality and accepted-answer times belong to the same stored comparison. */
export function OptimizerAnswerComparisons({ comparisons }: { comparisons: readonly OptimizerAnswerComparison[] }) {
  const m = useAdminMessages(adminAutoRouterOptimizerMessages);
  const seconds = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? `${(value / 1000).toFixed(2)} s`
      : m.comparisonLatencyMissing;
  if (!comparisons.length) return null;
  return <details className="mt-2" data-testid="admin-auto-router-optimizer-comparisons">
    <summary className="cursor-pointer text-xs font-bold text-zinc-400">
      {m.comparisonsTitle} ({comparisons.length})
    </summary>
    <p className="mt-2 text-xs text-zinc-400">{m.comparisonLatencyNote}</p>
    <ul className="mt-2 space-y-2 text-xs text-zinc-300">
      {comparisons.map((item, index) => <li key={index}>
        {item.kind ? `${(m.kinds as Record<string, string>)[item.kind] ?? item.kind} · ` : ""}
        {item.a ?? "-"} vs {item.b ?? "-"} · {(m.comparisonVerdicts as Record<string, string>)[item.verdict] ?? item.verdict}
        <span className="mt-0.5 block text-zinc-400" data-testid="optimizer-comparison-answer-latency">
          {m.comparisonAnswerLatency(seconds(item.answerMs?.a), seconds(item.answerMs?.b))}
        </span>
      </li>)}
    </ul>
  </details>;
}
