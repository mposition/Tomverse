import { useEffect, useRef, useState } from "react";
import type { QuickReview, ReviewChatSource } from "../../../lib/reviewToChat";
import { reviewHandoffCopy } from "../../../locales/reviewHandoff";
import { mobileReviewCopy } from "../../../locales/mobileReview";
import { nativeWorkspaceCopy } from "../../../locales/nativeWorkspace";
import type { MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport } from "./chatTransport";
import type { NativeReviewChatOffer } from "./nativeReviewChat";
import { Sheet } from "./Sheet";

export function QuickSummary({ id, owner, transport, language, onClose, onBusy, onContinue }: {
  id: string; owner: string | null; transport: ChatTransport; language: MobileLanguage;
  onClose: () => void; onBusy: (busy: boolean) => void; onContinue?: (offer: NativeReviewChatOffer) => void;
}) {
  const c = nativeWorkspaceCopy(language), reviewCopy = mobileReviewCopy(language);
  const handoff = reviewHandoffCopy[language === "zh-Hant" ? "zhHant" : language];
  const [setup, setSetup] = useState<Awaited<ReturnType<NonNullable<ChatTransport["quickSummaryPreview"]>>> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const key = `tomverse-quick-summary-pending:${owner}:${id}`;
  const [unknown, setUnknown] = useState(localStorage.getItem(key) === "pending");
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  // Only the newest read may write state; an older or post-unmount answer is dropped.
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function load() {
    if (!transport.quickSummaryPreview) return;
    const current = ++generation.current;
    const value = await transport.quickSummaryPreview(id);
    if (current !== generation.current) return;
    setSetup(value);
    if (value.cached && value.storedSummary) { localStorage.removeItem(key); setUnknown(false); }
  }
  useEffect(() => { let live = true; queueMicrotask(() => { if (!live) return; setBusy(true); void load().catch(() => { if (live) setError(reviewCopy.failed); }).finally(() => { if (live) setBusy(false); }); }); return () => { live = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps -- Owner/conversation-scoped modal is remounted.
  async function run() {
    if (busy || unknown || !setup?.available || !transport.runQuickSummary) return;
    localStorage.setItem(key, "pending"); setUnknown(true); setBusy(true); setError("");
    try { await transport.runQuickSummary(id); await load(); }
    catch (failure) {
      const status = (failure as { status?: number }).status;
      const refused = Boolean(status && status >= 400 && status < 500 && status !== 408);
      if (refused) { localStorage.removeItem(key); setUnknown(false); }
      setError(refused ? reviewCopy.failed : reviewCopy.uncertain);
    } finally { setBusy(false); }
  }
  const summary: QuickReview | undefined = setup?.storedSummary;
  const continuable = Boolean(onContinue && summary && setup?.source && setup.cached === true);
  // Quick Summary keeps its own sections; it is never parsed as an AI Review result.
  function offer(selection?: NativeReviewChatOffer["selection"]) {
    if (!continuable || !setup || !summary) return;
    onContinue!({ source: { kind: "quick", conversationId: id, setup: setup as ReviewChatSource["setup"], review: summary }, ...(selection ? { selection } : {}) });
  }
  const item = (section: string, ordinal: number) => continuable && <button disabled={busy} data-testid="native-quick-item-continue" onClick={() => offer({ section, ordinal })}>{handoff.issue}</button>;
  return <Sheet title={c.quickSummary} closeLabel={c.close} onClose={() => { if (!busy) onClose(); }}>
    <div className="cross-review">
      {error && <p role="alert">{error}</p>}
      {summary ? <><p>{reviewCopy.groundingHint}</p>
        {(["commonConclusions", "importantDifferences"] as const).map(section => <section key={section}><h3>{section === "commonConclusions" ? reviewCopy.consensus : reviewCopy.differences}</h3>{summary.result[section].map((entry, index) => <article key={index}><p>{entry.text}</p>{entry.citations.map((citation, n) => <blockquote key={n}>{citation.responseId}: “{citation.quote}”<small>{citation.verified ? reviewCopy.matched : reviewCopy.unmatched}</small></blockquote>)}{item(section, index)}</article>)}</section>)}
        <h3>{reviewCopy.modelAssessments}</h3>{summary.result.modelKeyClaims.map((entry, index) => <section key={entry.responseId}><strong>{summary.responseMap.find(row => row.responseId === entry.responseId)?.modelName ?? entry.responseId}</strong>{entry.claims.map((claim, n) => <p key={n}>{claim.claim}</p>)}{item("models", index)}</section>)}
        <h3>{reviewCopy.verificationNeeded}</h3>{summary.result.verificationNeeded.map((text, index) => <div key={index}><p>{text}</p>{item("verificationNeeded", index)}</div>)}
        {continuable && <button className="primary" disabled={busy} onClick={() => offer()}>{handoff.continue}</button>}
      </> : <><p>{setup?.reason}</p>{setup?.available && <p>{reviewCopy.cost}: {setup.estimatedCredits ?? "—"}</p>}<button className="primary" disabled={busy || unknown || !setup?.available} onClick={() => void run()}>{busy ? c.working : c.runSummary}</button></>}
      {unknown && <><p role="status">{reviewCopy.uncertain}</p><button disabled={busy} onClick={() => { setBusy(true); void load().catch(() => setError(reviewCopy.failed)).finally(() => setBusy(false)); }}>{reviewCopy.refresh}</button></>}
    </div>
  </Sheet>;
}
