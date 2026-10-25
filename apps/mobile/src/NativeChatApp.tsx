import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Browser } from "@capacitor/browser";
import { mobileChatCopy } from "../../../locales/mobileChat";
import { MobileAuth, mobileApiFetch } from "./authBridge";
import { nativeChatLocation } from "./chatLocation";
import { NativeChatError, sendNativeChat, type NativeChatMessage } from "./chatClient";

export const NativeChatApp = () => {
  const copy = mobileChatCopy(navigator.language);
  const [identity, setIdentity] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [code, setCode] = useState("");
  const [messages, setMessages] = useState<NativeChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const location = useSyncExternalStore(nativeChatLocation.subscribe, nativeChatLocation.getSnapshot);
  const run = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const end = useRef<HTMLDivElement | null>(null);

  const invalidateRun = useCallback(() => {
    epoch.current++;
    run.current?.abort();
    run.current = null;
  }, []);
  const clear = () => {
    invalidateRun();
    nativeChatLocation.disable();
    setMessages([]);
    setDraft("");
    setWebSearch(false);
    setBusy(false);
    setError("");
  };
  const readIdentity = useCallback(async (ticket: number) => {
    const result = await mobileApiFetch("/api/mobile/chat", { method: "GET" });
    if (!result.ok) throw new NativeChatError(result.status, "SESSION_UNAVAILABLE");
    const session = await result.json() as { userId?: unknown };
    if (ticket !== epoch.current) return;
    if (typeof session.userId !== "string" || !session.userId) throw new Error("invalid session");
    const key = `account:${session.userId}`;
    nativeChatLocation.setIdentity(key);
    setIdentity(key);
  }, []);
  useEffect(() => {
    let mounted = true;
    const ticket = epoch.current;
    void MobileAuth.hasSession().then(async ({ signedIn }) => {
      if (signedIn && mounted) await readIdentity(ticket);
    }).catch(() => { if (mounted) setError(copy.connectionError); });
    return () => { mounted = false; invalidateRun(); nativeChatLocation.disable(); };
  }, [copy.connectionError, readIdentity, invalidateRun]);
  useEffect(() => {
    const resize = () => document.documentElement.style.setProperty("--native-visible-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => { window.visualViewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages]);

  const connect = async () => {
    setConnecting(true); setError("");
    try {
      clear();
      const { url } = await MobileAuth.beginSignIn();
      await Browser.open({ url });
    } catch { setError(copy.connectionError); }
    finally { setConnecting(false); }
  };
  const finishConnection = async () => {
    if (!code.trim() || connecting) return;
    setConnecting(true); setError("");
    const grant = code.trim(); setCode("");
    const ticket = epoch.current;
    try { await MobileAuth.completeSignIn({ grant }); await readIdentity(ticket); }
    catch { setError(copy.connectionError); }
    finally { setConnecting(false); }
  };
  const send = async () => {
    if (!identity || run.current || !draft.trim()) return;
    const controller = new AbortController(); run.current = controller;
    const ticket = ++epoch.current;
    const prior = messages.filter((message) => message.role !== "assistant" || message.content.trim()).slice(-30);
    const question: NativeChatMessage = { role: "user", content: draft.trim() };
    const transcript = [...prior, question];
    setDraft(""); setBusy(true); setError("");
    setMessages([...transcript, { role: "assistant", content: "" }]);
    try {
      await sendNativeChat({ transport: mobileApiFetch, location: nativeChatLocation,
        identityKey: identity, messages: transcript, webSearch, signal: controller.signal,
        onText: (text) => {
          if (epoch.current === ticket) setMessages([...transcript, { role: "assistant", content: text }]);
        },
      });
    } catch (cause) {
      if (epoch.current === ticket && !controller.signal.aborted) {
        setError(cause instanceof NativeChatError && cause.status === 503 ? copy.disabled : copy.chatError);
        setMessages(prior);
        setDraft(question.content);
      }
    } finally {
      if (epoch.current === ticket) { run.current = null; setBusy(false); }
    }
  };

  return <main className="native-chat" data-testid="native-chat">
    <header className="native-chat-header"><h1>{copy.title}</h1>{identity && <div>
      <button type="button" onClick={clear}>{copy.newChat}</button>
      <button type="button" onClick={() => { clear(); setIdentity(null); nativeChatLocation.setIdentity(null); void MobileAuth.signOut().catch(() => setError(copy.connectionError)); }}>{copy.disconnect}</button>
    </div>}</header>
    {!identity ? <section className="native-connect">
      <h2>{copy.connect}</h2><p>{copy.connectionNote}</p>
      <button type="button" onClick={() => { void connect(); }} disabled={connecting} data-testid="native-sign-in">{connecting ? copy.connecting : copy.openBrowser}</button>
      <form onSubmit={(event) => { event.preventDefault(); void finishConnection(); }}>
        <label htmlFor="native-connection-code">{copy.code}</label>
        <input id="native-connection-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={512} />
        <button type="submit" disabled={connecting || !code.trim()}>{copy.confirm}</button>
      </form>
    </section> : <>
      <section className="native-messages" aria-live="polite" data-testid="native-messages">
        {messages.length === 0 && <p>{copy.empty}</p>}
        {messages.map((message, index) => <div key={index} className={`native-message native-message-${message.role}`} data-role={message.role}>{message.content || copy.thinking}</div>)}
        <div ref={end} />
      </section>
      <form className="native-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className="native-tools">
          <label><input type="checkbox" checked={location.enabled} onChange={() => {
            if (location.enabled || location.pending) nativeChatLocation.disable(); else void nativeChatLocation.enable(identity);
          }} data-testid="native-location-toggle" />{copy.location}</label>
          <label><input type="checkbox" checked={webSearch} onChange={(event) => setWebSearch(event.target.checked)} disabled={busy} />{copy.search}</label>
        </div>
        <p className="native-location-note">{copy.locationNote}</p>
        {(location.pending || location.error || location.enabled) && <p role="status" data-testid="native-location-status">{location.pending ? copy.reading : location.error ? copy[location.error] : copy.locationOn}</p>}
        <textarea aria-label={copy.prompt} placeholder={copy.prompt} rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} data-testid="native-chat-input" />
        <div className="native-send-row"><small>{copy.memoryOnly}</small>{busy
          ? <button type="button" onClick={() => { invalidateRun(); setBusy(false); setMessages((current) => current.filter((message) => message.role !== "assistant" || message.content.trim())); }}>{copy.stop}</button>
          : <button type="submit" disabled={!draft.trim()} data-testid="native-chat-send">{copy.send}</button>}</div>
      </form>
    </>}
    {error && <p role="alert" className="native-error">{error}</p>}
  </main>;
};
