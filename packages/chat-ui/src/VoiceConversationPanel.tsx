import type { CSSProperties } from "react";
import { voiceConversationCopy } from "./voiceConversationCopy";

export type VoicePanelState = {
  status: "idle" | "connecting" | "listening" | "closing" | "ended" | "error";
  captions: readonly { id: string; role: "user" | "assistant"; text: string }[];
  seconds: number; credits: number; muted: boolean; audioBlocked: boolean;
  confirmed: boolean; billingPending: boolean; error: string | null;
  inputLevel?: number; outputLevel?: number; working?: boolean;
};
export type VoiceSessionSummaryValue = { id: string; seconds: number; credits: number; confirmed: boolean; status: string };
const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function Icon({ kind }: { kind: "wave" | "close" | "mic" | "muted" }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "wave" ? <path d="M4 9v6M8 5v14M12 8v8M16 3v18M20 8v8" /> : kind === "close" ? <path d="m6 6 12 12M6 18 18 6" /> : <><path d="M8 6a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0V6ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />{kind === "muted" && <path d="m2 2 20 20" />}</>}
  </svg>;
}

/** Data and actions belong to the host; this view contains no transport or auth. */
export function VoiceConversationPanel({ language, state, selectionLabel, searchEnabled, reservedCredits, onStart, onClose, onStop, onToggleMicrophone, onResumeAudio }: {
  language: string; state: VoicePanelState | null; selectionLabel: string; searchEnabled: boolean; reservedCredits: number;
  onStart: () => void; onClose: () => void; onStop: () => void; onToggleMicrophone: () => void; onResumeAudio: () => void;
}) {
  const c = voiceConversationCopy(language);
  const active = state?.status === "listening";
  const finished = state?.status === "ended" || state?.status === "error";
  const speaking = active && (state?.outputLevel ?? 0) > .025;
  const level = Math.min(1, Math.max(0, speaking ? state?.outputLevel ?? 0 : state?.muted ? 0 : state?.inputLevel ?? 0));
  const status = !state ? c.ready : state.status === "connecting" ? c.connecting : state.status === "closing" ? c.finishing : finished ? c.ended : speaking ? c.speaking : state.working ? c.working : c.listening;
  const error = state?.error === "CREDIT_BALANCE_INSUFFICIENT" ? c.insufficient : /VOICE_OPERATIONAL_LIMIT_REACHED|PLAN_DAILY_CREDIT_LIMIT_REACHED/.test(state?.error ?? "") ? c.limited : /NotAllowedError|PermissionDeniedError/.test(state?.error ?? "") ? c.permission : c.error;
  return <section className="voice-conversation-panel" data-testid="voice-conversation-panel" data-voice-phase={!state ? "ready" : speaking ? "speaking" : state.status}>
    <header><h2 id="voice-conversation-title">{c.title}</h2><button type="button" onClick={onClose} aria-label={c.close}><Icon kind="close" /></button></header>
    <div className="voice-conversation-settings"><span>{selectionLabel}</span><span>{searchEnabled ? c.searchOn : c.searchOff}</span></div>
    <div className="voice-conversation-content">
      <div className={`voice-conversation-orb${active ? " is-active" : ""}${speaking ? " is-speaking" : ""}`} aria-hidden="true" style={{ "--voice-level": level } as CSSProperties}>
        {active ? <div className="voice-conversation-wave">{[.45, .8, 1, .65, .9, .5, .75].map((height, index) => <i key={index} style={{ "--bar-height": height } as CSSProperties} />)}</div> : <Icon kind="wave" />}
      </div>
      <div className="voice-conversation-status"><h3 role="status">{status}</h3>{!state && <p>{c.hint}</p>}</div>
      {state && <>
        <div role="log" aria-live="polite" aria-relevant="additions text" className="voice-conversation-captions">
          {state.captions.map(caption => <div className={`voice-conversation-caption voice-conversation-caption-${caption.role}`} key={caption.id}><span>{caption.role === "user" ? c.user : c.assistant}</span><p>{caption.text}</p></div>)}
        </div>
        {state.audioBlocked && <button type="button" onClick={onResumeAudio}>{c.audio}</button>}
        {state.error && <p role="alert" className="voice-conversation-error">{error}</p>}
        {finished && <p className="voice-conversation-billing-note">{state.billingPending ? c.unknown : state.confirmed ? c.saved : state.seconds > 0 ? c.adjusted : c.saved}</p>}
      </>}
      {!state && <div className="voice-conversation-price-details"><p>{c.reserve.replace("{credits}", String(reservedCredits))}</p></div>}
    </div>
    <footer>
      {state && <div className="voice-conversation-meter"><time>{clock(state.seconds)}</time><span>{state.billingPending ? c.estimated : c.charged}: {state.credits}</span></div>}
      <details className="voice-conversation-usage"><summary>{c.usageTitle}</summary><p>{c.extra}</p><p>{c.clock}</p></details>
      {!state ? <button className="voice-conversation-start" type="button" onClick={onStart}>{c.start}</button> : finished ? <button className="voice-conversation-start" type="button" onClick={onClose}>{c.back}</button> : <div className="voice-conversation-actions"><button type="button" disabled={!active} aria-pressed={state.muted} aria-label={state.muted ? c.unmute : c.mute} onClick={onToggleMicrophone}><Icon kind={state.muted ? "muted" : "mic"} /></button><button type="button" disabled={state.status === "closing"} onClick={onStop}>{c.stop}</button></div>}
    </footer>
  </section>;
}

export function VoiceSessionSummary({ language, value }: { language: string; value: VoiceSessionSummaryValue }) {
  const c = voiceConversationCopy(language);
  return <aside className="voice-session-summary" data-testid="voice-session-summary" aria-label={c.title}>
    <Icon kind="wave" /><div><strong>{c.ended}</strong><p>{clock(value.seconds)} · {value.status === "settled" ? c.charged : c.estimated}: {value.credits}</p><p>{value.status !== "settled" ? c.unknown : value.confirmed ? c.saved : c.adjusted}</p></div>
  </aside>;
}
