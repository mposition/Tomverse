import { useEffect, useRef, useState } from "react";
import { mobileCopy, mobileLanguages, type MobileLanguage } from "../../../locales/mobile";
import type { ChatSummary, ChatTransport, Conversation, MobileAttachment } from "./chatTransport";
import { Composer } from "./Composer";
import type { ToolChange } from "./ComposerTools";
import { AppIcon } from "./AppIcon";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";
import { SettingsScreen } from "./SettingsScreen";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { ModelSheet } from "./ModelSheet";
import { Sheet } from "./Sheet";
import { mobileErrorText } from "../../../locales/mobileErrors";
import { EmailLogin } from "./EmailLogin";
import { AnswerContent } from "./AnswerContent";
import { mobileCompletionCopy } from "../../../locales/mobileCompletion";
import { AccountScreen } from "./AccountScreen";
import { useDeviceDraft, clearNativeDrafts, preserveNativeDraft } from "./useDeviceDraft";

const LAST_CHAT = "tomverse-native-last-chat";
export function MobileApp({ transport, demo = false }: { transport: ChatTransport; demo?: boolean }) {
  const [language, setLanguage] = useState<MobileLanguage>(() => {
    const saved = localStorage.getItem("tomverse-language") ?? navigator.language.split("-")[0];
    return mobileLanguages.includes(saved as MobileLanguage) ? saved as MobileLanguage : "en";
  });
  const [theme, setTheme] = useState(() => localStorage.getItem("tomverse-theme") ?? "system");
  const copy = mobileCopy[language];
  const workspaceCopy = mobileWorkspaceCopy[language];
  const [signedIn, setSignedIn] = useState(false);
  const [emailLogin, setEmailLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [view, setView] = useState<"chat" | "list">("chat");
  const [settings, setSettings] = useState(false);
  const [modelPicker, setModelPicker] = useState(false);
  const [draftAutoOffered, setDraftAutoOffered] = useState(false);
  const [product, setProduct] = useState<"chat" | "review">("chat");
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [draft, setDraft] = useDeviceDraft(owner, conversation?.id ?? null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const abort = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const requestEpoch = useRef(0);
  const initializationError = useRef(copy.error);
  useEffect(() => { initializationError.current = copy.error; }, [copy.error]);

  useEffect(() => { document.documentElement.lang = language; localStorage.setItem("tomverse-language", language); }, [language]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("tomverse-theme", theme); }, [theme]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [partial, conversation?.messages.length]);
  useEffect(() => {
    if (!signedIn || conversation) return;
    let active = true;
    void transport.capabilities().then((value) => { if (active) setDraftAutoOffered(value.offered); }).catch(() => { if (active) setDraftAutoOffered(false); });
    return () => { active = false; };
  }, [transport, signedIn, conversation]);
  useEffect(() => transport.onSessionLost?.(() => {
    epoch.current++; requestEpoch.current++; abort.current?.abort();
    clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); setPartial(null);
    setUncertain(false); setStreaming(false); setModelPicker(false); setSettings(false); setAccountOpen(false); setProduct("chat");
    localStorage.removeItem(LAST_CHAT); setLoading(false);
  }), [transport]);

  useEffect(() => {
    const current = ++epoch.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && current === epoch.current;
    void (async () => {
      try {
        const active = await transport.session();
        if (!isCurrent()) return;
        setSignedIn(active);
        if (!active) return;
        const profile = await transport.account();
        if (!isCurrent()) return;
        setOwner(profile.id);
        const list = await transport.list();
        if (!isCurrent()) return;
        setChats(list);
        const last = localStorage.getItem(LAST_CHAT);
        if (last && list.some((chat) => chat.id === last)) {
          const restored = await transport.load(last);
          if (isCurrent()) { setConversation(restored); setUncertain(restored.activeAttempt === true); }
        }
      } catch { if (isCurrent()) setError(initializationError.current); }
      finally { if (isCurrent()) setLoading(false); }
    })();
    return () => { cancelled = true; abort.current?.abort(); };
  }, [transport]);

  useEffect(() => {
    const online = () => setOffline(!navigator.onLine); window.addEventListener("online", online); window.addEventListener("offline", online);
    const background = () => { if (document.hidden) abort.current?.abort(); };
    const offline = () => abort.current?.abort();
    document.addEventListener("visibilitychange", background); window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", online); document.removeEventListener("visibilitychange", background); window.removeEventListener("offline", offline); };
  }, []);

  async function signIn() {
    const current = ++requestEpoch.current;
    setLoading(true); setError("");
    try {
      await transport.signIn();
      const profile = await transport.account();
        if (current !== requestEpoch.current) return;
        setOwner(profile.id);
        const list = await transport.list();
      if (current !== requestEpoch.current) return;
      setSignedIn(true); setChats(list);
    } catch { if (current === requestEpoch.current) setError(demo ? copy.error : copy.native); }
    finally { if (current === requestEpoch.current) setLoading(false); }
  }
  async function signOut() {
    epoch.current++; requestEpoch.current++; abort.current?.abort();
    clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); setPartial(null);
    setUncertain(false); setStreaming(false); localStorage.removeItem(LAST_CHAT); setSettings(false); setModelPicker(false); setProduct("chat");
    try { await transport.signOut(); return true; } catch { setError(mobileCompletionCopy(language).logoutUnconfirmed); return false; }
  }
  async function reauthenticate() {
    setAccountOpen(false); setLoading(true);
    const revoked = await signOut();
    setLoading(false);
    if (!revoked) return;
    if (transport.requestEmailCode && transport.verifyEmailCode) setEmailLogin(true);
    else void signIn();
  }
  async function open(id: string) {
    const current = ++requestEpoch.current;
    setLoading(true); setError(""); setPartial(null);
    try {
      const item = await transport.load(id);
      if (current !== requestEpoch.current) return;
      setConversation(item); setUncertain(item.activeAttempt === true); setView("chat"); localStorage.setItem(LAST_CHAT, id);
    } catch { if (current === requestEpoch.current) setError(copy.unavailable); }
    finally { if (current === requestEpoch.current) setLoading(false); }
  }
  async function configureModel(modelId: string, auto: boolean) {
    const current = ++requestEpoch.current;
    const item = conversation ?? await transport.create();
    if (current !== requestEpoch.current) return;
    if (!conversation) preserveNativeDraft(owner, item.id, draft);
    setConversation(item); localStorage.setItem(LAST_CHAT, item.id);
    try {
      const updated = await transport.configure(item.id, modelId, auto);
      if (current !== requestEpoch.current) return;
      setConversation(updated); setModelPicker(false);
    } catch (error) {
      if (current !== requestEpoch.current) return;
      setUncertain(true); setError(mobileErrorText(error, language, copy.disconnected)); setModelPicker(false); throw error;
    }
  }
  async function configureTools(input: ToolChange) {
    if (!transport.configureTools) throw Error("NATIVE_TOOLS_UNAVAILABLE");
    const current = ++requestEpoch.current;
    const item = conversation ?? await transport.create();
    if (current !== requestEpoch.current) return;
    if (!conversation) preserveNativeDraft(owner, item.id, draft);
    setConversation(item); localStorage.setItem(LAST_CHAT, item.id);
    try {
      const updated = await transport.configureTools(item.id, input);
      if (current === requestEpoch.current) setConversation(updated);
    } catch (error) { if (current === requestEpoch.current) { setUncertain(true); setError(mobileErrorText(error, language, copy.error)); } throw error; }
  }
  async function send(text: string, files: MobileAttachment[]) {
    if (streaming || uncertain) return;
    const current = ++requestEpoch.current;
    const controller = new AbortController(); abort.current = controller;
    setStreaming(true); setError(""); setPartial("");
    let item = conversation;
    try {
      item ??= await transport.create();
      if (current !== requestEpoch.current) return;
      setConversation({ ...item, messages: [...item.messages, { id: "pending-user", role: "user", content: text }] });
      localStorage.setItem(LAST_CHAT, item.id);
      setDraft("");
      await transport.send(item, text, files, controller.signal, (value) => {
        if (current === requestEpoch.current) setPartial(value);
      });
      const restored = await transport.load(item.id);
      if (current !== requestEpoch.current) return;
      setConversation(restored); setPartial(null);
      const list = await transport.list();
      if (current === requestEpoch.current) setChats(list);
    } catch (error) {
      if (current !== requestEpoch.current) return;
      setUncertain(Boolean(item)); setError(mobileErrorText(error, language, item ? copy.disconnected : copy.error));
    } finally { if (current === requestEpoch.current) setStreaming(false); }
  }

  return <main className="mobile-app">
    <header className="app-header">
      <button className="menu-button" aria-label={copy.chats} onClick={() => setView(view === "list" ? "chat" : "list")} disabled={streaming || reviewBusy || !signedIn}><AppIcon name="menu" /><AppIcon name="menuDark" /></button>
      <span className="brand-lockup"><AppIcon name="logo" /><span className="wordmark tomverse-wordmark">tomverse<span className="tomverse-wordmark-dot">.</span></span></span>
      <button className="account-button" aria-label={copy.settings} onClick={() => setSettings(true)}><AppIcon name="settings" /></button>
    </header>
    {demo && <div className="demo-label">{copy.demo}</div>}
    {offline && <p role="status" className="notice">{mobileCompletionCopy(language).offline}</p>}
    {emailLogin && !signedIn && <EmailLogin transport={transport} language={language} onClose={() => setEmailLogin(false)} onComplete={async () => {
      const current = ++requestEpoch.current;
      setEmailLogin(false); setLoading(true); setError("");
      try { const profile = await transport.account();
        if (current !== requestEpoch.current) return;
        setOwner(profile.id);
        const list = await transport.list(); if (current === requestEpoch.current) { setSignedIn(true); setChats(list); } }
      catch { if (current === requestEpoch.current) setError(copy.error); }
      finally { if (current === requestEpoch.current) setLoading(false); }
    }} />}
    {signedIn && <nav className="product-navigation" aria-label={workspaceCopy.product}><div className="segmented">{(["chat", "review"] as const).map((target) => <button key={target} aria-current={product === target ? "page" : undefined} disabled={streaming || reviewBusy || uncertain} onClick={() => { setProduct(target); setView("chat"); }}>{target === "chat" ? "Chat" : "Review"}</button>)}</div></nav>}
    {loading && <p role="status" className="notice">{copy.loading}</p>}
    {error && <div role="alert" className="notice error">{error}</div>}
    {!signedIn ? <section className="welcome">
      <div className="welcome-mark"><AppIcon name="logo" /></div><h1>{copy.welcome}</h1><p>{copy.intro}</p>
      <button className="primary" onClick={() => { if (transport.requestEmailCode && transport.verifyEmailCode) setEmailLogin(true); else void signIn(); }} disabled={loading}>{copy.signIn} <span aria-hidden="true">→</span></button>
    </section> : product === "review" ? <ReviewWorkspace transport={transport} language={language} owner={owner} historyOpen={view === "list"} onCloseHistory={() => setView("chat")} onBusyChange={setReviewBusy} /> : view === "list" ? <section className="conversation-list">
      <div className="list-heading"><h1>{copy.chats}</h1><button className="primary" onClick={() => { requestEpoch.current++; setConversation(null); setPartial(null); setError(""); setUncertain(false); localStorage.removeItem(LAST_CHAT); setView("chat"); }}>{copy.newChat} +</button></div>
      {chats.length === 0 && <p>{copy.emptyList}</p>}
      {chats.map((chat) => <button className="conversation-row" key={chat.id} onClick={() => void open(chat.id)}>{chat.title}<span aria-hidden="true">↗</span></button>)}
    </section> : <>
      <section className="transcript" aria-label={conversation?.title ?? copy.newChat} aria-busy={streaming}>
        {!conversation?.messages.length && !streaming && <div className="empty-chat"><AppIcon name="logo" /><h1>{copy.empty}</h1><p>{copy.hint}</p><span className="chat-product-pill"><AppIcon name="spark" />Tomverse Chat</span><div className="starters"><button onClick={() => { setDraft(copy.starterIdea); document.querySelector<HTMLTextAreaElement>("textarea")?.focus(); }}><AppIcon name="idea" />{copy.starterIdea}</button><button onClick={() => { setDraft(copy.starterFile); document.querySelector<HTMLTextAreaElement>("textarea")?.focus(); }}><AppIcon name="file" />{copy.starterFile}</button></div></div>}
        {conversation?.messages.map((message) => <article key={message.id} className={`message ${message.role}`}>{message.role === "assistant" && <span className="message-label">{message.modelId ?? "Tomverse"}</span>}<AnswerContent content={message.content} imageTurn={message.imageTurn} artifacts={message.artifacts} citations={message.searchMetadata?.citations} transport={transport} language={language} />{message.attachments?.map((file) => <span className="saved-attachment" key={file.id}><AppIcon name="file" />{file.name}</span>)}{["failed", "cancelled"].includes(message.status ?? "") && <p className="response-state">{workspaceCopy.failed}<button onClick={() => { const questions = conversation.messages.filter((item) => item.role === "user"); setDraft(questions.at(-1)?.content ?? ""); }}>{workspaceCopy.retry}</button></p>}</article>)}
        {partial !== null && <article className="message assistant"><span className="message-label">Tomverse</span><AnswerContent content={partial || copy.waiting} transport={transport} language={language} /><span className="stream-caret" aria-hidden="true" /></article>}
        <div ref={end} />
      </section>
      {uncertain && conversation && <button className="restore" onClick={() => void open(conversation.id)}>{copy.restore} ↻</button>}
      <button className="model-trigger" disabled={streaming || loading || uncertain} onClick={() => setModelPicker(true)}><AppIcon name="spark" />{conversation?.selectionMode === "auto" || (!conversation && draftAutoOffered) ? "Smart Adaptive" : conversation?.selectedModels[0] ?? workspaceCopy.model}<span aria-hidden="true">⌄</span></button>
      <Composer copy={copy} language={language} transport={transport} draft={draft} setDraft={setDraft} disabled={loading || uncertain} offline={offline} streaming={streaming} conversation={conversation} onConfigureTools={configureTools} onSend={send} onStop={() => abort.current?.abort()} />
    </>}
    {modelPicker && <ModelSheet transport={transport} conversation={conversation} language={language} onClose={() => setModelPicker(false)} onApply={configureModel} />}
    {accountOpen && <Sheet title={copy.account} closeLabel={copy.close} onClose={() => setAccountOpen(false)}><AccountScreen transport={transport} language={language} onReauthenticate={() => void reauthenticate()} onDeleted={() => { setAccountOpen(false); clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); localStorage.removeItem(LAST_CHAT); }} /></Sheet>}
    {settings && <Sheet title={copy.settings} closeLabel={copy.close} onClose={() => setSettings(false)}><SettingsScreen transport={transport} signedIn={signedIn} language={language} theme={theme} onLanguage={setLanguage} onTheme={setTheme} onAccount={() => { setSettings(false); setAccountOpen(true); }} onSignOut={() => void signOut()} /></Sheet>}

  </main>;
}
