import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceConversationPanel, VoiceSessionSummary, voiceConversationCopy, type VoiceSessionSummaryValue } from "@tomverse/chat-ui";
import { createVoiceConversationClient, type VoiceAnswerReceipt, type VoiceConversationView } from "../../../components/chat/voiceConversationClient";
import { monitorVoiceAudioLevels } from "../../../components/chat/voiceAudioLevels";
import type { ChatTransport } from "./chatTransport";
import { AppIcon } from "./AppIcon";

export function VoiceConversation({ transport, language, conversationId, scopeKey, disabled, selectionLabel, searchEnabled, onRequest, onSessionEnded }: {
  transport: ChatTransport; language: string; conversationId: string | null; scopeKey: string; disabled: boolean;
  selectionLabel: string; searchEnabled: boolean; onRequest: (text: string) => Promise<VoiceAnswerReceipt>; onSessionEnded: () => void;
}) {
  const c = voiceConversationCopy(language); const [open, setOpen] = useState(false); const [state, setState] = useState<VoiceConversationView | null>(null);
  const [config, setConfig] = useState({ enabled: false, maxSeconds: 300 });
  const client = useRef<ReturnType<typeof createVoiceConversationClient> | null>(null); const dialog = useRef<HTMLDialogElement>(null);
  const previous = useRef({ scopeKey, conversationId }); const callbacks = useRef({ onRequest, onSessionEnded });
  useEffect(() => { callbacks.current = { onRequest, onSessionEnded }; }, [onRequest, onSessionEnded]);
  const close = useCallback(() => { client.current?.destroy(); client.current = null; setOpen(false); setState(null); callbacks.current.onSessionEnded(); }, []);
  useEffect(() => {
    let active = true; void transport.voiceConfiguration?.().then(value => { if (active) setConfig(value); }).catch(() => {});
    return () => { active = false; client.current?.destroy(); };
  }, [transport]);
  useEffect(() => {
    if (previous.current.scopeKey !== scopeKey || previous.current.conversationId && previous.current.conversationId !== conversationId) close();
    previous.current = { scopeKey, conversationId };
  }, [scopeKey, conversationId, close]);
  useEffect(() => {
    if (!open) return; const node = dialog.current; node?.showModal();
    const stop = () => { if (document.visibilityState === "hidden") void client.current?.stop(); };
    document.addEventListener("visibilitychange", stop); window.addEventListener("pagehide", stop);
    return () => { node?.close(); document.removeEventListener("visibilitychange", stop); window.removeEventListener("pagehide", stop); };
  }, [open]);
  const start = () => {
    if (client.current) return;
    client.current = createVoiceConversationClient({ deps: {
      getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }), createPeer: () => new RTCPeerConnection(), createAudio: () => new Audio(), monitorLevels: monitorVoiceAudioLevels,
      fetch: (_path, init) => transport.voiceRequest!(JSON.parse(String(init?.body)), init?.signal ?? undefined),
    }, onChange: next => { setState(next); if (next.status === "ended" && !next.billingPending) callbacks.current.onSessionEnded(); }, onRequest: text => callbacks.current.onRequest(text) });
    void client.current.start(conversationId);
  };
  if (!config.enabled || !transport.voiceRequest || !transport.sendVoice) return null;
  return <><button type="button" data-testid="native-voice-open" className="send native-voice-trigger" aria-label={c.title} disabled={disabled} onClick={() => setOpen(true)}><AppIcon name="voice" /></button>
    {open && <dialog ref={dialog} className="native-voice-dialog" aria-labelledby="voice-conversation-title" onCancel={event => { event.preventDefault(); close(); }}><VoiceConversationPanel language={language} state={state} selectionLabel={selectionLabel} searchEnabled={searchEnabled} reservedCredits={Math.ceil((config.maxSeconds + 30) * 36 / 60)} onStart={start} onClose={close} onStop={() => void client.current?.stop()} onToggleMicrophone={() => client.current?.toggleMicrophone()} onResumeAudio={() => void client.current?.resumeAudio()} /></dialog>}
  </>;
}

export function VoiceHistory({ transport, conversationId, revision, language }: { transport: ChatTransport; conversationId: string; revision: number; language: string }) {
  const [saved, setSaved] = useState<{ conversationId: string; rows: VoiceSessionSummaryValue[] } | null>(null);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined; const controller = new AbortController();
    async function load() {
      if (!transport.voiceRequest) return;
      try {
        const response = await transport.voiceRequest({ action: "history", conversationId }, controller.signal);
        if (!response.ok) return; const data = await response.json(); if (!active || !Array.isArray(data.sessions)) return;
        const rows = data.sessions.filter((row: Record<string, unknown>) => typeof row.id === "string" && typeof row.seconds === "number" && typeof row.credits === "number").map((row: VoiceSessionSummaryValue & { settled: boolean }) => ({ ...row, status: row.settled ? "settled" : "reserved" })).reverse();
        setSaved({ conversationId, rows }); if (rows.some((row: VoiceSessionSummaryValue) => row.status !== "settled")) timer = setTimeout(() => void load(), 15_000);
      } catch { /* Read again on reopen; text Chat remains available. */ }
    }
    void load(); return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [transport, conversationId, revision]);
  return saved?.conversationId === conversationId ? saved.rows.map(value => <VoiceSessionSummary key={value.id} language={language} value={value} />) : null;
}
