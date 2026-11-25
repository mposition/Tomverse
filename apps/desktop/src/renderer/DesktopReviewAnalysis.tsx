import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, Check, ChevronRight, Sparkles, X } from "lucide-react";
import { LanguageProvider, useLanguage } from "@/components/LanguageProvider";
import { ComparisonReviewWorkspace } from "@/components/chat/ComparisonReviewWorkspace";
import { SourceGroundingBadge } from "@/components/chat/SourceGroundingBadge";
import { studioAnswerAnalysisCopy } from "@/lib/studioAnswerAnalysisCopy";
import { StudioAnswerAnalysisSession } from "@/lib/studioAnswerAnalysisSession";
import { toSourceGrounding } from "@/lib/sourceGrounding";
import type { Language } from "@/lib/language";
import logo from "../../../../public/tomverse-logo.png";
import "@/components/chat/studio-answer-analysis.css";

export function DesktopReviewAnalysis({ language, ...props }: { language: Language; conversationId?: string; scope: string; ready: boolean }) {
  return <LanguageProvider initialLang={language} forceInitialLang><Analysis {...props} /></LanguageProvider>;
}

function Analysis({ conversationId, scope, ready }: { conversationId?: string; scope: string; ready: boolean }) {
  const { lang, t } = useLanguage();
  const copy = studioAnswerAnalysisCopy[lang];
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const outsideDown = useRef(false);
  const [session] = useState(() => new StudioAnswerAnalysisSession());
  const [tab, setTab] = useState<"summary" | "detail">("summary");
  const [reviewer, setReviewer] = useState<"primary" | "secondary">("primary");
  const [open, setOpen] = useState(false);
  useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const entry = session.get(scope);
  const busy = entry?.phase === "running" || entry?.phase === "checking";
  const review = entry?.review;
  const source = entry?.setup?.source;
  const result = review?.result[reviewer]?.result;
  useEffect(() => {
    if (dialog.current?.open) dialog.current.close();
  }, [scope]);
  function show() {
    if (!conversationId || !ready) return;
    if (!dialog.current?.open) {
      setTab("summary"); setReviewer("primary");
      dialog.current?.showModal(); setOpen(true);
    }
    const load = () => window.desktop.prepareReviewAnalysis(conversationId);
    if (entry?.phase === "error" && entry.executionStarted) {
      void session.recover(scope, load);
    } else {
      void session.open(scope, load, (setup) => {
        if (!setup.promptMessageId || !setup.assistantMessageIds || !setup.available) throw new Error("No completed Review answers.");
        return window.desktop.runReviewAnalysis({ conversationId, promptMessageId: setup.promptMessageId, assistantMessageIds: setup.assistantMessageIds });
      });
    }
  }
  return <>
    <div className="studio-analysis-entry" data-state={entry?.phase === "error" ? "error" : review ? "done" : "new"}>
      <button type="button" ref={trigger} disabled={!ready} onClick={show} aria-haspopup="dialog" aria-expanded={open}>
        {review ? <Check size={17} /> : <Sparkles size={17} />}<span>{entry?.phase === "error" ? copy.retry : review ? copy.view : copy.start}</span><ChevronRight size={16} />
      </button>
    </div>
    <dialog ref={dialog} className="studio-analysis-overlay desktop-review-analysis" aria-labelledby={`${id}-title`}
      onPointerDown={(event) => { outsideDown.current = event.target === event.currentTarget; }}
      onClick={(event) => { if (outsideDown.current && event.target === event.currentTarget) dialog.current?.close(); }}
      onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <div className="studio-analysis-panel">
        <header className="studio-analysis-header">
          <img src={logo} width="36" height="36" alt="" />
          <div><h2 id={`${id}-title`}>{copy.title}</h2><p>{copy.intro}</p></div>
          {review && <span className="studio-analysis-saved"><Check size={13} />{copy.saved}</span>}
          <button type="button" className="studio-analysis-close" aria-label={copy.close} onClick={() => dialog.current?.close()}><X size={21} /></button>
        </header>
        {source && <div className="studio-analysis-question"><span>Q</span><p>{source.question}</p><small>{source.responses.length} {t("chat.aiReviewResponse")}</small></div>}
        <div className="studio-analysis-tabbar"><div role="tablist" aria-label={copy.title}>
          {(["summary", "detail"] as const).map((item) => <button key={item} type="button" role="tab" id={`${id}-${item}-tab`}
            aria-controls={`${id}-${item}`} aria-selected={tab === item} disabled={!result} tabIndex={tab === item ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = item === "summary" ? "detail" : "summary";
              setTab(next); document.getElementById(`${id}-${next}-tab`)?.focus();
            }} onClick={() => setTab(item)}>{copy[item]}</button>)}
        </div><p>{result ? copy.reuse : copy.progress}</p></div>
        <div className="studio-analysis-body">
          {busy && <div className="studio-analysis-loading" role="status"><Sparkles size={24} /><h3>{entry.phase === "checking" ? copy.checking : copy.running}</h3>
            <div className="studio-analysis-progress" role="progressbar" aria-label={copy.running}><span /></div><p>{copy.background}</p></div>}
          {entry?.phase === "error" && <div className="studio-analysis-error" role="alert"><p>{copy.failed}</p><button type="button" onClick={show}>{copy.retry}</button></div>}
          {review && result && <>
            {review.result.secondary && <div className="studio-analysis-reviewers" aria-label={copy.reviewer}>
              {(["primary", "secondary"] as const).map((slot, index) => <button key={slot} type="button" aria-pressed={reviewer === slot}
                onClick={() => setReviewer(slot)}>{copy.reviewer} {index + 1}</button>)}
            </div>}
            <div role="tabpanel" id={`${id}-summary`} aria-labelledby={`${id}-summary-tab`} hidden={tab !== "summary"}>
              <section className="studio-analysis-lead"><span className="studio-analysis-eyebrow">{copy.differences}</span>
                <h3>{result.differences[0]?.issue || copy.empty}</h3>
                <ul>{result.differences.slice(1).map((item, index) => <li key={index}>{item.issue}</li>)}</ul>
                <button type="button" onClick={() => setTab("detail")}>{copy.sources}<ArrowUpRight size={16} /></button>
              </section>
              <section><h3 className="studio-analysis-section-title">{copy.models}</h3><div className="studio-analysis-models">
                {result.modelAssessments.map((assessment) => <article key={assessment.responseId}>
                  <h4><span>{assessment.responseId}</span>{review.responseMap.find((item) => item.responseId === assessment.responseId)?.modelName ?? assessment.responseId}</h4>
                  {result.differences[0]?.positions.filter(({ responseId }) => responseId === assessment.responseId).map((position, index) => <div key={index}>
                    <p className="studio-analysis-position">{position.position}</p><small className="studio-analysis-fineprint">{t(position.verified ? "chat.aiReviewQuoteVerified" : "chat.aiReviewQuoteUnverified")}</small>
                  </div>)}
                  <strong>{t("chat.aiReviewStrengths")}</strong><ul>{assessment.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul>
                  <strong>{t("chat.aiReviewCautions")}</strong><ul>{assessment.cautions.map((item, index) => <li key={index}>{item}</li>)}</ul>
                </article>)}
              </div></section>
              <section className="studio-analysis-consensus"><h3>{copy.consensus}</h3>
                {result.consensus.length ? result.consensus.map((item, index) => <p key={index}>{item.text} <small>{t(item.verified ? "chat.aiReviewQuoteVerified" : "chat.aiReviewQuoteUnverified")}</small></p>) : <p>{t("chat.aiReviewNoneFound")}</p>}
              </section>
            </div>
            <div role="tabpanel" id={`${id}-detail`} aria-labelledby={`${id}-detail-tab`} hidden={tab !== "detail"}>
              <SourceGroundingBadge grounding={toSourceGrounding(result)} labels={{ label: t("chat.aiReviewSourceGroundingOverall"),
                unavailable: t("chat.aiReviewSourceGroundingUnavailable"), quotesMatched: t("chat.aiReviewSourceGroundingQuotesMatched"),
                description: t("chat.aiReviewSourceGroundingDescription"), infoLabel: t("chat.aiReviewSourceGroundingInfoLabel") }} />
              <ComparisonReviewWorkspace result={result} responseMap={review.responseMap} source={source} renderActions={() => null} />
            </div>
            {result.limitations.length > 0 && <details className="studio-analysis-limitations"><summary>{t("chat.aiReviewLimitations")}</summary>
              <ul>{result.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
          </>}
        </div>
        <footer className="desktop-analysis-footer">{copy.disclaimer}</footer>
      </div>
    </dialog>
  </>;
}
