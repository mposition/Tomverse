"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import {
  discardReviewChatPacket, formatReviewChat, observeReviewChatIdentity, revalidateReviewChatSource,
  stageReviewChatPacket, type ReviewChatCopy, type ReviewChatSelection, type ReviewChatSource,
} from "@/lib/reviewToChat";

export function useReviewChatCopy(): ReviewChatCopy {
  const { t } = useLanguage();
  return useMemo(() => Object.fromEntries([
    ...["continue", "issue", "preview", "confirm", "cancel", "request", "blocked", "failed", "unsupported", "waiting", "missing", "conflict", "append", "reference", "question", "sources", "reviewer", "limitations", "matched", "unmatched", "quoteNote", "external", "independent", "omitted", "tooLarge"].map(key => [key, t(`reviewHandoff.${key}`)]),
    ...Object.entries({ consensus: "aiReviewConsensus", contradictions: "aiReviewContradictions", differences: "aiReviewDifferences", missingPoints: "aiReviewMissingPoints", verificationNeeded: "aiReviewVerificationNeeded", models: "quickSummaryModelClaims", synthesis: "aiReviewSynthesis", commonConclusions: "quickSummaryCommonConclusions", importantDifferences: "quickSummaryImportantDifferences" }).map(([key, value]) => [key, t(`chat.${value}`)]),
    ["none", t("chat.aiReviewNoneFound")], ["strengths", t("chat.aiReviewStrengths")], ["cautions", t("chat.aiReviewCautions")],
  ]), [t]);
}

type Offer = { source: ReviewChatSource; selection?: ReviewChatSelection; isCurrent: () => boolean };
const HandoffContext = createContext<{ open: (offer: Offer) => void; supported: boolean } | null>(null);

export function ReviewChatAction({ source, selection, ready = true, scope = "" }: {
  source: ReviewChatSource | null; selection?: ReviewChatSelection; ready?: boolean; scope?: string;
}) {
  const context = useContext(HandoffContext);
  const copy = useReviewChatCopy();
  const key = JSON.stringify([source, selection, ready, scope]);
  const current = useRef<string | null>(key);
  useLayoutEffect(() => { current.current = key; return () => { current.current = null; }; }, [key]);
  if (!context) return null;
  const eligible = context.supported && ready && source && source.setup.source && source.review.id &&
    (source.kind === "quick" || (!source.review.guest && source.review.persisted !== false));
  return <div className="my-3">
    <button type="button" disabled={!eligible} data-testid={selection ? "review-chat-issue" : "review-chat-continue"}
      className="min-h-11 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold disabled:opacity-50 dark:border-zinc-600"
      onClick={() => { if (eligible && source) context.open({ source: structuredClone(source), selection, isCurrent: () => current.current === key }); }}>
      {selection ? copy.issue : copy.continue}
    </button>
    {!eligible && !selection && <p className="mt-1 text-xs text-zinc-500">{context.supported ? copy.failed : copy.unsupported}</p>}
  </div>;
}

export function ReviewChatHandoffProvider({ identity, supported, sourceScope, navigate, children }: {
  identity: string | null; supported: boolean; sourceScope: string;
  navigate: (id: string) => boolean; children: ReactNode;
}) {
  const copy = useReviewChatCopy();
  const [offer, setOffer] = useState<(Offer & { identity: string; scope: string; epoch: number }) | null>(null);
  const [request, setRequest] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const latest = useRef({ identity, sourceScope, supported, navigate });
  useLayoutEffect(() => { latest.current = { identity, sourceScope, supported, navigate }; });
  useLayoutEffect(() => { observeReviewChatIdentity(identity); }, [identity]);
  const close = () => { pending.current?.abort(); pending.current = null; setBusy(false); setOffer(null); };
  const valid = offer && offer.identity === identity && offer.scope === sourceScope && supported && offer.isCurrent();
  useEffect(() => { if (offer && !valid) queueMicrotask(close); }, [offer, valid]);
  useEffect(() => () => { pending.current?.abort(); }, []);
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<HTMLTextAreaElement>(null);
  useModalDialog({ open: Boolean(valid), onClose: close, dialogRef, panelRef, initialFocusRef: requestRef });
  const preview = valid ? formatReviewChat(offer.source, offer.selection, request, copy) : null;
  const confirm = async () => {
    if (!valid || !preview || pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError("");
    const captured = offer;
    try {
      const authorized = await revalidateReviewChatSource(captured.source, controller.signal);
      const now = latest.current;
      if (controller.signal.aborted || pending.current !== controller) return;
      if (!captured.isCurrent() || captured.identity !== now.identity || captured.scope !== now.sourceScope || !now.supported) { setError(copy.failed); return; }
      if (!authorized) { setError(copy.failed); return; }
      const packet = stageReviewChatPacket(captured.identity, preview.text, Date.now(), captured.epoch);
      if (!packet) { setError(copy.failed); return; }
      try {
        if (!now.navigate(packet.id)) { discardReviewChatPacket(packet.id); setError(copy.blocked); return; }
      } catch { discardReviewChatPacket(packet.id); setError(copy.failed); return; }
      setOffer(null);
    } catch { if (!controller.signal.aborted) setError(copy.failed); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  };
  return <HandoffContext.Provider value={{ supported, open: next => {
    if (!identity?.startsWith("account:") || !supported) return;
    pending.current?.abort(); pending.current = null; setBusy(false);
    setOffer({ ...next, identity, scope: sourceScope, epoch: observeReviewChatIdentity(identity) }); setRequest(""); setError("");
  } }}>
    {children}
    {valid && createPortal(<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="review-chat-preview-title"
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-3" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={panelRef} tabIndex={-1} className="flex max-h-[90dvh] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
        <h2 id="review-chat-preview-title" className="text-lg font-bold">{copy.preview}</h2>
        <label className="grid gap-2 text-sm">{copy.request}<textarea ref={requestRef} disabled={busy} data-testid="review-chat-request" value={request} maxLength={4000}
          onChange={event => setRequest(event.target.value)} className="min-h-24 w-full rounded-xl border border-zinc-400 bg-transparent p-3" /></label>
        {preview ? <><a href={preview.sourceUrl} target="_blank" rel="noreferrer" className="text-sm underline">{copy.sources}</a>
          <pre data-testid="review-chat-preview" className="max-h-[40dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100 p-3 text-sm dark:bg-zinc-800">{preview.text}</pre></> : <p role="alert">{copy.tooLarge}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={close} className="min-h-11 rounded-xl border px-4">{copy.cancel}</button>
          <button type="button" onClick={() => void confirm()} disabled={busy || !preview} className="min-h-11 rounded-xl bg-blue-600 px-4 text-white disabled:opacity-50">{copy.confirm}</button>
        </div>
      </div>
    </div>, document.body)}
  </HandoffContext.Provider>;
}
