import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { MapPin, X } from "lucide-react";
import { CHAT_LOCATION_MAX_AGE_MS, CHAT_LOCATION_OFF, CHAT_LOCATION_TIMEOUT_MS, createChatLocationSession, type ChatLocation } from "@tomverse/chat-core";
import { readBrowserChatLocation } from "../../../../lib/chatLocationClient";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../../../../lib/chatRequestLimits";
import type { Language } from "../../../../lib/language";
import { mobileCopy } from "../../../../locales/mobile";

const copy = {
  en: { manualTitle: "Add a place", title: "Use current location", disclosure: "Share an approximate location with your next question about nearby places.",
    attach: "Attach current location", attached: "Location attached", remove: "Remove location",
    manual: "Enter a place manually", place: "City or area", add: "Add place to draft", placePrefix: "My location: ",
    denied: "Location permission was denied.", timeout: "The location request timed out.",
    unavailable: "A usable location is unavailable. You can enter a place manually.", stale: "Location expired. Attach it again if needed." },
  ko: { manualTitle: "장소 추가", title: "현재 위치 활용", disclosure: "주변 장소를 묻는 다음 질문에 대략적인 현재 위치를 첨부합니다.",
    attach: "현재 위치 첨부", attached: "위치 첨부됨", remove: "위치 제거",
    manual: "장소 직접 입력", place: "도시 또는 지역", add: "입력창에 장소 추가", placePrefix: "현재 위치: ",
    denied: "위치 사용이 거부되었습니다.", timeout: "위치 요청 시간이 초과되었습니다.",
    unavailable: "현재 위치를 가져올 수 없습니다. 장소를 직접 입력할 수 있습니다.", stale: "위치가 만료되었습니다. 필요하면 다시 첨부하세요." },
};

async function readDesktopLocation() {
  if (!await window.desktop.armChatLocation()) throw new Error("unavailable");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const fix = await Promise.race([readBrowserChatLocation(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("timeout")), CHAT_LOCATION_TIMEOUT_MS + 500);
    })]);
    if (fix.accuracy > 5_000) throw new Error("unavailable");
    return fix;
  } finally { clearTimeout(timeout); }
}

export function useChatDraftLocation(scope: string) {
  const [session] = useState(() => createChatLocationSession(readDesktopLocation));
  const [attached, setAttached] = useState<{ fix: ChatLocation; scope: string } | null>(null);
  const [expiredScope, setExpiredScope] = useState<string>();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, () => CHAT_LOCATION_OFF);
  useLayoutEffect(() => {
    session.setIdentity(scope);
    return () => session.setIdentity(null);
  }, [scope, session]);
  useLayoutEffect(() => {
    if (!attached || attached.scope !== scope) return;
    const timer = setTimeout(() => {
      setAttached(null);
      setExpiredScope(scope);
      session.disable();
    }, Math.max(0, attached.fix.timestamp + CHAT_LOCATION_MAX_AGE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [attached, scope, session]);
  return {
    scope, state, expired: expiredScope === scope,
    attached: attached?.scope === scope && session.canShare(attached.fix, scope),
    current() { return attached?.scope === scope && session.canShare(attached.fix, scope) ? attached.fix : undefined; },
    remove() { session.disable(); setAttached(null); setExpiredScope(undefined); },
    async attach() {
      session.setIdentity(null);
      session.setIdentity(scope);
      setAttached(null);
      setExpiredScope(undefined);
      const fix = await session.readForTurn(scope, undefined, { turnId: crypto.randomUUID(), requiresLocation: async () => true });
      if (!fix || !session.canShare(fix, scope)) return false;
      setAttached({ fix, scope });
      return true;
    },
  };
}

export function ChatDraftLocation(props: {
  location: ReturnType<typeof useChatDraftLocation>;
  language: Language;
  draft: string;
  setDraft: (value: string) => void;
  disabled: boolean;
  deviceLocation: boolean;
  maxLength?: number;
}) {
  return <LocationDialog key={props.location.scope} {...props} />;
}

function LocationDialog({ location, language, draft, setDraft, disabled, deviceLocation,
  maxLength = CHAT_MAX_MESSAGE_CHARACTERS }: Parameters<typeof ChatDraftLocation>[0]) {
  const text = language === "ko" ? copy.ko : copy.en;
  const common = mobileCopy[language];
  const dialog = useRef<HTMLDialogElement>(null);
  const [manual, setManual] = useState(false);
  const [place, setPlace] = useState("");
  const error = location.state.error;
  const title = deviceLocation ? text.title : text.manualTitle;
  const placeText = place.trim();
  const addition = (draft.trim() ? "\n\n" : "") + text.placePrefix + placeText;
  return <div className="chat-location-control">
    <button className="icon" type="button" aria-label={title} title={title} disabled={disabled}
      onClick={() => dialog.current?.showModal()}><MapPin size={17} /></button>
    {location.attached && <button type="button" className="soft" aria-label={text.remove} disabled={disabled}
      onClick={location.remove}>{text.attached}<X size={14} /></button>}
    {location.expired && <span role="status">{text.stale}</span>}
    <dialog ref={dialog} className="task-github-dialog chat-location-dialog" aria-labelledby="chat-location-title"
      onClose={() => { if (location.state.pending) location.remove(); }}>
      <header>
        <h2 id="chat-location-title">{title}</h2>
        <button type="button" className="icon" aria-label={common.close} onClick={() => dialog.current?.close()}><X size={17} /></button>
      </header>
      {deviceLocation && <p>{text.disclosure}</p>}
      {error && <p role="alert">{text[error]}</p>}
      {location.state.pending && <p role="status">{common.loading}</p>}
      {deviceLocation && !manual ? <div className="chat-location-manual">
        <button type="button" className="soft" onClick={() => setManual(true)}>{text.manual}</button>
        <button type="button" className="primary" disabled={disabled || location.state.pending} onClick={() => {
          void location.attach().then((ok) => { if (ok && dialog.current?.open) dialog.current.close(); });
        }}>{text.attach}</button>
      </div> : <div className="chat-location-manual">
        <label>{text.place}<input value={place} maxLength={160} onChange={(event) => setPlace(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /></label>
        <button type="button" className="primary" disabled={disabled || !placeText || draft.length + addition.length > maxLength} onClick={() => {
          location.remove();
          setDraft(draft + addition);
          setPlace("");
          setManual(false);
          dialog.current?.close();
        }}>{text.add}</button>
      </div>}
    </dialog>
  </div>;
}
