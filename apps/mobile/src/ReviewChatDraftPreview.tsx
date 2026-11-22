import { useEffect, useRef, useState } from "react";
import { formatReviewChat, type ReviewChatSource } from "../../../lib/reviewToChat";
import { reviewHandoffCopy } from "../../../locales/reviewHandoff";
import { mobileReviewCopy } from "../../../locales/mobileReview";
import type { MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport } from "./chatTransport";
import { confirmNativeReviewSource } from "./nativeReviewChat";
import { Sheet } from "./Sheet";
import { readDeviceDraft } from "@tomverse/chat-core/device-draft";


export function ReviewChatDraftPreview({ source, transport, language, owner, onClose, onConfirm }: {
  source: ReviewChatSource; transport: ChatTransport; language: MobileLanguage;
  owner: string | null;
  onClose: () => void; onConfirm: (text: string) => void;
}) {
  const c = { ...mobileReviewCopy(language), ...reviewHandoffCopy[language === "zh-Hant" ? "zhHant" : language] };
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const preview = formatReviewChat(source, undefined, request, c);
  const existing = owner ? readDeviceDraft(localStorage, owner, null) : "";
  async function confirm() {
    if (pending.current || !preview) return;
    if (existing.length + preview.text.length + 2 > 40000) { setError(c.tooLarge); return; }
    pending.current = true; setBusy(true); setError("");
    try {
      const valid = await confirmNativeReviewSource(source, transport);
      if (!live.current) return;
      if (!valid) { setError(c.failed); return; }
      onConfirm(preview.text);
    } catch { setError(c.failed); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Sheet title={c.preview} closeLabel={c.cancel} onClose={() => { if (!busy) onClose(); }}>
    <label className="ios-field">{c.request}<textarea maxLength={4000} value={request} disabled={busy} onChange={event => setRequest(event.target.value)} /></label>
    {preview ? <pre className="native-review-draft-preview" data-testid="native-review-chat-preview">{preview.text}</pre> : <p role="alert">{c.tooLarge}</p>}
    {existing.trim() && <p>{c.conflict}</p>}
    {error && <p role="alert">{error}</p>}
    <button className="primary" disabled={busy || !preview} onClick={() => void confirm()}>{existing.trim() ? c.append : c.confirm}</button>
  </Sheet>;
}
