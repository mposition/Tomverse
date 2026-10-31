import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConversationHistory } from "./ConversationHistory";
import { ConversationListScreen } from "./ConversationListScreen";
import { WorkspaceWelcome } from "./WorkspaceWelcome";
import { ImportedTranscript } from "./ImportedTranscript";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { mobileErrorText } from "../../../locales/mobileErrors";
import { canUseModelWithPlan } from "../../../lib/models";
import type { ChatSummary, ChatTransport, Conversation, MobileAttachment, MobileCapabilities, MobileModel } from "./chatTransport";
import { Composer } from "./Composer";
import type { ToolChange } from "./ComposerTools";
import { AnswerContent } from "./AnswerContent";
import { NativeImageWorkspace } from "./NativeImageWorkspace";
import { useReviewWorkspace } from "../../../components/chat/useReviewWorkspace";
import type { ImagePreset } from "../../../lib/imageGenerationPricing";
import { ReviewModelPicker } from "./ReviewModelPicker";
import { useDeviceDraft, preserveNativeDraft } from "./useDeviceDraft";
import type { MobileProduct } from "./WorkspaceNavigation";

export function ReviewWorkspace({ transport, language, owner, historyOpen, onCloseHistory, onBusyChange, onLoadingChange, onProductChange, historyFooter, newConversationRequest = 0 }: {
  transport: ChatTransport; language: MobileLanguage; owner: string | null; historyOpen: boolean;
  historyFooter?: ReactNode; newConversationRequest?: number;
  onCloseHistory: () => void; onBusyChange: (busy: boolean) => void;
  onLoadingChange: (loading: boolean) => void; onProductChange: (product: MobileProduct) => void;
}) {
  const c = mobileParityCopy(language); const copy = mobileCopy[language];
  const [capability, setCapability] = useState<MobileCapabilities | null>(null);
  const [models, setModels] = useState<MobileModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const { mode, setMode, providers: manualProviders, providersConfigured, setProviders, clearProviders } = useReviewWorkspace(owner, capability?.reviewEasy ?? false, conversation?.id ?? null);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [providerOptions, setProviderOptions] = useState<string[]>([]);
  const providers = providersConfigured ? manualProviders : defaults;
  const [actionBusy, setActionBusy] = useState(false);
  const [image, setImage] = useState<{ prompt: string; modelIds: string[]; preset: ImagePreset; unsupported: boolean } | null>(null);
  const [imageHistory, setImageHistory] = useState<string | null>(null); const [imageOpen, setImageOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [picker, setPicker] = useState(false);
  const [activeModel, setActiveModel] = useState(""); const [partial, setPartial] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState(false); const [loading, setLoading] = useState(true);
  const [uncertain, setUncertain] = useState(false); const [error, setError] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [draft, setDraft] = useDeviceDraft(owner, conversation?.id ?? "review:new");
  const titleScope = useRef(0);
  useEffect(() => () => { titleScope.current++; }, [owner, transport]);
  const request = useRef(0); const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null); const followOutput = useRef(true);
  useEffect(() => { if (followOutput.current) end.current?.scrollIntoView({ block: "end" }); }, [conversation?.messages.length, partial, activeModel]);
  const researchKey = conversation?.messages.filter(message => message.pendingJobId && message.status === "pending").map(message => message.id).join(",") ?? "";
  useEffect(() => {
    if (!researchKey || streaming || !conversation || !transport.resumeResearch) return;
    const controller = new AbortController();
    void transport.resumeResearch(conversation, controller.signal, item => { if (!controller.signal.aborted) { setConversation(item); setUncertain(item.activeAttempt === true); } }).catch(() => { /* Retain readback state; no model resubmission. */ });
    return () => controller.abort();
  }, [researchKey, streaming, transport]); // eslint-disable-line react-hooks/exhaustive-deps -- Job identity controls one restoration watcher.
  const initializationError = useRef(c.reviewUnavailable);
  const defaultsError = useRef(c.reviewDefaultsUnavailable);
  useEffect(() => { defaultsError.current = c.reviewDefaultsUnavailable; }, [c.reviewDefaultsUnavailable]);
  useEffect(() => { initializationError.current = c.reviewUnavailable; }, [c.reviewUnavailable]);
  useEffect(() => { onBusyChange(loading || streaming || uncertain || actionBusy); return () => onBusyChange(false); }, [loading, streaming, uncertain, actionBusy, onBusyChange]);
  useEffect(() => { onLoadingChange(loading); return () => onLoadingChange(false); }, [loading, onLoadingChange]);
  useEffect(() => {
    const current = ++request.current;
    void (async () => {
      try {
        if (!transport.mobileCapabilities || !transport.listReview) throw Error("REVIEW_UNAVAILABLE");
        const [cap, catalog, history, preferences] = await Promise.all([transport.mobileCapabilities(), transport.models(), transport.listReview(), transport.preferences?.().catch(() => null)]);
        if (current !== request.current) return;
        setCapability(cap); setModels(catalog.filter(model => canUseModelWithPlan(cap.plan, model))); setChats(history);
        const eligible = catalog.filter(model => canUseModelWithPlan(cap.plan, model));
        setSelected(eligible.slice(0, Math.min(cap.maxModels, 2)).map(model => model.id));
        const available = new Set(eligible.map(model => model.provider));
        const options = preferences?.reviewEasyProviderOptions?.filter(provider => available.has(provider)) ?? [];
        setProviderOptions(options);
        setDefaults((preferences?.reviewEasyEffectiveProviders ?? []).filter(provider => options.includes(provider)).slice(0, Math.min(cap.maxModels, preferences?.reviewEasyMaxProviders ?? 3)));
        if (cap.reviewEasy && !preferences?.reviewEasyEffectiveProviders) setError(defaultsError.current);
      } catch { if (current === request.current) setError(initializationError.current); }
      finally { if (current === request.current) setLoading(false); }
    })();
    return () => { request.current++; abort.current?.abort(); }; // eslint-disable-line react-hooks/exhaustive-deps -- Invalidate outstanding requests on unmount.
  }, [transport, owner, setProviders]);
  const previousNewRequest = useRef(newConversationRequest);
  function newReview() {
    request.current++; setConversation(null); setPartial({}); setError(""); setUncertain(false); clearProviders(); onCloseHistory();
  }
  useEffect(() => {
    if (previousNewRequest.current === newConversationRequest) return;
    previousNewRequest.current = newConversationRequest; newReview();
  }, [newConversationRequest]); // eslint-disable-line react-hooks/exhaustive-deps -- Header action identity.
  async function open(id: string) {
    if (chats.find(row => row.id === id)?.kind === "image") { setImageHistory(id); setImage(null); setImageOpen(true); onCloseHistory(); return; }
    const current = ++request.current; setLoading(true); setError("");
    try {
      const item = await transport.load(id);
      if (current !== request.current) return;
      setConversation(item); setSelected(item.selectedModels); setActiveModel(item.selectedModels[0] ?? ""); setUncertain(item.activeAttempt === true); setPartial({}); onCloseHistory();
    } catch { if (current === request.current) setError(copy.unavailable); }
    finally { if (current === request.current) setLoading(false); }
  }
  async function ensureConversation(modelIds: string[], epoch = request.current, preserveDraft = true) {
    if (conversation) return conversation;
    if (!transport.createReview) throw Error("REVIEW_UNAVAILABLE");
    const item = await transport.createReview(modelIds);
    if (epoch !== request.current || abort.current?.signal.aborted) throw new DOMException("Stopped", "AbortError");
    if (preserveDraft) preserveNativeDraft(owner, item.id, draft);
    setConversation(item); return item;
  }
  async function configureTools(input: ToolChange) {
    if (!transport.configureTools) throw Error("NATIVE_TOOLS_UNAVAILABLE");
    const current = request.current;
    abort.current = null;
    const item = await ensureConversation(selected, current);
    if (current !== request.current) throw Error("REVIEW_SCOPE_CHANGED");
    try { setConversation(await transport.configureTools(item.id, input)); }
    catch (error) { setUncertain(true); throw error; }
  }
  async function send(text: string, files: MobileAttachment[]) {
    if (streaming || uncertain || !capability) return false;
    if (!(mode === "easy" ? providers : selected).length) { setError(c.noParticipants); return false; }
    const titleEpoch = titleScope.current;
    const current = ++request.current; const controller = new AbortController(); abort.current = controller;
    setStreaming(true); setError(""); setPartial({}); setPendingQuestion(text); setDraft("");
    let item = conversation; let dispatched = false;
    try {
      if (!transport.configureReview || !transport.sendReview) throw Error("REVIEW_UNAVAILABLE");
      item = await ensureConversation(selected, current, false);
      if (current !== request.current || controller.signal.aborted) return false;
      let participants = selected;
      if (mode === "easy") {
        if (!capability.reviewEasy || !transport.routeReview) throw Error("EASY_UNAVAILABLE");
        const decision = await transport.routeReview({ text, context: item.messages.filter(message => message.role === "user").at(-1)?.content.slice(0, 1200) ?? "", providers, hasImages: files.some(file => file.mediaType.startsWith("image/")) || item.messages.some(message => message.attachments?.some(file => file.mediaType.startsWith("image/"))) });
        if (current !== request.current) return false;
        if (decision.kind === "image") { setImage({ prompt: text, modelIds: decision.choices.flatMap(choice => choice.modelId ? [choice.modelId] : []), preset: decision.preset, unsupported: decision.choices.some(choice => !choice.modelId) }); setImageHistory(null); setImageOpen(true); return false; }
        if (decision.choices.some(choice => !choice.modelId)) throw Error("PROVIDER_UNAVAILABLE");
        participants = decision.choices.map(choice => choice.modelId!);
      }
      if (current !== request.current || controller.signal.aborted) return false;
      item = await transport.configureReview(item.id, participants);
      if (current !== request.current) return false;
      setSelected(item.selectedModels); setActiveModel(item.selectedModels[0] ?? "");
      setConversation({ ...item, messages: [...item.messages, { id: "pending-review-user", role: "user", content: text }] });
      setPendingQuestion(null); setDraft("", item.id);
      setPartial(Object.fromEntries(item.selectedModels.map(id => [id, ""])));
      dispatched = true;
      const outcome = await transport.sendReview(item, text, files, controller.signal, (modelId, value) => {
        if (current === request.current) setPartial(previous => ({ ...previous, [modelId]: value }));
      });
      const saved = await transport.load(item.id);
      if (current !== request.current) return;
      setConversation(saved); setPartial({}); setUncertain(saved.activeAttempt === true);
      if (outcome.failedModelIds.length) setError(copy.disconnected);
      const history = await transport.listReview!();
      if (current === request.current) setChats(history);
      if (titleEpoch === titleScope.current) void transport.generateTitle?.(saved).then(title => {
        if (!title || titleEpoch !== titleScope.current) return;
        setConversation(value => value?.id === saved.id && value.title === saved.title ? { ...value, title } : value);
        setChats(rows => rows.map(row => row.id === saved.id && row.title === saved.title ? { ...row, title } : row));
      }).catch(() => { /* Preserve the stored title on background generation failure. */ });
    } catch (error) {
      const beforePersistence = (error as { questionPersisted?: boolean }).questionPersisted === false;
      if (current === request.current) { setError(mobileErrorText(error, language, copy.error)); setUncertain(dispatched && !beforePersistence); if (beforePersistence) setConversation(item); }
      if (beforePersistence) dispatched = false;
      if (current === request.current) setPartial(previous => Object.fromEntries(Object.entries(previous).filter(([, text]) => text)));
      if (beforePersistence || !dispatched) return false;
    } finally { if (current === request.current) { if (!dispatched) setDraft(text, item?.id ?? "review:new"); setStreaming(false); setPendingQuestion(null); } }
  }
  const visibleModels = conversation?.selectedModels.length ? conversation.selectedModels : selected;
  const name = (id: string) => models.find(model => model.id === id)?.name ?? id;
  const messages = conversation?.messages.filter(message => message.role === "user" || message.modelId === activeModel || (message.imageTurn?.modelIds.includes(activeModel)) || (!message.modelId && activeModel === visibleModels[0])) ?? [];
  if (historyOpen) return <ConversationListScreen title={copy.chats} newLabel={c.newReview} disabled={loading || streaming || uncertain || actionBusy} onNew={newReview} footer={historyFooter}>
    <ConversationHistory transport={transport} language={language} owner={owner} chats={chats} currentId={conversation?.id} disabled={loading || streaming || uncertain || actionBusy} onOpen={id => void open(id)} onRefresh={async () => {
      const scope = request.current; const rows = await transport.listReview!();
      if (scope !== request.current) throw Error("REVIEW_SCOPE_CHANGED");
      setChats(rows); setConversation(previous => previous ? { ...previous, title: rows.find(row => row.id === previous.id)?.title ?? previous.title } : null); return rows;
    }} onChanged={(id, deleted, locked) => { if ((deleted || locked) && conversation?.id === id) { request.current++; setConversation(null); setPartial({}); setUncertain(false); } }} />
  </ConversationListScreen>;
  return <section className="review-workspace">
    {error && <p role="alert" className="notice error">{error}</p>}
    {!conversation?.messages.length && !streaming && conversation?.surface !== "continuation" ? <div className="review-intro" data-testid="review-landing"><WorkspaceWelcome product="review" language={language} /></div> : <>

      <div className="transcript review-transcript" aria-live="off" aria-busy={streaming} onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}><div className="review-context-bar"><select className="review-response-select" aria-label={c.models} value={activeModel} onChange={event => { followOutput.current = true; setActiveModel(event.target.value); }}>{visibleModels.map(id => <option value={id} key={id}>{name(id)}{streaming ? " ···" : ""}</option>)}</select></div>{conversation?.surface === "continuation" && <ImportedTranscript key={conversation.id} conversationId={conversation.id} imported={conversation.imported} transport={transport} language={language} />}{messages.map(message => <article className={`message ${message.role}`} id={`review-message-${message.id}`} key={message.id}>{message.role === "assistant" && <span className="message-label">{name(message.modelId ?? activeModel)}</span>}<AnswerContent copyable={message.role === "assistant"} content={message.content} imageTurn={message.imageTurn} artifacts={message.artifacts} citations={message.searchMetadata?.citations} transport={transport} language={language} /></article>)}{pendingQuestion !== null && <><article className="message user"><AnswerContent content={pendingQuestion} transport={transport} language={language} /></article><article className="message assistant"><AnswerContent content={copy.waiting} transport={transport} language={language} /></article></>}{partial[activeModel] !== undefined && <article className="message assistant"><span className="message-label">{name(activeModel)}</span><AnswerContent content={partial[activeModel] || copy.waiting} transport={transport} language={language} /></article>}<div ref={end} /></div>
    </>}
    {uncertain && conversation && <button className="restore" onClick={() => void open(conversation.id)}>{copy.restore}</button>}
    <Composer product="review" onProductChange={onProductChange} productBusy={loading || streaming || uncertain || actionBusy} productLoading={loading}
      selectionControl={<button type="button" className="review-setup-trigger" aria-label={`${c.choose} · ${mode === "easy" ? "Easy" : "Professional"}`} disabled={streaming || uncertain || loading} onClick={() => setPicker(true)}><span>{mode === "easy" ? "Easy" : "Professional"}</span><span className="participant-count">{mode === "easy" ? providers.length : selected.length}</span><span aria-hidden="true">⌄</span></button>}
      locationIdentity={owner} copy={copy} language={language} transport={transport} draft={draft} setDraft={setDraft} disabled={loading || !capability || uncertain} offline={!navigator.onLine} streaming={streaming} conversation={conversation} onConfigureTools={configureTools} onSend={send} onStop={() => abort.current?.abort()} />
    {picker && <ReviewModelPicker language={language} mode={mode} onMode={setMode} easyOffered={capability?.reviewEasy ?? false} busy={streaming || uncertain} models={models} selected={selected} providers={providers} providerOptions={providerOptions} maxModels={capability?.maxModels ?? 1} onModels={setSelected} onProviders={setProviders} onClose={() => setPicker(false)} />}
    {imageOpen && <NativeImageWorkspace owner={owner} transport={transport} language={language} initial={image ?? undefined} historyId={imageHistory ?? undefined} onBusy={setActionBusy} onClose={() => setImageOpen(false)} onCreated={id => { setImageHistory(id); void transport.listReview!().then(setChats).catch(() => setError(copy.unavailable)); }} />}
  </section>;
}
