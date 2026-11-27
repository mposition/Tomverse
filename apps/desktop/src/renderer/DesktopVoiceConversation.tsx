import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import { VoiceConversationPanel, voiceConversationCopy } from "@tomverse/chat-ui";
import { createVoiceConversationClient, type VoiceAnswerReceipt, type VoiceConversationView } from "../../../../components/chat/voiceConversationClient";
import { monitorVoiceAudioLevels } from "../../../../components/chat/voiceAudioLevels";
import type { Language } from "../../../../lib/language";
import type { VoiceConversationCapability } from "../voice-contract";
import { desktopVoiceFetch } from "./voice-transport";
import "@tomverse/chat-ui/voice.css";
import "./voice.css";

const CREDITS_PER_MINUTE = 36;

/**
 * The Chat voice conversation, with the screen and the connection the web and the mobile app use. Only two things
 * are Desktop's own: the server is reached through the main process, and the microphone is opened by the main
 * process for the one session the person starts.
 */
export function DesktopVoiceConversation({ language, capability, conversationId, scopeKey, primary, disabled, selectionLabel, searchEnabled, onRequest, onSessionEnded }: {
  language: Language; capability: VoiceConversationCapability;
  conversationId: string | null; scopeKey: string;
  /** Whether the button takes the Send button's place: the draft is empty and nothing is being sent. */
  primary: boolean; disabled: boolean;
  selectionLabel: string; searchEnabled: boolean;
  onRequest: (text: string) => Promise<VoiceAnswerReceipt>; onSessionEnded?: () => void;
}) {
  const copy = voiceConversationCopy(language);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VoiceConversationView | null>(null);
  const client = useRef<ReturnType<typeof createVoiceConversationClient> | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const previous = useRef({ scopeKey, conversationId });
  const callbacks = useRef({ onRequest, onSessionEnded });
  useEffect(() => { callbacks.current = { onRequest, onSessionEnded }; }, [onRequest, onSessionEnded]);
  const close = useCallback(() => {
    client.current?.destroy();
    client.current = null;
    setOpen(false);
    setState(null);
    callbacks.current.onSessionEnded?.();
  }, []);
  // The main process ends the session on sign-out, on sleep, and when the server withdraws the feature.
  useEffect(() => {
    const unsubscribe = window.desktop.subscribeVoiceStop(() => { void client.current?.stop(); });
    return () => { unsubscribe(); client.current?.destroy(); client.current = null; };
  }, []);
  // A session belongs to the account and the conversation it started in. A new chat that becomes a saved one is the same session.
  useEffect(() => {
    if (previous.current.scopeKey !== scopeKey || (previous.current.conversationId && previous.current.conversationId !== conversationId)) close();
    previous.current = { scopeKey, conversationId };
  }, [scopeKey, conversationId, close]);
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, [open]);

  function start() {
    if (client.current) return;
    client.current = createVoiceConversationClient({
      deps: {
        getMicrophone: async () => {
          if (!await window.desktop.armVoice()) throw new DOMException("The microphone is not available.", "NotAllowedError");
          return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        },
        createPeer: () => new RTCPeerConnection(),
        createAudio: () => new Audio(),
        monitorLevels: monitorVoiceAudioLevels,
        fetch: desktopVoiceFetch,
      },
      onChange: (next) => {
        setState(next);
        if (next.status === "ended" && !next.billingPending) callbacks.current.onSessionEnded?.();
      },
      onRequest: (text) => callbacks.current.onRequest(text),
    });
    void client.current.start(conversationId);
  }

  return <>
    {primary && <button type="button" className="send voice-conversation-open" data-testid="voice-conversation-open"
      aria-label={copy.title} title={copy.title} disabled={disabled} onClick={() => setOpen(true)}><AudioLines size={18} /></button>}
    {open && <dialog ref={dialog} className="desktop-voice-dialog" aria-labelledby="voice-conversation-title"
      onCancel={(event) => { event.preventDefault(); close(); }}>
      <VoiceConversationPanel language={language} state={state} selectionLabel={selectionLabel} searchEnabled={searchEnabled}
        continuous={capability.continuous}
        reservedCredits={capability.continuous ? CREDITS_PER_MINUTE : Math.ceil((capability.maxSeconds + 30) * CREDITS_PER_MINUTE / 60)}
        onStart={start} onClose={close} onStop={() => void client.current?.stop()}
        onToggleMicrophone={() => client.current?.toggleMicrophone()} onResumeAudio={() => void client.current?.resumeAudio()} />
    </dialog>}
  </>;
}
