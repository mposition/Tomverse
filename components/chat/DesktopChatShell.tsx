"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { useChatConsentSlotRef } from "@/components/analytics/AnalyticsProvider";
import { useSidebarCollapsePreference } from "@/components/chat/useSidebarCollapse";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatInput } from "@/components/chat/ChatInput";
import type { AttachmentsChangeHandler } from "@/components/chat/useConversationDrafts";
import type { AiModel } from "@/lib/models";
import { useComposerPortalHost } from "@/components/chat/useComposerPortalHost";
import { ChatWelcomeScreen } from "@/components/chat/ChatWelcomeScreen";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ProviderStatusBanner } from "@/components/chat/ProviderStatusBanner";
import {
  ComparisonActionRail,
  type AiReviewAccess,
} from "@/components/chat/ComparisonActionRail";
import type { ChatAttachmentCapabilities } from "@/lib/guestAttachmentPolicy";
import { GuestVerificationDesktopSlot } from "@/components/chat/GuestVerificationDesktopSlot";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { deriveComparisonReadiness } from "@/lib/comparisonReadiness";
import {
  deriveDeepResearchSuggestion,
  type DeepResearchAvailability,
  type DeepResearchSuggestionTurn,
} from "@/lib/deepResearchSuggestion";
import { DeepResearchSuggestionCard } from "@/components/chat/DeepResearchSuggestionCard";
import type { DeepResearchSuggestionCopy } from "@/components/chat/deepResearchSuggestionCopy";
import {
  deriveWebSearchSuggestion,
  type WebSearchSuggestionState,
  type WebSearchSuggestionTurn,
  type WebSearchTopicSignal,
} from "@/lib/webSearchRetrySuggestion";
import { WebSearchSuggestionCard } from "@/components/chat/WebSearchSuggestionCard";
import { arbitrateWebSearchOffer } from "@/lib/answerSuggestionArbitration";
import type { WebSearchSuggestionCopy } from "@/components/chat/webSearchSuggestionCopy";
import {
  chatContentStateKey,
  resolveChatContentState,
  type ChatContentState,
} from "@/lib/chatContentState";
import {
  chatModelStatusKey,
  isConversationResponding,
  scopeModelStatusesToConversation,
  type ModelRuntimeStatus,
} from "@/lib/chatRuntimeStatus";
import { useGuestChatContentSeed } from "@/components/chat/useGuestChatContentSeed";
import { englishCreditUnit, formatCountedUnit } from "@/lib/pricingFormat";
import {
  getModelUsageProfile,
  type ChatAttachment,
  type Conversation,
} from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";
import type {
  ChatAssistantProfile,
  ChatAssistantProfileOption,
} from "@/lib/conversationProfileBinding";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import type { ConversationMemoryMode } from "@/lib/conversationMemoryMode";
import type { WebSearchMode } from "@/lib/appDefaults";

const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

type PromptPayload = {
  id: string;
  text: string;
  chatId: string;
  userMessageId: string;
  /** The models this send was made for; other panels must not consume it. */
  modelIds: string[];
  attachments: ChatAttachment[];
  deepResearchDepth?: "quick" | "standard" | "deep";
  admissionToken?: string | null;
  contextBundle?: string | null;
  contextLayout?: "single" | "comparison";
};

type DesktopChatShellProps = {
  conversations: Conversation[];
  currentChatId: string | null;
  selectedModels: string[];
  disabledPanels: string[];
  promptPayload: PromptPayload | null;
  inputValue: string;
  setInputValue: (value: string) => void;
  personalizedPrompt?: string | null;
  attachments: ChatAttachment[];
  setAttachments: AttachmentsChangeHandler;
  focusToken: number;
  isGuestMode: boolean;
  /** What this caller may do with the AI cross-review. */
  aiReviewAccess: AiReviewAccess;
  /** What this caller may do with file attachments. */
  attachmentCapabilities: ChatAttachmentCapabilities;
  /** Passed straight through to the composer; see ChatInput's own prop. */
  voiceInputEnabled?: boolean;
  /** Passed straight through to the composer; see ChatInput's own prop. */
  onVoiceTranscript?: (transcript: string, scopeId: string | null) => void;
  /** Passed straight through to the composer; see ChatInput's own prop. */
  /** Who this tab is; see ChatInput's prop of the same name. */
  identityKey: string | null;
  guestPreviewMode?: boolean;
  guestMessageCount: number;
  maxGuestMessages: number;
  isModelSelectionReady: boolean;
  /**
   * Whether the page has finished deciding which conversation is active.
   * Distinct from `isModelSelectionReady`, which is unconditionally true for
   * guests: a guest conversation is restored from localStorage after mount,
   * so until this flips there is no conversation to call empty or not.
   */
  isConversationSelectionResolved: boolean;
  /**
   * A send this page has started but not yet handed to the panels, and the
   * conversation it started from. Only the content-state derivation reads
   * it; it decides nothing about credits, preflight or admission.
   */
  pendingSubmission: { originConversationId: string | null } | null;
  onNewChat: () => void;
  onNewImage?: (() => void) | null;
  /** Set when image generation is visible to this viewer but not usable. */
  imageLock?: "sign_in" | "upgrade" | null;
  onLockedImageClick?: (lock: "sign_in" | "upgrade") => void;
  onStartImageDraft?: (draftText: string, modelId?: string) => void;
  imageWorkspace?: React.ReactNode;
  onSelectConversation: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onLock: (id: string, password: string) => void;
  onUnlock: (id: string) => void;
  onShare: (id: string, title: string) => void;
  onRevokeShare: (id: string) => void;
  onDownload: (id: string, title: string) => void;
  onToggleModel: (modelId: string) => boolean;
  onSwapModel: (removeModelId: string, addModelId: string) => boolean;
  /** Threaded to the composer; see `ChatInput`'s own prop docs. */
  modelSwapRequest?: AiModel | null;
  onModelSwapRequestResolved?: (swapped: boolean) => void;
  /** Plan/guest entitlement check, so the outage banner never offers a swap this viewer cannot run. */
  canSelectModel?: (modelId: string) => boolean;
  webSearchMode: WebSearchMode;
  onWebSearchModeChange: (mode: WebSearchMode) => void;
  memoryMode?: ConversationMemoryMode;
  /**
   * Auto model selection (UI contract auto-model-selection.md §1). Passed
   * straight through to the composer's model picker; this shell makes no
   * decision about it, because `offered` already folds the flag, the
   * conversation's product and cohort eligibility together on the server.
   */
  autoSelectionOffered?: boolean;
  selectionMode?: "manual" | "auto";
  selectionModePending?: boolean;
  onSelectionModeChange?: (next: boolean) => void;
  /** §14. Passed straight through to the composer's tools menu. */
  assistantProfile?: ChatAssistantProfile | null;
  /** ISO time this conversation's assistant was deleted, if it was. */
  assistantProfileRemovedAt?: string | null;
  assistantProfileOptions?: ChatAssistantProfileOption[];
  onAssistantProfileChange?: (profileId: string | null) => void;
  onMemoryModeChange?: (mode: ConversationMemoryMode) => void;
  accountMemoryDefault?: "on" | "off";
  onOpenDeepResearchSetup: () => void;
  isDeepResearchPending: boolean;
  onDismissDeepResearchChip: () => void;
  /*
    The Deep Research expansion offer (lib/deepResearchSuggestion.ts).

    The page supplies the question, the viewer's access and what has already
    been settled; the *statuses* are this shell's, because the panels report
    here. So the decision is made below with `deriveDeepResearchSuggestion`,
    exactly as `deriveComparisonReadiness` is -- one rule module, two shells,
    no chance of the card appearing on one and not the other.
  */
  deepResearchSuggestionTurn: DeepResearchSuggestionTurn | null;
  deepResearchAvailability: DeepResearchAvailability;
  deepResearchResolvedTopicKeys: readonly string[];
  deepResearchOfferedTopics: readonly { topicKey: string; promptId: string }[];
  onDeepResearchSuggestionShown: (offer: {
    topicKey: string;
    promptId: string;
  }) => void;
  deepResearchSuggestionCopy: DeepResearchSuggestionCopy;
  isDeepResearchExpanding: boolean;
  onDeepResearchSuggestionExpand: (turn: {
    conversationId: string;
    text: string;
  }) => void;
  onDeepResearchSuggestionDismiss: (turn: {
    conversationId: string;
    text: string;
  }) => void;
  /*
    The web-search offer (lib/webSearchRetrySuggestion.ts).

    Same division of labour as the Deep Research offer directly above: the page
    holds the question, the access and the bookkeeping; this shell holds the
    panel status map that says whether the answers are finished. So the page
    passes what it knows and `deriveWebSearchSuggestion` below decides, which
    is what stops desktop and mobile drifting into different rules for the same
    card.
  */
  webSearchSuggestionTurn: WebSearchSuggestionTurn | null;
  webSearchAvailability: "available" | "unsupported" | "blocked";
  /** A re-run of this question failed, and how. Null when none has. */
  webSearchRetryFailure: "error" | "blocked" | null;
  webSearchResolvedTopicKeys: readonly string[];
  webSearchOfferedTopics: readonly { topicKey: string; promptId: string }[];
  isWebSearchRetrying: boolean;
  onWebSearchSuggestionShown: (offer: {
    topicKey: string;
    promptId: string;
    state: WebSearchSuggestionState;
    reason: WebSearchTopicSignal | null;
  }) => void;
  /** The card's strings for one state; see ChatPageClient for why it is a function. */
  webSearchSuggestionCopyFor: (
    state: WebSearchSuggestionState
  ) => WebSearchSuggestionCopy;
  onWebSearchSuggestionConfirm: (turn: {
    conversationId: string;
    text: string;
    state: WebSearchSuggestionState;
    reason: WebSearchTopicSignal | null;
  }) => void;
  onWebSearchSuggestionDismiss: (turn: {
    conversationId: string;
    text: string;
    state: WebSearchSuggestionState;
    reason: WebSearchTopicSignal | null;
  }) => void;
  onSubmit: () => void;
  onBeforeModelSend: (chatId: string) => Promise<boolean>;
  onChangePanelModel: (oldModelId: string, newModelId: string) => void;
  onTogglePanelDisable: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onCompareSummary: () => void;
  isCompareSummaryLoading: boolean;
  isQuickSummaryCached?: boolean;
  availableCredits?: number | null;
  onComparisonReview: () => void;
  onGuestSignInPrompt: () => void;
  onResponseComplete: (promptId: string | null, modelId: string, responseText: string) => void;
  /** A panel's turn ended in an error. Forwarded straight to the page. */
  onTurnError: (
    promptId: string | null,
    modelId: string,
    errorCode: string
  ) => void;
  onFollowupSent: (modelId: string) => void;
  /**
   * Re-prepares the §10 context for a whole run after a panel's bundle was
   * refused for drift. Passed straight through: the shell knows which models
   * are in the run, and the coordination that keeps them on one snapshot
   * belongs to whoever owns the send.
   */
  onContextBundleStale?: (input: {
    promptId: string | null;
    modelId: string;
  }) => Promise<string | null>;
};

export function DesktopChatShell({
  conversations,
  currentChatId,
  selectedModels,
  disabledPanels,
  promptPayload,
  inputValue,
  setInputValue,
  personalizedPrompt,
  attachments,
  setAttachments,
  focusToken,
  isGuestMode,
  aiReviewAccess,
  attachmentCapabilities,
  voiceInputEnabled = false,
  onVoiceTranscript,
  identityKey,
  guestPreviewMode = false,
  guestMessageCount,
  maxGuestMessages,
  isModelSelectionReady,
  isConversationSelectionResolved,
  pendingSubmission,
  onNewChat,
  onNewImage,
  imageLock,
  onLockedImageClick,
  onStartImageDraft,
  imageWorkspace,
  onSelectConversation,
  onRename,
  onDelete,
  onLock,
  onUnlock,
  onShare,
  onRevokeShare,
  onDownload,
  onToggleModel,
  onSwapModel,
  modelSwapRequest = null,
  onModelSwapRequestResolved,
  canSelectModel,
  webSearchMode,
  onWebSearchModeChange,
  memoryMode,
  autoSelectionOffered,
  selectionMode,
  selectionModePending,
  onSelectionModeChange,
  assistantProfile,
  assistantProfileRemovedAt,
  assistantProfileOptions,
  onAssistantProfileChange,
  onMemoryModeChange,
  accountMemoryDefault,
  onOpenDeepResearchSetup,
  isDeepResearchPending,
  onDismissDeepResearchChip,
  deepResearchSuggestionTurn,
  deepResearchAvailability,
  deepResearchResolvedTopicKeys,
  deepResearchOfferedTopics,
  onDeepResearchSuggestionShown,
  deepResearchSuggestionCopy,
  isDeepResearchExpanding,
  onDeepResearchSuggestionExpand,
  onDeepResearchSuggestionDismiss,
  webSearchSuggestionTurn,
  webSearchAvailability,
  webSearchRetryFailure,
  webSearchResolvedTopicKeys,
  webSearchOfferedTopics,
  isWebSearchRetrying,
  onWebSearchSuggestionShown,
  webSearchSuggestionCopyFor,
  onWebSearchSuggestionConfirm,
  onWebSearchSuggestionDismiss,
  onSubmit,
  onBeforeModelSend,
  onChangePanelModel,
  onTogglePanelDisable,
  onRemoveModel,
  onCompareSummary,
  isCompareSummaryLoading,
  isQuickSummaryCached = false,
  availableCredits = null,
  onComparisonReview,
  onGuestSignInPrompt,
  onResponseComplete,
  onTurnError,
  onFollowupSent,
  onContextBundleStale,
}: DesktopChatShellProps) {
  const {
    models: AVAILABLE_MODELS,
    enabledModels: ENABLED_MODELS,
  } = useModelCatalog();
  const { t, lang } = useLanguage();
  const recentConversations = useMemo(
    () =>
      conversations
        // The chat you are already in is not a chat to return to -- a brand
        // new guest conversation exists from the first render, and offering it
        // back to the user was both meaningless and (on mobile) the only thing
        // keeping the recent-chats row on screen for someone with no history.
        .filter(
          (conversation) =>
            !conversation.isLocked && conversation.id !== currentChatId
        )
        .slice(0, 3)
        .map((conversation) => ({ id: conversation.id, title: conversation.title })),
    [conversations, currentChatId]
  );
  // Identity of the conversation currently on screen, used to scope
  // per-conversation UI state (the active tab below).
  const conversationStateKey = currentChatId || "new";
  const [modelContentStates, setModelContentStates] = useState<
    Record<string, ChatContentState>
  >({});
  const handleContentStateChange = useCallback(
    (modelId: string, state: ChatContentState) => {
      const key = chatContentStateKey(currentChatId, modelId);
      setModelContentStates((current) =>
        current[key] === state ? current : { ...current, [key]: state }
      );
    },
    [currentChatId]
  );
  // "Is this conversation empty" has three answers, not two, and only one of
  // them may render the welcome screen. See lib/chatContentState.ts: the
  // shell used to default an unreported panel to "empty", which flashed the
  // welcome screen over every conversation that was still loading and over
  // every send that adopted a new conversation id.
  const guestContentSeed = useGuestChatContentSeed(isGuestMode, currentChatId);
  const conversationContentState = resolveChatContentState({
    isConversationSelectionResolved,
    conversationId: currentChatId,
    selectedModelIds: selectedModels,
    reported: modelContentStates,
    // An accepted send has put a user turn in this conversation, so it can
    // never read as empty again -- not even in the window before its panels
    // have re-reported under the new conversation id.
    hasAcceptedSubmission: Boolean(
      promptPayload && currentChatId && promptPayload.chatId === currentChatId
    ),
    storedSeed: guestContentSeed,
    pendingSubmission,
  });
  const isConversationEmpty = conversationContentState === "empty";
  // Keyed by (conversation, model), never by model alone: a run started in one
  // conversation used to disable the composer of every other one, because a
  // model id says nothing about where it was running. See
  // lib/chatRuntimeStatus.ts -- the report keeps its own conversation, and the
  // run itself keeps going (lib/chatStreamRuntime.ts).
  const [reportedModelStatuses, setReportedModelStatuses] = useState<
    Record<string, ModelRuntimeStatus>
  >({});
  const handleModelStatusChange = useCallback(
    (
      modelId: string,
      nextStatus: ModelRuntimeStatus,
      conversationId: string | null
    ) => {
      const key = chatModelStatusKey(conversationId, modelId);
      setReportedModelStatuses((current) =>
        current[key] === nextStatus ? current : { ...current, [key]: nextStatus }
      );
    },
    []
  );
  // What every consumer below reads: this conversation's currently selected
  // models and nothing else. A model dropped from the selection stops counting
  // immediately rather than when it next reports, and a model still answering
  // in another conversation is simply not in here.
  const modelStatuses = useMemo(
    () =>
      scopeModelStatusesToConversation({
        statuses: reportedModelStatuses,
        conversationId: currentChatId,
        selectedModelIds: selectedModels,
      }),
    [currentChatId, reportedModelStatuses, selectedModels]
  );
  // Bumped to abort every currently-responding panel at once ("stop all").
  // A counter, not a boolean, so a second click still re-triggers each
  // ChatApp panel's abort effect even though the value it flips from/to
  // would otherwise look unchanged.
  const [stopSignal, setStopSignal] = useState(0);
  // Only a run this conversation's own, un-paused panels are performing may
  // hold this composer -- and only those panels are what the stop button then
  // stops. A background answer in a conversation the user left keeps running,
  // shows its own state when they return, and has no say here.
  const isAnyModelResponding = isConversationResponding({
    statuses: modelStatuses,
    selectedModelIds: selectedModels,
    disabledModelIds: disabledPanels,
  });
  // A quick-comparison summary needs at least two models that have actually
  // finished responding (not still streaming, not paused/off) -- the
  // request only ever counted selectedModels.length > 1 and an otherwise
  // non-empty conversation, so the button was clickable the instant a
  // message was sent, well before any model had a real answer to compare.
  // Both shells now read that from the same derivation, which also supplies
  // the sentence explaining the state.
  const comparisonReadiness = deriveComparisonReadiness({
    selectedModelIds: selectedModels,
    disabledModelIds: disabledPanels,
    modelStatuses,
    hasComparableConversation: !isConversationEmpty && Boolean(currentChatId),
    isBusy: isCompareSummaryLoading,
  });
  // The expansion offer, decided from the same status map the rail reads.
  const deepResearchSuggestion = deriveDeepResearchSuggestion({
    conversationId: currentChatId,
    turn: deepResearchSuggestionTurn,
    selectedModelIds: selectedModels,
    disabledModelIds: disabledPanels,
    modelStatuses,
    availability: deepResearchAvailability,
    isDeepResearchRunning: isDeepResearchPending,
    resolvedTopicKeys: deepResearchResolvedTopicKeys,
    offeredTopics: deepResearchOfferedTopics,
  });
  /*
    Reported the moment the card is on screen, so "already offered" is a fact
    about what was shown rather than about what was sent. The page records it
    against this question's own id, which is what keeps the entry from
    refusing the card that wrote it.
  */
  const offeredTopicKey = deepResearchSuggestion.offered
    ? deepResearchSuggestion.topicKey
    : null;
  const offeredPromptId = deepResearchSuggestion.offered
    ? deepResearchSuggestion.promptId
    : null;
  useEffect(() => {
    if (!offeredTopicKey || !offeredPromptId) return;
    onDeepResearchSuggestionShown({
      topicKey: offeredTopicKey,
      promptId: offeredPromptId,
    });
  }, [offeredPromptId, offeredTopicKey, onDeepResearchSuggestionShown]);
  /*
    The web-search offer, decided from the same status map the rail and the
    expansion offer read.
  */
  const webSearchSuggestionForTurn = deriveWebSearchSuggestion({
    conversationId: currentChatId,
    turn: webSearchSuggestionTurn,
    selectedModelIds: selectedModels,
    disabledModelIds: disabledPanels,
    modelStatuses,
    availability: webSearchAvailability,
    retryFailure: webSearchRetryFailure,
    resolvedTopicKeys: webSearchResolvedTopicKeys,
    offeredTopics: webSearchOfferedTopics,
  });
  /*
    A question can satisfy both offers -- recency and a depth signal together --
    and Deep Research outranks this one when it does
    (lib/answerSuggestionArbitration.ts).

    Applied here and not at the render site: the impression effect below writes
    `offeredTopics`, and a card that was never drawn must not be recorded as
    having been offered, or a later turn refuses the offer for a question nobody
    was asked about.
  */
  const webSearchSuggestion = arbitrateWebSearchOffer({
    webSearch: webSearchSuggestionForTurn,
    deepResearch: deepResearchSuggestion,
    retryFailure: webSearchRetryFailure,
  });
  /*
    The strongest signal, and only that one. The classifier reports every
    signal that fired; the impression event carries one, because a set of fixed
    identifiers beside a timestamp is closer to an identifier than a single one
    is (lib/productAnalyticsShared.ts). Ordered as the classifier lists them --
    what the person said, then what the wording implies, then the category.
  */
  const webSearchOfferReason: WebSearchTopicSignal | null =
    webSearchSuggestion.signals.find(
      (signal) => signal === "explicit_search_request"
    ) ??
    webSearchSuggestion.signals.find((signal) => signal === "recency") ??
    webSearchSuggestion.signals[0] ??
    null;
  const webSearchOfferedTopicKey = webSearchSuggestion.offered
    ? webSearchSuggestion.topicKey
    : null;
  const webSearchOfferedPromptId = webSearchSuggestion.offered
    ? webSearchSuggestion.promptId
    : null;
  const webSearchOfferedState = webSearchSuggestion.state;
  useEffect(() => {
    if (!webSearchOfferedTopicKey || !webSearchOfferedPromptId) return;
    if (!webSearchOfferedState) return;
    onWebSearchSuggestionShown({
      topicKey: webSearchOfferedTopicKey,
      promptId: webSearchOfferedPromptId,
      state: webSearchOfferedState,
      reason: webSearchOfferReason,
    });
  }, [
    onWebSearchSuggestionShown,
    webSearchOfferReason,
    webSearchOfferedPromptId,
    webSearchOfferedState,
    webSearchOfferedTopicKey,
  ]);
  // The answer canvas, handed to the composer as a drop target. Held in state
  // rather than in a ref so the composer re-registers its listeners when the
  // element appears, and loses them when an image conversation replaces the
  // whole chat surface (docs/policy/image-generation.md §1) and this branch
  // stops rendering.
  const [conversationDropSurface, setConversationDropSurface] =
    useState<HTMLDivElement | null>(null);
  const [welcomeInputSlot, setWelcomeInputSlot] = useState<HTMLDivElement | null>(null);
  const [bottomInputSlot, setBottomInputSlot] = useState<HTMLDivElement | null>(null);
  const inputPortalTarget = isConversationEmpty
    ? welcomeInputSlot ?? bottomInputSlot
    : bottomInputSlot ?? welcomeInputSlot;
  // STG-F003: portal into a host we move between the two slots, never into
  // the slots themselves -- switching containers would rebuild the composer
  // and drop whatever the user had just typed into it.
  const composerPortalHost = useComposerPortalHost(inputPortalTarget);
  // Mirrors inputPortalTarget above: the composer (and so the consent
  // notice slot right next to it) lives in one of two DOM positions
  // depending on whether the welcome screen is showing.
  const [welcomeConsentSlot, setWelcomeConsentSlot] = useState<HTMLDivElement | null>(null);
  const [bottomConsentSlot, setBottomConsentSlot] = useState<HTMLDivElement | null>(null);
  const consentSlotTarget = isConversationEmpty
    ? welcomeConsentSlot ?? bottomConsentSlot
    : bottomConsentSlot ?? welcomeConsentSlot;
  const registerChatConsentSlot = useChatConsentSlotRef();
  useEffect(() => {
    registerChatConsentSlot(consentSlotTarget);
    return () => registerChatConsentSlot(null);
  }, [consentSlotTarget, registerChatConsentSlot]);

  // STG-F002: at tablet/split-screen widths, an always-expanded 320px
  // sidebar plus N side-by-side panels can leave each panel with nowhere
  // near enough room for its model name/controls. Both layout decisions
  // below are driven by content width (viewport width, minus the sidebar's
  // own known fixed widths, minus chrome padding/gaps, divided by the
  // selected model count) rather than a single breakpoint -- so the same
  // math that decides collapsing the sidebar also decides falling back to
  // tabs, and both react correctly to browser zoom (window.innerWidth
  // shrinks in CSS px as zoom increases) as well as to the model count
  // changing. Auto-collapsing the sidebar is tried first (recovering
  // SIDEBAR_EXPANDED_WIDTH - SIDEBAR_COLLAPSED_WIDTH of extra room); tabs
  // only kick in if that alone still isn't enough, matching the requested
  // priority order.
  const SIDEBAR_EXPANDED_WIDTH = 320;
  const SIDEBAR_COLLAPSED_WIDTH = 64;
  const CONTENT_PADDING = 32; // px-4 on both the sidebar's sibling section and the panel row
  const PANEL_GAP = 16; // gap-4 between panels
  const MIN_PANEL_WIDTH = 310; // keeps the model name/select area >= 120px usable

  const [viewportWidth, setViewportWidth] = useState<number>(
    () => window.innerWidth
  );
  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  const [sidebarCollapsePreference] = useSidebarCollapsePreference();
  const perModelWidth = useCallback(
    (sidebarWidth: number) => {
      if (selectedModels.length === 0) return Infinity;
      const contentWidth = viewportWidth - sidebarWidth - CONTENT_PADDING;
      return (
        (contentWidth - PANEL_GAP * (selectedModels.length - 1)) /
        selectedModels.length
      );
    },
    [viewportWidth, selectedModels.length]
  );
  const autoCollapseSuggested =
    selectedModels.length > 1 &&
    perModelWidth(SIDEBAR_EXPANDED_WIDTH) < MIN_PANEL_WIDTH;
  const isSidebarCollapsed =
    sidebarCollapsePreference === "collapsed" ||
    (sidebarCollapsePreference === "auto" && autoCollapseSuggested);
  const useTabsLayout =
    selectedModels.length > 1 &&
    perModelWidth(isSidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH) <
      MIN_PANEL_WIDTH;

  const [activeModelId, setActiveModelId] = useState<string | null>(
    selectedModels[0] || null
  );
  // The active tab is scoped to the current conversation: switching to a
  // different conversation (even one that happens to share a model with
  // whatever tab was active before) must re-anchor to that conversation's
  // first model rather than silently keeping the previous tab selected just
  // because that model id still happens to be a member of the new list.
  const [activeModelChatKey, setActiveModelChatKey] = useState(conversationStateKey);
  if (activeModelChatKey !== conversationStateKey) {
    setActiveModelChatKey(conversationStateKey);
    setActiveModelId(selectedModels[0] || null);
  }
  const resolvedActiveModelId =
    activeModelId && selectedModels.includes(activeModelId)
      ? activeModelId
      : selectedModels[0] || null;
  const activeModelIndex = resolvedActiveModelId
    ? selectedModels.indexOf(resolvedActiveModelId)
    : -1;
  // Roving tabindex per the WAI-ARIA tabs pattern: only the active tab is
  // in the Tab order, and arrow keys move both selection and focus. Focus
  // is moved imperatively inside these handlers (not via an effect keyed
  // on the active id) so it only happens in response to an actual
  // keyboard/click interaction, never on mount or on an ambient re-render
  // (e.g. resizing into tabs layout for the first time).
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activateModel = useCallback((modelId: string, focus: boolean) => {
    setActiveModelId(modelId);
    if (focus) tabRefs.current[modelId]?.focus();
  }, []);
  const switchModelByOffset = useCallback(
    (offset: number) => {
      if (selectedModels.length < 2 || activeModelIndex < 0) return;
      const nextIndex =
        (activeModelIndex + offset + selectedModels.length) %
        selectedModels.length;
      activateModel(selectedModels[nextIndex], true);
    },
    [activateModel, activeModelIndex, selectedModels]
  );
  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        switchModelByOffset(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        switchModelByOffset(-1);
      } else if (event.key === "Home") {
        event.preventDefault();
        if (selectedModels[0]) activateModel(selectedModels[0], true);
      } else if (event.key === "End") {
        event.preventDefault();
        const last = selectedModels[selectedModels.length - 1];
        if (last) activateModel(last, true);
      }
    },
    [activateModel, selectedModels, switchModelByOffset]
  );

  return (
    <main
      data-testid="desktop-chat-shell"
      // Observable so a regression test can assert on the state machine itself
      // -- "unknown" must never be rendered as the welcome screen -- rather
      // than only on what happened to be painted when it looked.
      data-content-state={conversationContentState}
      className="flex h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <ChatSidebar
        conversations={conversations}
        currentChatId={currentChatId}
        onNewChat={onNewChat}
        onNewImage={onNewImage ?? null}
        imageLock={imageLock ?? null}
        onLockedImageClick={onLockedImageClick}
        onSelectConversation={onSelectConversation}
        onRename={onRename}
        onDelete={onDelete}
        isGuestMode={isGuestMode}
        guestMessageCount={guestMessageCount}
        maxGuestMessages={maxGuestMessages}
        onLock={onLock}
        onUnlock={onUnlock}
        onShare={onShare}
        onRevokeShare={onRevokeShare}
        onDownload={onDownload}
        currentModelId={selectedModels[0]}
        attachmentCount={attachments.length}
        autoCollapseSuggested={autoCollapseSuggested}
      />

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/*
          An image conversation replaces the entire chat surface -- panels,
          welcome overlay, comparison rail and composer are all chat-only
          (docs/policy/image-generation.md §1). The sidebar above stays, so
          navigation between chat and image conversations is one list.
        */}
        {imageWorkspace ? (
          <div
            data-testid="desktop-image-workspace"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {imageWorkspace}
          </div>
        ) : (
          <>
        <ProviderStatusBanner
          selectedModels={selectedModels}
          compact
          onSwapModel={onSwapModel}
          canSelectModel={canSelectModel}
        />
        {/*
          UI-P1-05. The tab bar used to be suppressed while the conversation
          was empty, on the reasoning that the welcome screen covers the panels
          anyway so there is nothing to switch between. But panel visibility is
          decided by `useTabsLayout` alone: at 768-1024px two of the three
          panels are already `display:none` and `aria-hidden` before a single
          message exists. With the tab bar hidden as well, nothing on screen
          named them -- the composer said "3 models" while two of the three
          were neither identifiable nor reachable, by pointer or by keyboard.
          At >=1058px all three panels render side by side, so the same empty
          state never had the problem there, which is why it went unnoticed.

          The tab bar is the thing that already names every selected model,
          carries the WAI-ARIA roving tabindex, and offers per-model removal.
          Showing it whenever the tabs layout is in force -- empty or not --
          is the smallest change that makes the selection legible, and it
          costs nothing at the widths that render all three panels.
        */}
        {useTabsLayout && (
          <div
            role="tablist"
            aria-label={t("chat.compareTabsLabel")}
            data-testid="model-compare-tablist"
            className="flex shrink-0 snap-x snap-mandatory gap-1.5 overflow-x-auto border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950"
          >
            {selectedModels.map((modelId) => {
              const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
              const isActive = modelId === resolvedActiveModelId;
              const isPanelDisabled = disabledPanels.includes(modelId);
              const status = isPanelDisabled
                ? "paused"
                : modelStatuses[modelId] || "idle";
              return (
                <div
                  key={modelId}
                  className={`flex min-w-[228px] shrink-0 snap-start items-center rounded-xl border transition ${
                    isActive
                      ? "border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30"
                      : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  } ${isPanelDisabled ? "opacity-50" : ""}`}
                >
                  <button
                    ref={(node) => {
                      tabRefs.current[modelId] = node;
                    }}
                    type="button"
                    role="tab"
                    id={`model-tab-${modelId}`}
                    aria-selected={isActive}
                    aria-controls={`model-tabpanel-${modelId}`}
                    tabIndex={isActive ? 0 : -1}
                    data-testid="model-compare-tab"
                    data-model-id={modelId}
                    onClick={() => activateModel(modelId, false)}
                    onKeyDown={handleTabKeyDown}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                  >
                    <ModelLogo model={model} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-bold text-zinc-800 dark:text-zinc-100">
                        {model?.name || modelId}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                        {model?.provider}
                      </span>
                    </span>
                    {status === "responding" || status === "loading" ? (
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
                    ) : status === "error" ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                    ) : status === "paused" ? (
                      <span className="shrink-0 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">OFF</span>
                    ) : status === "idle" ? (
                      <Check className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden="true" />
                    ) : null}
                  </button>
                  {selectedModels.length > 1 && (
                    <button
                      type="button"
                      data-testid="model-compare-tab-remove"
                      aria-label={t("chat.removeModelFromComparison")}
                      onClick={() => onRemoveModel(modelId)}
                      className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div
          ref={setConversationDropSurface}
          data-testid="desktop-conversation-surface"
          className="relative flex min-h-0 flex-1 gap-4 overflow-hidden bg-zinc-100/80 px-4 pb-4 pt-3 dark:bg-zinc-950"
        >
          {isConversationEmpty && (
            // UI-EMPTY-001. The light overlay has always been translucent, so
            // the three comparison panels stay legible behind the welcome
            // screen and the first screen still reads as a comparison
            // product. Dark was opaque, which erased that structure entirely.
            // Matching the light alpha is the smallest change that restores
            // it; the welcome text sits on its own surfaces inside
            // ChatWelcomeScreen, so its contrast is unaffected either way.
            <div className="absolute inset-0 z-10 bg-zinc-100/80 dark:bg-zinc-950/80">
              <ChatWelcomeScreen
                recentConversations={recentConversations}
                onSelectConversation={onSelectConversation}
                inputSlotRef={setWelcomeInputSlot}
                consentSlotRef={setWelcomeConsentSlot}
              />
            </div>
          )}
          {selectedModels.length === 0 && (
            <div className="flex flex-1 select-none flex-col items-center justify-center text-zinc-500">
              <div className="mb-4 text-4xl opacity-50">AI</div>
              <p className="text-sm font-medium">{t("chat.inactivePanel")}</p>
              <p className="mt-1 text-xs opacity-70">{t("chat.chooseModel")}</p>
            </div>
          )}

          {selectedModels.map((modelId, panelIndex) => {
            const modelInfo = AVAILABLE_MODELS.find((model) => model.id === modelId);
            const usageProfile = modelInfo
              ? getModelUsageProfile(modelInfo)
              : null;
            const isPanelDisabled = disabledPanels.includes(modelId);
            const isPanelVisible = !useTabsLayout || modelId === resolvedActiveModelId;

            return (
              <div
                key={`${currentChatId || "new"}:panel:${panelIndex}`}
                data-testid="desktop-model-panel"
                data-model-id={modelId}
                {...(useTabsLayout
                  ? {
                      role: "tabpanel",
                      id: `model-tabpanel-${modelId}`,
                      "aria-labelledby": `model-tab-${modelId}`,
                    }
                  : {})}
                // `aria-hidden` states the exclusion the empty state needs, and
                // `inert` below enforces it. Both, because they are not
                // interchangeable: `inert` alone is invisible to tooling that
                // derives the accessibility tree from the DOM rather than from
                // the platform (Playwright's `ariaSnapshot()` still listed
                // every panel control), while `aria-hidden` alone would leave
                // them focusable -- a focusable node hidden from assistive tech
                // is worse than either. Together they are safe: nothing in here
                // can take focus, so nothing can be focused-but-unannounced.
                aria-hidden={!isPanelVisible || isConversationEmpty}
                // UI-EMPTY-001. While the welcome screen is up these panels are
                // decoration: they are painted through its translucent surface
                // so the first screen still reads as a three-model comparison,
                // but nothing in them is a control the user can act on yet.
                // Without this they stayed in the tab order and in the
                // accessibility tree, so a keyboard user reached 24 stops a
                // mouse user could not -- every one of them covered on screen.
                //
                // The start screen carries the pre-chat controls itself: the
                // composer, and with it the model picker, portal into
                // ChatWelcomeScreen (see inputPortalTarget above), so choosing
                // models and discovering locked ones before the first question
                // goes through the front of the screen rather than through a
                // selector hidden behind it. That is what makes this safe to
                // close -- an earlier attempt inerted the panels while that
                // front path was the only thing keeping the capability, and it
                // broke a real one. The capability is not in the panels.
                //
                // Deliberately not `hidden`: the panels have to keep painting.
                inert={isConversationEmpty || undefined}
                style={isPanelVisible ? undefined : { contentVisibility: "hidden" }}
                className={`relative flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm shadow-zinc-200/60 transition-all duration-300 ease-in-out dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/20 ${
                  !isPanelVisible ? "hidden" : isPanelDisabled ? "flex w-44 shrink-0" : "flex min-w-0 flex-1"
                }`}
              >
                <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400">
                  <div className={`flex min-w-0 flex-1 items-center gap-2 transition-opacity ${isPanelDisabled ? "opacity-50" : ""}`}>
                    <ModelLogo model={modelInfo} size="md" />

                    {isPanelDisabled ? (
                      <span className="flex min-w-0 select-none flex-col truncate">
                        <span className="truncate text-sm font-semibold text-zinc-600 dark:text-zinc-300">{modelInfo?.name}</span>
                        <span className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                          <span className="truncate">{modelInfo?.provider}</span>
                          {usageProfile && (
                            <CreditCostBadge
                              credits={usageProfile.credits}
                              size="xs"
                              label={lang === "ko" ? `기본 ${usageProfile.credits}크레딧 차감` : `Base cost ${formatCountedUnit(usageProfile.credits, englishCreditUnit, "en")}`}
                            />
                          )}
                        </span>
                      </span>
                    ) : (
                      <span className="flex min-w-0 flex-col">
                        {/*
                          RECON-A11Y-001: the selected model name is this
                          control's only visible text, so a screen reader
                          announced three identical "combo box"es and gave no
                          way to tell which panel was about to change models
                          -- and changing the wrong panel spends credits.
                          Named by panel position rather than by model, so the
                          name stays stable across a selection change and the
                          three names stay unique.
                        */}
                        <select
                          value={modelId}
                          onChange={(event) => onChangePanelModel(modelId, event.target.value)}
                          disabled={isPanelDisabled || !isModelSelectionReady}
                          aria-busy={!isModelSelectionReady}
                          aria-label={interpolate(t("chat.panelModelSelectLabel"), {
                            position: panelIndex + 1,
                          })}
                          // UI-014. This was borderless, background-less text with no focus ring, so
                          // the primary way to change a panel's model read as a static
                          // label. It keeps the native select (and its own arrow, and
                          // its unique aria-label) and only gains the field affordance:
                          // a border, a hover and focus-visible state, and a disabled
                          // treatment. Padding stays tight so three panels at 200% text
                          // still truncate rather than overflow.
                          className="min-w-0 cursor-pointer truncate rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-sm font-semibold text-zinc-800 outline-none transition-colors hover:border-zinc-400 hover:text-zinc-950 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60 aria-busy:opacity-70 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500 dark:hover:text-white"
                        >
                          {ENABLED_MODELS.map((model) => {
                            const isAlreadyUsed = selectedModels.includes(model.id) && model.id !== modelId;
                            return (
                              <option
                                key={model.id}
                                value={model.id}
                                disabled={isAlreadyUsed}
                                className="bg-zinc-900 text-zinc-100"
                              >
                                {model.name} {isAlreadyUsed ? t("chat.inUsed") : ""}
                              </option>
                            );
                          })}
                        </select>
                        <span className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                          <span className="truncate">{modelInfo?.provider}</span>
                          {usageProfile && (
                            <CreditCostBadge
                              credits={usageProfile.credits}
                              size="xs"
                              label={lang === "ko" ? `기본 ${usageProfile.credits}크레딧 차감` : `Base cost ${formatCountedUnit(usageProfile.credits, englishCreditUnit, "en")}`}
                            />
                          )}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {selectedModels.length > 1 && (
                      <>
                        <button
                          type="button"
                          onClick={() => onTogglePanelDisable(modelId)}
                          className="flex cursor-pointer items-center gap-2 rounded-full px-2 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          title={isPanelDisabled ? t("chat.resumePanel") : t("chat.pausePanel")}
                          // UX-013. Text content wins over `title` when a name is
                          // computed, so all three of these buttons were announced as
                          // "ON" -- identical, and silent about which model they
                          // control. The visible ON/OFF is decorative once the name
                          // carries the state.
                          aria-label={interpolate(
                            isPanelDisabled
                              ? t("chat.panelResumeLabel")
                              : t("chat.panelPauseLabel"),
                            {
                              position: panelIndex + 1,
                              model: modelInfo?.name || modelId,
                            }
                          )}
                          aria-pressed={!isPanelDisabled}
                        >
                          <span
                            aria-hidden="true"
                            className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400"
                          >
                            {isPanelDisabled ? "OFF" : "ON"}
                          </span>
                          <div className={`h-4 w-8 rounded-full p-0.5 transition-colors ${!isPanelDisabled ? "bg-blue-500" : "bg-zinc-700"}`}>
                            <div className={`h-3 w-3 rounded-full bg-white transition-transform ${!isPanelDisabled ? "translate-x-4" : "translate-x-0"}`} />
                          </div>
                        </button>

                        <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-700/50" />

                        <button
                          type="button"
                          onClick={() => onRemoveModel(modelId)}
                          className="flex cursor-pointer items-center justify-center rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-500"
                          title={t("chat.closeModelPanel")}
                          // Destructive and repeated once per panel: the name has to
                          // say which comparison column it discards.
                          aria-label={interpolate(t("chat.panelCloseLabel"), {
                            position: panelIndex + 1,
                            model: modelInfo?.name || modelId,
                          })}
                        >
                          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <ChatApp
                  modelId={modelId}
                  initialConversationId={currentChatId}
                  promptPayload={promptPayload}
                  isPanelDisabled={isPanelDisabled}
                  isGuestMode={isGuestMode}
                  webSearchMode={webSearchMode}
                  onBeforeSend={onBeforeModelSend}
                  onResponseComplete={onResponseComplete}
                  onTurnError={onTurnError}
                  onFollowupSent={onFollowupSent}
                  onContextBundleStale={onContextBundleStale}
                  hideModelOnlyInput={selectedModels.length <= 1}
                  useCenteredWelcome
                  onContentStateChange={handleContentStateChange}
                  onStatusChange={handleModelStatusChange}
                  onRequestCloseModel={() => onToggleModel(modelId)}
                  hasMultipleActiveModels={selectedModels.length > 1}
                  stopSignal={stopSignal}
                />
              </div>
            );
          })}
        </div>

        {/*
          The bottom workflow dock. The comparison rail and the composer are
          separate sections semantically -- one acts on finished answers, the
          other configures the next request -- but they share one alignment
          axis (`max-w-4xl mx-auto`, same horizontal padding) and one boundary
          against the answer canvas, so a wide screen no longer strands the
          actions on the far left of a centred composer.
        */}
        {/*
          The Deep Research expansion offer, above the comparison rail and
          directly under the answers it is about. One card for the whole
          question -- a comparison's three panels answered one question, and
          three offers to expand it would be three ways to start one run.

          It is in the dock rather than inside a panel's message list for the
          same reason the rail is: the dock exists once, and it is the only
          place in this layout where "under the answer" and "once" are the
          same position.
        */}
        {/*
          The web-search offer, directly above the expansion offer and under the
          answers both are about. One card for the whole question, in the dock,
          for the same reason the expansion is: the dock exists once however
          many panels are on screen.

          The two are never on screen together, and `arbitrateWebSearchOffer`
          above is what makes that true. It used to be argued from the rules --
          this offer needs only recency and `classifyDeepResearchTopic` refuses
          recency alone -- but needing only recency is not firing only on it: a
          question carrying recency *and* a depth signal satisfied both, and drew
          both cards. Deep Research wins that question, as the deeper of the two
          answers; a failed re-run's own report is the one thing the arbitration
          does not take away.
        */}
        {webSearchSuggestion.offered &&
          webSearchSuggestion.state &&
          webSearchSuggestionTurn && (
            <WebSearchSuggestionCard
              state={webSearchSuggestion.state}
              copy={webSearchSuggestionCopyFor(webSearchSuggestion.state)}
              isStarting={isWebSearchRetrying}
              onConfirm={() =>
                onWebSearchSuggestionConfirm({
                  conversationId: webSearchSuggestionTurn.conversationId,
                  text: webSearchSuggestionTurn.text,
                  state: webSearchSuggestion.state!,
                  reason: webSearchOfferReason,
                })
              }
              onDismiss={() =>
                onWebSearchSuggestionDismiss({
                  conversationId: webSearchSuggestionTurn.conversationId,
                  text: webSearchSuggestionTurn.text,
                  state: webSearchSuggestion.state!,
                  reason: webSearchOfferReason,
                })
              }
            />
          )}
        {deepResearchSuggestion.offered && deepResearchSuggestionTurn && (
          <DeepResearchSuggestionCard
            copy={deepResearchSuggestionCopy}
            isStarting={isDeepResearchExpanding}
            onExpand={() =>
              onDeepResearchSuggestionExpand({
                conversationId: deepResearchSuggestionTurn.conversationId,
                text: deepResearchSuggestionTurn.text,
              })
            }
            onDismiss={() =>
              onDeepResearchSuggestionDismiss({
                conversationId: deepResearchSuggestionTurn.conversationId,
                text: deepResearchSuggestionTurn.text,
              })
            }
          />
        )}
        <ComparisonActionRail
          layout="desktop"
          readiness={comparisonReadiness}
          aiReviewAccess={aiReviewAccess}
          isCompareSummaryLoading={isCompareSummaryLoading}
          isQuickSummaryCached={isQuickSummaryCached}
          availableCredits={availableCredits}
          verificationSlot={<GuestVerificationDesktopSlot variant="rail" />}
          onCompareSummary={onCompareSummary}
          onComparisonReview={onComparisonReview}
          onGuestSignInPrompt={onGuestSignInPrompt}
        />

        {/*
          The shared fallback: with a single model there is no comparison rail
          to host the widget, but the verification surface still has to exist
          somewhere predictable -- a full-width row of its own directly above
          the composer, never inside a model panel.
        */}
        {!comparisonReadiness.isVisible && (
          <GuestVerificationDesktopSlot variant="fallback" />
        )}

        <div className="w-full shrink-0 px-4 md:px-6">
          <div ref={setBottomConsentSlot} className="mx-auto w-full max-w-4xl" />
        </div>
        <div ref={setBottomInputSlot} />
        {composerPortalHost &&
          createPortal(
            <ChatInput
              value={inputValue}
              onChange={setInputValue}
              personalizedPrompt={personalizedPrompt}
              onSubmit={onSubmit}
              onCancel={() => setStopSignal((current) => current + 1)}
              isSending={isAnyModelResponding}
              focusToken={focusToken}
              currentChatId={currentChatId}
              selectedModels={selectedModels}
              disabledModelIds={disabledPanels}
              onToggleModel={onToggleModel}
              onSwapModel={onSwapModel}
              modelSwapRequest={modelSwapRequest}
              onModelSwapRequestResolved={onModelSwapRequestResolved}
              webSearchMode={webSearchMode}
              onWebSearchModeChange={onWebSearchModeChange}
              memoryMode={memoryMode}
              autoSelectionOffered={autoSelectionOffered}
              selectionMode={selectionMode}
              selectionModePending={selectionModePending}
              onSelectionModeChange={onSelectionModeChange}
              assistantProfile={assistantProfile}
              assistantProfileRemovedAt={assistantProfileRemovedAt}
              assistantProfileOptions={assistantProfileOptions}
              onAssistantProfileChange={onAssistantProfileChange}
              onMemoryModeChange={onMemoryModeChange}
              accountMemoryDefault={accountMemoryDefault}
              onOpenDeepResearchSetup={onOpenDeepResearchSetup}
              isDeepResearchPending={isDeepResearchPending}
              onDismissDeepResearchChip={onDismissDeepResearchChip}
              onStartImageDraft={onStartImageDraft}
              imageGenerationLock={imageLock ?? null}
              onLockedImageGenerationClick={onLockedImageClick}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              attachmentCapabilities={attachmentCapabilities}
              voiceInputEnabled={voiceInputEnabled}
              onVoiceTranscript={onVoiceTranscript}
              identityKey={identityKey}
              onGuestSignInPrompt={onGuestSignInPrompt}
              isGuestMode={isGuestMode}
              guestPreviewMode={guestPreviewMode}
              guestMessageCount={guestMessageCount}
              maxGuestMessages={maxGuestMessages}
              variant={isConversationEmpty ? "floating" : "bar"}
              hideTopBorder={comparisonReadiness.isVisible}
              conversationDropSurface={conversationDropSurface}
            />,
            composerPortalHost
          )}
          </>
        )}
      </section>
    </main>
  );
}
