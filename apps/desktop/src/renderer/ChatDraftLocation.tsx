import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, MapPin, X } from "lucide-react";
import { CHAT_LOCATION_OFF, createChatLocationSession } from "@tomverse/chat-core";
import { LanguageProvider, useLanguage } from "@/components/LanguageProvider";
import { readBrowserChatLocation } from "../../../../lib/chatLocationClient";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../../../../lib/chatRequestLimits";
import type { Language } from "../../../../lib/language";
import { mobileCopy } from "../../../../locales/mobile";
import { readDesktopLocation } from "./chat-location-read";

/**
 * The "Current location" switch. While it is on, every message reads a fresh fix and carries it;
 * nothing is read in the background and no fix is kept. The state is in memory and belongs to one account.
 */
export function useChatLocation(scope: string | null) {
  const [session] = useState(() => createChatLocationSession(() => readDesktopLocation(() => window.desktop.armChatLocation(), () => readBrowserChatLocation())));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, () => CHAT_LOCATION_OFF);
  useLayoutEffect(() => {
    session.setIdentity(scope);
    return () => session.setIdentity(null);
  }, [scope, session]);
  // After a failed read the host says whether Windows itself has location off; only then is the message more specific.
  const [osCheck, setOsCheck] = useState<{ failure: typeof state; off: boolean }>();
  useEffect(() => {
    if (!state.error) return;
    let current = true;
    window.desktop.osLocationStatus().then((status) => { if (current) setOsCheck({ failure: state, off: status === "off" }); }, () => undefined);
    return () => { current = false; };
  }, [state]);
  // The answer belongs to the failure it was asked about; a later read starts without it.
  const windowsOff = Boolean(state.error) && osCheck?.failure === state && osCheck.off;
  return {
    scope, state, windowsOff, enabled: session.isEnabled(scope),
    openWindowsSettings: () => { void window.desktop.openOsLocationSettings().catch(() => undefined); },
    enable: () => session.enable(scope),
    disable: session.disable,
    /** The fix for the message being sent, or nothing when the switch is off or the read failed. */
    async read() {
      const fix = await session.readForTurn(scope);
      return fix && session.canShare(fix, scope) ? fix : undefined;
    },
  };
}
export type ChatLocation = ReturnType<typeof useChatLocation>;

/** The "+" menu row. The caller renders it inside ComposerTools, which supplies the language. */
export function ChatLocationTool({ location, disabled }: { location: ChatLocation; disabled: boolean }) {
  const { t } = useLanguage();
  const { state, enabled } = location;
  const status = state.error ? t(location.windowsOff ? "chat.locationWindowsOff" : `chat.locationError${state.error}`)
    : state.pending ? t("chat.locationReading") : t("chat.locationDisclosure");
  return <button type="button" role="switch" className="composer-tool-row" data-testid="tools-location-row"
    aria-checked={enabled} aria-labelledby="chat-location-label" aria-describedby="chat-location-description"
    disabled={!location.scope || (disabled && !enabled && !state.pending)}
    onClick={() => { if (enabled || state.pending) location.disable(); else void location.enable(); }}>
    <span className="composer-tool-icon"><MapPin size={18} aria-hidden="true" /></span>
    <span><strong id="chat-location-label">{t("chat.locationLabel")}</strong>
      <small id="chat-location-description" role="status">{status}</small></span>
    <span className="composer-tool-state" aria-hidden="true">
      {state.pending ? <Loader2 size={16} className="location-spin" /> : enabled ? t("chat.locationOn") : t("chat.locationOff")}</span>
  </button>;
}

/** Shown above the draft while the switch is on, reading, or failed, so the state is visible with the menu closed. */
export function ChatLocationStatus({ location, language }: { location: ChatLocation; language: Language }) {
  return <LanguageProvider initialLang={language} forceInitialLang><LocationStatus location={location} /></LanguageProvider>;
}

function LocationStatus({ location }: { location: ChatLocation }) {
  const { t } = useLanguage();
  const { state, enabled } = location;
  if (!enabled && !state.pending && !state.error) return null;
  return <div className="chat-location-status" data-testid="chat-location-status">
    {state.pending ? <Loader2 size={15} className="location-spin" aria-hidden="true" /> : <MapPin size={15} aria-hidden="true" />}
    <span role="status">{state.error ? t(location.windowsOff ? "chat.locationWindowsOff" : `chat.locationError${state.error}`)
      : state.pending ? t("chat.locationReading") : t("chat.locationActive")}</span>
    {state.error && location.windowsOff && <button type="button" className="chat-location-settings" data-testid="chat-location-open-windows-settings"
      onClick={location.openWindowsSettings}>{t("chat.locationOpenWindowsSettings")}</button>}
    <button type="button" className="icon" aria-label={t("chat.locationDisable")} data-testid="chat-location-disable"
      onClick={location.disable}><X size={14} aria-hidden="true" /></button>
  </div>;
}

const placeCopy = {
  en: { title: "Add a place", place: "City or area", add: "Add place to draft", prefix: "My location: " },
  ko: { title: "장소 추가", place: "도시 또는 지역", add: "입력창에 장소 추가", prefix: "현재 위치: " },
};

/** Types a city or area into a draft. Code Ask has no device location, so this stays a plain text helper. */
export function ChatDraftPlace({ language, draft, setDraft, disabled, maxLength = CHAT_MAX_MESSAGE_CHARACTERS }: {
  language: Language;
  draft: string;
  setDraft: (value: string) => void;
  disabled: boolean;
  maxLength?: number;
}) {
  const text = language === "ko" ? placeCopy.ko : placeCopy.en;
  const common = mobileCopy[language];
  const dialog = useRef<HTMLDialogElement>(null);
  const [place, setPlace] = useState("");
  const placeText = place.trim();
  const addition = (draft.trim() ? "\n\n" : "") + text.prefix + placeText;
  return <div className="chat-location-control">
    <button className="icon" type="button" aria-label={text.title} title={text.title} disabled={disabled}
      onClick={() => dialog.current?.showModal()}><MapPin size={17} /></button>
    <dialog ref={dialog} className="task-github-dialog chat-location-dialog" aria-labelledby="chat-location-title">
      <header>
        <h2 id="chat-location-title">{text.title}</h2>
        <button type="button" className="icon" aria-label={common.close} onClick={() => dialog.current?.close()}><X size={17} /></button>
      </header>
      <div className="chat-location-manual">
        <label>{text.place}<input value={place} maxLength={160} onChange={(event) => setPlace(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /></label>
        <button type="button" className="primary" disabled={disabled || !placeText || draft.length + addition.length > maxLength} onClick={() => {
          setDraft(draft + addition);
          setPlace("");
          dialog.current?.close();
        }}>{text.add}</button>
      </div>
    </dialog>
  </div>;
}
