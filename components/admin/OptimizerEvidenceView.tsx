"use client";

import type { OptimizerCostCoverage } from "@/lib/autoOptimizerCost";
import { optimizerEvidenceMessages } from "@/lib/adminMessages/optimizerEvidence";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";

export type OptimizerEvidenceSummary = {
  evaluation?: { version: string; legacyInputSamples: number };
  costCoverage?: OptimizerCostCoverage;
  quality?: { status: "passed" | "failed" | "unmeasured" };
  gate?: { basis: "judged" | "direct" } | null;
  evidence?: { ownAnswerCases: number; proxyTowardWinner: number; proxyTowardLoser: number; orderDisagreements: number };
  incumbentCredits?: number;
  candidateCredits?: number;
};

export function OptimizerEvidenceView({ summary, spentMicroUsd }: {
  summary: OptimizerEvidenceSummary | null; spentMicroUsd: number;
}) {
  const m = useAdminMessages(optimizerEvidenceMessages);
  const cost = summary?.costCoverage;
  const evidence = summary?.evidence;
  const ratio = summary?.incumbentCredits !== undefined && summary.candidateCredits !== undefined
    ? summary.incumbentCredits > 0 ? summary.candidateCredits / summary.incumbentCredits
      : summary.candidateCredits === 0 ? 1 : null : null;
  const reasons = cost?.calls.filter(call => call.state === "unknown").reduce((counts, call) => {
    const key = `${call.kind}/${call.state === "unknown" ? call.reason : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return <div className="mt-2 text-xs text-zinc-400" data-testid="optimizer-evidence">
    <p>{m.knownCost}: US${(spentMicroUsd / 1_000_000).toFixed(6)}</p>
    {!cost?.complete ? <p className="text-amber-300" data-testid="optimizer-cost-unconfirmed">{m.incomplete}</p> : null}
    {!summary?.evaluation ? <p>{m.legacy}</p> : null}
    <p>{m.costBasis}</p>
    {cost ? <>
      <p>{m.coverage(cost.knownCalls, cost.noDispatchCalls, cost.unknownCalls)}</p>
      {cost.boundedCalls ? <p data-testid="optimizer-cost-bounded">{m.bounded(cost.boundedCalls, ((cost.boundedMicroUsd ?? 0) / 1_000_000).toFixed(6))}</p> : null}
      <p>{m.calls(cost.started, cost.completed, cost.notStarted, cost.failed)}</p>
      {reasons?.size ? <p>{[...reasons].map(([reason, count]) => `${reason}: ${count}`).join(" · ")}</p> : null}
    </> : null}
    {summary?.quality ? <p>{m.quality}: {m.qualityStatus[summary.quality.status]}</p> : null}
    {summary?.gate ? <p>{m.basis}: {m[summary.gate.basis]}</p> : null}
    {evidence ? <p>{m.evidence(evidence.ownAnswerCases, evidence.proxyTowardWinner, evidence.proxyTowardLoser, evidence.orderDisagreements)}</p> : null}
    {ratio !== null ? <p data-testid="optimizer-credit-ratio">{m.creditRatio}: {ratio.toFixed(3)} · {m.creditLimit}</p> : null}
    {summary?.evaluation?.legacyInputSamples ? <p>{m.legacySamples(summary.evaluation.legacyInputSamples)}</p> : null}
  </div>;
}
