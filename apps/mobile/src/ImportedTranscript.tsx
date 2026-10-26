import { useState } from "react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileContinuationCopy } from "../../../locales/mobileContinuation";
import { providerLabel } from "../../../components/imports/importFormatting";
import type { ChatTransport, ImportedTranscript as ImportedTranscriptValue } from "./chatTransport";
import { AnswerContent } from "./AnswerContent";

/**
 * The imported original above a continuation's own turns, on the native app.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.2. The same
 * reading order as the web timeline: one provenance line, older imported
 * turns on request, the imported turns as dashed read-only bubbles, then the
 * divider where Tomverse takes over. Imported bubbles carry no action -- no
 * report, retry or copy-into-composer -- because nothing here is a Tomverse
 * answer.
 */
export function ImportedTranscript({ conversationId, imported, transport, language }: {
  conversationId: string;
  imported: ImportedTranscriptValue | undefined;
  transport: ChatTransport;
  language: MobileLanguage;
}) {
  const c = mobileContinuationCopy(language);
  // Older pages are this screen's own reading state; the parent remounts it
  // per conversation, so one conversation's pages never show above another's.
  const [older, setOlder] = useState<{ offset: number; messages: ImportedTranscriptValue["messages"] } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const provider = imported ? providerLabel(imported.provider) : "";
  const messages = [...(older?.messages ?? []), ...(imported?.messages ?? [])];
  const firstOffset = older?.offset ?? imported?.offset ?? 0;
  async function loadOlder() {
    if (!imported || !transport.continuationSource || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await transport.continuationSource(conversationId, Math.max(0, firstOffset - imported.pageSize));
      const known = new Set(messages.map(message => message.id));
      setOlder(previous => ({ offset: page.offset, messages: [...page.messages.filter(message => !known.has(message.id)), ...(previous?.messages ?? [])] }));
    } catch { /* The button stays; pressing again reads the same page. */ }
    finally { setLoadingOlder(false); }
  }
  return <div className="imported-transcript" data-testid="imported-transcript">
    {imported && <p className="imported-provenance" data-testid="continuation-provenance">
      <span>{c.importedFrom.replaceAll("{provider}", provider)}</span><span aria-hidden="true"> · </span><span>{imported.importedAt.slice(0, 10)}</span><span aria-hidden="true"> · </span><span>{c.readOnlyLabel}</span>
    </p>}
    {imported?.status === "deleted" && <p className="imported-state" data-testid="continuation-source-tombstone">{c.sourceDeleted}</p>}
    {imported?.status === "locked" && <p className="imported-state" data-testid="continuation-source-locked">{c.sourceLocked}</p>}
    {imported?.status === "available" && firstOffset > 0 && <button type="button" className="imported-older" data-testid="imported-load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
      {loadingOlder ? c.loadingOlderImported : c.showOlderImported.replaceAll("{count}", String(firstOffset))}
    </button>}
    {messages.map(message => <article key={message.id} className={`message ${message.role} imported`} data-testid="chat-message" data-message-source="imported">
      <span className="imported-sr-only">{c.importedMessageDescription.replaceAll("{provider}", provider)}</span>
      <span className="message-label">{message.role === "user" ? c.importedYou.replaceAll("{provider}", provider) : [provider, message.sourceModelLabel].filter(Boolean).join(" · ")}</span>
      <AnswerContent content={message.content} transport={transport} language={language} />
    </article>)}
    <div role="separator" aria-label={c.divider} className="continuation-divider" data-testid="continuation-divider"><span>{c.divider}</span></div>
  </div>;
}
