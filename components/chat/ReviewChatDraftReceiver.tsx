"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/components/useModalDialog";
import type { ConversationDraftsApi } from "./useConversationDrafts";
import { useReviewChatCopy } from "./ReviewChatHandoff";
import { discardReviewChatPacket, observeReviewChatIdentity, peekReviewChatPacket, REVIEW_CHAT_PARAM, REVIEW_CHAT_TTL, takeReviewChatPacket } from "@/lib/reviewToChat";

export function ReviewChatDraftReceiver({ marker, identity, conversationId, hydrated, blocked, beginNew, selectionTicket, readDraft, setDraftText, notify }: {
  marker: string | null; identity: string | null; conversationId: string | null; hydrated: boolean; blocked: boolean;
  beginNew: () => number; selectionTicket: () => number;
  readDraft: ConversationDraftsApi["readDraft"]; setDraftText: ConversationDraftsApi["setDraftText"];
  notify: (text: string) => void;
}) {
  const copy = useReviewChatCopy();
  const [conflict, setConflict] = useState<{ id: string; identity: string; text: string } | null>(null);
  const active = useRef<{ id: string; identity: string | null; epoch: number; ticket: number } | null>(null);
  const done = useRef<string | null>(null);
  const lifecycle = useRef<{ live: boolean } | null>(null);
  const [expiryTick, tick] = useState(0);
  const [finished, setFinished] = useState<string | null>(null);
  const latest = useRef({ identity, conversationId, hydrated, blocked, selectionTicket, readDraft, setDraftText, notify });
  useLayoutEffect(() => { latest.current = { identity, conversationId, hydrated, blocked, selectionTicket, readDraft, setDraftText, notify }; });
  const clean = useCallback((id: string) => {
    setFinished(id);
    discardReviewChatPacket(id); done.current = id; active.current = null; setConflict(null);
    const url = new URL(window.location.href);
    if (url.searchParams.get(REVIEW_CHAT_PARAM) === id) {
      url.searchParams.delete(REVIEW_CHAT_PARAM);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);
  useLayoutEffect(() => {
    const epoch = observeReviewChatIdentity(identity);
    if (!marker) { if (active.current) clean(active.current.id); return; }
    if (done.current === marker) { clean(marker); return; }
    if (active.current && (active.current.identity !== identity || active.current.epoch !== epoch)) { clean(marker); return; }
    if (!active.current) active.current = { id: marker, identity, epoch, ticket: beginNew() };
  }, [marker, identity, beginNew, clean]);
  useEffect(() => {
    let canceled = false;
    let timer: number | undefined;
    queueMicrotask(() => {
      if (canceled || !marker || done.current === marker) return;
      const attempt = active.current;
      const packet = peekReviewChatPacket(marker, identity);
      if (!attempt || attempt.id !== marker || attempt.identity !== identity || attempt.ticket !== selectionTicket()) { clean(marker); return; }
      if (!packet) { clean(marker); notify(copy.missing); return; }
      // The first commit can still name the preceding Review; beginNew's
      // selection ticket distinguishes that transition from a later selection.
      if (conversationId !== null) return;
      timer = window.setTimeout(() => tick(value => value + 1), Math.max(1, packet.createdAt + REVIEW_CHAT_TTL - Date.now()));
      if (hydrated && !blocked) {
        const draft = readDraft(null);
        if (draft.text || draft.attachments.length) setConflict(previous => previous?.id === marker ? previous : { id: marker, identity: packet.identity, text: packet.text });
        else {
          const accepted = takeReviewChatPacket(marker, packet.identity);
          if (accepted) {
            setDraftText(accepted.text, null); clean(marker);
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"] textarea')?.focus());
          }
        }
      }
    });
    return () => { canceled = true; window.clearTimeout(timer); };
  }, [marker, identity, conversationId, hydrated, blocked, selectionTicket, readDraft, setDraftText, notify, copy.missing, expiryTick, clean]);
  useEffect(() => {
    let mounted = true;
    // StrictMode's immediate second setup keeps the same receiver alive.
    const lease = { live: true };
    lifecycle.current = lease;
    return () => {
      mounted = false;
      queueMicrotask(() => { if (!mounted && lifecycle.current === lease && active.current) discardReviewChatPacket(active.current.id); });
    };
  }, []);
  const append = () => {
    if (!conflict) return;
    const current = latest.current;
    const attempt = active.current;
    if (!attempt || attempt.identity !== current.identity || attempt.ticket !== current.selectionTicket() ||
      current.conversationId !== null || !current.hydrated || current.blocked) return;
    const packet = takeReviewChatPacket(conflict.id, conflict.identity);
    if (!packet) { clean(conflict.id); current.notify(copy.missing); return; }
    current.setDraftText(previous => previous ? `${previous}\n\n${packet.text}` : packet.text, null);
    clean(conflict.id);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"] textarea')?.focus());
  };
  const visible = conflict && conflict.identity === identity && conflict.id === marker && conversationId === null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalDialog({ open: Boolean(visible), onClose: () => { if (marker) clean(marker); }, dialogRef, panelRef });
  if (visible) return createPortal(<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="review-chat-conflict-title" className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-3">
    <div ref={panelRef} tabIndex={-1} className="max-h-[90dvh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-2xl bg-white p-4 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <h2 id="review-chat-conflict-title" className="font-bold">{copy.conflict}</h2>
      <pre className="max-h-[45dvh] overflow-y-auto whitespace-pre-wrap break-words text-sm">{conflict.text}</pre>
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className="min-h-11 rounded-xl border px-4" onClick={() => clean(conflict.id)}>{copy.cancel}</button>
        <button type="button" disabled={blocked} className="min-h-11 rounded-xl bg-blue-600 px-4 text-white disabled:opacity-50" onClick={append}>{copy.append}</button></div>
    </div>
  </div>, document.body);
  return marker && finished !== marker ? <div role="status" className="fixed bottom-2 left-2 z-[90] max-w-sm rounded-xl bg-white p-3 text-sm shadow-lg dark:bg-zinc-900">
    {copy.waiting}<button type="button" className="ml-3 underline" onClick={() => clean(marker)}>{copy.cancel}</button>
  </div> : null;
}
