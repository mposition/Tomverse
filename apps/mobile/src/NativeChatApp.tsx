import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Browser } from "@capacitor/browser";
import { App } from "@capacitor/app";
import { mobileChatCopy } from "../../../locales/mobileChat";
import { readMobileAuthReturn } from "../../../lib/mobileBrowserLogin";
import { MobileAuth, mobileApiFetch, TOMVERSE_API_ORIGIN } from "./authBridge";
import { nativeChatLocation } from "./chatLocation";
import { NativeChatError, sendNativeChat, type NativeChatMessage } from "./chatClient";

const appLinksEnabled = import.meta.env.VITE_MOBILE_AUTH_APP_LINKS_ENABLED === "true";
const authReturnOrigin = import.meta.env.VITE_MOBILE_AUTH_APP_LINK_ORIGIN ?? TOMVERSE_API_ORIGIN;

export const NativeChatApp = () => {
  const copy = mobileChatCopy(navigator.language);
  const [identity, setIdentity] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<"checking" | "signed_out" | "restore_failed" | "connected">("checking");
  const [pairingRequestId, setPairingRequestId] = useState("");
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
  const pendingChallenge = useRef<string | null>(null);
  const connectionBusy = useRef(false);

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
  const restoreSession = useCallback(async (ticket: number) => {
    setSessionState("checking"); setError("");
    try {
      const { signedIn } = await MobileAuth.hasSession();
      if (ticket !== epoch.current) return;
      if (!signedIn) { setSessionState("signed_out"); return; }
      await readIdentity(ticket);
      if (ticket === epoch.current) setSessionState("connected");
    } catch {
      if (ticket === epoch.current) { setSessionState("restore_failed"); setError(copy.connectionError); }
    }
  }, [copy.connectionError, readIdentity]);
  useEffect(() => {
    void restoreSession(epoch.current);
    return () => { invalidateRun(); nativeChatLocation.disable(); };
  }, [restoreSession, invalidateRun]);
  useEffect(() => {
    const resize = () => document.documentElement.style.setProperty("--native-visible-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => { window.visualViewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages]);

  const connect = async () => {
    if (sessionState !== "signed_out" || connectionBusy.current) return;
    connectionBusy.current = true;
    setConnecting(true); setError("");
    try {
      clear();
      pendingChallenge.current = null;
      setPairingRequestId(""); setCode("");
      const { url } = await MobileAuth.beginSignIn();
      const challenge = new URL(url).searchParams.get("codeChallenge");
      if (!challenge) throw new Error("missing connection request");
      pendingChallenge.current = challenge;
      setPairingRequestId(challenge.slice(-8));
      const destination = new URL(url);
      if (appLinksEnabled) destination.searchParams.set("returnTo", "app");
      await Browser.open({ url: destination.toString() });
    } catch { setSessionState("restore_failed"); setError(copy.connectionError); }
    finally { connectionBusy.current = false; setConnecting(false); }
  };
  const completeConnection = useCallback(async (grant: string, closeBrowser = false) => {
    if (connectionBusy.current || !pendingChallenge.current) return;
    connectionBusy.current = true;
    // Consume the pending callback before any async work: duplicates cannot exchange twice.
    pendingChallenge.current = null;
    setConnecting(true); setError("");
    setCode("");
    const ticket = epoch.current;
    let connected = false;
    try {
      await MobileAuth.completeSignIn({ grant }); connected = true;
      if (closeBrowser) await Browser.close().catch(() => {});
      await readIdentity(ticket);
      if (ticket === epoch.current) { setPairingRequestId(""); setSessionState("connected"); }
    } catch {
      if (ticket === epoch.current) {
        setPairingRequestId(""); setError(copy.connectionError);
        setSessionState(connected ? "restore_failed" : "signed_out");
      }
    }
    finally { connectionBusy.current = false; setConnecting(false); }
  }, [copy.connectionError, readIdentity]);
  useEffect(() => {
    if (!appLinksEnabled) return;
    let disposed = false;
    const onReturn = ({ url }: { url: string }) => {
      if (disposed) return;
      const grant = readMobileAuthReturn(url, authReturnOrigin, pendingChallenge.current);
      if (grant) void completeConnection(grant, true);
    };
    const listener = App.addListener("appUrlOpen", onReturn);
    void listener.then(() => App.getLaunchUrl()).then((launch) => {
      if (launch?.url) onReturn(launch);
    }).catch(() => {});
    return () => { disposed = true; void listener.then((handle) => handle.remove()).catch(() => {}); };
  }, [completeConnection]);
  const finishConnection = async () => {
    if (sessionState !== "signed_out" || !pairingRequestId || !code.trim()) return;
    await completeConnection(code.trim());
  };
  const disconnect = async () => {
    pendingChallenge.current = null;
    clear(); setIdentity(null); setPairingRequestId(""); setCode("");
    nativeChatLocation.setIdentity(null); setSessionState("checking");
    const ticket = epoch.current;
    try { await MobileAuth.signOut(); if (ticket === epoch.current) setSessionState("signed_out"); }
    catch { if (ticket === epoch.current) { setSessionState("restore_failed"); setError(copy.connectionError); } }
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
    let answer = "";
    try {
      await sendNativeChat({ transport: mobileApiFetch, location: nativeChatLocation,
        identityKey: identity, messages: transcript, webSearch, signal: controller.signal,
        onText: (text) => {
          answer = text;
          if (epoch.current === ticket) setMessages([...transcript, { role: "assistant", content: text }]);
        },
        onCompletion: (completion) => {
          if (epoch.current === ticket) setMessages([...transcript, { role: "assistant", content: answer, completion }]);
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
    <header className="native-chat-header"><h1>{copy.title}</h1>{(identity || sessionState === "restore_failed") && <div>
      {identity && <button type="button" onClick={clear}>{copy.newChat}</button>}
      <button type="button" onClick={() => { void disconnect(); }}>{copy.disconnect}</button>
    </div>}</header>
    {!identity ? sessionState !== "signed_out" ? <section className="native-connect">
      <p role="status">{sessionState === "checking" ? copy.restoring : copy.connectionError}</p>
      {sessionState === "restore_failed" && <button type="button" onClick={() => { void restoreSession(epoch.current); }}>{copy.retryConnection}</button>}
    </section> : <section className="native-connect">
      <h2>{copy.connect}</h2><p>{appLinksEnabled ? copy.browserConnectionNote : copy.connectionNote}</p>
      <button type="button" onClick={() => { void connect(); }} disabled={connecting} data-testid="native-sign-in">{connecting ? copy.connecting : copy.openBrowser}</button>
      {pairingRequestId && <p data-testid="native-pairing-request">{copy.requestId}: <strong>{pairingRequestId}</strong></p>}
      <form onSubmit={(event) => { event.preventDefault(); void finishConnection(); }}>
        <label htmlFor="native-connection-code">{copy.code}</label>
        <input id="native-connection-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={512} disabled={!pairingRequestId || connecting} />
        <button type="submit" disabled={connecting || !pairingRequestId || !code.trim()}>{copy.confirm}</button>
      </form>
    </section> : <>
      <section className="native-messages" aria-live="polite" data-testid="native-messages">
        {messages.length === 0 && <p>{copy.empty}</p>}
        {messages.map((message, index) => <div key={index} className={`native-message native-message-${message.role}`} data-role={message.role}>{message.content || copy.thinking}
          {message.completion?.status === "incomplete" && <p role="status" data-testid="native-answer-incomplete">{copy.incomplete}</p>}
        </div>)}
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
