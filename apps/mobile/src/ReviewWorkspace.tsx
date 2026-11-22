import { CrossReview } from "./CrossReview";
import { QuickSummary } from "./QuickSummary";
import { ReviewChatDraftPreview } from "./ReviewChatDraftPreview";
import { providerName } from "./ModelChoices";
import { mobileReviewCopy } from "../../../locales/mobileReview";
import { nativeWorkspaceCopy } from "../../../locales/nativeWorkspace";
import type { ReviewChatSource } from "../../../lib/reviewToChat";
import { ScanSearch, ListFilter } from "lucide-react";
import { IosAssistantBadge } from "./IosWorkspace";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConversationHistory } from "./ConversationHistory";
import { ConversationListScreen } from "./ConversationListScreen";
import { WorkspaceWelcome } from "./WorkspaceWelcome";
import { ImportedTranscript } from "./ImportedTranscript";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { mobileReviewModeLabel } from "../../../locales/mobileSelection";
import { mobileErrorText } from "../../../locales/mobileErrors";
import { canUseModelWithPlan } from "../../../lib/models";
import type { ChatSummary, ChatTransport, Conversation, MobileAttachment, MobileCapabilities, MobileModel } from "./chatTransport";
import { Composer } from "./Composer";
import type { ComposerAction, ToolChange } from "./ComposerTools";
import { AnswerContent } from "./AnswerContent";
import { NativeImageWorkspace } from "./NativeImageWorkspace";
import { useReviewWorkspace } from "../../../components/chat/useReviewWorkspace";
import type { ImagePreset } from "../../../lib/imageGenerationPricing";
import { ReviewModelPicker } from "./ReviewModelPicker";
import { useDeviceDraft, preserveNativeDraft } from "./useDeviceDraft";
import type { MobileProduct } from "./WorkspaceNavigation";
import { useReviewHandoffDraft } from "./useReviewHandoffDraft";
import { reviewContinuationHandoffCopy as handoffCopy } from "../../../locales/reviewContinuationHandoff";

export function ReviewWorkspace({ transport, language, owner, historyOpen, onCloseHistory, onBusyChange, onLoadingChange, onProductChange, historyFooter, newConversationRequest = 0, conversationRequest, extraTools, onContinueInChat }: {
  transport: ChatTransport; language: MobileLanguage; owner: string | null; historyOpen: boolean;
  conversationRequest?: { id?: string; draft?: string; nonce: number }; extraTools?: ComposerAction[];
  onContinueInChat: (text: string) => void;
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
  const [analysis, setAnalysis] = useState<"cross" | "quick" | null>(null);
  const [chatSource, setChatSource] = useState<ReviewChatSource | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [image, setImage] = useState<{ prompt: string; modelIds: string[]; preset: ImagePreset; unsupported: boolean } | null>(null);
  const [imageHistory, setImageHistory] = useState<string | null>(null); const [imageOpen, setImageOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [picker, setPicker] = useState(false);
  const [activeModel, setActiveModel] = useState(""); const [partial, setPartial] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState(false); const [loading, setLoading] = useState(true);
  const [uncertain, setUncertain] = useState(false); const [error, setError] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const handoff = conversation?.reviewHandoff ?? conversation?.imported?.reviewHandoff;
  const handoffSummary = typeof conversation?.reviewHandoff === "object" ? conversation.reviewHandoff : conversation?.imported?.reviewHandoff;
  const effectiveMode = handoff ? "professional" : mode;
  const [deviceDraft, setDeviceDraft] = useDeviceDraft(handoff ? null : owner, conversation?.id ?? "review:new");
  const durableDraft = useReviewHandoffDraft(owner, handoff ? conversation!.id : null, transport);
  const draft = handoff ? durableDraft.text : deviceDraft;
  const setDraft = (text: string, target?: string | null) => {
    if (handoff) durableDraft.setText(text);
    else setDeviceDraft(text, target);
  };
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
  const draftBlocked = Boolean(handoff && durableDraft.blocked);
  useEffect(() => { onBusyChange(loading || streaming || uncertain || actionBusy || draftBlocked); return () => onBusyChange(false); }, [loading, streaming, uncertain, actionBusy, draftBlocked, onBusyChange]);
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
    if (streaming || uncertain || actionBusy || draftBlocked) return;
    request.current++; setConversation(null); setPartial({}); setError(""); setAnalysis(null); setChatSource(null); setUncertain(false); clearProviders(); onCloseHistory();
  }
  useEffect(() => {
    if (previousNewRequest.current === newConversationRequest) return;
    previousNewRequest.current = newConversationRequest; newReview();
  }, [newConversationRequest]); // eslint-disable-line react-hooks/exhaustive-deps -- Header action identity.
  async function open(id: string) {
    if (streaming || actionBusy || draftBlocked) return;
    if (chats.find(row => row.id === id)?.kind === "image") { setImageHistory(id); setImage(null); setImageOpen(true); onCloseHistory(); return; }
    const current = ++request.current; setLoading(true); setError("");
    try {
      const item = await transport.load(id);
      if (current !== request.current) return;
      setConversation(item); setSelected(item.selectedModels); setActiveModel(item.selectedModels[0] ?? ""); setUncertain(item.activeAttempt === true); setPartial({}); onCloseHistory();
    } catch { if (current === request.current) setError(copy.unavailable); }
    finally { if (current === request.current) setLoading(false); }
  }
  const handledConversationRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!capability || !conversationRequest || handledConversationRequest.current === conversationRequest.nonce) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      handledConversationRequest.current = conversationRequest.nonce;
      if (conversationRequest.id) void open(conversationRequest.id);
      else if (conversationRequest.draft !== undefined) { newReview(); setDraft(conversationRequest.draft, "review:new"); }
    });
    return () => { active = false; };
  }, [capability, conversationRequest]); // eslint-disable-line react-hooks/exhaustive-deps -- Open after capability initialization without replacing this workspace.
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
    setActionBusy(true);
    try {
      const item = await ensureConversation(selected, current);
      if (current !== request.current) throw Error("REVIEW_SCOPE_CHANGED");
      const configured = await transport.configureTools(item.id, input);
      if (current === request.current) setConversation(configured);
    } catch (error) { if (current === request.current) setUncertain(true); throw error; }
    finally { if (current === request.current) setActionBusy(false); }
  }
  async function send(text: string, files: MobileAttachment[]) {
    if (streaming || uncertain || !capability) return false;
    if (handoff && files.length) { setError(handoffCopy.attachmentsUnsupported); return false; }
    if (handoff && !durableDraft.ready) return false;
    // A conversation bound to a saved assistant answers with that assistant's models;
    // Easy routing never replaces them (IOS_WORKSPACE_API.md).
    const easy = !handoff && mode === "easy" && !conversation?.assistantProfileId;
    if (!(easy ? providers : selected).length) { setError(c.noParticipants); return false; }
    const titleEpoch = titleScope.current;
    const current = ++request.current; const controller = new AbortController(); abort.current = controller;
    setStreaming(true); setError(""); setPartial({}); setPendingQuestion(text); if (!handoff) setDraft("");
    let item = conversation; let dispatched = false;
    try {
      const draftRevision = handoff ? await durableDraft.save() : undefined;
      if (!transport.configureReview || !transport.sendReview) throw Error("REVIEW_UNAVAILABLE");
      item = await ensureConversation(selected, current, false);
      if (current !== request.current || controller.signal.aborted) return false;
      let participants = mode === "easy" && item.assistantProfileId ? item.selectedModels : selected;
      if (easy && !item.assistantProfileId) {
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
      setPendingQuestion(null); if (!handoff) setDraft("", item.id);
      setPartial(Object.fromEntries(item.selectedModels.map(id => [id, ""])));
      dispatched = true;
      const outcome = await transport.sendReview(item, text, files, controller.signal, (modelId, value) => {
        if (current === request.current) setPartial(previous => ({ ...previous, [modelId]: value }));
      }, draftRevision ? { revision: draftRevision } : undefined);
      const saved = await transport.load(item.id);
      if (current !== request.current) return;
      setConversation(saved); setPartial({}); setUncertain(saved.activeAttempt === true);
      if (handoff) await durableDraft.reload();
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
      if (current === request.current) { setError(handoff && (error as { code?: string }).code === "REVIEW_HANDOFF_UNAVAILABLE" ? handoffCopy.unavailable : mobileErrorText(error, language, copy.error)); setUncertain(dispatched && !beforePersistence); if (beforePersistence) setConversation(item); }
      if (beforePersistence) dispatched = false;
      if (current === request.current) setPartial(previous => Object.fromEntries(Object.entries(previous).filter(([, text]) => text)));
      if (beforePersistence || !dispatched) return false;
    } finally { if (current === request.current) { if (!dispatched && !handoff) setDraft(text, item?.id ?? "review:new"); setStreaming(false); setPendingQuestion(null); } }
  }
  const lastQuestion = conversation ? conversation.messages.map(message => message.role).lastIndexOf("user") : -1;
  const canAnalyse = lastQuestion >= 0 && !handoff && !streaming && !uncertain &&
    (conversation?.messages.slice(lastQuestion + 1).filter(message => message.role === "assistant" && message.content.trim() && !message.imageTurn && !message.pendingJobId && [undefined, "normal", "completed"].includes(message.status)).length ?? 0) >= 2;
  const visibleModels = conversation?.selectedModels.length ? conversation.selectedModels : selected;
  const name = (id: string) => models.find(model => model.id === id)?.name ?? id;
  const messages = conversation?.messages.filter(message => message.role === "user" || message.modelId === activeModel || (message.imageTurn?.modelIds.includes(activeModel)) || (!message.modelId && activeModel === visibleModels[0])) ?? [];
  if (historyOpen) return <ConversationListScreen title={copy.chats} newLabel={c.newReview} disabled={loading || streaming || uncertain || actionBusy || draftBlocked} onNew={newReview} footer={historyFooter}>
    <ConversationHistory transport={transport} language={language} owner={owner} chats={chats} currentId={conversation?.id} disabled={loading || streaming || uncertain || actionBusy || draftBlocked} onOpen={id => void open(id)} onRefresh={async () => {
      const scope = request.current; const rows = await transport.listReview!();
      if (scope !== request.current) throw Error("REVIEW_SCOPE_CHANGED");
      setChats(rows); setConversation(previous => previous ? { ...previous, title: rows.find(row => row.id === previous.id)?.title ?? previous.title } : null); return rows;
    }} onChanged={(id, deleted, locked) => { if ((deleted || locked) && conversation?.id === id) { request.current++; setConversation(null); setPartial({}); setUncertain(false); } }} />
  </ConversationListScreen>;
  return <section className="review-workspace">
    {error && <p role="alert" className="notice error">{error}</p>}
    {handoff && <div className="notice" data-testid="review-handoff-context">{handoffSummary ? <><p>{handoffCopy.scope(handoffSummary.sourceTurnCount, handoffSummary.nativeTurnCount)}</p>{handoffSummary.sourceOmittedCount > 0 && <p>{handoffCopy.sourceOmitted(handoffSummary.sourceOmittedCount)}</p>}{handoffSummary.nativeOmittedCount > 0 && <p>{handoffCopy.omitted(handoffSummary.nativeOmittedCount)}</p>}{handoffSummary.sourceMode === "legacy" && <p>{handoffCopy.legacy}</p>}</> : <p>{handoffCopy.unavailable}</p>}<p>{handoffCopy.multiModel}</p></div>}
    {handoff && (durableDraft.status === "failed" || durableDraft.status === "conflict") && <p role="alert" className="notice error">{durableDraft.status === "conflict" ? handoffCopy.draftConflict : handoffCopy.draftFailed}<button type="button" onClick={() => void (durableDraft.status === "conflict" ? durableDraft.reload() : durableDraft.save()).catch(() => {})}>{durableDraft.status === "conflict" ? handoffCopy.reloadDraft : handoffCopy.retryDraft}</button></p>}
    {handoff && durableDraft.status === "saving" && <p role="status">{handoffCopy.draftSaving}</p>}
    {conversation?.assistantProfileId && <IosAssistantBadge id={conversation.assistantProfileId} transport={transport} />}
    {!conversation?.messages.length && !streaming && conversation?.surface !== "continuation" ? <div className="review-intro" data-testid="review-landing"><WorkspaceWelcome product="review" language={language} /></div> : <>

      <div className="transcript review-transcript" aria-live="off" aria-busy={streaming} onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }}><div className="review-context-bar"><div className="review-provider-tabs" role="tablist" aria-label={c.models}>{visibleModels.map(id => <button type="button" role="tab" aria-selected={activeModel === id} aria-controls="native-review-answer-panel" id={`native-review-model-${id}`} key={id} onClick={() => { followOutput.current = true; setActiveModel(id); }}><strong>{name(id)}</strong><small>{providerName(models.find(model => model.id === id)?.provider ?? "")}{streaming ? " ···" : ""}</small></button>)}</div></div><div id="native-review-answer-panel" role="tabpanel" aria-labelledby={`native-review-model-${activeModel}`}>{conversation?.surface === "continuation" && <ImportedTranscript key={conversation.id} conversationId={conversation.id} imported={conversation.imported} transport={transport} language={language} />}{messages.map(message => <article className={`message ${message.role}`} id={`review-message-${message.id}`} key={message.id}>{message.role === "assistant" && <span className="message-label">{name(message.modelId ?? activeModel)}</span>}<AnswerContent copyable={message.role === "assistant"} content={message.content} imageTurn={message.imageTurn} artifacts={message.artifacts} citations={message.searchMetadata?.citations} transport={transport} language={language} /></article>)}{pendingQuestion !== null && <><article className="message user"><AnswerContent content={pendingQuestion} transport={transport} language={language} /></article><article className="message assistant"><AnswerContent content={copy.waiting} transport={transport} language={language} /></article></>}{partial[activeModel] !== undefined && <article className="message assistant"><span className="message-label">{name(activeModel)}</span><AnswerContent content={partial[activeModel] || copy.waiting} transport={transport} language={language} /></article>}</div>{canAnalyse && conversation && <div className="native-review-actions" aria-label={mobileReviewCopy(language).crossReview}>
        {transport.reviewPreview && <button type="button" data-testid="native-cross-review" disabled={actionBusy || loading} onClick={() => setAnalysis("cross")}><ScanSearch size={17} />{mobileReviewCopy(language).crossReview}</button>}
        {capability?.reviewAnalysis?.quickSummary && transport.quickSummaryPreview && <button type="button" data-testid="native-quick-summary" disabled={actionBusy || loading} onClick={() => setAnalysis("quick")}><ListFilter size={17} />{nativeWorkspaceCopy(language).quickSummary}</button>}
      </div>}<div ref={end} /></div>
    </>}
    {uncertain && conversation && <button className="restore" onClick={() => void (async () => { await open(conversation.id); if (handoff) await durableDraft.reload(); })()}>{copy.restore}</button>}
    <Composer extraTools={extraTools} inputMaxLength={handoff ? 50000 : undefined} product="review" onProductChange={onProductChange} productBusy={loading || streaming || uncertain || actionBusy || draftBlocked} productLoading={loading}
      selectionControl={<button type="button" className="review-setup-trigger" aria-label={`${c.choose} · ${mobileReviewModeLabel(language, effectiveMode)}`} disabled={streaming || uncertain || loading} onClick={() => setPicker(true)}><span>{mobileReviewModeLabel(language, effectiveMode)}</span><span className="participant-count">{effectiveMode === "easy" ? providers.length : selected.length}</span><span aria-hidden="true">⌄</span></button>}
      locationIdentity={owner} copy={copy} language={language} transport={transport} draft={handoff && streaming ? "" : draft} setDraft={setDraft} disabled={loading || !capability || uncertain || Boolean(handoff && !durableDraft.ready && durableDraft.status !== "saving")} offline={!navigator.onLine} streaming={streaming} conversation={conversation} onConfigureTools={configureTools} onSend={send} onStop={() => abort.current?.abort()} />
    {analysis === "cross" && conversation && <CrossReview key={conversation.id} id={conversation.id} owner={owner} transport={transport} language={language} onClose={() => setAnalysis(null)} onBusy={setActionBusy} onContinue={setChatSource} onSource={id => { const message = conversation.messages.find(row => row.id === id); if (message?.modelId) setActiveModel(message.modelId); setAnalysis(null); requestAnimationFrame(() => document.getElementById(`review-message-${id}`)?.scrollIntoView({ block: "center" })); }} />}
    {analysis === "quick" && conversation && <QuickSummary key={conversation.id} id={conversation.id} owner={owner} transport={transport} language={language} onClose={() => setAnalysis(null)} onBusy={setActionBusy} onContinue={setChatSource} />}
    {chatSource && <ReviewChatDraftPreview key={chatSource.review.id} source={chatSource} owner={owner} transport={transport} language={language} onClose={() => setChatSource(null)} onConfirm={onContinueInChat} />}
    {picker && <ReviewModelPicker language={language} mode={effectiveMode} onMode={setMode} easyOffered={!handoff && (capability?.reviewEasy ?? false)} busy={streaming || uncertain} models={models} selected={selected} providers={providers} providerOptions={providerOptions} maxModels={capability?.maxModels ?? 1} onModels={setSelected} onProviders={setProviders} onClose={() => setPicker(false)} />}
    {imageOpen && <NativeImageWorkspace owner={owner} transport={transport} language={language} initial={image ?? undefined} historyId={imageHistory ?? undefined} onBusy={setActionBusy} onClose={() => setImageOpen(false)} onCreated={id => { setImageHistory(id); void transport.listReview!().then(setChats).catch(() => setError(copy.unavailable)); }} />}
  </section>;
}
