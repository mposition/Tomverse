"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, Mic, MicOff, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { createVoiceConversationClient, type VoiceAnswerReceipt, type VoiceConversationView } from "./voiceConversationClient";
import "./voice-conversation.css";

const english = {
  title: "Voice conversation", start: "Start voice conversation", close: "Close", stop: "End conversation",
  ready: "Continue this chat by speaking.", hint: "You can interrupt at any time. Your questions and answers stay in this chat.",
  price: "Voice: 36 credits/minute", extra: "Answer model and search usage are charged separately.",
  clock: "Connected time is billed, including pauses and time with your microphone muted.",
  connecting: "Connecting…", listening: "Listening · interrupt whenever you need", finishing: "Ending conversation…",
  ended: "Conversation ended", saved: "Your questions and answers are saved in this chat.", unknown: "Final voice usage is still being confirmed.",
  mute: "Mute microphone", unmute: "Unmute microphone", audio: "Play assistant audio", error: "Voice could not complete this request. Your chat remains available.",
  estimated: "Estimated voice credits", charged: "Voice credits", user: "You", assistant: "Tomverse", back: "Back to chat",
  reserve: "Up to {credits} credits are temporarily reserved; unused credits are returned after confirmed settlement.",
  searchOn: "Web search on", searchOff: "Web search off",
  insufficient: "There are not enough available credits to start voice. Your existing chat is saved.",
  limited: "Voice has reached its current usage limit. You can continue in this chat.",
};
const korean: typeof english = {
  title: "음성 대화", start: "음성 대화 시작", close: "닫기", stop: "대화 종료",
  ready: "지금 대화를 말로 이어가세요.", hint: "언제든 말로 끼어들 수 있어요. 질문과 답변은 이 채팅에 이어집니다.",
  price: "음성 36크레딧/분", extra: "답변 모델·검색 사용량은 별도로 차감됩니다.",
  clock: "말을 쉬거나 마이크를 꺼도 연결 시간은 계속 계산돼요.",
  connecting: "연결 중…", listening: "듣고 있어요 · 언제든 말씀하세요", finishing: "대화를 종료하고 있어요…",
  ended: "대화가 종료됐어요", saved: "질문과 답변은 이 채팅에 남아 있어요.", unknown: "최종 음성 사용량을 확인하고 있어요.",
  mute: "마이크 끄기", unmute: "마이크 켜기", audio: "음성 답변 재생", error: "음성 요청을 완료하지 못했어요. 기존 채팅에서 이어갈 수 있습니다.",
  estimated: "음성 예상 크레딧", charged: "음성 크레딧", user: "나", assistant: "Tomverse", back: "채팅으로 돌아가기",
  reserve: "최대 {credits}크레딧을 임시 예약하고, 정산이 확인되면 사용하지 않은 크레딧을 돌려드려요.",
  searchOn: "웹 검색 켜짐", searchOff: "웹 검색 꺼짐",
  insufficient: "음성을 시작할 수 있는 크레딧이 부족해요. 기존 대화는 이 채팅에 남아 있어요.",
  limited: "현재 음성 사용 한도에 도달했어요. 이 채팅에서 계속 대화할 수 있습니다.",
};

export function VoiceConversationControl({ conversationId, scopeKey, maxSeconds, disabled, selectionLabel, searchEnabled, onRequest }: {
  conversationId: string | null; scopeKey: string; disabled: boolean;
  maxSeconds: number;
  selectionLabel: string; searchEnabled: boolean; onRequest: (text: string) => Promise<VoiceAnswerReceipt>;
}) {
  const { lang } = useLanguage(); const c = lang === "ko" ? korean : english;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VoiceConversationView | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null); const triggerRef = useRef<HTMLButtonElement>(null);
  const onRequestRef = useRef(onRequest);
  useEffect(() => { onRequestRef.current = onRequest; }, [onRequest]);
  const clientRef = useRef<ReturnType<typeof createVoiceConversationClient> | null>(null);
  const scopeRef = useRef(scopeKey);
  const conversationRef = useRef(conversationId);
  const close = useCallback(() => { clientRef.current?.destroy(); clientRef.current = null; setOpen(false); setState(null); }, []);
  useModalDialog({ open, onClose: close, dialogRef, panelRef: dialogRef, returnFocusRef: triggerRef });
  useEffect(() => {
    if (scopeRef.current !== scopeKey) { scopeRef.current = scopeKey; close(); }
  }, [scopeKey, close]);
  useEffect(() => {
    // The first voice send may create the blank Chat. A later switch ends its session.
    if (conversationRef.current && conversationRef.current !== conversationId) close();
    conversationRef.current = conversationId;
  }, [conversationId, close]);
  useEffect(() => () => { clientRef.current?.destroy(); }, []);
  const start = () => {
    const client = createVoiceConversationClient({
      deps: { getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }), createPeer: () => new RTCPeerConnection(), createAudio: () => new Audio(), fetch },
      onChange: setState, onRequest: text => onRequestRef.current(text),
    });
    clientRef.current = client; void client.start(conversationId);
  };
  const active = state?.status === "listening";
  const finished = state?.status === "ended" || state?.status === "error";
  const time = Math.floor(state?.seconds ?? 0);
  return <>
    <button ref={triggerRef} type="button" data-testid="voice-conversation-open" className="voice-conversation-trigger" disabled={disabled} title={c.title} aria-label={c.title} onClick={() => setOpen(true)}><AudioLines size={21} aria-hidden="true" /></button>
    {open && createPortal(<div className="voice-conversation-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="voice-conversation-title" className="voice-conversation-panel" data-testid="voice-conversation-panel">
        <header><h2 id="voice-conversation-title">{c.title}</h2><button type="button" onClick={close} aria-label={c.close}><X size={22} /></button></header>
        <div className="voice-conversation-settings"><span>{selectionLabel}</span><span>{searchEnabled ? c.searchOn : c.searchOff}</span></div>
        <div className="voice-conversation-content">
          {!state ? <div className="voice-conversation-ready"><AudioLines size={64} aria-hidden="true" /><h3>{c.ready}</h3><p>{c.hint}</p></div> : <>
            <p role="status">{state.status === "connecting" ? c.connecting : state.status === "closing" ? c.finishing : finished ? c.ended : c.listening}</p>
            <div role="log" aria-live="polite" aria-relevant="additions text" className="voice-conversation-captions">
              {state.captions.map(caption => <div className={`voice-conversation-caption voice-conversation-caption-${caption.role}`} key={caption.id}><span>{caption.role === "user" ? c.user : c.assistant}</span><p>{caption.text}</p></div>)}
            </div>
            {state.audioBlocked && <button type="button" onClick={() => void clientRef.current?.resumeAudio()}>{c.audio}</button>}
            {state.error && <p role="alert">{state.error === "CREDIT_BALANCE_INSUFFICIENT" ? c.insufficient : /VOICE_OPERATIONAL_LIMIT_REACHED|PLAN_DAILY_CREDIT_LIMIT_REACHED/.test(state.error) ? c.limited : c.error}</p>}
            {finished && (state.confirmed || state.billingPending) && <p>{state.confirmed ? c.saved : c.unknown}</p>}
          </>}
          <div className="voice-conversation-price-details">
            {!state && <p>{c.reserve.replace("{credits}", String(Math.ceil((maxSeconds + 30) * 36 / 60)))}</p>}
            <p>{c.clock}</p>
          </div>
        </div>
        <footer>
          {state && <div className="voice-conversation-meter"><time>{String(Math.floor(time / 60)).padStart(2, "0")}:{String(time % 60).padStart(2, "0")}</time><span>{state.confirmed ? c.charged : c.estimated}: {state.credits}</span></div>}
          <p><strong>{c.price}</strong><br />{c.extra}</p>
          {!state ? <button className="voice-conversation-start" type="button" onClick={start}>{c.start}</button> : finished ? <button type="button" onClick={close}>{c.back}</button> : <div className="voice-conversation-actions"><button type="button" disabled={!active} aria-pressed={state.muted} aria-label={state.muted ? c.unmute : c.mute} onClick={() => clientRef.current?.toggleMicrophone()}>{state.muted ? <MicOff size={22} /> : <Mic size={22} />}</button><button type="button" disabled={state.status === "closing"} onClick={() => void clientRef.current?.stop()}>{c.stop}</button></div>}
        </footer>
      </div>
    </div>, document.body)}
  </>;
}
