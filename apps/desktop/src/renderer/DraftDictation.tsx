import { useEffect, useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import { useVoiceRecorder } from "../../../../components/chat/useVoiceRecorder";
import { VOICE_CLIP_MAX_BYTES } from "../../../../lib/voiceInputFormats";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../../../../lib/chatRequestLimits";
import type { Language } from "../../../../lib/language";

const copy = {
  en: { cancel: "Cancel", start: "Record voice input", stop: "Use recording as text", listening: "Recording", processing: "Transcribing",
    denied: "Microphone access was denied.", device: "No recording device is available.", failed: "Voice input could not finish." },
  ko: { cancel: "취소", start: "음성으로 입력하기", stop: "녹음을 텍스트로 사용", listening: "녹음 중", processing: "받아쓰기 중",
    denied: "마이크 사용이 거부되었습니다.", device: "사용 가능한 녹음 장치가 없습니다.", failed: "음성 입력을 완료하지 못했습니다." },
};

export function DraftDictation(props: {
  language: Language;
  maxLength?: number;
  scope: string;
  disabled: boolean;
  draft: string;
  setDraft: (value: string) => void;
}) {
  return <ScopedDraftDictation key={props.scope} {...props} />;
}

function ScopedDraftDictation({ language, maxLength = CHAT_MAX_MESSAGE_CHARACTERS, scope, disabled, draft, setDraft }: Parameters<typeof DraftDictation>[0]) {
  const text = language === "ko" ? copy.ko : copy.en;
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
      if (available > 0) setDraft(draft + separator + transcript.slice(0, available));
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
  return <span className="desktop-dictation">
    <button type="button" className="icon" aria-label={recording ? text.stop : text.start}
      aria-pressed={recording} disabled={disabled || arming || (!idle && !recording)}
      onClick={() => recording ? voice.stop() : void start()}>{recording ? <Square size={15} /> : <Mic size={16} />}</button>
    {recording && <span role="status">{text.listening} {voice.elapsedSeconds}s</span>}
    {!idle && !recording && <span role="status">{text.processing}</span>}
    {!idle && <button type="button" className="icon" aria-label={text.cancel}
      onClick={() => { voice.cancel(); if (grant.current) void window.desktop.cancelDictation(grant.current).catch(() => {}); }}><X size={15} /></button>}
    {error && <span role="alert" data-voice-error={voice.serverCode ?? problem}>{error}</span>}
  </span>;
}
