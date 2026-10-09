"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxIdeaResolutionPanel } from "@/components/admin/AmuxIdeaResolutionPanel";
import { AmuxIdeaNodeRegistrationPanel } from
  "@/components/admin/AmuxIdeaNodeRegistrationPanel";
import { AmuxIdeaNodeSelectionPanel } from
  "@/components/admin/AmuxIdeaNodeSelectionPanel";
import { AmuxIdeaCardRegistrationPanel } from
  "@/components/admin/AmuxIdeaStoryRegistrationPanel";
import { AmuxIdeaCardLinkPanel } from
  "@/components/admin/AmuxIdeaCardLinkPanel";
import { AmuxIdeaUnitRejectionPanel } from
  "@/components/admin/AmuxIdeaUnitRejectionPanel";
import { AmuxIdeaUnknownDecisionRecoveryPanel } from
  "@/components/admin/AmuxIdeaUnknownDecisionRecoveryPanel";
import { AmuxIdeaDerivationPanel } from
  "@/components/admin/AmuxIdeaDerivationPanel";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { parseAmuxIdeaAnalysisResultView,
  type AmuxIdeaAnalysisResultView } from "@/lib/amux/ideaAnalysisResultReadCore";

const list = (values: string[]) => <ul className="list-disc pl-5">
  {values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}
</ul>;

/** Owner-only page section. Model-derived text is rendered as React text,
 * never as HTML; the separate Story panel owns the gated confirmation flow. */
export function AmuxIdeaAnalysisResultPanel({ ideaId, onContinuationReady }: {
  ideaId: string; onContinuationReady?: (chunkIndex: number) => void;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [loading, setLoading] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [view, setView] = useState<AmuxIdeaAnalysisResultView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);

  const refresh = async (page = chunkIndex) => {
    if (loading) return;
    setLoading(true);
    setUnavailable(false);
    setNeedsReauthentication(false);
    try {
      const params = new URLSearchParams({ ideaId, chunkIndex: String(page) });
      const response = await adminFetch(`/api/admin/amux/ideas/analysis-result?${params}`,
        { cache: "no-store" });
      if (response.status === 428) {
        setView(null);
        setNeedsReauthentication(true);
        return;
      }
      const parsed = parseAmuxIdeaAnalysisResultView(response.status,
        await response.json(), ideaId);
      if (!parsed) { setView(null); setUnavailable(true); }
      else {
        setView(parsed); setChunkIndex(page);
        if (parsed.state === "partial") onContinuationReady?.(parsed.nextChunkIndex);
      }
    } catch { setView(null); setUnavailable(true); }
    finally { setLoading(false); }
  };

  return <section className="space-y-3 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
    aria-labelledby="amux-v4-analysis-result-heading">
    <h3 id="amux-v4-analysis-result-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">
      {m.analysisResultTitle}
    </h3>
    <p className="text-zinc-700 dark:text-zinc-300">{m.analysisResultHint}</p>
    <button type="button" onClick={() => void refresh()} disabled={loading}
      className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
      {m.analysisResultRefresh}
    </button>
    {chunkIndex > 0 ? <button type="button" disabled={loading}
      onClick={() => void refresh(chunkIndex - 1)}
      className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
      {m.analysisResultPreviousPage}
    </button> : null}
    {loading ? <p role="status">{m.analysisResultLoading}</p> : null}
    {needsReauthentication ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}
    </a> : null}
    {unavailable ? <p role="alert">{m.analysisResultUnavailable}</p> : null}
    {view?.state === "pending" ? <p role="status">{m.analysisResultPending}</p> : null}
    {view?.state === "cancelled" ? <p role="status">{m.analysisResultCancelled}</p> : null}
    {view?.state === "provider_failed" ? <p role="alert">{m.analysisResultProviderFailed}</p> : null}
    {view?.state === "needs_new_preview" ? <p role="status">
      {m.analysisResultNeedsNewPreview}
    </p> : null}
    {view?.state === "ready" || view?.state === "partial" ||
      view?.state === "needs_owner_input" ? <div className="space-y-3">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {view.completedAt} · {view.previewId}
      </p>
      {view.state === "partial" ? <div role="status" className="space-y-1">
        <p>{m.analysisResultPartial}</p>
        <p className="font-medium">{m.analysisResultRemaining}</p>
        <p className="whitespace-pre-wrap">{view.remainingScope ?? m.analysisResultScopeExpired}</p>
        <button type="button" disabled={loading}
          onClick={() => void refresh(view.nextChunkIndex)}
          className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
          {m.analysisResultNextPage}
        </button>
      </div> : null}
      {view.state === "needs_owner_input" ? <div role="status" className="space-y-1">
        <p>{m.analysisResultNeedsOwner}</p>
        <p className="whitespace-pre-wrap">{view.ownerQuestion ?? m.analysisResultScopeExpired}</p>
        <p className="font-medium">{m.analysisResultRemaining}</p>
        <p className="whitespace-pre-wrap">{view.remainingScope ?? m.analysisResultScopeExpired}</p>
      </div> : null}
      <p>{view.coveredScope ?? m.analysisResultScopeExpired}</p>
      {view.outcome === "reject" ? <p role="status">{m.analysisResultRejected}</p> : null}
      <ol className="space-y-2">
        {view.units.map((unit) => <li key={unit.id}
          className="rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {unit.localRef} · {unit.decisionState}
          </p>
          {!unit.proposal ? <p>{m.analysisResultBodyExpired}</p> : null}
          {unit.proposal?.kind === "node" ? <div className="space-y-1">
            <h4 className="font-semibold">{unit.proposal.title}</h4>
            <p>{unit.proposal.level} · {unit.proposal.parentRef ?? "root"}</p>
            <p className="whitespace-pre-wrap">{unit.proposal.description}</p>
          </div> : null}
          {unit.proposal?.kind === "card" ? <div className="space-y-2">
            <h4 className="font-semibold">{unit.proposal.title}</h4>
            <p>{unit.proposal.cardType} · {unit.proposal.featureRef}</p>
            <div><p className="font-medium">{m.analysisResultProblem}</p>
              <p className="whitespace-pre-wrap">{unit.proposal.problem}</p></div>
            <div><p className="font-medium">{m.analysisResultScopeIn}</p>
              {list(unit.proposal.scopeIn)}</div>
            <div><p className="font-medium">{m.analysisResultScopeOut}</p>
              {unit.proposal.scopeOut.length ? list(unit.proposal.scopeOut) : <p>—</p>}</div>
            <div><p className="font-medium">{m.analysisResultCriteria}</p>
              {list(unit.proposal.completionCriteria)}</div>
            {unit.proposal.executionBrief ? <div>
              <p className="font-medium">{m.analysisResultExecution}</p>
              <p>{unit.proposal.taskRole} · {unit.proposal.executionGrade}</p>
              <p className="whitespace-pre-wrap">{unit.proposal.executionBrief}</p>
            </div> : null}
          </div> : null}
          {unit.proposal?.kind === "evidence" ? <div className="space-y-1">
            <h4 className="font-semibold">{unit.proposal.evidenceType}</h4>
            <p className="whitespace-pre-wrap">{unit.proposal.summary}</p>
            <p className="text-xs">{unit.proposal.cardRef}</p>
          </div> : null}
          {unit.proposal?.kind !== "evidence" &&
            unit.proposal?.portfolioSignal ? <div className="space-y-1 rounded border border-zinc-300 p-2 dark:border-zinc-700">
            <p className="font-medium">{m.portfolioSignalTitle}</p>
            <p>{m.portfolioSignalHint}</p>
            <p className="break-all font-mono text-xs">{unit.bodyDigest}</p>
            <p className="whitespace-pre-wrap">{unit.proposal.portfolioSignal.rationale}</p>
            <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify({ metrics: unit.proposal.portfolioSignal.metrics,
                uncertainty: unit.proposal.portfolioSignal.uncertainty,
                evidenceRefIds: unit.proposal.portfolioSignal.evidenceRefIds }, null, 2)}
            </pre>
          </div> : null}
        </li>)}
      </ol>
      {view.outcome === "propose" ? <AmuxIdeaResolutionPanel
        key={`${view.previewId}:${chunkIndex}:${view.units.map((unit) => unit.bodyDigest).join(":")}`}
        ideaId={ideaId} chunkIndex={chunkIndex} units={view.units} /> : null}
      {view.outcome === "propose" ? <AmuxIdeaDerivationPanel
        key={`derivation:${view.previewId}:${chunkIndex}`}
        ideaId={ideaId} chunkIndex={chunkIndex} units={view.units} /> : null}
      {view.outcome === "propose" ? view.units.filter((unit) =>
        unit.decisionState === "proposed" && unit.proposal?.kind === "node")
        .map((unit) => <AmuxIdeaNodeRegistrationPanel
          key={unit.id} ideaId={ideaId} unit={unit} />) : null}
      {view.outcome === "propose" ? view.units.filter((unit) =>
        unit.decisionState === "proposed" && unit.proposal?.kind === "node")
        .map((unit) => <AmuxIdeaNodeSelectionPanel
          key={`select:${unit.id}`} ideaId={ideaId} unit={unit} />) : null}
      {view.outcome === "propose" ? view.units.filter((unit) =>
        unit.decisionState === "proposed" && unit.proposal?.kind === "card" &&
        ["story", "task"].includes(unit.proposal.cardType)).map((unit) =>
        <AmuxIdeaCardRegistrationPanel key={unit.id} ideaId={ideaId} unit={unit} />) : null}
      {view.outcome === "propose" ? view.units.filter((unit) =>
        unit.decisionState === "proposed" && unit.proposal?.kind === "card" &&
        ["story", "task"].includes(unit.proposal.cardType)).map((unit) =>
        <AmuxIdeaCardLinkPanel key={`link:${unit.id}`} ideaId={ideaId} unit={unit} />) : null}
      {view.outcome === "propose" ? view.units.filter((unit) =>
        unit.decisionState === "proposed" &&
        (unit.proposal?.kind === "node" || unit.proposal?.kind === "card"))
        .map((unit) => <AmuxIdeaUnitRejectionPanel
          key={`reject:${unit.id}`} ideaId={ideaId} unit={unit} />) : null}
      {view.outcome === "propose" ? <AmuxIdeaUnknownDecisionRecoveryPanel
        ideaId={ideaId} /> : null}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{m.analysisResultNoApproval}</p>
    </div> : null}
  </section>;
}
