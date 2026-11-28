import { useEffect, useId, useRef, useState } from "react";
import { Scale, X } from "lucide-react";
import { SourceGroundingBadge } from "@/components/chat/SourceGroundingBadge";
import { toSourceGrounding } from "@/lib/sourceGrounding";
import type { Language } from "../../../../lib/language";
import type { CompareEstimateOutcome, QuickSummary } from "../chat-extras-contract";
import { webLocales } from "./answer-locales";
import { compareFailureText } from "./compare-failure";
import { VerifyReviewItem } from "./ReviewItemActions";
import "./review-extras.css";

type Chat = typeof webLocales.en.chat;

function Quote({ quote, verified, source, chat }: { quote: string; verified: boolean; source: string; chat: Chat }) {
  return <blockquote className="quick-summary-quote" data-verified={verified}>
    <q>{quote}</q> <small>{source} · {verified ? chat.aiReviewQuoteVerified : chat.aiReviewQuoteUnverified}</small>
  </blockquote>;
}

/** The quick difference summary of the latest Review turn: one model call, quoted claims and optional web checks. */
export function DesktopCompareSummary({ language, conversationId, ready }: { language: Language; conversationId?: string; ready: boolean }) {
  const chat = webLocales[language].chat;
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [estimate, setEstimate] = useState<Extract<CompareEstimateOutcome, { ok: true }> | null>(null);
  const [summary, setSummary] = useState<QuickSummary | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!conversationId || !ready) return;
    let current = true;
    void window.desktop.chatExtras<"compareEstimate">({ action: "compareEstimate", conversationId })
      .then((outcome) => { if (current && outcome.ok && outcome.available) setEstimate(outcome); }, () => {});
    return () => { current = false; };
  }, [conversationId, ready]);
  if (!conversationId || !estimate) return null;
  const names = new Map(summary?.responseMap.map((row) => [row.responseId, row.modelName]));

  async function run() {
    if (summary) { dialog.current?.showModal(); return; }
    setPhase("running");
    setFailure("");
    try {
      const outcome = await window.desktop.chatExtras<"compareSummary">({ action: "compareSummary", conversationId: conversationId! });
      if (!outcome.ok) {
        setFailure(compareFailureText(chat, outcome.code));
        setPhase("failed");
        return;
      }
      setSummary(outcome.summary);
      setPhase("idle");
      dialog.current?.showModal();
    } catch {
      setFailure(chat.compareUnavailable);
      setPhase("failed");
    }
  }
  const quoteSource = (responseId: string) => names.get(responseId as "A") ?? responseId;
  return <>
    <div className="studio-analysis-entry review-quick-summary-entry">
      <button type="button" disabled={!ready || phase === "running"} data-testid="desktop-quick-summary-open" onClick={() => void run()}
        aria-haspopup="dialog">
        <Scale size={17} aria-hidden="true" />
        <span>{phase === "running" ? chat.quickDifferenceSummaryLoading : chat.quickDifferenceSummary}</span>
        <small>{estimate.cached || summary ? chat.aiReviewCached : `${estimate.estimatedCredits} ${chat.aiReviewCredits}`}</small>
      </button>
      {phase === "failed" && <p role="alert" className="review-quick-summary-error">{failure}</p>}
    </div>
    <dialog ref={dialog} className="studio-analysis-overlay desktop-review-analysis" aria-labelledby={`${id}-title`}
      data-testid="desktop-quick-summary-dialog">
      <div className="studio-analysis-panel">
        <header className="studio-analysis-header">
          <div><h2 id={`${id}-title`}>{chat.quickDifferenceSummary}</h2>
            <p>{summary?.cached ? chat.quickDifferenceSummaryCachedNote : chat.quickDifferenceSummaryNote}</p>
            {summary && <small>{chat.aiReviewedBy}: {summary.reviewerModelId}</small>}</div>
          <button type="button" className="studio-analysis-close" aria-label={chat.close} onClick={() => dialog.current?.close()}><X size={21} /></button>
        </header>
        {summary && <div className="studio-analysis-body review-quick-summary-body">
          <SourceGroundingBadge grounding={toSourceGrounding(summary.result)} labels={{ label: chat.aiReviewSourceGroundingOverall,
            unavailable: chat.aiReviewSourceGroundingUnavailable, quotesMatched: chat.aiReviewSourceGroundingQuotesMatched,
            description: `${chat.aiReviewSourceGroundingDescription}\n\n${chat.aiReviewSourceGroundingScopeSummary}`,
            infoLabel: chat.aiReviewSourceGroundingInfoLabel }} testId="desktop-quick-summary-grounding" />
          <section data-testid="quick-summary-consensus"><h3>{chat.quickSummaryCommonConclusions}</h3>
            <ul>{summary.result.commonConclusions.map((item, index) => <li key={`${index}-${item.text}`}>{item.text}
              {item.citations.map((citation, at) => <Quote key={at} quote={citation.quote} verified={citation.verified}
                source={quoteSource(citation.responseId)} chat={chat} />)}</li>)}</ul></section>
          <section data-testid="quick-summary-differences"><h3>{chat.quickSummaryImportantDifferences}</h3>
            {summary.result.importantDifferences.length ? <ol>{summary.result.importantDifferences.map((item, index) =>
              <li key={`${index}-${item.text}`}>{item.text}
                {item.citations.map((citation, at) => <Quote key={at} quote={citation.quote} verified={citation.verified}
                  source={quoteSource(citation.responseId)} chat={chat} />)}</li>)}</ol>
              : <p>{chat.quickSummaryNoMeaningfulDifferences}</p>}</section>
          <section data-testid="quick-summary-model-claims"><h3>{chat.quickSummaryModelClaims}</h3>
            {summary.result.modelKeyClaims.map((assessment) => <article key={assessment.responseId}>
              <h4>{quoteSource(assessment.responseId)}</h4>
              <ul>{assessment.claims.map((claim, index) => <li key={`${index}-${claim.claim}`}>{claim.claim}
                <Quote quote={claim.quote} verified={claim.verified} source={quoteSource(assessment.responseId)} chat={chat} /></li>)}</ul>
            </article>)}</section>
          <section data-testid="quick-summary-verification"><h3>{chat.quickSummaryVerificationNeeded}</h3>
            {summary.result.verificationNeeded.length ? <ul>{summary.result.verificationNeeded.map((item, index) => <li key={`${index}-${item}`}>
              {item}<VerifyReviewItem conversationId={conversationId} item={item} language={language} /></li>)}</ul>
              : <p>{chat.quickSummaryNoVerificationItems}</p>}
            <small>{chat.quickSummaryDisclaimer}</small></section>
        </div>}
      </div>
    </dialog>
  </>;
}
