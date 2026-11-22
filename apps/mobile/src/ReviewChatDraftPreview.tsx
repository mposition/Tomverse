import { useEffect, useRef, useState } from "react";
import { formatReviewChat } from "../../../lib/reviewToChat";
import { nativeReviewChatCopy } from "../../../locales/nativeReviewChat";
import type { MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport } from "./chatTransport";
import {
  appendNativeReviewChatDraft, confirmNativeReviewSource, hasNativeChatDraft, sameNativeChatDraft,
  type NativeChatDraftApply, type NativeChatDraftSnapshot, type NativeReviewChatOffer,
} from "./nativeReviewChat";
import { Sheet } from "./Sheet";

/**
 * One offer, applied at most once. The target is the owner's new-Chat draft as
 * the parent holds it; the read-only source check is cancellable and an
 * answer that arrives after Cancel, unmount or a changed draft is ignored.
 */
export function ReviewChatDraftPreview({ offer, transport, language, readTarget, isCurrent, onClose, onConfirm }: {
  offer: NativeReviewChatOffer; transport: ChatTransport; language: MobileLanguage;
  readTarget: () => NativeChatDraftSnapshot | null; isCurrent: () => boolean;
  onClose: () => void; onConfirm: (text: string, expected: NativeChatDraftSnapshot) => NativeChatDraftApply;
}) {
  const c = nativeReviewChatCopy(language);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [target, setTarget] = useState(readTarget);
  const pending = useRef(false), live = useRef(true), applied = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; abort.current?.abort(); }; }, []);
  const preview = formatReviewChat(offer.source, offer.selection, request, c);
  const existing = target && hasNativeChatDraft(target);
  const fits = Boolean(preview && target && appendNativeReviewChatDraft(target.text, preview.text) !== null);
  function refresh(message: string) { setTarget(readTarget()); setError(message); }
  async function confirm() {
    if (pending.current || applied.current || !preview || !target) return;
    const before = readTarget();
    if (!before || !isCurrent()) { setError(c.unsupported); return; }
    if (!sameNativeChatDraft(before, target)) { refresh(c.changed); return; }
    if (appendNativeReviewChatDraft(before.text, preview.text) === null) { setError(c.tooLarge); return; }
    const controller = new AbortController(); abort.current = controller;
    pending.current = true; setBusy(true); setError("");
    try {
      const valid = await confirmNativeReviewSource(offer.source, transport, offer.selection, controller.signal);
      if (!live.current || controller.signal.aborted) return;
      if (!valid || !isCurrent()) { setError(c.failed); return; }
      const result = onConfirm(preview.text, before);
      if (result === "applied") applied.current = true;
      else if (result === "changed") refresh(c.changed);
      else setError(result === "tooLarge" ? c.tooLarge : c.unsupported);
    } catch { if (live.current && !controller.signal.aborted) setError(c.failed); }
    finally {
      if (abort.current === controller) { abort.current = null; pending.current = applied.current; }
      if (live.current) setBusy(false);
    }
  }
  // Closing never waits for the read: it aborts it and leaves every draft as it was.
  const close = () => { abort.current?.abort(); abort.current = null; pending.current = false; onClose(); };
  return <Sheet title={c.preview} closeLabel={c.cancel} onClose={close}>
    <label className="ios-field">{c.request}<textarea maxLength={4000} value={request} disabled={busy} onChange={event => setRequest(event.target.value)} /></label>
    {preview ? <pre className="native-review-draft-preview" data-testid="native-review-chat-preview">{preview.text}</pre> : <p role="alert">{c.tooLarge}</p>}
    {existing && target && <section className="notice" data-testid="native-review-chat-existing"><p>{c.conflict}</p>
      {target.text && <details><summary>{c.currentDraft}</summary><pre className="native-review-draft-preview">{target.text}</pre></details>}
      {target.files.length > 0 && <p>{c.draftFiles.replace("{count}", String(target.files.length))}</p>}</section>}
    {preview && target && !fits && <p role="alert">{c.tooLarge}</p>}
    {busy && <p role="status">{c.checking}</p>}
    {error && <p role="alert">{error}</p>}
    <button className="primary" data-testid="native-review-chat-confirm" disabled={busy || !preview || !fits} onClick={() => void confirm()}>{existing ? c.append : c.confirm}</button>
  </Sheet>;
}
