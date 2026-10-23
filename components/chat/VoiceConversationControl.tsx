"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines } from "lucide-react";
import { VoiceConversationPanel, voiceConversationCopy } from "@tomverse/chat-ui";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { createVoiceConversationClient, type VoiceAnswerReceipt, type VoiceConversationView } from "./voiceConversationClient";
import { monitorVoiceAudioLevels } from "./voiceAudioLevels";
import "./voice-conversation.css";

export function VoiceConversationControl({ conversationId, scopeKey, maxSeconds, disabled, selectionLabel, searchEnabled, onRequest, onSessionEnded }: {
  conversationId: string | null; scopeKey: string; disabled: boolean; maxSeconds: number;
  selectionLabel: string; searchEnabled: boolean; onRequest: (text: string) => Promise<VoiceAnswerReceipt>; onSessionEnded?: () => void;
}) {
  const { lang } = useLanguage(); const c = voiceConversationCopy(lang);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VoiceConversationView | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null); const triggerRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onRequest, onSessionEnded });
  useEffect(() => { callbacks.current = { onRequest, onSessionEnded }; }, [onRequest, onSessionEnded]);
  const clientRef = useRef<ReturnType<typeof createVoiceConversationClient> | null>(null);
  const scopeRef = useRef(scopeKey); const conversationRef = useRef(conversationId);
  const close = useCallback(() => { clientRef.current?.destroy(); clientRef.current = null; setOpen(false); setState(null); callbacks.current.onSessionEnded?.(); }, []);
  useModalDialog({ open, onClose: close, dialogRef, panelRef: dialogRef, returnFocusRef: triggerRef });
  useEffect(() => { if (scopeRef.current !== scopeKey) { scopeRef.current = scopeKey; close(); } }, [scopeKey, close]);
  useEffect(() => {
    if (conversationRef.current && conversationRef.current !== conversationId) close();
    conversationRef.current = conversationId;
  }, [conversationId, close]);
  useEffect(() => () => { clientRef.current?.destroy(); }, []);
  const start = () => {
    const client = createVoiceConversationClient({
      deps: { getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }), createPeer: () => new RTCPeerConnection(), createAudio: () => new Audio(), fetch, monitorLevels: monitorVoiceAudioLevels },
      onChange: next => { setState(next); if (next.status === "ended" && !next.billingPending) callbacks.current.onSessionEnded?.(); },
      onRequest: text => callbacks.current.onRequest(text),
    });
    clientRef.current = client; void client.start(conversationId);
  };
  return <>
    <button ref={triggerRef} type="button" data-testid="voice-conversation-open" className="voice-conversation-trigger" disabled={disabled} title={c.title} aria-label={c.title} onClick={() => setOpen(true)}><AudioLines size={21} aria-hidden="true" /></button>
    {open && createPortal(<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="voice-conversation-title" className="voice-conversation-overlay">
      <VoiceConversationPanel language={lang} state={state} selectionLabel={selectionLabel} searchEnabled={searchEnabled} reservedCredits={Math.ceil((maxSeconds + 30) * 36 / 60)} onStart={start} onClose={close} onStop={() => void clientRef.current?.stop()} onToggleMicrophone={() => clientRef.current?.toggleMicrophone()} onResumeAudio={() => void clientRef.current?.resumeAudio()} />
    </div>, document.body)}
  </>;
}
