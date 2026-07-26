"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Lock, X } from "lucide-react";
import { useChatConsentSlotRef } from "@/components/analytics/AnalyticsProvider";
import { useSidebarCollapsePreference } from "@/components/chat/useSidebarCollapse";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatWelcomeScreen } from "@/components/chat/ChatWelcomeScreen";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ProviderStatusBanner } from "@/components/chat/ProviderStatusBanner";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import {
  getModelUsageProfile,
  type ChatAttachment,
  type Conversation,
} from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import type { WebSearchMode } from "@/lib/appDefaults";

type PromptPayload = {
  id: string;
  text: string;
  chatId: string;
  userMessageId: string;
  attachments: ChatAttachment[];
  deepResearchDepth?: "quick" | "standard" | "deep";
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
  setAttachments: (attachments: ChatAttachment[]) => void;
  isSending: boolean;
  focusToken: number;
  isGuestMode: boolean;
  guestPreviewMode?: boolean;
  guestMessageCount: number;
  maxGuestMessages: number;
  isModelSelectionReady: boolean;
  onNewChat: () => void;
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
  webSearchMode: WebSearchMode;
  onWebSearchModeChange: (mode: WebSearchMode) => void;
  onOpenDeepResearchSetup: () => void;
  isDeepResearchPending: boolean;
  onDismissDeepResearchChip: () => void;
  onSubmit: () => void;
  onBeforeModelSend: (chatId: string) => Promise<boolean>;
  onChangePanelModel: (oldModelId: string, newModelId: string) => void;
  onTogglePanelDisable: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onCompareSummary: () => void;
  isCompareSummaryLoading: boolean;
  onComparisonReview: () => void;
  onGuestSignInPrompt: () => void;
  onResponseComplete: (promptId: string | null, modelId: string, responseText: string) => void;
  onFollowupSent: (modelId: string) => void;
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
  isSending,
  focusToken,
  isGuestMode,
  guestPreviewMode = false,
  guestMessageCount,
  maxGuestMessages,
  isModelSelectionReady,
  onNewChat,
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
  webSearchMode,
  onWebSearchModeChange,
  onOpenDeepResearchSetup,
  isDeepResearchPending,
  onDismissDeepResearchChip,
  onSubmit,
  onBeforeModelSend,
  onChangePanelModel,
  onTogglePanelDisable,
  onRemoveModel,
  onCompareSummary,
  isCompareSummaryLoading,
  onComparisonReview,
  onGuestSignInPrompt,
  onResponseComplete,
  onFollowupSent,
}: DesktopChatShellProps) {
  const {
    models: AVAILABLE_MODELS,
    enabledModels: ENABLED_MODELS,
  } = useModelCatalog();
  const { t, lang } = useLanguage();
  const helpCopy = chatHelpCopy[lang];
  const recentConversations = useMemo(
    () =>
      conversations
        .filter((conversation) => !conversation.isLocked)
        .slice(0, 3)
        .map((conversation) => ({ id: conversation.id, title: conversation.title })),
    [conversations]
  );
  const [modelEmptyStates, setModelEmptyStates] = useState<Record<string, boolean>>({});
  const conversationStateKey = currentChatId || "new";
  const emptyStateKey = useCallback(
    (modelId: string) => `${conversationStateKey}:${modelId}`,
    [conversationStateKey]
  );
  const handleEmptyStateChange = useCallback(
    (modelId: string, isEmpty: boolean) => {
      const key = emptyStateKey(modelId);
      setModelEmptyStates((current) =>
        current[key] === isEmpty ? current : { ...current, [key]: isEmpty }
      );
    },
    [emptyStateKey]
  );
  const isConversationEmpty =
    selectedModels.length > 0 &&
    selectedModels.every((modelId) => modelEmptyStates[emptyStateKey(modelId)] ?? true);
  const [modelStatuses, setModelStatuses] = useState<
    Record<string, "idle" | "loading" | "responding" | "error" | "cancelled" | "paused">
  >({});
  const handleModelStatusChange = useCallback(
    (
      modelId: string,
      nextStatus: "idle" | "loading" | "responding" | "error" | "cancelled" | "paused"
    ) => {
      setModelStatuses((current) =>
        current[modelId] === nextStatus
          ? current
          : { ...current, [modelId]: nextStatus }
      );
    },
    []
  );
  // Bumped to abort every currently-responding panel at once ("stop all").
  // A counter, not a boolean, so a second click still re-triggers each
  // ChatApp panel's abort effect even though the value it flips from/to
  // would otherwise look unchanged.
  const [stopSignal, setStopSignal] = useState(0);
  const isAnyModelResponding = Object.values(modelStatuses).some(
    (status) => status === "responding"
  );
  // A quick-comparison summary needs at least two models that have actually
  // finished responding (not still streaming, not paused/off) -- the
  // request only ever counted selectedModels.length > 1 and an otherwise
  // non-empty conversation, so the button was clickable the instant a
  // message was sent, well before any model had a real answer to compare.
  const readyForCompareCount = selectedModels.filter(
    (modelId) =>
      !disabledPanels.includes(modelId) && modelStatuses[modelId] === "idle"
  ).length;
  const comparableModelCount = selectedModels.filter(
    (modelId) => !disabledPanels.includes(modelId)
  ).length;
  const isCompareSummaryDisabled =
    isCompareSummaryLoading || readyForCompareCount < 2;
  const [welcomeInputSlot, setWelcomeInputSlot] = useState<HTMLDivElement | null>(null);
  const [bottomInputSlot, setBottomInputSlot] = useState<HTMLDivElement | null>(null);
  const inputPortalTarget = isConversationEmpty
    ? welcomeInputSlot ?? bottomInputSlot
    : bottomInputSlot ?? welcomeInputSlot;
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
      className="flex h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <ChatSidebar
        conversations={conversations}
        currentChatId={currentChatId}
        onNewChat={onNewChat}
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
        <ProviderStatusBanner
          selectedModels={selectedModels}
          compact
          onToggleModel={onToggleModel}
          onSwapModel={onSwapModel}
        />
        {!isConversationEmpty && useTabsLayout && (
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
                      <span className="block truncate text-[10px] text-zinc-400">
                        {model?.provider}
                      </span>
                    </span>
                    {status === "responding" || status === "loading" ? (
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
                    ) : status === "error" ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                    ) : status === "paused" ? (
                      <span className="shrink-0 text-[9px] font-bold text-zinc-400">OFF</span>
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
        <div className="relative flex min-h-0 flex-1 gap-4 overflow-hidden bg-zinc-100/80 px-4 pb-4 pt-3 dark:bg-zinc-950">
          {isConversationEmpty && (
            <div className="absolute inset-0 z-10 bg-zinc-100/80 dark:bg-zinc-950">
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
                aria-hidden={!isPanelVisible}
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
                        <span className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-400">
                          <span className="truncate">{modelInfo?.provider}</span>
                          {usageProfile && (
                            <CreditCostBadge
                              credits={usageProfile.credits}
                              size="xs"
                              label={lang === "ko" ? `기본 ${usageProfile.credits}크레딧 차감` : `Base cost ${usageProfile.credits} credits`}
                            />
                          )}
                        </span>
                      </span>
                    ) : (
                      <span className="flex min-w-0 flex-col">
                        <select
                          value={modelId}
                          onChange={(event) => onChangePanelModel(modelId, event.target.value)}
                          disabled={isPanelDisabled || !isModelSelectionReady}
                          aria-busy={!isModelSelectionReady}
                          className="min-w-0 cursor-pointer truncate bg-transparent text-sm font-semibold text-zinc-800 outline-none hover:text-zinc-950 dark:text-zinc-100 dark:hover:text-white"
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
                        <span className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-400">
                          <span className="truncate">{modelInfo?.provider}</span>
                          {usageProfile && (
                            <CreditCostBadge
                              credits={usageProfile.credits}
                              size="xs"
                              label={lang === "ko" ? `기본 ${usageProfile.credits}크레딧 차감` : `Base cost ${usageProfile.credits} credits`}
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
                          aria-pressed={!isPanelDisabled}
                        >
                          <span className="text-[10px] font-bold text-zinc-500">
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
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
                  onFollowupSent={onFollowupSent}
                  hideModelOnlyInput={selectedModels.length <= 1}
                  useCenteredWelcome
                  onEmptyStateChange={handleEmptyStateChange}
                  onStatusChange={handleModelStatusChange}
                  onRequestCloseModel={() => onToggleModel(modelId)}
                  hasMultipleActiveModels={selectedModels.length > 1}
                  stopSignal={stopSignal}
                />
              </div>
            );
          })}
        </div>

        {!isConversationEmpty && selectedModels.length > 1 && currentChatId && (
          <div className="flex gap-2 border-t border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
            <button
              type="button"
              data-testid="quick-comparison-button"
              onClick={onCompareSummary}
              disabled={isCompareSummaryDisabled}
              title={readyForCompareCount < 2 ? t("chat.aiReviewResponsesRequired") : undefined}
              className="flex items-center justify-between gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-black text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-50 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200 dark:hover:bg-blue-950 dark:disabled:hover:bg-blue-950/30"
            >
              <span>
                {t("chat.quickDifferenceSummary")}
                {comparableModelCount > 1 && readyForCompareCount < comparableModelCount && (
                  <span
                    data-testid="quick-comparison-ready-count"
                    className="ml-1 font-normal text-blue-500/80 dark:text-blue-300/80"
                  >
                    ({readyForCompareCount}/{comparableModelCount})
                  </span>
                )}
              </span>
              <CreditCostBadge
                credits={1}
                size="xs"
                label={t("chat.quickDifferenceSummaryCreditCost")}
                testId="quick-comparison-credit-cost"
              />
            </button>
            {isGuestMode ? (
              <button
                type="button"
                data-testid="ai-review-guest-locked"
                onClick={onGuestSignInPrompt}
                className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2 text-xs font-black text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <span className="flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("chat.aiReviewLoginToUnlock")}
                </span>
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onComparisonReview}
                  className="flex items-center justify-between gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-black text-white hover:bg-blue-500"
                >
                  <span>{t("chat.aiReviewButton")}</span>
                  <CreditCostBadge
                    credits={4}
                    size="xs"
                    tone="onColor"
                    label={`4 ${t("chat.aiReviewCredits")}`}
                    testId="ai-review-entry-credit-cost"
                    className="border-0 bg-white/20"
                  />
                </button>
                <FeatureHelpPopover
                  title={helpCopy.aiReviewTitle}
                  description={helpCopy.aiReviewDescription}
                  buttonLabel={helpCopy.helpAboutAiReview}
                  learnMoreLabel={helpCopy.learnMore}
                  topic="ai_review"
                  href={chatWorkspaceGuideHref(lang, "ai-review")}
                  align="right"
                  testId="ai-review-help"
                />
              </div>
            )}
          </div>
        )}

        <div ref={setBottomConsentSlot} className="shrink-0 px-4" />
        <div ref={setBottomInputSlot} />
        {inputPortalTarget &&
          createPortal(
            <ChatInput
              value={inputValue}
              onChange={setInputValue}
              personalizedPrompt={personalizedPrompt}
              onSubmit={onSubmit}
              onCancel={() => setStopSignal((current) => current + 1)}
              isSending={isSending || isAnyModelResponding}
              focusToken={focusToken}
              currentChatId={currentChatId}
              selectedModels={selectedModels}
              disabledModelIds={disabledPanels}
              onToggleModel={onToggleModel}
              onSwapModel={onSwapModel}
              webSearchMode={webSearchMode}
              onWebSearchModeChange={onWebSearchModeChange}
              onOpenDeepResearchSetup={onOpenDeepResearchSetup}
              isDeepResearchPending={isDeepResearchPending}
              onDismissDeepResearchChip={onDismissDeepResearchChip}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              canAttach={!isGuestMode}
              isGuestMode={isGuestMode}
              guestPreviewMode={guestPreviewMode}
              guestMessageCount={guestMessageCount}
              maxGuestMessages={maxGuestMessages}
              variant={isConversationEmpty ? "floating" : "bar"}
            />,
            inputPortalTarget
          )}
      </section>
    </main>
  );
}
