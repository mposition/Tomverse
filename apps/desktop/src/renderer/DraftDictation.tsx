import { useEffect, useRef, useState } from "react";
import { AudioLines, Mic, Square, X } from "lucide-react";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import { useVoiceRecorder } from "../../../../components/chat/useVoiceRecorder";
import { VOICE_CLIP_MAX_BYTES } from "../../../../lib/voiceInputFormats";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../../../../lib/chatRequestLimits";
import type { Language } from "../../../../lib/language";

const copy = {
  en: { cancel: "Cancel", start: "Record voice input", stop: "Use recording as text", listening: "Recording", processing: "Transcribing",
    denied: "Microphone access was denied.", device: "No recording device is available.", failed: "Voice input could not finish.",
    command: "Speak an instruction", sendSpoken: "Send what I said" },
  ko: { cancel: "취소", start: "음성으로 입력하기", stop: "녹음을 텍스트로 사용", listening: "녹음 중", processing: "받아쓰기 중",
    denied: "마이크 사용이 거부되었습니다.", device: "사용 가능한 녹음 장치가 없습니다.", failed: "음성 입력을 완료하지 못했습니다.",
    command: "말로 지시하기", sendSpoken: "말한 내용 보내기" },
};

export function DraftDictation(props: {
  language: Language;
  maxLength?: number;
  scope: string;
  disabled: boolean;
  draft: string;
  setDraft: (value: string) => void;
  /**
   * With this the button is a spoken instruction: what was said becomes the draft and is sent at once, through the
   * composer's own Send (see useSpokenCommand). Nothing is spoken back.
   */
  onCommand?: (draft: string) => void;
  /**
   * With this the one microphone button opens a small menu of two entries, dictation and the voice conversation.
   * Dictation then runs exactly as it does without a menu; choosing the conversation hands over to `onChoose`.
   * While the conversation is open the same button shows that state.
   */
  conversation?: { open: boolean; disabled: boolean; creditsPerMinute: number; onChoose: () => void };
}) {
  return <ScopedDraftDictation key={props.scope} {...props} />;
}

/**
 * Sends a spoken instruction once the composer holds it. The composer's own Send runs after the draft is in place,
 * so the instruction takes exactly the path typed words take. The composer owns this, because the button that
 * heard the words is gone as soon as the draft is no longer empty.
 */
export function useSpokenCommand(draft: string, submit: () => void) {
  const pending = useRef<{ draft: string; until: number } | null>(null);
  useEffect(() => {
    const waiting = pending.current;
    if (!waiting) return;
    if (Date.now() > waiting.until) { pending.current = null; return; }
    if (waiting.draft !== draft) return;
    pending.current = null;
    submit();
  });
  return (spoken: string) => { pending.current = { draft: spoken, until: Date.now() + 2_000 }; };
}

function ScopedDraftDictation({ language, maxLength = CHAT_MAX_MESSAGE_CHARACTERS, scope, disabled, draft, setDraft, onCommand, conversation }: Parameters<typeof DraftDictation>[0]) {
  const text = language === "ko" ? copy.ko : copy.en;
  const menuText = desktopChatCopy[language];
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { if (menuOpen) menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }, [menuOpen]);
  const closeMenu = (returnFocus: boolean) => { setMenuOpen(false); if (returnFocus) trigger.current?.focus(); };
  const grant = useRef<string | null>(null);
  const alive = useRef(true);
  const [arming, setArming] = useState(false);
  const [denied, setDenied] = useState(false);
  const fetchImpl: typeof fetch = async (_path, options) => {
    const id = grant.current;
    const clip = options?.body;
    const signal = options?.signal;
    if (!id || !(clip instanceof Blob) || clip.size > VOICE_CLIP_MAX_BYTES || signal?.aborted) throw new Error("Recording ended.");
    const cancel = () => { void window.desktop.cancelDictation(id).catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const bytes = new Uint8Array(await clip.arrayBuffer());
      if (signal?.aborted) throw new Error("Recording ended.");
      const reply = await window.desktop.transcribeDictation({ id, mediaType: clip.type, bytes });
      return Response.json(reply, { status: reply.status });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
  const voice = useVoiceRecorder({
    scopeId: scope, endpoint: "/api/chat/voice-transcription", fetchImpl,
    onTranscript: (transcript) => {
      const separator = draft && !/\s$/.test(draft) ? " " : "";
      const available = maxLength - draft.length - separator.length;
      if (available <= 0) return;
      const next = draft + separator + transcript.slice(0, available);
      onCommand?.(next);
      setDraft(next);
    },
  });
  const cancelVoice = useRef(voice.cancel);
  useEffect(() => { cancelVoice.current = voice.cancel; }, [voice.cancel]);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.desktop.subscribeDictationStop(() => cancelVoice.current());
    return () => {
      alive.current = false;
      unsubscribe();
      if (grant.current) void window.desktop.cancelDictation(grant.current).catch(() => {});
    };
  }, []);
  useEffect(() => { if (disabled) cancelVoice.current(); }, [disabled]);

  async function start() {
    setArming(true);
    setDenied(false);
    try {
      const id = await window.desktop.armDictation();
      if (!id) { if (alive.current) setDenied(true); return; }
      if (!alive.current) { await window.desktop.cancelDictation(id); return; }
      grant.current = id;
      voice.start();
    } catch {
      if (alive.current) setDenied(true);
    } finally {
      if (alive.current) setArming(false);
    }
  }
  const status = voice.state.status;
  const recording = status === "recording";
  const idle = status === "idle" || status === "error";
  const problem = status === "error" ? voice.state.code : undefined;
  const error = problem === "VOICE_PERMISSION_DENIED" || denied ? text.denied
    : problem === "VOICE_DEVICE_UNAVAILABLE" || problem === "VOICE_UNSUPPORTED_BROWSER" ? text.device : problem ? text.failed : "";
  const menuMode = Boolean(conversation) && !onCommand && idle;
  return <span className={onCommand ? "desktop-dictation desktop-dictation--command" : "desktop-dictation"}>
    {menuMode && conversation && <span className="desktop-voice-menu-anchor" onBlur={(event) => {
      if (menuOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
    }}>
      <button type="button" ref={trigger} className="icon" data-testid="voice-menu-trigger" data-voice-busy={conversation.open || undefined}
        aria-label={menuText.voiceInput} title={menuText.voiceInput} aria-haspopup="menu" aria-expanded={menuOpen}
        disabled={disabled || arming || conversation.open} onClick={() => setMenuOpen(!menuOpen)}
        onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setMenuOpen(true); } }}>
        {conversation.open ? <AudioLines size={16} /> : <Mic size={16} />}</button>
      {menuOpen && <div ref={menu} role="menu" aria-label={menuText.voiceInput} className="desktop-voice-menu" data-testid="voice-menu"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
        <button type="button" role="menuitem" data-testid="voice-menu-dictation" onClick={() => { closeMenu(false); void start(); }}>
          <Mic size={16} aria-hidden="true" /><span>{menuText.voiceDictation}</span></button>
        <button type="button" role="menuitem" data-testid="voice-menu-conversation" disabled={conversation.disabled}
          onClick={() => { closeMenu(false); conversation.onChoose(); }}>
          <AudioLines size={16} aria-hidden="true" /><span>{menuText.voiceConversation}
            <small>{menuText.voiceCost.replace("{credits}", String(conversation.creditsPerMinute))}</small></span></button>
      </div>}
    </span>}
    {!menuMode && <button type="button" className={onCommand ? "send" : "icon"} data-testid={onCommand ? "voice-command" : undefined}
      aria-label={recording ? (onCommand ? text.sendSpoken : text.stop) : onCommand ? text.command : text.start}
      title={onCommand && !recording ? text.command : undefined}
      aria-pressed={recording} disabled={disabled || arming || (!idle && !recording)}
      onClick={() => recording ? voice.stop() : void start()}>{recording ? <Square size={15} /> : onCommand ? <AudioLines size={18} /> : <Mic size={16} />}</button>}
    {recording && <span role="status">{text.listening} {voice.elapsedSeconds}s</span>}
    {!idle && !recording && <span role="status">{text.processing}</span>}
    {!idle && <button type="button" className="icon" aria-label={text.cancel}
      onClick={() => { voice.cancel(); if (grant.current) void window.desktop.cancelDictation(grant.current).catch(() => {}); }}><X size={15} /></button>}
    {error && <span role="alert" data-voice-error={voice.serverCode ?? problem}>{error}</span>}
  </span>;
}
