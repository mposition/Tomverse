"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ArrowUpRight, Check, ChevronRight, Sparkles, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { useGuestVerification } from "./GuestVerificationProvider";
import { ComparisonReviewWorkspace } from "./ComparisonReviewWorkspace";
import { ReviewItemFeedback, VerifyItemButton, type GuestReviewSource } from "./ComparisonReviewDialog";
import { SourceGroundingBadge } from "./SourceGroundingBadge";
import { StudioAnswerAnalysisSession } from "@/lib/studioAnswerAnalysisSession";
import { studioAnswerAnalysisCopy } from "@/lib/studioAnswerAnalysisCopy";
import { toSourceGrounding } from "@/lib/sourceGrounding";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { ComparisonReview, ReviewSetup } from "../../packages/chat-core/src/review";
import type { AiReviewAccess } from "./ComparisonActionRail";
import "./studio-answer-analysis.css";

const subscribeDesktop = (listener: () => void) => {
  const media = window.matchMedia("(min-width: 769px)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
export const useStudioAnalysisDesktop = () => useSyncExternalStore(
  subscribeDesktop, () => window.matchMedia("(min-width: 769px)").matches, () => false,
);

export function StudioAnswerAnalysis({
  enabled, ready, scope, conversationId, identityKey, isGuest, access,
  getGuestSource, onCompleted, onSignIn,
}: {
  enabled: boolean;
  ready: boolean;
  /** Changes for a new question, regeneration or restored conversation. */
  scope: string;
  conversationId: string | null;
  identityKey: string | null;
  isGuest: boolean;
  access: AiReviewAccess;
  getGuestSource?: () => GuestReviewSource | null;
  onCompleted?: () => void;
  onSignIn?: () => void;
}) {
  const { lang, t } = useLanguage();
  const desktop = useStudioAnalysisDesktop();
  const active = enabled && desktop;
  const copy = studioAnswerAnalysisCopy[lang];
  const { requestToken } = useGuestVerification();
  // Neither dismissal nor viewport changes discard completed or in-flight work.
  // A different identity, however, must never inherit this session's answers.
  const { session } = useMemo(() => ({ identityKey, isGuest, session: new StudioAnswerAnalysisSession() }), [identityKey, isGuest]);
  useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const entry = session.get(scope);
  const [openScope, setOpenScope] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<"summary" | "detail">("summary");
  const [reviewer, setReviewer] = useState<"primary" | "secondary">("primary");
  const keys = useRef(new Map<string, string>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = active && isOpen && openScope === scope;
  const close = useCallback(() => setIsOpen(false), []);
  useModalDialog({ open, onClose: close, dialogRef, panelRef });

  const loadAccount = useCallback(async () => {
    if (!conversationId) throw new Error("No conversation");
    const query = new URLSearchParams({ reviewMode: "balanced", includeSynthesis: "false" });
    const response = await fetch(`/api/conversations/${conversationId}/comparison-reviews?${query}`, { cache: "no-store" });
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error("Cannot prepare analysis");
    }
    return await response.json() as ReviewSetup;
  }, [conversationId]);

  useEffect(() => {
    if (active && ready && !isGuest) {
      // Read-only cache lookup. A paid execution is only reachable from a click.
      void session.prepare(scope, loadAccount).catch(() => {});
    }
  }, [active, ready, isGuest, session, scope, loadAccount]);

  const show = () => {
    if (openScope !== scope) { setTab("summary"); setReviewer("primary"); }
    trackProductEvent("comparison_review_viewed", entry?.review?.responseMap.length ?? entry?.setup?.responses?.length ?? 0);
    setOpenScope(scope);
    setIsOpen(true);
    if (entry?.review || entry?.phase === "running") return;
    const guest = isGuest ? getGuestSource?.() : null;
    const load = isGuest ? async (): Promise<ReviewSetup> => {
      if (!guest) throw new Error("No completed answers");
      const response = await fetch("/api/chat/comparison-review/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(guest), cache: "no-store",
      });
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error("Cannot prepare analysis");
      }
      const setup = await response.json() as ReviewSetup;
      return { ...setup, source: { question: guest.question, responses: guest.responses } };
    } : loadAccount;
    void session.open(scope, load, async (setup) => {
      if (!(access.kind === "account" || access.kind === "guestTrial")) throw new Error("Access unavailable");
      if (!guest && (!setup.promptMessageId || !setup.assistantMessageIds)) throw new Error("No completed answers");
      const keyScope = JSON.stringify([identityKey, guest]);
      if (!keys.current.has(keyScope)) keys.current.set(keyScope, crypto.randomUUID());
      const send = (turnstileToken?: string) => fetch(guest
        ? "/api/chat/comparison-review"
        : `/api/conversations/${conversationId}/comparison-reviews`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(guest ? { ...guest, idempotencyKey: keys.current.get(keyScope), ...(turnstileToken ? { turnstileToken } : {}) }
            : { promptMessageId: setup.promptMessageId, assistantMessageIds: setup.assistantMessageIds }),
          reviewMode: "balanced", includeSynthesis: false,
        }),
      });
      trackProductEvent("comparison_review_started", setup.responses?.length ?? 0, { review_mode: "balanced" });
      let response = await send();
      if (guest && !response.ok) {
        const failure = await response.clone().json().catch(() => ({})) as { code?: string };
        if (failure.code === "TURNSTILE_REQUIRED") {
          const token = await requestToken("guest_ai_review");
          if (!token) throw new Error("Verification incomplete");
          response = await send(token);
        } else if (failure.code !== "DUPLICATE_REQUEST") {
          // Only a known refusal releases the guest retry key. Unknown network
          // outcomes retain it so retry cannot silently start another paid run.
          keys.current.delete(keyScope);
        }
      }
      const data = await response.json() as ComparisonReview;
      if (!response.ok || !data.result) throw new Error("Analysis failed");
      trackProductEvent("comparison_review_completed", data.responseMap.length, { review_mode: "balanced", cached: data.cached });
      onCompleted?.();
      return data;
    });
  };

  const busy = entry?.phase === "running" || entry?.phase === "checking";
  const review = entry?.review;
  const source = entry?.setup?.source;
  const persisted = review?.persisted !== false && !isGuest;
  const slots = review ? (["primary", ...(review.result.secondary ? ["secondary"] : [])] as const) : [];
  if (!active) return null;

  return <>
    <div className="studio-analysis-entry" data-testid="studio-analysis-entry" data-state={review ? "done" : "new"}>
      <button type="button" onClick={show} disabled={!ready && !review && !busy} aria-haspopup="dialog" aria-expanded={open}>
        {review ? <Check size={17} /> : <Sparkles size={17} />}
        <span>{review ? copy.view : entry?.phase === "checking" ? copy.checking : busy ? copy.running : copy.start}</span><ChevronRight size={16} />
      </button>
      {busy && <div className="studio-analysis-progress" role="progressbar" aria-label={copy.running}><span /></div>}
      <p>{review ? copy.reuse : !ready ? copy.wait : copy.ready}</p>
    </div>
    {openScope === scope && createPortal(
      <div ref={dialogRef} className="studio-analysis-overlay" style={{ display: open ? undefined : "none" }}
        role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div ref={panelRef} className="studio-analysis-panel" tabIndex={-1}>
          <header className="studio-analysis-header">
            <Image unoptimized src="/tomverse-logo.png" width={36} height={36} alt="" />
            <div><h2 id={`${id}-title`}>{copy.title}</h2><p>{copy.intro}</p></div>
            {review && <span className="studio-analysis-saved"><Check size={13} />{persisted ? copy.saved : copy.local}</span>}
            <button type="button" className="studio-analysis-close" aria-label={copy.close} onClick={close}><X size={21} /></button>
          </header>
          {source && <div className="studio-analysis-question"><span>Q</span><p>{source.question}</p><small>{review?.responseMap.length ?? source.responses.length} {t("chat.aiReviewResponse")}</small></div>}
          <div className="studio-analysis-tabbar">
            <div role="tablist" aria-label={copy.title}>
              {(["summary", "detail"] as const).map((value) => <button key={value} type="button" role="tab" id={`${id}-${value}-tab`}
                aria-selected={tab === value} aria-controls={`${id}-${reviewer}-${value}`} disabled={!review} tabIndex={tab === value ? 0 : -1}
                onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = value === "summary" ? "detail" : "summary"; setTab(next); document.getElementById(`${id}-${next}-tab`)?.focus(); } }}
                onClick={() => setTab(value)}>{copy[value]}</button>)}
            </div><p>{review ? copy.reuse : copy.progress}</p>
          </div>
          <div className="studio-analysis-body">
            {!review && entry?.phase !== "error" && <div className="studio-analysis-loading" role="status" aria-live="polite">
              <span className="studio-analysis-mark"><Sparkles size={30} /></span>
              <h3>{entry?.phase === "checking" ? copy.checking : copy.running}</h3><p>{copy.progress}</p>
              <div className="studio-analysis-progress" role="progressbar" aria-label={copy.running}><span /></div>
              <ol><li aria-current={entry?.phase === "checking" ? "step" : undefined}>{entry?.phase !== "checking" && <Check size={15} />}{t("chat.aiReviewResponse")}</li><li aria-current={entry?.phase === "running" ? "step" : undefined}>{copy.detail}</li><li>{copy.summary}</li></ol>
              <p>{copy.background}</p>
            </div>}
            {entry?.phase === "error" && <div className="studio-analysis-error" role="alert"><p>{copy.failed}</p>
              <button type="button" onClick={show}>{copy.retry}</button>
              {isGuest && <button type="button" onClick={() => { close(); onSignIn?.(); }}>{copy.signIn}</button>}
            </div>}
            {review && <>
              {review.result.secondary && <div className="studio-analysis-reviewers" aria-label={copy.reviewer}>
                {(["primary", "secondary"] as const).map((slot, index) => <button type="button" key={slot} aria-pressed={reviewer === slot} onClick={() => setReviewer(slot)}>{copy.reviewer} {index + 1}</button>)}
              </div>}
              {slots.map((slot) => {
                const result = review.result[slot as "primary" | "secondary"]?.result;
                if (!result) return null;
                return <div key={`${review.id}-${slot}`} hidden={reviewer !== slot}>
                  <div role="tabpanel" id={`${id}-${slot}-summary`} aria-labelledby={`${id}-summary-tab`} hidden={tab !== "summary"}>
                    <section className="studio-analysis-lead"><span className="studio-analysis-eyebrow">{copy.differences}</span>
                      <h3>{result.differences[0]?.issue || copy.empty}</h3>
                      <ul>{result.differences.slice(1).map((item, i) => <li key={i}>{item.issue}</li>)}</ul>
                      <button type="button" onClick={() => setTab("detail")}>{copy.sources}<ArrowUpRight size={16} /></button>
                    </section>
                    <section><h3 className="studio-analysis-section-title">{copy.models}</h3><div className="studio-analysis-models">
                      {result.modelAssessments.map((assessment) => <article key={assessment.responseId}>
                        <h4><span>{assessment.responseId}</span>{review.responseMap.find((item) => item.responseId === assessment.responseId)?.modelName ?? assessment.responseId}</h4>
                        {result.differences[0]?.positions.filter((position) => position.responseId === assessment.responseId).map((position, i) => <div key={i}>
                          <p className="studio-analysis-position">{position.position}</p>
                          <small className="studio-analysis-fineprint">{t(position.verified ? "chat.aiReviewQuoteVerified" : "chat.aiReviewQuoteUnverified")}</small>
                        </div>)}
                        <strong>{t("chat.aiReviewStrengths")}</strong><ul>{assessment.strengths.map((text, i) => <li key={i}>{text}</li>)}</ul>
                        <strong>{t("chat.aiReviewCautions")}</strong><ul>{assessment.cautions.map((text, i) => <li key={i}>{text}</li>)}</ul>
                      </article>)}
                    </div></section>
                    <section className="studio-analysis-consensus"><h3>{copy.consensus}</h3>
                      {result.consensus.length ? result.consensus.map((claim, i) => <p key={i}>{claim.text} <small>{t(claim.verified ? "chat.aiReviewQuoteVerified" : "chat.aiReviewQuoteUnverified")}</small></p>) : <p>{t("chat.aiReviewNoneFound")}</p>}
                    </section>
                  </div>
                  <div role="tabpanel" id={`${id}-${slot}-detail`} aria-labelledby={`${id}-detail-tab`} hidden={tab !== "detail"}>
                    <SourceGroundingBadge grounding={toSourceGrounding(result)} labels={{
                      label: t("chat.aiReviewSourceGroundingOverall"), unavailable: t("chat.aiReviewSourceGroundingUnavailable"),
                      quotesMatched: t("chat.aiReviewSourceGroundingQuotesMatched"), description: `${t("chat.aiReviewSourceGroundingDescription")}\n\n${t("chat.aiReviewSourceGroundingScopeReview")}`, infoLabel: t("chat.aiReviewSourceGroundingInfoLabel"),
                    }} />
                    <ComparisonReviewWorkspace result={result} responseMap={review.responseMap} source={source} renderActions={(item) => <>
                      {item.section === "verificationNeeded" && <>
                        {isGuest || !conversationId || review.webVerificationAvailable === false ? <p>{t(isGuest ? "chat.guestAiReviewVerifySignIn" : "chat.aiReviewWebUnavailable")}</p> : <>
                          <VerifyItemButton conversationId={conversationId} item={item.text} checkLabel={t("chat.aiReviewVerifyWithWeb")} checkingLabel={t("chat.aiReviewVerifying")} failedLabel={copy.failed} showServerError={false}
                            statusLabels={{ supported: t("chat.aiReviewVerifySupported"), unsupported: t("chat.aiReviewVerifyUnsupported"), inconclusive: t("chat.aiReviewVerifyInconclusive") }} />
                          <p className="studio-analysis-fineprint">{copy.external}</p>
                        </>}
                      </>}
                      <ReviewItemFeedback conversationId={conversationId} reviewId={review.id} guest={isGuest}
                        itemId={review.reviewItems?.find((value) => value.reviewer === slot && value.section === item.section && value.ordinal === item.ordinal)?.id} />
                    </>} />
                  </div>
                  {result.limitations.length > 0 && <details className="studio-analysis-limitations"><summary>{t("chat.aiReviewLimitations")}</summary><ul>{result.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></details>}
                </div>;
              })}
            </>}
          </div>
          <footer className="studio-analysis-footer"><p>{copy.disclaimer}</p><button type="button" onClick={close}>{copy.close}</button></footer>
        </div>
      </div>, document.body)}
  </>;
}
