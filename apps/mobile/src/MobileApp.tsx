import { useEffect, useRef, useState } from "react";
import { mobileCopy, mobileLanguages, type MobileLanguage } from "../../../locales/mobile";
import type { ChatSummary, ChatTransport, Conversation, MobileAttachment } from "./chatTransport";
import { SidebarAccount } from "./SidebarAccount";
import { ConversationHistory } from "./ConversationHistory";
import { ConversationListScreen } from "./ConversationListScreen";
import { WorkspaceWelcome } from "./WorkspaceWelcome";
import { Composer } from "./Composer";
import { VoiceConversation, VoiceHistory } from "./VoiceConversation";
import type { ToolChange } from "./ComposerTools";
import { AppIcon } from "./AppIcon";
import { mobileWorkspaceCopy } from "../../../locales/mobileWorkspace";
import { autoRoutingCopy } from "../../../lib/autoRoutingCopy";
import { getModel } from "../../../lib/models";
import { SettingsScreen } from "./SettingsScreen";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { ModelSheet } from "./ModelSheet";
import { Sheet } from "./Sheet";
import { AnswerReport } from "./AnswerReport";
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
  const [voiceRevision, setVoiceRevision] = useState(0);
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
  const [newReviewRequest, setNewReviewRequest] = useState(0);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [draft, setDraft] = useDeviceDraft(owner, conversation?.id ?? null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [reportFor, setReportFor] = useState<{ messageId: string; modelId?: string } | null>(null);
  // Only a finished answer has a saved Message row the report can be linked to;
  // a reopened claimed or streaming attempt does not yet.
  const reportable = (message: { content: string; status?: string }) =>
    Boolean(transport.reportAnswer) && Boolean(message.content.trim()) && [undefined, "normal", "incomplete"].includes(message.status);
  const [offline, setOffline] = useState(!navigator.onLine);
  const abort = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const requestEpoch = useRef(0);
  const researchKey = conversation?.messages.filter(message => message.pendingJobId && message.status === "pending").map(message => message.id).join(",") ?? "";
  useEffect(() => {
    if (!researchKey || streaming || !conversation || !transport.resumeResearch) return;
    const controller = new AbortController();
    void transport.resumeResearch(conversation, controller.signal, item => { if (!controller.signal.aborted) { setConversation(item); setUncertain(item.activeAttempt === true); } }).catch(() => { /* Retain readback state; no model resubmission. */ });
    return () => controller.abort();
  }, [researchKey, streaming, transport]); // eslint-disable-line react-hooks/exhaustive-deps -- Job identity controls one restoration watcher.
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
    clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); setPartial(null); setReportFor(null);
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
    clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); setPartial(null); setReportFor(null);
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
  async function send(text: string, files: MobileAttachment[], fromVoice = false) {
    if (streaming || uncertain) { if (fromVoice) throw Error("CHAT_TURN_BUSY"); return; }
    const current = ++requestEpoch.current;
    const titleEpoch = epoch.current;
    const controller = new AbortController(); abort.current = controller;
    setStreaming(true); setError(""); setPartial("");
    let item = conversation;
    try {
      item ??= await transport.create((text.trim() || files[0]?.name || copy.newChat).slice(0, 30));
      if (current !== requestEpoch.current) return;
      setConversation({ ...item, messages: [...item.messages, { id: "pending-user", role: "user", content: text }] });
      localStorage.setItem(LAST_CHAT, item.id);
      setDraft("");
      const receipt = fromVoice ? await transport.sendVoice!(item, text, controller.signal, (value) => {
        if (current === requestEpoch.current) setPartial(value);
      }) : await transport.send(item, text, files, controller.signal, (value) => {
        if (current === requestEpoch.current) setPartial(value);
      });
      const restored = await transport.load(item.id);
      if (current !== requestEpoch.current) return;
      setConversation(restored); setPartial(null);
      const list = await transport.list();
      if (current === requestEpoch.current) setChats(list);
      if (titleEpoch === epoch.current) void transport.generateTitle?.(restored).then(title => {
        if (!title || titleEpoch !== epoch.current) return;
        setConversation(value => value?.id === restored.id && value.title === restored.title ? { ...value, title } : value);
        setChats(rows => rows.map(row => row.id === restored.id && row.title === restored.title ? { ...row, title } : row));
      }).catch(() => { /* The saved interim title remains usable. Never retry model work. */ });
      return receipt;
    } catch (error) {
      if (current !== requestEpoch.current) return;
      setUncertain(Boolean(item)); setError(mobileErrorText(error, language, item ? copy.disconnected : copy.error));
      if (fromVoice) throw error;
    } finally { if (current === requestEpoch.current) setStreaming(false); }
  }

  function newConversation() {
    if (streaming || reviewBusy || loading) return;
    if (product === "review") setNewReviewRequest(value => value + 1);
    else { requestEpoch.current++; setConversation(null); setPartial(null); setError(""); setUncertain(false); localStorage.removeItem(LAST_CHAT); }
    setView("chat");
  }
  function switchProduct(next: "chat" | "review") {
    if (next === product) return;
    requestEpoch.current++;
    setProduct(next); setView("chat"); setError("");
    if (next === "chat") { setConversation(null); setPartial(null); setUncertain(false); localStorage.removeItem(LAST_CHAT); }
  }
  const accountFooter = <SidebarAccount transport={transport} language={language} onSettings={() => { setView("chat"); setSettings(true); }} />;

  return <main className="mobile-app">
    <header className="app-header">
      <button className="menu-button" aria-label={copy.chats} onClick={() => setView(view === "list" ? "chat" : "list")} disabled={!signedIn}><AppIcon name="menu" /><AppIcon name="menuDark" /></button>
      <span className="brand-lockup"><AppIcon name="logo" /><span className="wordmark tomverse-wordmark">tomverse<span className="tomverse-wordmark-dot">.</span></span></span>
      {signedIn && <select data-testid="product-switcher" className="product-switcher" aria-label={workspaceCopy.product} value={product} disabled={streaming || reviewBusy || uncertain} onChange={event => switchProduct(event.target.value as "chat" | "review")}><option value="chat">Chat</option><option value="review">Review</option></select>}
      {signedIn ? <button className="header-new-chat" aria-label={copy.newChat} disabled={streaming || reviewBusy || loading} onClick={newConversation}><AppIcon name="newChat" /></button> : <button className="account-button" aria-label={copy.settings} onClick={() => setSettings(true)}><AppIcon name="settings" /></button>}
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

    {loading && <p role="status" className="notice">{copy.loading}</p>}
    {error && <div role="alert" className="notice error">{error}</div>}
    {!signedIn ? <section className="welcome">
      <div className="welcome-mark"><AppIcon name="logo" /></div><h1>{copy.welcome}</h1><p>{copy.intro}</p>
      <button className="primary" onClick={() => { if (transport.requestEmailCode && transport.verifyEmailCode) setEmailLogin(true); else void signIn(); }} disabled={loading}>{copy.signIn} <span aria-hidden="true">→</span></button>
    </section> : product === "review" ? <ReviewWorkspace transport={transport} language={language} owner={owner} historyOpen={view === "list"} onCloseHistory={() => setView("chat")} onBusyChange={setReviewBusy} historyFooter={accountFooter} newConversationRequest={newReviewRequest} /> : view === "list" ? <ConversationListScreen title={copy.chats} newLabel={copy.newChat} disabled={streaming || loading} onNew={newConversation} footer={accountFooter}>
      <ConversationHistory transport={transport} language={language} owner={owner} chats={chats} currentId={conversation?.id} disabled={streaming || loading} onOpen={id => void open(id)} onRefresh={async () => {
        const scope = epoch.current; const rows = await transport.list();
        if (scope !== epoch.current) throw Error("SIGN_IN_REQUIRED");
        setChats(rows); setConversation(previous => previous ? { ...previous, title: rows.find(row => row.id === previous.id)?.title ?? previous.title } : null); return rows;
      }} onChanged={(id, deleted, locked) => { if ((deleted || locked) && conversation?.id === id) { requestEpoch.current++; setConversation(null); setPartial(null); setUncertain(false); localStorage.removeItem(LAST_CHAT); } }} />
    </ConversationListScreen> : <>
      <section className="transcript" aria-label={conversation?.title ?? copy.newChat} aria-busy={streaming}>
        {!conversation?.messages.length && !streaming && <WorkspaceWelcome product="chat" language={language} transport={transport} onSeed={(text, starter) => {
          if (starter === "compareAnswers" || starter === "compareImageModels") { preserveNativeDraft(owner, "review:new", text); setProduct("review"); setView("chat"); }
          else { setDraft(text); document.querySelector<HTMLTextAreaElement>("textarea")?.focus(); if (starter === "sourcedAnswer" && conversation && conversation.webSearchMode !== "always") void configureTools({ webSearchMode: "always" }).catch(() => {}); }
        }} />}
        {conversation?.messages.map((message) => <article key={message.id} className={`message ${message.role}`}><AnswerContent content={message.content} imageTurn={message.imageTurn} artifacts={message.artifacts} citations={message.searchMetadata?.citations} transport={transport} language={language} />{message.role === "assistant" && ((reportable(message)) || message.routedModelId) && <div className="answer-footer">{reportable(message) && <button type="button" className="answer-report" data-testid="answer-report" onClick={() => setReportFor({ messageId: message.id, modelId: message.modelId })}><AppIcon name="report" />{workspaceCopy.report}</button>}{message.routedModelId && <span className="routed-badge" data-testid="auto-routed-by" title={`${autoRoutingCopy[language].answeredByTitle} · ${getModel(message.routedModelId)?.name ?? message.routedModelId}`}><AppIcon name="spark" /><span>{autoRoutingCopy[language].answeredBy} · {getModel(message.routedModelId)?.name ?? message.routedModelId}</span></span>}</div>}{message.attachments?.map((file) => <span className="saved-attachment" key={file.id}><AppIcon name="file" />{file.name}</span>)}{["failed", "cancelled"].includes(message.status ?? "") && <p className="response-state">{workspaceCopy.failed}<button onClick={() => { const questions = conversation.messages.filter((item) => item.role === "user"); setDraft(questions.at(-1)?.content ?? ""); }}>{workspaceCopy.retry}</button></p>}</article>)}
        {partial !== null && <article className="message assistant"><AnswerContent content={partial || copy.waiting} transport={transport} language={language} /><span className="stream-caret" aria-hidden="true" /></article>}
        {conversation && <VoiceHistory transport={transport} conversationId={conversation.id} revision={voiceRevision} language={language} />}
        <div ref={end} />
      </section>
      {uncertain && conversation && <button className="restore" onClick={() => void open(conversation.id)}>{copy.restore} ↻</button>}
      <button className="model-trigger" disabled={streaming || loading || uncertain} onClick={() => setModelPicker(true)}><AppIcon name="spark" />{conversation?.selectionMode === "auto" || (!conversation && draftAutoOffered) ? "Smart Adaptive" : conversation?.selectedModels[0] ?? workspaceCopy.model}<span aria-hidden="true">⌄</span></button>
      <Composer copy={copy} language={language} transport={transport} draft={draft} setDraft={setDraft} disabled={loading || uncertain} offline={offline} streaming={streaming} conversation={conversation} onConfigureTools={configureTools} onSend={(text, files) => send(text, files).then(() => undefined)} onStop={() => abort.current?.abort()} voiceConversation={disabled => <VoiceConversation transport={transport} language={language} conversationId={conversation?.id ?? null} scopeKey={`${owner}:${signedIn}:${product}`} disabled={disabled} selectionLabel={conversation?.selectionMode === "auto" || (!conversation && draftAutoOffered) ? "Smart Adaptive" : conversation?.selectedModels[0] ?? "Tomverse"} searchEnabled={conversation ? conversation.webSearchMode === "always" : true} onSessionEnded={() => setVoiceRevision(value => value + 1)} onRequest={async text => { const receipt = await send(text, [], true); if (!receipt) throw Error("VOICE_ANSWER_FAILED"); return receipt; }} />} />
    </>}
    {modelPicker && <ModelSheet transport={transport} conversation={conversation} language={language} onClose={() => setModelPicker(false)} onApply={configureModel} />}
    {accountOpen && <Sheet title={copy.account} closeLabel={copy.close} onClose={() => setAccountOpen(false)}><AccountScreen transport={transport} language={language} onReauthenticate={() => void reauthenticate()} onDeleted={() => { setAccountOpen(false); clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); localStorage.removeItem(LAST_CHAT); }} /></Sheet>}
    {reportFor && signedIn && <Sheet title={workspaceCopy.report} closeLabel={copy.close} onClose={() => setReportFor(null)}><AnswerReport transport={transport} language={language} messageId={reportFor.messageId} modelId={reportFor.modelId} /></Sheet>}
    {settings && <Sheet title={copy.settings} closeLabel={copy.close} onClose={() => setSettings(false)}><SettingsScreen transport={transport} signedIn={signedIn} language={language} theme={theme} onLanguage={setLanguage} onTheme={setTheme} onAccount={() => { setSettings(false); setAccountOpen(true); }} onSignOut={() => void signOut()} /></Sheet>}

  </main>;
}
