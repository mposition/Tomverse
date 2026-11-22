import { ContinuationReceipt } from "../../../components/continuations/ContinuationReceipt";
import type { ContinuationReceipt as SourceReceipt } from "../../../lib/continuationReceipt";
import type { Passage } from "../../../lib/continuationPassages";
import { mobileSourceContextCopy } from "../../../locales/mobileSourceContext";
import { useResearchPreview } from "../../../components/chat/useResearchPreview";
import { ResearchPreviewRunCard } from "../../../components/chat/ResearchPreviewRunCard";
import { DeepResearchEngineSheet, ResearchWorkspace } from "../../../components/chat/DeepResearchEngine";
import { researchEngineCopy } from "../../../locales/researchEngine";
import { researchRunMessage } from "../../../lib/researchPreviewRunClient";
import { providerName } from "./ModelChoices";
import { type AssistantEntry, type IosPanel } from "./iosWorkspaceContract";
import { IosNavigation, IosWelcome, IosWorkspacePanel, IosAssistantBadge } from "./IosWorkspace";
import { mobileIosWorkspaceCopy } from "../../../locales/mobileIosWorkspace";
import { canUseModelWithPlan } from "../../../lib/models";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { mobileNavigationCopy } from "../../../locales/mobileNavigation";
import { mobileCopy, mobileLanguages, type MobileLanguage } from "../../../locales/mobile";
import type { ChatSummary, ChatTransport, Conversation, MobileAttachment, ChatMessage } from "./chatTransport";
import { SidebarAccount } from "./SidebarAccount";
import { ConversationHistory } from "./ConversationHistory";
import { ConversationListScreen } from "./ConversationListScreen";
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
import { mobileLoginCopy, mobileLoginError } from "../../../locales/mobileLogin";
import { AnswerContent } from "./AnswerContent";
import { mobileCompletionCopy } from "../../../locales/mobileCompletion";
import { AccountScreen } from "./AccountScreen";
import { useDeviceDraft, clearNativeDrafts, preserveNativeDraft, readNativeDraftText } from "./useDeviceDraft";
import { appendNativeReviewChatDraft, sameNativeChatDraft, type NativeChatDraftApply, type NativeChatDraftSnapshot } from "./nativeReviewChat";
import { useArtifactRevisionDraft } from "./useArtifactRevisionDraft";
import { ImportedTranscript } from "./ImportedTranscript";
import { reviewSeedFromChat } from "../../../lib/chatReviewHandoff";
import { mobileCompareInReviewCopy } from "../../../locales/mobileCompareInReview";
import { reviewContinuationHandoffCopy } from "../../../locales/reviewContinuationHandoff";
import type { AccountSettingsTab } from "../../../lib/accountSettingsEvents";
import { mobileSettingsCopy } from "../../../locales/mobileSettings";
import { useCompactBottomDock, useVisibleViewportHeight } from "../../../components/chat/useVisualViewport";
import { NativeLocationOnboarding } from "./NativeLocationOnboarding";
import { NativeAppUpdate } from "./NativeAppUpdate";

const LAST_CHAT = "tomverse-native-last-chat";
const REVIEW_HANDOFF_TARGET = "tomverse-native-review-handoff-target";
function AnswerAttribution({ message, language }: { message: ChatMessage; language: MobileLanguage }) {
  const modelId = message.routedModelId ?? message.modelId;
  if (!modelId) return null;
  const model = getModel(modelId);
  const name = model?.name ?? modelId;
  const attribution = model ? `${name} · ${providerName(model.provider)}` : name;
  return <span className="routed-badge" data-testid={message.routedModelId ? "auto-routed-by" : "answered-by"} title={name}>
    {message.routedModelId && <AppIcon name="spark" />}<span>{message.routedModelId ? `${autoRoutingCopy[language].answeredBy} · ${attribution}` : attribution}</span>
  </span>;
}

export function MobileApp({ transport, demo = false }: { transport: ChatTransport; demo?: boolean }) {
  const visibleHeight = useVisibleViewportHeight();
  const shortViewport = useCompactBottomDock();
  const compact = shortViewport || (visibleHeight > 0 && visibleHeight < 640);
  const [language, setLanguage] = useState<MobileLanguage>(() => {
    const saved = localStorage.getItem("tomverse-language") ?? navigator.language.split("-")[0];
    return mobileLanguages.includes(saved as MobileLanguage) ? saved as MobileLanguage : "en";
  });
  const [theme, setTheme] = useState(() => localStorage.getItem("tomverse-theme") ?? "system");
  const copy = mobileCopy[language];
  const navigationCopy = mobileNavigationCopy[language];
  const loginCopy = mobileLoginCopy[language];
  const workspaceCopy = mobileWorkspaceCopy[language];
  const [signedIn, setSignedIn] = useState(false);
  const [voiceRevision, setVoiceRevision] = useState(0);
  const [emailLogin, setEmailLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [view, setView] = useState<"chat" | "list">("chat");
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<AccountSettingsTab>("account");
  const [modelPicker, setModelPicker] = useState(false);
  const [draftAutoOffered, setDraftAutoOffered] = useState(false);
  const [draftModelId, setDraftModelId] = useState<string>();
  const [draftCapabilityReady, setDraftCapabilityReady] = useState(false);
  const [iosEntry, setIosEntry] = useState<AssistantEntry | null>(null);
  const [iosImageEnabled, setIosImageEnabled] = useState(false);
  const [iosImportsEnabled, setIosImportsEnabled] = useState(false);
  const [fileRevisionOffer, setFileRevisionOffer] = useState<{ owner: string | null; enabled: boolean }>({ owner: null, enabled: false });
  const reviewRequestSequence = useRef(0);
  const [reviewOpen, setReviewOpen] = useState<{ id?: string; draft?: string; nonce: number } | undefined>();
  const [sourceExpanded, setSourceExpanded] = useState(() => matchMedia("(min-width: 900px)").matches);
  const [product, setProduct] = useState<"chat" | "review">("chat");
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [newReviewRequest, setNewReviewRequest] = useState(0);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [configurationBusy, setConfigurationBusy] = useState(false);
  const handoffAttempt = useRef<{ owner: string; parentId: string; assistantId: string; key: string } | null>(null);
  const handoffOrigin = useRef<{ owner: string; parentId: string } | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [partial, setPartial] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [sourcePick, setSourcePick] = useState<{ owner: string | null; id: string; parts: Passage[] } | null>(null);
  const [sourceDelivery, setSourceDelivery] = useState<{ owner: string | null; id: string; receipt: SourceReceipt } | null>(null);
  const sourceParts = sourcePick?.owner === owner && sourcePick.id === conversation?.id ? sourcePick.parts : [];
  const sourceCopy = mobileSourceContextCopy(language);
  const sourceT = (key: string) => sourceCopy[key] ?? key;
  const sourceSelection = conversation ? { selected: sourceParts, busy: streaming || uncertain,
    onChoose: (parts: Passage[]) => setSourcePick({ owner, id: conversation.id, parts }) } : undefined;
  const [draft, setDraft] = useDeviceDraft(owner, conversation?.id ?? null);
  const revisionDraft = useArtifactRevisionDraft({ owner, conversationId: conversation?.id ?? null,
    text: draft, setText: setDraft, transport, language,
    enabled: signedIn && fileRevisionOffer.owner === owner && fileRevisionOffer.enabled && !loading && !streaming && !uncertain });
  const researchPreview = useResearchPreview({
    identityKey: owner, conversationId: conversation?.id ?? null,
    modelId: conversation?.selectedModels[0] ?? draftModelId, question: draft.trim(), locale: language,
    assistantProfileId: conversation?.assistantProfileId, requestOffer: transport.researchPreviewOffer,
    revision: JSON.stringify([conversation?.assistantProfileId]),
    enabled: Boolean(transport.researchPreviewOffer && signedIn && product === "chat" &&
      (conversation ? conversation.selectionMode === "manual" && conversation.selectedModels.length === 1 && conversation.surface !== "continuation" : draftCapabilityReady && !draftAutoOffered)),
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const [reportFor, setReportFor] = useState<{ messageId: string; modelId?: string } | null>(null);
  // Only a finished answer has a saved Message row the report can be linked to;
  // a reopened claimed or streaming attempt does not yet.
  const reportable = (message: { content: string; status?: string }) =>
    Boolean(transport.reportAnswer) && Boolean(message.content.trim()) && [undefined, "normal", "incomplete"].includes(message.status);
  const comparable = (message: ChatMessage) =>
    message.role === "assistant" && Boolean(message.content.trim()) &&
    (conversation?.surface === "continuation" ? [undefined, "normal", "completed"].includes(message.status) && !message.imageTurn && !message.researchRunId && !message.pendingJobId : [undefined, "normal", "incomplete"].includes(message.status));
  const [offline, setOffline] = useState(!navigator.onLine);
  const abort = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  /** The owner's new-Chat draft (text and files), memory first; distinct from an open Chat's own draft. */
  const readNewChatDraft = (): NativeChatDraftSnapshot | null => owner ? { owner, generation: epoch.current,
    text: readNativeDraftText(owner, null), files: revisionDraft.peekFiles(null).map(({ uploadId, name }) => ({ uploadId, name })) } : null;
  const end = useRef<HTMLDivElement>(null);
  const requestEpoch = useRef(0);
  useEffect(() => {
    handoffAttempt.current = null;
    let active = true;
    void Promise.resolve().then(() => { if (active) setHandoffBusy(false); });
    return () => { active = false; handoffAttempt.current = null; };
  }, [owner, transport, conversation?.id]);
  const researchKey = conversation?.messages.filter(message => message.pendingJobId && message.status === "pending").map(message => message.id).join(",") ?? "";
  useEffect(() => {
    if (!researchKey || streaming || !conversation || !transport.resumeResearch) return;
    const controller = new AbortController();
    void transport.resumeResearch(conversation, controller.signal, item => { if (!controller.signal.aborted) { setConversation(item); setUncertain(item.activeAttempt === true); } }).catch(() => { /* Retain readback state; no model resubmission. */ });
    return () => controller.abort();
  }, [researchKey, streaming, transport]); // eslint-disable-line react-hooks/exhaustive-deps -- Job identity controls one restoration watcher.
  useEffect(() => {
    if (!signedIn || !owner) return;
    let live = true;
    void transport.mobileCapabilities?.(true).then(value => { if (live) {
      setFileRevisionOffer({ owner, enabled: value.generatedFileRevisions === true });
      setIosImageEnabled(value.chatImageTurns === true && value.images?.enabled === true); setIosImportsEnabled(value.workspace?.externalImport === true);
    } }).catch(() => { if (live) setFileRevisionOffer({ owner, enabled: false }); });
    return () => { live = false; };
  }, [owner, signedIn, transport]);
  const initializationError = useRef(copy.error);
  useEffect(() => { initializationError.current = copy.error; }, [copy.error]);

  useEffect(() => { document.documentElement.lang = language; localStorage.setItem("tomverse-language", language); }, [language]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("tomverse-theme", theme); }, [theme]);
  useEffect(() => {
    if (conversation?.messages.length || partial !== null) end.current?.scrollIntoView({ block: "end" });
    else end.current?.parentElement?.scrollTo({ top: 0 });
  }, [partial, conversation?.messages.length]);
  useEffect(() => {
    if (!signedIn || conversation) return;
    let active = true;
    void Promise.all([transport.capabilities(), transport.preferences?.()]).then(([value, preferences]) => {
      if (active) { setDraftAutoOffered(value.offered); setDraftModelId(preferences?.defaultModel); setDraftCapabilityReady(true); }
    }).catch(() => { if (active) { setDraftAutoOffered(false); setDraftCapabilityReady(false); } });
    return () => { active = false; };
  }, [transport, signedIn, conversation]);
  useEffect(() => transport.onSessionLost?.(() => {
    epoch.current++; requestEpoch.current++; abort.current?.abort();
    clearNativeDrafts(); handoffAttempt.current = null; handoffOrigin.current = null; setHandoffBusy(false); setConfigurationBusy(false); sessionStorage.removeItem(REVIEW_HANDOFF_TARGET); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); setPartial(null); setPendingQuestion(null); setReportFor(null);
    setIosEntry(null); setReviewOpen(undefined); setUncertain(false); setStreaming(false); setModelPicker(false); setSettings(false); setAccountOpen(false); setProduct("chat");
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
        try {
          const saved = JSON.parse(sessionStorage.getItem(REVIEW_HANDOFF_TARGET) ?? "null") as { owner?: string; id?: string } | null;
          if (saved?.owner === profile.id && saved.id && /^[A-Za-z0-9_-]{1,64}$/.test(saved.id)) {
            setReviewOpen({ id: saved.id, nonce: Date.now() }); setProduct("review");
          }
        } catch { /* An opaque navigation hint is optional. */ }
        await transport.mobileCapabilities?.().catch(() => undefined);
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
    } catch (failure) { if (current === requestEpoch.current) setError(mobileLoginError(failure, language, "browser")); }
    finally { if (current === requestEpoch.current) setLoading(false); }
  }
  async function signOut() {
    epoch.current++; requestEpoch.current++; abort.current?.abort();
    handoffAttempt.current = null; handoffOrigin.current = null; setHandoffBusy(false); setConfigurationBusy(false); sessionStorage.removeItem(REVIEW_HANDOFF_TARGET);
    clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); setPartial(null); setPendingQuestion(null); setReportFor(null);
    setIosEntry(null); setReviewOpen(undefined); setUncertain(false); setStreaming(false); localStorage.removeItem(LAST_CHAT); setSettings(false); setModelPicker(false); setProduct("chat");
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
    if (handoffBusy || configurationBusy) return false;
    setSourcePick(null); setSourceDelivery(null);
    const current = ++requestEpoch.current;
    setLoading(true); setError(""); setPartial(null);
    try {
      const item = await transport.load(id);
      if (current !== requestEpoch.current) return false;
      setConversation(item); setUncertain(item.activeAttempt === true); setView("chat"); localStorage.setItem(LAST_CHAT, id); return true;
    } catch { if (current === requestEpoch.current) setError(copy.unavailable); return false; }
    finally { if (current === requestEpoch.current) setLoading(false); }
  }
  async function configureModel(modelId: string, auto: boolean) {
    const current = ++requestEpoch.current;
    setConfigurationBusy(true);
    try {
      const item = conversation ?? await transport.create();
      if (current !== requestEpoch.current) return;
      if (!conversation) preserveNativeDraft(owner, item.id, draft);
      setConversation(item); localStorage.setItem(LAST_CHAT, item.id);
      const updated = await transport.configure(item.id, modelId, auto);
      if (current !== requestEpoch.current) return;
      setConversation(updated); setModelPicker(false);
    } catch (error) {
      if (current !== requestEpoch.current) return;
      setUncertain(true); setError(mobileErrorText(error, language, copy.disconnected)); setModelPicker(false); throw error;
    } finally { if (current === requestEpoch.current) setConfigurationBusy(false); }
  }
  async function configureTools(input: ToolChange) {
    if (!transport.configureTools) throw Error("NATIVE_TOOLS_UNAVAILABLE");
    const current = ++requestEpoch.current;
    setConfigurationBusy(true);
    try {
      const item = conversation ?? await transport.create();
      if (current !== requestEpoch.current) return;
      if (!conversation) preserveNativeDraft(owner, item.id, draft);
      setConversation(item); localStorage.setItem(LAST_CHAT, item.id);
      const updated = await transport.configureTools(item.id, input);
      if (current === requestEpoch.current) setConversation(updated);
    } catch (error) { if (current === requestEpoch.current) { setUncertain(true); setError(mobileErrorText(error, language, copy.error)); } throw error; }
    finally { if (current === requestEpoch.current) setConfigurationBusy(false); }
  }
  async function send(text: string, files: MobileAttachment[], fromVoice = false, research = false) {
    if (research && (!researchPreview.offered || files.length || !text.trim() || text.trim().length > 4000 || !transport.sendResearchPreview)) return false;
    if (streaming || uncertain || configurationBusy || handoffBusy) { if (fromVoice) throw Error("CHAT_TURN_BUSY"); return false; }
    const current = ++requestEpoch.current;
    const titleEpoch = epoch.current;
    const picked = !fromVoice && sourceParts.length ? [...sourceParts] : undefined;
    setSourceDelivery(null);
    const controller = new AbortController(); abort.current = controller;
    setStreaming(true); setError(""); setPartial(""); setPendingQuestion(text); setDraft("");
    let item = conversation; let dispatched = false;
    try {
      item ??= await transport.create((text.trim() || files[0]?.name || copy.newChat).slice(0, 30));
      if (current !== requestEpoch.current) return;
      if (controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
      setConversation({ ...item, messages: [...item.messages, { id: "pending-user", role: "user", content: text }] });
      setPendingQuestion(null);
      localStorage.setItem(LAST_CHAT, item.id);
      setDraft("", item.id);
      dispatched = true;
      if (!fromVoice) setSourcePick(null);
      const receipt = fromVoice ? await transport.sendVoice!(item, text, controller.signal, (value) => {
        if (current === requestEpoch.current) setPartial(value);
      }) : research ? await transport.sendResearchPreview!(item, text, files, controller.signal, value => {
        if (current === requestEpoch.current) setPartial(value);
      }, { durable: researchPreview.features?.durableRuns === true, locale: language }) : await transport.send(item, text, files, controller.signal, (value) => {
        if (current === requestEpoch.current) setPartial(value);
      }, { ...(picked ? { sourcePassages: picked } : {}), onReceipt: receipt => {
        if (current === requestEpoch.current && !controller.signal.aborted) setSourceDelivery({ owner, id: item!.id, receipt });
      } });
      if (research) researchPreview.onSelectedChange(false);
      const restored = await transport.load(item.id);
      if (current !== requestEpoch.current) return;
      setConversation(restored); setPartial(null); setSourceDelivery(null);
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
      setPartial(value => value || null);
      const questionUnsent = (error as { questionPersisted?: boolean }).questionPersisted === false;
      if (!dispatched) setDraft(text);
      else if (questionUnsent) setDraft(text, item?.id ?? null);
      else if (research) researchPreview.onSelectedChange(false);
      setUncertain(dispatched && !questionUnsent); setError(mobileErrorText(error, language, dispatched ? copy.disconnected : copy.error));
      if (fromVoice) throw error;
      if (!dispatched || questionUnsent) return false;
    } finally { if (current === requestEpoch.current) { setStreaming(false); setPendingQuestion(null); } }
  }

  function newConversation() {
    if (streaming || reviewBusy || handoffBusy || configurationBusy || loading) return;
    setSourcePick(null); setSourceDelivery(null);
    if (product === "review") { sessionStorage.removeItem(REVIEW_HANDOFF_TARGET); setReviewOpen(undefined); setNewReviewRequest(value => value + 1); }
    else { requestEpoch.current++; setConversation(null); setPartial(null); setError(""); setUncertain(false); localStorage.removeItem(LAST_CHAT); }
    setView("chat");
  }
  async function compareInReview(messageId: string) {
    if (!conversation || streaming || reviewBusy || handoffBusy || configurationBusy || uncertain || loading) return;
    if (conversation.surface === "continuation") {
      if (!owner || !transport.prepareReviewHandoff) { setError(reviewContinuationHandoffCopy.unavailable); return; }
      const parent = conversation;
      const previous = handoffAttempt.current;
      const attempt = previous?.owner === owner && previous.parentId === parent.id && previous.assistantId === messageId
        ? previous : { owner, parentId: parent.id, assistantId: messageId, key: crypto.randomUUID() };
      handoffAttempt.current = attempt;
      const current = ++requestEpoch.current;
      setHandoffBusy(true); setError("");
      try {
        const result = await transport.prepareReviewHandoff(parent.id, { assistantMessageId: messageId, idempotencyKey: attempt.key });
        if (current !== requestEpoch.current || handoffAttempt.current !== attempt) return;
        setHandoffBusy(false); handoffAttempt.current = null; handoffOrigin.current = { owner, parentId: parent.id };
        sessionStorage.setItem(REVIEW_HANDOFF_TARGET, JSON.stringify({ owner, id: result.conversationId }));
        setReviewOpen({ id: result.conversationId, nonce: current }); setProduct("review"); setView("chat");
      } catch (error) {
        const refusal = error as { code?: string; status?: number };
        if (current === requestEpoch.current && handoffAttempt.current === attempt) setError(refusal.code?.includes("ATTACHMENT") ? reviewContinuationHandoffCopy.attachmentsUnsupported
          : refusal.code === "REVIEW_HANDOFF_ANSWER_NOT_COMPLETE" ? reviewContinuationHandoffCopy.completedOnly
          : refusal.code === "REVIEW_HANDOFF_QUESTION_TOO_LONG" ? reviewContinuationHandoffCopy.questionTooLong
          : refusal.code === "REVIEW_HANDOFF_MODE_UNSUPPORTED" ? reviewContinuationHandoffCopy.modeUnsupported
          : [403, 404, 423].includes(refusal.status ?? 0) ? reviewContinuationHandoffCopy.unavailable : reviewContinuationHandoffCopy.failed);
      } finally { if (current === requestEpoch.current && handoffAttempt.current === attempt) setHandoffBusy(false); }
      return;
    }
    const seed = reviewSeedFromChat(conversation.messages, messageId, mobileCompareInReviewCopy(language).context);
    if (!seed) return;
    setReviewOpen(undefined); handoffOrigin.current = null; sessionStorage.removeItem(REVIEW_HANDOFF_TARGET);
    preserveNativeDraft(owner, "review:new", seed);
    switchProduct("review");
  }
  function switchProduct(next: "chat" | "review") {
    if (next === product || streaming || reviewBusy || handoffBusy || configurationBusy || uncertain || loading) return;
    setSourcePick(null); setSourceDelivery(null);
    requestEpoch.current++;
    if (!reviewOpen?.id) setReviewOpen(undefined);
    setProduct(next); setView("chat"); setError("");
    if (next === "chat") {
      sessionStorage.removeItem(REVIEW_HANDOFF_TARGET);
      if (handoffOrigin.current?.owner !== owner || handoffOrigin.current.parentId !== conversation?.id) { setConversation(null); localStorage.removeItem(LAST_CHAT); }
      setPartial(null); setUncertain(false);
    }
  }
  function openSettings(tab: AccountSettingsTab = "account") { setView("chat"); setSettingsTab(tab); setSettings(true); }
  function openPlan() { openSettings("plan"); }
  function returnToWorkspace() { setSettings(false); setAccountOpen(false); setView("chat"); }
  const accountFooter = <SidebarAccount transport={transport} language={language} onSettings={() => openSettings()} onPlan={openPlan} />;

  function openIosPanel(panel: IosPanel) {
    if (streaming || loading || reviewBusy || uncertain) return;
    setIosEntry({ product, panel });
  }
  async function startIosAssistant(profile: { id: string }) {
    if (!iosEntry) throw Error("NATIVE_TOOLS_UNAVAILABLE");
    const origin = iosEntry.product, scope = requestEpoch.current;
    let item: Conversation;
    if (origin === "review") {
      if (!transport.createReview || !transport.mobileCapabilities) throw Error("REVIEW_UNAVAILABLE");
      const [catalog, preferences, capability] = await Promise.all([transport.models(), transport.preferences?.(), transport.mobileCapabilities()]);
      if (scope !== requestEpoch.current) throw Error("SIGN_IN_REQUIRED");
      const available = catalog.filter(model => canUseModelWithPlan(capability.plan, model));
      const selected = available.find(model => model.id === preferences?.defaultModel) ?? available[0];
      if (!selected) throw Error("MODEL_UNAVAILABLE");
      item = await transport.createReview([selected.id], profile.id);
    } else item = await transport.create(undefined, profile.id);
    const configured = item;
    if (scope !== requestEpoch.current) throw Error("SIGN_IN_REQUIRED");
    setProduct(origin); setView("chat"); setIosEntry(null);
    if (origin === "review") setReviewOpen({ id: configured.id, nonce: ++reviewRequestSequence.current });
    else { setConversation(configured); setPartial(null); setUncertain(configured.activeAttempt === true); localStorage.setItem(LAST_CHAT, configured.id); }
  }
  function seedIosWorkspace(text: string) {
    const origin = iosEntry?.product ?? product;
    setIosEntry(null);
    if (origin === "review") {
      preserveNativeDraft(owner, "review:new", text);
      setReviewOpen({ draft: text, nonce: ++reviewRequestSequence.current });
      return;
    }
    const target = conversation?.id ?? "new";
    preserveNativeDraft(owner, target, text); setDraft(text, target);
  }
  const [researchEngineOpen, setResearchEngineOpen] = useState(false);
  const [researchEngineAvailable, setResearchEngineAvailable] = useState(false);
  const [researchEngineOffer, setResearchEngineOffer] = useState<{ offered: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    if (!signedIn || !transport.researchEngineEnabled || !transport.researchEngine) return;
    void transport.researchEngineEnabled().then(async (enabled) => {
      if (!active) return;
      setResearchEngineAvailable(enabled);
      if (enabled) { const value = await transport.researchEngine!.offer().catch(() => null); if (active) setResearchEngineOffer(value as never); }
    }).catch(() => { if (active) setResearchEngineAvailable(false); });
    return () => { active = false; };
  }, [signedIn, owner, transport]);
  const iosExtraTools = [
    ...(signedIn && researchEngineAvailable && transport.researchEngine ? [{ label: researchEngineCopy[language].title, onSelect: () => setResearchEngineOpen(true) }] : []),
    { label: mobileIosWorkspaceCopy(language).assistants, onSelect: () => openIosPanel("assistants") },
    { label: mobileIosWorkspaceCopy(language).files, onSelect: () => openIosPanel("starters") },
    { label: mobileIosWorkspaceCopy(language).imports, onSelect: () => openIosPanel("imports") },
  ];

  const productSelector = <select data-testid="product-switcher" className="product-switcher" aria-label={workspaceCopy.product} value={product} disabled={streaming || reviewBusy || handoffBusy || uncertain} onChange={event => switchProduct(event.target.value as "chat" | "review")}><option value="chat">Chat</option><option value="review">Review</option></select>;

  const researchEngineSheet = researchEngineOpen && transport.researchEngine ? <DeepResearchEngineSheet open api={transport.researchEngine} language={language}
    conversationId={conversation?.id ?? null} draft={draft} offer={researchEngineOffer} onClose={() => setResearchEngineOpen(false)}
    onStarted={(id) => { setResearchEngineOpen(false); void open(id); }} /> : null;

  return <main className="mobile-app ios-workspace native-workspace" data-compact={compact || undefined} style={visibleHeight ? { height: visibleHeight } : undefined}>
    {researchEngineSheet}
    <header className="app-header" data-product-control={signedIn && compact && view === "chat" || undefined}>
      <button className="menu-button" aria-label={view === "list" ? navigationCopy.returnToChat : copy.chats} onClick={() => view === "list" ? returnToWorkspace() : setView("list")} disabled={!signedIn}>{view === "list" ? <ArrowLeft size={22} aria-hidden="true" /> : <><AppIcon name="menu" /><AppIcon name="menuDark" /></>}</button>
      <button type="button" className="brand-lockup" aria-label={navigationCopy.home} onClick={returnToWorkspace}><AppIcon name="logo" /><span className="wordmark tomverse-wordmark">tomverse<span className="tomverse-wordmark-dot">.</span></span></button>
      {signedIn && compact && view === "chat" && productSelector}
      {compact && (loading || reviewLoading) && <span className="workspace-loading" role="status"><span className="sr-only">{copy.loading}</span></span>}
      {signedIn ? <button className="header-new-chat" aria-label={copy.newChat} disabled={streaming || reviewBusy || loading} onClick={newConversation}><AppIcon name="newChat" /></button> : <button className="account-button" aria-label={copy.settings} onClick={() => openSettings()}><AppIcon name="settings" /></button>}
    </header>
    {signedIn && <IosNavigation importsEnabled={iosImportsEnabled} language={language} product={product} busy={streaming || loading || reviewBusy || uncertain} onProduct={next => { returnToWorkspace(); switchProduct(next); }} onPanel={openIosPanel} />}
    <NativeAppUpdate language={language} paused={loading || streaming || reviewBusy} />
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

    {!signedIn && loading && <span className="sign-in-progress workspace-loading" role="status"><span className="sr-only">{copy.loading}</span></span>}
    {error && <div role="alert" className="notice error">{error}</div>}
    {handoffBusy && <p role="status" className="notice">{reviewContinuationHandoffCopy.preparing}</p>}
    {!signedIn ? <section className="welcome">
      <div className="welcome-mark"><AppIcon name="logo" /></div><h1>{copy.welcome}</h1><p>{copy.intro}</p>
      <button className="primary" onClick={() => void signIn()} disabled={loading} aria-describedby="browser-sign-in-note">{copy.signIn} <span aria-hidden="true">→</span></button>
      <p id="browser-sign-in-note" className="browser-sign-in-note">{loginCopy.browserIntro}</p>
      {transport.requestEmailCode && transport.verifyEmailCode && <button type="button" className="sign-in-email" disabled={loading} onClick={() => { setError(""); setEmailLogin(true); }}>{loginCopy.inAppEmail}</button>}
    </section> : product === "review" ? <ReviewWorkspace key={`review:${owner}`} transport={transport} language={language} owner={owner} historyOpen={view === "list"} onCloseHistory={returnToWorkspace} onBusyChange={setReviewBusy} onLoadingChange={setReviewLoading} onProductChange={switchProduct} historyFooter={accountFooter} readChatDraft={readNewChatDraft} onContinueInChat={(text, expected): NativeChatDraftApply => {
      // Applies only to the new-Chat draft the user just confirmed: same owner and
      // sign-in generation, same text and files. Anything else asks again.
      const current = readNewChatDraft();
      if (!current || !owner) return "unavailable";
      if (!sameNativeChatDraft(current, expected)) return "changed";
      const next = appendNativeReviewChatDraft(current.text, text);
      if (next === null) return "tooLarge";
      sessionStorage.removeItem(REVIEW_HANDOFF_TARGET); setReviewOpen(undefined); handoffOrigin.current = null; handoffAttempt.current = null;
      requestEpoch.current++; setConversation(null); setPartial(null); setUncertain(false); setProduct("chat"); setView("chat");
      try { localStorage.removeItem(LAST_CHAT); } catch { /* Optional persistence. */ }
      setDraft(next, null);
      return "applied";
    }} newConversationRequest={newReviewRequest} conversationRequest={reviewOpen} extraTools={iosExtraTools} /> : view === "list" ? <ConversationListScreen title={copy.chats} newLabel={copy.newChat} disabled={streaming || loading} onNew={newConversation} footer={accountFooter}>
      <ConversationHistory transport={transport} language={language} owner={owner} chats={chats} currentId={conversation?.id} disabled={streaming || loading} onOpen={id => void open(id)} onRefresh={async () => {
        const scope = epoch.current; const rows = await transport.list();
        if (scope !== epoch.current) throw Error("SIGN_IN_REQUIRED");
        setChats(rows); setConversation(previous => previous ? { ...previous, title: rows.find(row => row.id === previous.id)?.title ?? previous.title } : null); return rows;
      }} onChanged={(id, deleted, locked) => { if ((deleted || locked) && conversation?.id === id) { requestEpoch.current++; setConversation(null); setPartial(null); setUncertain(false); localStorage.removeItem(LAST_CHAT); } }} />
    </ConversationListScreen> : <>
      <div className="native-chat-body">
      {conversation?.surface === "continuation" && <details className="ios-source-panel" open={sourceExpanded} onToggle={event => setSourceExpanded(event.currentTarget.open)}><summary>{mobileIosWorkspaceCopy(language).source}</summary><ImportedTranscript key={conversation.id} conversationId={conversation.id} imported={conversation.imported} transport={transport} language={language} selection={sourceSelection} /></details>}
      <section className="transcript" aria-label={conversation?.title ?? copy.newChat} aria-busy={streaming}>
        {/* A continuation is never a blank new chat: its original is its start. */}
        {conversation?.assistantProfileId && <IosAssistantBadge id={conversation.assistantProfileId} transport={transport} />}
        {!conversation?.messages.length && !streaming && conversation?.surface !== "continuation" && <IosWelcome importsEnabled={iosImportsEnabled} language={language} automatic={conversation ? conversation.selectionMode === "auto" && conversation.autoSelection?.offered === true : draftAutoOffered} imageEnabled={iosImageEnabled} onPanel={openIosPanel} onSeed={seedIosWorkspace} />}
        {conversation?.surface === "continuation" && !conversation.messages.length && !streaming && <div className="ios-continuation-start"><h2>{mobileIosWorkspaceCopy(language).disclosure}</h2><p>{mobileIosWorkspaceCopy(language).readOnly}</p><button onClick={() => setDraft(language === "ko" ? "지난 대화를 바탕으로 다음 할 일을 정리해줘." : "Based on our previous conversation, help me plan the next steps.")}>{language === "ko" ? "다음 할 일부터 정리해줘" : "Help me plan the next steps"}</button></div>}
        {pendingQuestion !== null && <article className="message user"><AnswerContent content={pendingQuestion} transport={transport} language={language} /></article>}
        {conversation?.messages.map((message) => <article key={message.id} className={`message ${message.role}`}>{message.role === "assistant" && <span className="message-label response-identity"><AppIcon name="logo" />Tomverse</span>}{message.researchEngineRun && message.researchRunId && conversation && transport.researchEngine ? <ResearchWorkspace api={transport.researchEngine} runId={message.researchRunId} conversationId={conversation.id} language={language} accountKey={owner ?? "native"} /> : message.researchRunId && conversation && transport.researchRuns && <ResearchPreviewRunCard
          runId={message.researchRunId} conversationId={conversation.id} assistantMessageId={message.id} language={language} transport={transport.researchRuns}
          reportOutcome={message.searchMetadata?.research?.outcome}
          onMessage={run => setConversation(item => item?.id === run.conversationId ? { ...item, messages: item.messages.map(existing => existing.id === run.assistantMessageId ? researchRunMessage(run) : existing) } : item)} />}
<AnswerContent copyable={message.role === "assistant"} content={message.content} imageTurn={message.imageTurn} artifacts={message.artifacts} onRevise={revisionDraft.prepare} citations={message.searchMetadata?.citations} transport={transport} language={language} />{message.continuationReceipt && <ContinuationReceipt receipt={message.continuationReceipt} t={sourceT} />}{message.role === "assistant" && ((reportable(message)) || comparable(message) || message.routedModelId || message.modelId) && <div className="answer-footer">{reportable(message) && <button type="button" className="answer-report" data-testid="answer-report" onClick={() => setReportFor({ messageId: message.id, modelId: message.modelId })}><AppIcon name="report" />{workspaceCopy.report}</button>}{comparable(message) && <button type="button" className="answer-report" data-testid="chat-compare-in-review" aria-label={mobileCompareInReviewCopy(language).aria} disabled={streaming || reviewBusy || handoffBusy || uncertain} onClick={() => void compareInReview(message.id)}>{mobileCompareInReviewCopy(language).label}</button>}<AnswerAttribution message={message} language={language} /></div>}{message.attachments?.map((file) => <span className="saved-attachment" key={file.id}><AppIcon name="file" />{file.name}</span>)}{["failed", "cancelled"].includes(message.status ?? "") && <p className="response-state">{workspaceCopy.failed}<button onClick={() => { const questions = conversation.messages.filter((item) => item.role === "user"); setDraft(questions.at(-1)?.content ?? ""); }}>{workspaceCopy.retry}</button></p>}</article>)}
        {partial !== null && <article className="message assistant"><span className="message-label response-identity"><AppIcon name="logo" />Tomverse</span><AnswerContent content={partial || copy.waiting} transport={transport} language={language} /><span className="stream-caret" aria-hidden="true" /></article>}
        {sourceDelivery?.owner === owner && sourceDelivery.id === conversation?.id && <ContinuationReceipt receipt={sourceDelivery.receipt} t={sourceT} />}
        {conversation && <VoiceHistory transport={transport} conversationId={conversation.id} revision={voiceRevision} language={language} />}
        <div ref={end} />
      </section>
      </div>
      {uncertain && conversation && <button className="restore" onClick={() => void open(conversation.id)}>{copy.restore} ↻</button>}
      <Composer researchPreview={researchPreview} extraTools={iosExtraTools} product="chat" onProductChange={switchProduct} productBusy={streaming || loading || handoffBusy || uncertain} productLoading={loading}
        selectionControl={<button type="button" className="model-trigger" disabled={streaming || loading || uncertain} onClick={() => setModelPicker(true)}><span>{conversation?.selectionMode === "auto" || (!conversation && draftAutoOffered) ? "Smart Adaptive" : getModel(conversation?.selectedModels[0] ?? "")?.name ?? workspaceCopy.model}</span><span aria-hidden="true">⌄</span></button>}
        locationIdentity={owner} files={revisionDraft.files} onFilesChange={revisionDraft.setFiles} onRemoveFile={revisionDraft.removeFile} onFileUploaded={revisionDraft.addFile} copy={copy} language={language} transport={transport} draft={draft} setDraft={setDraft} disabled={loading || handoffBusy || uncertain} offline={offline} streaming={streaming} conversation={conversation} onConfigureTools={configureTools} onSend={(text, files) => send(text, files, false, researchPreview.selected).then(result => result === false ? false : undefined)} onStop={() => abort.current?.abort()} voiceConversation={disabled => <VoiceConversation transport={transport} language={language} conversationId={conversation?.id ?? null} scopeKey={`${owner}:${signedIn}:${product}`} disabled={disabled} selectionLabel={conversation?.selectionMode === "auto" || (!conversation && draftAutoOffered) ? "Smart Adaptive" : conversation?.selectedModels[0] ?? "Tomverse"} searchEnabled={conversation ? conversation.webSearchMode === "always" : true} onSessionEnded={() => setVoiceRevision(value => value + 1)} onRequest={async text => { const receipt = await send(text, [], true); if (!receipt) throw Error("VOICE_ANSWER_FAILED"); return receipt; }} />} />
    </>}
    {iosEntry && signedIn && <IosWorkspacePanel key={`workspace:${owner}`} entry={iosEntry} language={language} transport={transport} imageEnabled={iosImageEnabled} onClose={() => setIosEntry(null)} onStartAssistant={startIosAssistant} onContinue={async id => { if (await open(id)) { setProduct("chat"); setIosEntry(null); } else throw Error("CONVERSATION_OPEN_FAILED"); }} onSeed={seedIosWorkspace} onSettings={tab => { setIosEntry(null); openSettings(tab); }} />}
    {modelPicker && <ModelSheet transport={transport} conversation={conversation} language={language} onClose={() => setModelPicker(false)} onApply={configureModel} />}
    {accountOpen && <Sheet title={mobileSettingsCopy(language).accountData} closeLabel={copy.close} onClose={() => setAccountOpen(false)} exitLabel={navigationCopy.returnToChat} onExit={returnToWorkspace}><button type="button" className="settings-detail-back" onClick={() => { setAccountOpen(false); openSettings("data"); }}><span aria-hidden="true">← </span>{mobileSettingsCopy(language).back}</button><AccountScreen transport={transport} language={language} onReauthenticate={() => void reauthenticate()} onDeleted={() => { setAccountOpen(false); clearNativeDrafts(); setOwner(null); setSignedIn(false); setConversation(null); setChats([]); localStorage.removeItem(LAST_CHAT); }} /></Sheet>}
    {!demo && <NativeLocationOnboarding language={language} />}
    {reportFor && signedIn && <Sheet title={workspaceCopy.report} closeLabel={copy.close} onClose={() => setReportFor(null)}><AnswerReport transport={transport} language={language} messageId={reportFor.messageId} modelId={reportFor.modelId} /></Sheet>}
    {settings && <Sheet className="settings-sheet" title={copy.settings} closeLabel={copy.close} onClose={() => setSettings(false)}><SettingsScreen transport={transport} signedIn={signedIn} language={language} theme={theme} initialTab={settingsTab} onLanguage={setLanguage} onTheme={setTheme} onAssistants={() => { setSettings(false); openIosPanel("assistants"); }} onImports={iosImportsEnabled ? () => { setSettings(false); openIosPanel("imports"); } : undefined} onAccount={() => { setSettings(false); setAccountOpen(true); }} onSignOut={() => void signOut()} /></Sheet>}

  </main>;
}
