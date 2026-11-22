"use client";

import type { CostEfficiencyReport } from "@/lib/autoCostEfficiencyReport";
import type { ChatServingCostSummary } from "@/lib/autoChatServingCostCore";
import { costEfficiencyMessages } from "@/lib/adminMessages/costEfficiency";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";

const usd = (micro: number) => `US$${(micro / 1_000_000).toFixed(6)}`;

/**
 * A cost-efficiency cycle's report: price-blind quality, credits, observed
 * cost, experiment cost, coverage and why it is not applicable. Counts and
 * model-free totals only; no message text.
 */
export function CostEfficiencyDiagnosticView({ report }: { report: CostEfficiencyReport | null | undefined }) {
  const m = useAdminMessages(costEfficiencyMessages);
  if (!report) return null;
  const c = report.candidateDiagnosis;
  const g = report.guidanceComparison;
  const q = (tally: typeof c.quality) =>
    m.quality(tally.challengerBetter, tally.incumbentBetter, tally.equal, tally.insufficient, tally.orderDisagreement, tally.undecided);
  const reasons = report.applicability.reasons;
  return (
    <div className="mt-2 rounded-xl border border-sky-900/60 p-3 text-xs text-zinc-300" data-testid="admin-cost-efficiency-diagnostic">
      <p className="font-bold text-sky-200">{m.title}</p>
      <p className="mt-1 text-zinc-500">{m.scope}</p>
      <p className="mt-2 font-bold text-zinc-300">{m.candidateTitle}</p>
      <p>{m.samples(c.savingsSamples, c.byBasis.quality_comparison, c.noAlternative)}</p>
      <p>{m.basis(c.byBasis.lower_credit, c.byBasis.lower_estimated_provider_cost)}</p>
      <p data-testid="admin-cost-efficiency-quality">{q(c.quality)}</p>
      <p className={c.criticalRegressions ? "text-amber-300" : undefined}>{m.regressions(c.criticalRegressions)}</p>
      {c.exact.graded ? <p>{m.exact(c.exact.graded, c.exact.incumbentPassed, c.exact.challengerPassed)}</p> : null}
      <p>{m.credits(c.credits.pairs, c.credits.incumbent, c.credits.challenger)}</p>
      <p data-testid="admin-cost-efficiency-observed">
        {m.observed(c.observedAnswerCost.pairsKnown, c.observedAnswerCost.pairsUnknown,
          usd(c.observedAnswerCost.incumbentMicroUsd), usd(c.observedAnswerCost.challengerMicroUsd), c.observedAnswerCost.challengerLower)}
      </p>
      <p>{m.latency(c.answerLatencyMs.pairs, c.answerLatencyMs.incumbentMedian, c.answerLatencyMs.challengerMedian)}</p>
      <p className="mt-2 font-bold text-zinc-300">{m.guidanceTitle}</p>
      <p>{m.guidance(g.evaluated, g.unchanged, g.changed, g.unrouted)} · {m.guidanceCredits(g.credits.baseline, g.credits.candidate)}</p>
      <p>{q(g.quality)}</p>
      <p>{m.serving(usd(report.servingCost.baselineKnownMicroUsd), usd(report.servingCost.candidateKnownMicroUsd), report.servingCost.complete)}</p>
      <p className="mt-2">{m.experiment(usd(report.experimentCost.knownMicroUsd), report.experimentCost.unknownCalls, report.experimentCost.failed,
        report.experimentCost.answerRetries, report.experimentCost.notStarted)}</p>
      <p>{m.taskUnlinked}</p>
      <p>{m.criteria(report.criteria.version, report.criteria.status)}</p>
      <p className="mt-1 text-amber-300" data-testid="admin-cost-efficiency-applicability">
        {m.notApplicable} {reasons.map((reason) => m.reasons[reason] ?? reason).join(" · ")}
      </p>
      {report.applicability.measuredWithinCriteria ? <p>{m.measured}</p> : null}
    </div>
  );
}

/** Recent real Auto turns' answer cost, linked by trace id; the rest stays unknown. */
export function ChatServingCostView({ summary }: { summary: ChatServingCostSummary | null | undefined }) {
  const m = useAdminMessages(costEfficiencyMessages);
  if (summary === undefined) return null;
  const row = (bucket: ChatServingCostSummary["total"]) =>
    m.servingRow(bucket.traces, bucket.linked, bucket.answer.knownTraces, bucket.answer.unknownTraces,
      usd(bucket.answer.knownMicroUsd), bucket.settledCredits, bucket.answer.retriedTraces, bucket.firstContentMsP50);
  return (
    <details className="rounded-2xl border border-zinc-800 p-4 text-xs text-zinc-300" data-testid="admin-chat-serving-cost">
      <summary className="cursor-pointer text-sm font-bold text-zinc-200">{m.servingTitle}</summary>
      {summary === null ? <p className="mt-2 text-amber-300">{m.servingUnavailable}</p> : (
        <>
          <p className="mt-2 text-zinc-500">{m.servingNote}</p>
          <p className="mt-2 font-bold">{row(summary.total)}</p>
          <ul className="mt-1 space-y-1">
            {summary.byModel.map((bucket) => <li key={bucket.modelId}>{bucket.modelId}: {row(bucket)}</li>)}
          </ul>
        </>
      )}
    </details>
  );
}
