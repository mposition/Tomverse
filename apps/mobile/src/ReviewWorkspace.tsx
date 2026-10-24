import { useEffect, useRef, useState, type ReactNode } from "react";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { mobileErrorText } from "../../../locales/mobileErrors";
import { canUseModelWithPlan } from "../../../lib/models";
import type { ChatSummary, ChatTransport, Conversation, MobileAttachment, MobileCapabilities, MobileModel } from "./chatTransport";
import { Composer } from "./Composer";
import type { ToolChange } from "./ComposerTools";
import { AnswerContent } from "./AnswerContent";
import { CrossReview } from "./CrossReview";
import { NativeImageWorkspace } from "./NativeImageWorkspace";
import { useReviewWorkspace } from "../../../components/chat/useReviewWorkspace";
import { mobileReviewCopy } from "../../../locales/mobileReview";
import type { ImagePreset } from "../../../lib/imageGenerationPricing";
import { Sheet } from "./Sheet";
import { useDeviceDraft, preserveNativeDraft } from "./useDeviceDraft";

export function ReviewWorkspace({ transport, language, owner, historyOpen, onCloseHistory, onBusyChange, historyFooter, newConversationRequest = 0 }: {
  transport: ChatTransport; language: MobileLanguage; owner: string | null; historyOpen: boolean;
  historyFooter?: ReactNode; newConversationRequest?: number;
  onCloseHistory: () => void; onBusyChange: (busy: boolean) => void;
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
  const [crossReview, setCrossReview] = useState(false); const [actionBusy, setActionBusy] = useState(false);
  const [image, setImage] = useState<{ prompt: string; modelIds: string[]; preset: ImagePreset; unsupported: boolean } | null>(null);
  const [imageHistory, setImageHistory] = useState<string | null>(null); const [imageOpen, setImageOpen] = useState(false);
  const reviewCopy = mobileReviewCopy(language);
  const [chats, setChats] = useState<ChatSummary[]>([]); const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [activeModel, setActiveModel] = useState(""); const [partial, setPartial] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState(false); const [loading, setLoading] = useState(true);
  const [uncertain, setUncertain] = useState(false); const [error, setError] = useState("");
  const [draft, setDraft] = useDeviceDraft(owner, conversation?.id ?? "review:new");
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
  useEffect(() => { initializationError.current = c.reviewUnavailable; }, [c.reviewUnavailable]);
  const lastKey = `tomverse-native-last-review:${owner ?? ""}`;
  useEffect(() => { onBusyChange(loading || streaming || uncertain || actionBusy); return () => onBusyChange(false); }, [loading, streaming, uncertain, actionBusy, onBusyChange]);
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
        if (cap.reviewEasy && !preferences?.reviewEasyEffectiveProviders) setError(initializationError.current);
        const last = localStorage.getItem(lastKey);
        if (last && history.some(chat => chat.id === last && chat.kind !== "image")) {
          const item = await transport.load(last);
          if (current !== request.current) return;
          setConversation(item); setSelected(item.selectedModels); setActiveModel(item.selectedModels[0] ?? ""); setUncertain(item.activeAttempt === true);
        }
      } catch { if (current === request.current) setError(initializationError.current); }
      finally { if (current === request.current) setLoading(false); }
    })();
    return () => { request.current++; abort.current?.abort(); }; // eslint-disable-line react-hooks/exhaustive-deps -- Invalidate outstanding requests on unmount.
  }, [transport, lastKey, setProviders]);
  const previousNewRequest = useRef(newConversationRequest);
  function newReview() {
    request.current++; setConversation(null); setPartial({}); setError(""); setUncertain(false); clearProviders(); localStorage.removeItem(lastKey); onCloseHistory();
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
      setConversation(item); setSelected(item.selectedModels); setActiveModel(item.selectedModels[0] ?? ""); setUncertain(item.activeAttempt === true); setPartial({}); localStorage.setItem(lastKey, id); onCloseHistory();
    } catch { if (current === request.current) setError(copy.unavailable); }
    finally { if (current === request.current) setLoading(false); }
  }
  async function ensureConversation(modelIds: string[], epoch = request.current) {
    if (conversation) return conversation;
    if (!transport.createReview) throw Error("REVIEW_UNAVAILABLE");
    const item = await transport.createReview(modelIds);
    if (epoch !== request.current || abort.current?.signal.aborted) throw new DOMException("Stopped", "AbortError");
    preserveNativeDraft(owner, item.id, draft); setConversation(item); localStorage.setItem(lastKey, item.id); return item;
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
    const current = ++request.current; const controller = new AbortController(); abort.current = controller;
    setStreaming(true); setError(""); setPartial({});
    let item = conversation; let dispatched = false;
    try {
      if (!transport.configureReview || !transport.sendReview) throw Error("REVIEW_UNAVAILABLE");
      item = await ensureConversation(selected, current);
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
      dispatched = true;
      const outcome = await transport.sendReview(item, text, files, controller.signal, (modelId, value) => {
        if (current === request.current) setPartial(previous => ({ ...previous, [modelId]: value }));
      });
      const saved = await transport.load(item.id);
      if (current !== request.current) return;
      setConversation(saved); setPartial({}); setUncertain(saved.activeAttempt === true);
      if (!outcome.failedModelIds.length) setDraft(""); else setError(copy.disconnected);
      const history = await transport.listReview!();
      if (current === request.current) setChats(history);
      void transport.generateTitle?.(saved).then(title => {
        if (!title || current !== request.current) return;
        setConversation(value => value?.id === saved.id && value.title === saved.title ? { ...value, title } : value);
        setChats(rows => rows.map(row => row.id === saved.id && row.title === saved.title ? { ...row, title } : row));
      }).catch(() => { /* Preserve the stored title on background generation failure. */ });
    } catch (error) {
      const beforePersistence = (error as { questionPersisted?: boolean }).questionPersisted === false;
      if (current === request.current) { setError(mobileErrorText(error, language, copy.error)); setUncertain(dispatched && !beforePersistence); if (beforePersistence) setConversation(item); }
      if (beforePersistence || !dispatched) return false;
    } finally { if (current === request.current) setStreaming(false); }
  }
  const visibleModels = conversation?.selectedModels.length ? conversation.selectedModels : selected;
  const name = (id: string) => models.find(model => model.id === id)?.name ?? id;
  const messages = conversation?.messages.filter(message => message.role === "user" || message.modelId === activeModel || (message.imageTurn?.modelIds.includes(activeModel)) || (!message.modelId && activeModel === visibleModels[0])) ?? [];
  return <section className="review-workspace">
    <div className="review-context-bar">
      <button className="review-setup-trigger" aria-label={`${c.choose} · ${mode === "easy" ? "Easy" : "Professional"}`} disabled={streaming || uncertain || loading} onClick={() => setPicker(true)}>{mode === "easy" ? "Easy" : "Professional"}<span className="participant-count">{mode === "easy" ? providers.length : selected.length}</span><span aria-hidden="true">⌄</span></button>
      {conversation?.messages.length ? <select className="review-response-select" aria-label={c.models} value={activeModel} onChange={event => { followOutput.current = true; setActiveModel(event.target.value); }}>{visibleModels.map(id => <option value={id} key={id}>{name(id)}{streaming ? " ···" : ""}</option>)}</select> : <span className="review-context-hint">{c.review}</span>}
    </div>
    {error && <p role="alert" className="notice error">{error}</p>}{loading && <p role="status">{copy.loading}</p>}
    {!conversation?.messages.length && !streaming ? <div className="review-intro"><h1>{c.reviewEmpty}</h1><p>{mode === "easy" ? c.easy : c.professional}</p><div className="review-participants">{(mode === "easy" ? providers : selected).map(value => <span key={value}>{mode === "easy" ? value : name(value)}</span>)}</div></div> : <>

      <div className="transcript review-transcript" aria-live="off" aria-busy={streaming} onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}>{messages.map(message => <article className={`message ${message.role}`} id={`review-message-${message.id}`} key={message.id}>{message.role === "assistant" && <span className="message-label">{name(message.modelId ?? activeModel)}</span>}<AnswerContent content={message.content} imageTurn={message.imageTurn} artifacts={message.artifacts} citations={message.searchMetadata?.citations} transport={transport} language={language} /></article>)}{partial[activeModel] !== undefined && <article className="message assistant"><span className="message-label">{name(activeModel)}</span><AnswerContent content={partial[activeModel] || copy.waiting} transport={transport} language={language} /></article>}<div ref={end} /></div>
    </>}
    {uncertain && conversation && <button className="restore" onClick={() => void open(conversation.id)}>{copy.restore}</button>}
    <Composer copy={copy} language={language} transport={transport} draft={draft} setDraft={setDraft} disabled={loading || !capability || uncertain} offline={!navigator.onLine} streaming={streaming} conversation={conversation} onConfigureTools={configureTools} onSend={send} onStop={() => abort.current?.abort()} extraTools={[
      { label: reviewCopy.crossReview, disabled: !conversation?.messages.some(message => message.role === "assistant"), onSelect: () => setCrossReview(true) },
      { label: reviewCopy.images, disabled: !capability?.images?.enabled, onSelect: () => { setImage(null); setImageHistory(null); setImageOpen(true); } },
    ]} />
    {picker && <Sheet title={mode === "easy" ? c.providers : c.models} closeLabel={copy.close} onClose={() => setPicker(false)}><div className="segmented" role="group" aria-label="Review mode">{(["easy", "professional"] as const).map(value => <button key={value} aria-pressed={mode === value} disabled={streaming || uncertain || (value === "easy" && !capability?.reviewEasy)} onClick={() => setMode(value)}>{value === "easy" ? "Easy" : "Professional"}</button>)}</div><p>{mode === "easy" ? c.easy : c.professional}</p><div className="review-model-options">
      {mode === "easy" ? providerOptions.map(provider => <label key={provider}>{provider}<input type="checkbox" checked={providers.includes(provider)} disabled={!providers.includes(provider) && providers.length >= Math.min(3, capability?.maxModels ?? 1)} onChange={event => { const checked = event.currentTarget.checked; setProviders(checked ? [...providers, provider] : providers.filter(value => value !== provider)); }} /></label>) : models.map(model => <label key={model.id}><span>{model.name}<small>{model.provider}</small></span><input type="checkbox" checked={selected.includes(model.id)} disabled={!selected.includes(model.id) && selected.length >= (capability?.maxModels ?? 1)} onChange={event => { const checked = event.currentTarget.checked; setSelected(previous => checked ? [...previous, model.id] : previous.filter(value => value !== model.id)); }} /></label>)}
    </div></Sheet>}
    {crossReview && conversation && <CrossReview id={conversation.id} owner={owner} transport={transport} language={language} onClose={() => setCrossReview(false)} onBusy={setActionBusy} onSource={messageId => { const source = conversation.messages.find(message => message.id === messageId); if (source?.modelId) setActiveModel(source.modelId); setCrossReview(false); setTimeout(() => document.getElementById(`review-message-${messageId}`)?.scrollIntoView({ block: "center" }), 50); }} />}
    {imageOpen && <NativeImageWorkspace owner={owner} transport={transport} language={language} initial={image ?? undefined} historyId={imageHistory ?? undefined} onBusy={setActionBusy} onClose={() => setImageOpen(false)} onCreated={id => { setImageHistory(id); void transport.listReview!().then(setChats).catch(() => setError(copy.unavailable)); }} />}
    {historyOpen && <Sheet title={c.history} closeLabel={copy.close} onClose={onCloseHistory}><button className="primary" onClick={newReview}>{c.newReview}</button><div className="history-scroll"><input type="search" aria-label={c.history} value={query} onChange={event => setQuery(event.target.value)} />{chats.filter(chat => chat.title.toLowerCase().includes(query.toLowerCase())).map(chat => <button className="conversation-row" key={chat.id} onClick={() => void open(chat.id)}>{chat.title}</button>)}</div>{historyFooter}</Sheet>}
  </section>;
}
