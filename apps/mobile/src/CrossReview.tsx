import { useEffect, useState } from "react";
import type { ComparisonReview, ReviewMode, ReviewSetup, Citation } from "../../../packages/chat-core/src/review";
import { toSourceGrounding } from "../../../lib/sourceGrounding";
import { mobileReviewCopy } from "../../../locales/mobileReview";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport } from "./chatTransport";
import { Sheet } from "./Sheet";

export function CrossReview({ id, owner, transport, language, onClose, onSource, onBusy }: {
  id: string; owner: string | null; transport: ChatTransport; language: MobileLanguage; onClose: () => void; onSource: (id: string) => void; onBusy: (busy: boolean) => void;
}) {
  const c = mobileReviewCopy(language);
  const [mode, setMode] = useState<ReviewMode>("balanced"); const [synthesis, setSynthesis] = useState(false);
  const [setup, setSetup] = useState<ReviewSetup | null>(null); const [review, setReview] = useState<ComparisonReview | null>(null);
  const [reviewer, setReviewer] = useState<"primary" | "secondary">("primary");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [unknown, setUnknown] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [verify, setVerify] = useState(""); const [verification, setVerification] = useState<Awaited<ReturnType<NonNullable<ChatTransport["verifyReviewItem"]>>> | null>(null);
  const pendingKey = `tomverse-review-pending:${owner}:${id}:${mode}:${synthesis}`;
  const verificationKey = `tomverse-review-verification-pending:${owner}:${id}`;
  const [verificationUnknown, setVerificationUnknown] = useState(localStorage.getItem(verificationKey) === "pending");
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  async function load() {
    setError("");
    try {
      if (!transport.reviewPreview) throw Error("UNAVAILABLE");
      const value = await transport.reviewPreview(id, mode, synthesis); setSetup(value);
      if (value.storedReview) { setReview(value.storedReview); setUnknown(false); localStorage.removeItem(pendingKey); }
      else { setReview(null); setUnknown(localStorage.getItem(pendingKey) === "pending"); }
    } catch { setError(c.failed); }
  }
  useEffect(() => { let active = true;
    queueMicrotask(() => { if (!active) return; setSetup(null); setReview(null); setBusy(true); void load().finally(() => { if (active) setBusy(false); }); }); return () => { active = false; };
    // Request configuration is the readback identity; no effect submits a paid run.
  }, [id, mode, synthesis]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let active = true; queueMicrotask(() => { if (active) setFeedback({}); });
    if (review && transport.reviewFeedback) void transport.reviewFeedback(id, review.id).then(value => { if (active) setFeedback(Object.fromEntries(value.feedback.map(item => [item.reviewItemId, item.verdict]))); }).catch(() => { if (active) setError(c.failed); });
    return () => { active = false; };
  }, [id, review, transport, c.failed]);
  async function run() {
    if (busy || unknown || !setup?.available || !setup.promptMessageId || !setup.assistantMessageIds || !transport.runComparison) return;
    // Written before dispatch so a process restart cannot silently repeat an unknown run.
    localStorage.setItem(pendingKey, "pending"); setUnknown(true); setBusy(true); setError("");
    try { const value = await transport.runComparison(id, { promptMessageId: setup.promptMessageId, assistantMessageIds: setup.assistantMessageIds, reviewMode: mode, includeSynthesis: synthesis }); setReview(value); localStorage.removeItem(pendingKey); setUnknown(false); }
    catch (error) { const status = (error as { status?: number }).status; if (status && status >= 400 && status < 500 && status !== 408) { localStorage.removeItem(pendingKey); setUnknown(false); setError(c.failed); } else setError(c.uncertain); } finally { setBusy(false); }
  }
  const result = review?.result[reviewer]?.result;
  const grounding = result && toSourceGrounding(result);
  function citations(items: Citation[]) {
    return items.map((item, index) => <blockquote key={index}><p>“{item.quote}”</p><small>{item.responseId} · {item.verified ? c.matched : c.unmatched}</small><button onClick={() => { const source = review?.responseMap.find(row => row.responseId === item.responseId); if (source) onSource(source.messageId); }}>{c.original}</button></blockquote>);
  }
  function actions(section: string, ordinal: number, text: string) {
    const itemId = review?.reviewItems?.find(item => item.reviewer === reviewer && item.section === section && item.ordinal === ordinal)?.id;
    return <div className="review-item-actions">{itemId && <><p className="field-hint">{c.feedbackHint}</p><div role="group" aria-label={c.feedbackHint}>{(["helpful", "incorrect", "unclear", "missing_point"] as const).map(verdict => <button key={verdict} disabled={busy} aria-pressed={feedback[itemId] === verdict} onClick={() => {
      if (!transport.setReviewFeedback || !review) return; setBusy(true);
      void transport.setReviewFeedback(id, review.id, itemId, feedback[itemId] === verdict ? null : verdict).then(() => transport.reviewFeedback!(id, review.id)).then(value => setFeedback(Object.fromEntries(value.feedback.map(item => [item.reviewItemId, item.verdict])))).catch(() => setError(c.failed)).finally(() => setBusy(false));
    }}>{c[verdict]}</button>)}</div></>}
      <button disabled={busy || text.length > 500} onClick={() => { setVerify(text); setVerification(null); }}>{c.verify}</button></div>;
  }
  return <Sheet title={c.crossReview} closeLabel={mobileCopy[language].close} onClose={() => { if (!busy) onClose(); }}>
    <div className="cross-review"><div className="segmented" role="group" aria-label={c.crossReview}>{(["balanced", "evidence", "action"] as const).map(value => <button key={value} disabled={busy} aria-pressed={mode === value} onClick={() => setMode(value)}>{c[value]}</button>)}</div>
    <label className="switch-field">{c.synthesis}<input type="checkbox" checked={synthesis} disabled={busy} onChange={event => setSynthesis(event.target.checked)} /></label>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!review && <><p>{setup?.reason ?? setup?.disclaimer}</p>{setup?.available && <p>{c.cost}: {setup.estimatedCredits ?? "—"}</p>}<button className="primary" disabled={busy || unknown || !setup?.available} onClick={() => void run()}>{busy ? mobileCopy[language].loading : c.run}</button></>}
    {unknown && <><p role="status">{c.uncertain}</p><button disabled={busy} onClick={() => void load()}>{c.refresh}</button></>}
    {review && result && <><p>{review.disclaimer}</p><p>{review.usageCredits} {c.credits}{review.cached ? " · cached" : ""}</p><div className="review-provider-tabs">{(["primary", "secondary"] as const).filter(value => review.result[value]).map(value => <button key={value} aria-pressed={reviewer === value} onClick={() => setReviewer(value)}>{review.result[value]?.reviewerModelId}</button>)}</div>
    <p>{grounding?.available ? `${c.grounding}: ${grounding.percent}% (${grounding.matchedQuotes}/${grounding.totalQuotes})` : c.noGrounding}</p><p className="field-hint">{c.groundingHint}</p>
    {(["consensus", "contradictions"] as const).map(section => <section key={section}><h3>{c[section]}</h3>{result[section].map((claim, index) => <article className="review-claim" key={index}><p>{claim.text}</p>{citations(claim.citations)}{actions(section, index, claim.text)}</article>)}</section>)}
    <section><h3>{c.differences}</h3>{result.differences.map((item, index) => <article className="review-claim" key={index}><h4>{item.issue}</h4>{item.positions.map((position, n) => <div key={n}><p>{position.responseId}: {position.position}</p>{citations([position])}</div>)}{actions("differences", index, item.issue)}</article>)}</section>
    {(["missingPoints", "verificationNeeded", "limitations"] as const).map(section => <section key={section}><h3>{c[section]}</h3>{result[section].map((text, index) => <article className="review-claim" key={index}><p>{text}</p>{section !== "limitations" && actions(section, index, text)}</article>)}</section>)}
    <section><h3>{c.modelAssessments}</h3>{result.modelAssessments.map(item => <article key={item.responseId}><h4>{item.responseId}</h4><ul>{[...item.strengths, ...item.cautions].map((text, index) => <li key={index}>{text}</li>)}</ul></article>)}</section>
    {result.synthesis && <section><h3>{c.synthesis}</h3><p>{result.synthesis}</p></section>}
    {verify && <aside className="notice"><h3>{c.verification}</h3><p>{verify}</p><p>{c.verifyConsent}</p>{verificationUnknown && <p role="status">{c.uncertain}</p>}{verification ? <><p>{verification.status} · {verification.reviewerModelId} · {verification.usageCredits} {c.credits}</p><p>{verification.summary}</p><p>{verification.disclaimer}</p></> : <button disabled={busy || verificationUnknown} onClick={() => { if (!transport.verifyReviewItem) return; setBusy(true); localStorage.setItem(verificationKey, "pending"); setVerificationUnknown(true); void transport.verifyReviewItem(id, verify).then(value => { setVerification(value); localStorage.removeItem(verificationKey); setVerificationUnknown(false); }).catch(error => { const status = (error as { status?: number }).status; if (status && status >= 400 && status < 500 && status !== 408) { localStorage.removeItem(verificationKey); setVerificationUnknown(false); } setError(c.uncertain); }).finally(() => setBusy(false)); }}>{c.verifyRun}</button>}</aside>}
    </>}
    </div>
  </Sheet>;
}
