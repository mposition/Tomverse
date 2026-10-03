"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxIdeaProposalRelations } from "@/components/admin/AmuxIdeaProposalRelations";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { parseAmuxIdeaAnalysisResultView,
  type AmuxIdeaAnalysisResultPage,
  type AmuxIdeaAnalysisResultView } from "@/lib/amux/ideaAnalysisResultReadCore";

const list = (values: string[]) => <ul className="list-disc pl-5">
  {values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}
</ul>;

/** Owner-only page section. All model-derived text is rendered as React text,
 * never as HTML. No approval, registration, or model request originates here. */
export function AmuxIdeaAnalysisResultPanel({ ideaId, onContinuationSelection }: {
  ideaId: string;
  onContinuationSelection?: (value: { chunkIndex: number;
    pinnedTargetRefs: string[] } | null) => void;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<AmuxIdeaAnalysisResultView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [pinnedTargetRefs, setPinnedTargetRefs] = useState<string[]>([]);

  const refresh = async (startChunkIndex = 0) => {
    if (loading) return;
    setLoading(true);
    setUnavailable(false);
    setNeedsReauthentication(false);
    try {
      const params = new URLSearchParams({ ideaId });
      if (startChunkIndex > 0) params.set("startChunkIndex", String(startChunkIndex));
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
        setView(parsed);
        const last = parsed.state === "partial" ? 0 :
          parsed.state === "continued_partial" ? parsed.pages.at(-1)?.chunkIndex :
            parsed.state === "continued_window" && !parsed.complete &&
              parsed.nextChunkIndex === null ? parsed.pages.at(-1)?.chunkIndex : null;
        if (last !== null && last !== undefined) {
          onContinuationSelection?.({ chunkIndex: last + 1, pinnedTargetRefs });
        } else if (parsed.state === "ready" || parsed.state === "continued_ready" ||
            (parsed.state === "continued_window" && parsed.complete)) {
          onContinuationSelection?.(null);
        }
      }
    } catch { setView(null); setUnavailable(true); }
    finally { setLoading(false); }
  };

  const pages: AmuxIdeaAnalysisResultPage[] = view?.state === "continued_ready" ||
    view?.state === "continued_partial" || view?.state === "continued_window" ? view.pages :
    view?.state === "ready" || view?.state === "partial" ? [{
      chunkIndex: 0, previewId: view.previewId, completedAt: view.completedAt,
      outcome: view.outcome, coveredScope: view.coveredScope,
      remainingScope: view.state === "partial" ? view.remainingScope : null,
      units: view.units,
    }] : [];

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
    {loading ? <p role="status">{m.analysisResultLoading}</p> : null}
    {needsReauthentication ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}
    </a> : null}
    {unavailable ? <p role="alert">{m.analysisResultUnavailable}</p> : null}
    {view?.state === "pending" ? <p role="status">{m.analysisResultPending}</p> : null}
    {view?.state === "cancelled" ? <p role="status">{m.analysisResultCancelled}</p> : null}
    {view?.state === "provider_failed" ? <p role="alert">{m.analysisResultProviderFailed}</p> : null}
    {view?.state === "owner_input" ? <div role="alert"
      className="space-y-2 rounded-lg border border-amber-300 p-3 dark:border-amber-700">
      <p>{m.analysisResultOwnerInput}</p>
      <p className="whitespace-pre-wrap">{view.ownerQuestion ?? m.analysisResultScopeExpired}</p>
      <p className="whitespace-pre-wrap">{view.remainingScope ?? m.analysisResultScopeExpired}</p>
    </div> : null}
    {pages.length > 0 ? <div className="space-y-3">
      {pages.map((page, pageIndex) => <div key={page.previewId} className="space-y-3">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        #{page.chunkIndex + 1} · {page.completedAt} · {page.previewId}
      </p>
      <p>{page.coveredScope ?? m.analysisResultScopeExpired}</p>
      {(view?.state === "partial" ||
        (view?.state === "continued_partial" && pageIndex === pages.length - 1) ||
        (view?.state === "continued_window" && !view.complete &&
          view.nextChunkIndex === null && pageIndex === pages.length - 1)) ?
        <p role="status" className="rounded-lg border border-amber-300 p-3 dark:border-amber-700">
        {m.analysisResultPartial} {page.remainingScope ?? m.analysisResultScopeExpired}
      </p> : null}
      {page.outcome === "reject" ? <p role="status">{m.analysisResultRejected}</p> : null}
      <ol className="space-y-2">
        {page.units.map((unit) => <li key={unit.id}
          className="rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {unit.localRef} · {unit.decisionState}
          </p>
          {unit.proposal && unit.proposal.kind !== "evidence" ? <label className="flex gap-2 text-xs">
            <input type="checkbox" checked={pinnedTargetRefs.includes(unit.localRef)}
              disabled={!pinnedTargetRefs.includes(unit.localRef) && pinnedTargetRefs.length >= 6}
              onChange={(event) => {
                const next = event.target.checked ? [...pinnedTargetRefs, unit.localRef] :
                  pinnedTargetRefs.filter((ref) => ref !== unit.localRef);
                setPinnedTargetRefs(next);
                const last = pages.at(-1)?.chunkIndex;
                if (last !== undefined && ((view?.state === "partial") ||
                    view?.state === "continued_partial" ||
                    (view?.state === "continued_window" && !view.complete &&
                      view.nextChunkIndex === null))) {
                  onContinuationSelection?.({ chunkIndex: last + 1,
                    pinnedTargetRefs: next });
                }
              }} />
            {m.analysisResultPinReference}
          </label> : null}
          {!unit.proposal ? <p>{m.analysisResultBodyExpired}</p> : null}
          {unit.proposal?.kind === "node" ? <div className="space-y-1">
            <h4 className="font-semibold">{unit.proposal.title}</h4>
            <p>{unit.proposal.level}</p>
            <p className="whitespace-pre-wrap">{unit.proposal.description}</p>
          </div> : null}
          {unit.proposal?.kind === "card" ? <div className="space-y-2">
            <h4 className="font-semibold">{unit.proposal.title}</h4>
            <p>{unit.proposal.cardType}</p>
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
          </div> : null}
          {unit.proposal ? <AmuxIdeaProposalRelations proposal={unit.proposal} messages={m} /> : null}
        </li>)}
      </ol>
      </div>)}
      {view?.state === "continued_window" && view.startChunkIndex > 0 ?
        <button type="button" disabled={loading}
          onClick={() => void refresh(Math.max(0, view.startChunkIndex - 16))}
          className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
          {m.analysisResultPreviousWindow}
        </button> : null}
      {view?.state === "continued_window" && view.nextChunkIndex !== null ?
        <button type="button" disabled={loading}
          onClick={() => void refresh(view.nextChunkIndex!)}
          className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
          {m.analysisResultNextWindow}
        </button> : null}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{m.analysisResultNoApproval}</p>
    </div> : null}
  </section>;
}
