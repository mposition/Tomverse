"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useChatConsentSlotRef } from "@/components/analytics/AnalyticsProvider";
import { ANALYTICS_PREFERENCES_OPEN_EVENT } from "@/lib/analyticsPreferencesEvents";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatWelcomeScreen } from "@/components/chat/ChatWelcomeScreen";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ProviderStatusBanner } from "@/components/chat/ProviderStatusBanner";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { ModeInfoSheet } from "@/components/chat/ModeInfoSheet";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { chatModelSummaryCopy } from "@/components/chat/chatModelSummaryCopy";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import { buildChatModelSummary } from "@/lib/chatModelSummary";
import { openChatModelPicker } from "@/lib/chatModelPickerEvents";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import {
  type ChatAttachment,
  type Conversation,
} from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import type { WebSearchMode } from "@/lib/appDefaults";
import {
  Check,
  ChevronDown,
  Lock,
  Menu,
  Share2,
  Sparkles,
  SquarePen,
  X,
} from "lucide-react";

type PromptPayload = {
  id: string;
  text: string;
  chatId: string;
  userMessageId: string;
  attachments: ChatAttachment[];
  deepResearchDepth?: "quick" | "standard" | "deep";
};

type ModelRuntimeStatus = "idle" | "loading" | "responding" | "error" | "cancelled" | "paused";

type MobileChatShellProps = {
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
  onRequestUndoToast: (message: string, undo: () => void) => void;
  onSubmit: () => void;
  onBeforeModelSend: (chatId: string) => Promise<boolean>;
  onCompareSummary: () => void;
  isCompareSummaryLoading: boolean;
  onComparisonReview: () => void;
  onGuestSignInPrompt: () => void;
  onResponseComplete: (promptId: string | null, modelId: string, responseText: string) => void;
  onFollowupSent: (modelId: string) => void;
};

export function MobileChatShell({
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
  onRequestUndoToast,
  onSubmit,
  onBeforeModelSend,
  onCompareSummary,
  isCompareSummaryLoading,
  onComparisonReview,
  onGuestSignInPrompt,
  onResponseComplete,
  onFollowupSent,
}: MobileChatShellProps) {
  const { models: AVAILABLE_MODELS } = useModelCatalog();
  const { t, lang } = useLanguage();
  const helpCopy = chatHelpCopy[lang];
  const registerChatConsentSlot = useChatConsentSlotRef();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(
    selectedModels[0] || null
  );
  const recentConversations = useMemo(
    () =>
      conversations
        .filter((conversation) => !conversation.isLocked)
        .slice(0, 3)
        .map((conversation) => ({ id: conversation.id, title: conversation.title })),
    [conversations]
  );
  const [modelStatuses, setModelStatuses] = useState<Record<string, ModelRuntimeStatus>>({});
  const [modelEmptyStates, setModelEmptyStates] = useState<Record<string, boolean>>({});
  const [modeSheet, setModeSheet] = useState<"guest" | null>(null);

  const handleTabRemoveClick = useCallback(
    (modelId: string) => {
      const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
      onToggleModel(modelId);
      onRequestUndoToast(
        t("chat.modelRemovedUndo").replace("{model}", model?.name || modelId),
        () => onToggleModel(modelId)
      );
    },
    [AVAILABLE_MODELS, onRequestUndoToast, onToggleModel, t]
  );
  const resolvedActiveModelId =
    activeModelId && selectedModels.includes(activeModelId)
      ? activeModelId
      : selectedModels[0] || null;
  const conversationStateKey = currentChatId || "new";
  const emptyStateKey = useCallback(
    (modelId: string) => `${conversationStateKey}:${modelId}`,
    [conversationStateKey]
  );

  // Bumped to abort every currently-responding panel at once ("stop all").
  const [stopSignal, setStopSignal] = useState(0);
  const isAnyModelResponding = Object.values(modelStatuses).some(
    (status) => status === "responding"
  );

  const handleModelStatusChange = useCallback(
    (modelId: string, nextStatus: ModelRuntimeStatus) => {
      setModelStatuses((current) =>
        current[modelId] === nextStatus
          ? current
          : { ...current, [modelId]: nextStatus }
      );
    },
    []
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

  const activeModelIndex = resolvedActiveModelId
    ? selectedModels.indexOf(resolvedActiveModelId)
    : -1;

  const switchModelByOffset = useCallback(
    (offset: number) => {
      if (selectedModels.length < 2 || activeModelIndex < 0) return;
      const nextIndex =
        (activeModelIndex + offset + selectedModels.length) %
        selectedModels.length;
      setActiveModelId(selectedModels[nextIndex]);
    },
    [activeModelIndex, selectedModels]
  );

  useEffect(() => {
    if (!isDrawerOpen) return;

    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => {
      drawerCloseButtonRef.current?.focus();
    });

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsDrawerOpen(false);
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isDrawerOpen]);

  // The drawer's own analytics-settings entry point (guest-analytics-cookie-settings
  // in AuthButton) opens the analytics preferences notice via this shared event
  // without knowing the drawer is open. The notice portals into a slot in the main
  // chat area, which sits below the drawer's fixed overlay, so without closing the
  // drawer first the notice would render but stay hidden and unreachable behind it.
  useEffect(() => {
    if (!isDrawerOpen) return;
    const closeDrawerForAnalyticsPreferences = () => setIsDrawerOpen(false);
    window.addEventListener(
      ANALYTICS_PREFERENCES_OPEN_EVENT,
      closeDrawerForAnalyticsPreferences
    );
    return () =>
      window.removeEventListener(
        ANALYTICS_PREFERENCES_OPEN_EVENT,
        closeDrawerForAnalyticsPreferences
      );
  }, [isDrawerOpen]);

  const getDrawerFocusableElements = useCallback(() => {
    const panel = drawerPanelRef.current;
    if (!panel) return [];

    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        [
          "button:not([disabled])",
          "input:not([disabled])",
          "select:not([disabled])",
          "textarea:not([disabled])",
          "a[href]",
          '[tabindex]:not([tabindex="-1"])',
        ].join(",")
      )
    ).filter((element) => element.offsetParent !== null);
  }, []);

  useEffect(() => {
    if (!isDrawerOpen) return;

    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      const focusableElements = getDrawerFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleDrawerKeyDown, true);
    return () => document.removeEventListener("keydown", handleDrawerKeyDown, true);
  }, [getDrawerFocusableElements, isDrawerOpen]);

  // One derivation feeds the header summary, its accessible name and (through
  // the same selectedModels/disabledPanels props) the composer's own count, so
  // the two can no longer disagree about how many models are really answering.
  const modelSummary = useMemo(
    () =>
      buildChatModelSummary({
        selectedModels,
        disabledModelIds: disabledPanels,
        primaryModelId: resolvedActiveModelId,
        models: AVAILABLE_MODELS,
      }),
    [AVAILABLE_MODELS, disabledPanels, resolvedActiveModelId, selectedModels]
  );
  const summaryCopy = chatModelSummaryCopy[lang];
  const modelSummaryLabel = summaryCopy.accessibleName({
    primaryModelName: modelSummary.primary?.name ?? null,
    extraActiveCount: modelSummary.extraActiveCount,
    activeCount: modelSummary.activeCount,
    pausedCount: modelSummary.pausedCount,
  });
  const handleOpenModelPicker = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      trackProductEvent("chat_tool_menu_opened", modelSummary.activeCount, {
        cta_location: "mobile_header_model_summary",
      });
      openChatModelPicker(event.currentTarget);
    },
    [modelSummary.activeCount]
  );
  const isActiveConversationEmpty = resolvedActiveModelId
    ? modelEmptyStates[emptyStateKey(resolvedActiveModelId)] ?? true
    : true;
  const isConversationEmpty =
    selectedModels.length > 0 &&
    selectedModels.every((modelId) => modelEmptyStates[emptyStateKey(modelId)] ?? true);
  const currentConversation = conversations.find(
    (conversation) => conversation.id === currentChatId
  );
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
  useEffect(() => {
    registerChatConsentSlot(consentSlotTarget);
    return () => registerChatConsentSlot(null);
  }, [consentSlotTarget, registerChatConsentSlot]);
  const isCurrentLocked = Boolean(currentConversation?.isLocked);
  const isCurrentShared = Boolean(currentConversation?.shareEnabled);
  const respondingCount = selectedModels.filter((modelId) => {
    const status = modelStatuses[modelId];
    return status === "responding" || status === "loading";
  }).length;
  const errorCount = selectedModels.filter(
    (modelId) => modelStatuses[modelId] === "error"
  ).length;
  const isAnyError = errorCount > 0;
  // Mirrors DesktopChatShell's fix: the button used to be clickable the
  // instant a message was sent, well before any model had finished --
  // require at least two active (non-paused) models to have actually
  // reached "idle" (finished, no error) before allowing a comparison.
  const readyForCompareCount = selectedModels.filter(
    (modelId) =>
      !disabledPanels.includes(modelId) && modelStatuses[modelId] === "idle"
  ).length;
  const comparableModelCount = selectedModels.filter(
    (modelId) => !disabledPanels.includes(modelId)
  ).length;
  const isCompareSummaryDisabled =
    isCompareSummaryLoading || readyForCompareCount < 2;
  const isAnyWorkingOrError = selectedModels.some((modelId) => {
    const status = modelStatuses[modelId];
    return status === "responding" || status === "loading" || status === "error";
  });

  return (
    <main
      data-testid="mobile-chat-shell"
      className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-white text-[13px] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <header className="min-w-0 shrink-0 overflow-hidden border-b border-zinc-200 bg-white px-3 pb-1.5 pt-[calc(0.45rem+env(safe-area-inset-top))] dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          data-testid="mobile-sidebar-open"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          aria-label={t("chat.moreActions")}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-[13px] font-bold">
            {currentConversation?.title || t("sidebar.newChat")}
          </p>
          {isModelSelectionReady ? (
            <button
              type="button"
              data-testid="mobile-header-model-summary"
              onClick={handleOpenModelPicker}
              aria-haspopup="dialog"
              aria-label={modelSummaryLabel}
              title={modelSummary.entries.map((entry) => entry.name).join(", ")}
              className="-mx-1 -my-0.5 flex min-h-11 min-w-0 max-w-full items-center gap-1 rounded-lg px-1 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 active:bg-zinc-100 dark:active:bg-zinc-900"
            >
              {/* Avatars are a supplement, never the only signal: the model
                  name and "+N" carry the same information, and the stack is
                  the first thing to go when the viewport cannot afford it. */}
              {modelSummary.avatars.length > 1 && (
                <span
                  data-testid="mobile-header-model-avatars"
                  className="hidden shrink-0 items-center -space-x-1 min-[360px]:flex"
                  aria-hidden="true"
                >
                  {modelSummary.avatars.map((entry) => (
                    <ModelLogo
                      key={entry.modelId}
                      model={entry.model}
                      size="xs"
                      className={entry.isPaused ? "opacity-40" : ""}
                    />
                  ))}
                  {modelSummary.avatarOverflowCount > 0 && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200 text-[9px] font-black text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
                      +{modelSummary.avatarOverflowCount}
                    </span>
                  )}
                </span>
              )}
              <span
                data-testid="mobile-header-primary-model"
                className="min-w-0 flex-1 truncate text-[10px] font-medium text-zinc-500"
              >
                {modelSummary.primary?.name || t("chat.modelSelect")}
              </span>
              {modelSummary.extraActiveCount > 0 && (
                <span
                  data-testid="mobile-header-extra-model-count"
                  className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-px text-[10px] font-black leading-4 text-blue-600 dark:text-blue-300"
                >
                  +{modelSummary.extraActiveCount}
                </span>
              )}
              <ChevronDown className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden="true" />
            </button>
          ) : (
            // Never paint "1 model" and correct it to "3" a frame later: until
            // the restored selection is known there is no honest number to show.
            <span
              data-testid="mobile-header-model-summary-skeleton"
              className="-my-0.5 flex min-h-11 items-center py-0.5"
              aria-hidden="true"
            >
              <span className="h-3 w-24 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
            </span>
          )}
        </div>
        {!isActiveConversationEmpty && (
          <button
            type="button"
            onClick={onNewChat}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-950/20"
            aria-label={t("sidebar.newChat")}
          >
            <SquarePen className="h-5 w-5" />
          </button>
        )}
        </div>
        <div className="mt-1.5 flex min-h-6 max-w-full gap-1.5 overflow-x-auto overscroll-x-contain">
          {isGuestMode && (
            <button
              type="button"
              onClick={() => setModeSheet("guest")}
              data-testid="mobile-guest-usage-badge"
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full bg-blue-500/10 px-2 text-[10px] font-bold text-blue-600 dark:text-blue-300"
            >
              <Sparkles className="h-3 w-3" />
              {t("modelTiers.guest")} {guestMessageCount}/{maxGuestMessages}
            </button>
          )}
          {isCurrentLocked && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-600 dark:text-amber-300">
              <Lock className="h-3 w-3" />
              {t("sidebar.lockedBadge")}
            </span>
          )}
          {isCurrentShared && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
              <Share2 className="h-3 w-3" />
              {t("sidebar.sharedBadge")}
            </span>
          )}
          {isAnyWorkingOrError && selectedModels.length > 1 && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ${
                isAnyError
                  ? "bg-red-500/10 text-red-600 dark:text-red-300"
                  : "bg-blue-500/10 text-blue-600 dark:text-blue-300"
              }`}
              aria-live="polite"
            >
              {isAnyError
                ? `${errorCount}/${selectedModels.length} error`
                : `${respondingCount}/${selectedModels.length} responding`}
            </span>
          )}
        </div>
      </header>

      <ProviderStatusBanner
        selectedModels={selectedModels}
        compact
        onToggleModel={onToggleModel}
        onSwapModel={onSwapModel}
      />

      {!isConversationEmpty && selectedModels.length > 1 && (
        <div className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="flex min-w-0 gap-1.5" role="tablist" aria-label={t("chat.modelSelect")}>
            {selectedModels.map((modelId) => {
              const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
              const isActive = resolvedActiveModelId === modelId;
              const isDisabled = disabledPanels.includes(modelId);
              const status = isDisabled ? "paused" : modelStatuses[modelId] || "idle";

              return (
                <div
                  key={modelId}
                  role="tab"
                  aria-selected={isActive}
                  className={`relative flex h-11 min-w-0 flex-1 touch-manipulation items-center rounded-full border shadow-sm transition-colors ${
                    isActive
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                  } ${isDisabled ? "opacity-50" : ""}`}
                >
                  <button
                    type="button"
                    data-testid="mobile-model-tab"
                    data-model-id={modelId}
                    onClick={() => setActiveModelId(modelId)}
                    aria-label={`${model?.name || modelId} ${status}`}
                    className="flex min-w-0 flex-1 shrink-0 items-center gap-1 self-stretch py-1 pl-2.5 pr-1 text-left text-[11px] font-semibold"
                  >
                    <ModelLogo model={model} size="xs" />
                    <span className="min-w-0 flex-1 truncate">{model?.name || modelId}</span>
                    {status === "responding" || status === "loading" ? (
                      <span className={`h-2 w-2 shrink-0 animate-pulse rounded-full ${isActive ? "bg-white" : "bg-blue-500"}`} />
                    ) : status === "error" ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                    ) : status === "cancelled" ? (
                      <span className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-white/70" : "bg-zinc-400"}`} />
                    ) : status === "paused" ? (
                      <span className="shrink-0 text-[9px]">OFF</span>
                    ) : status === "idle" ? (
                      <Check className={`h-3 w-3 shrink-0 ${isActive ? "text-white" : "text-emerald-500"}`} />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    data-testid="mobile-model-tab-remove"
                    aria-label={t("chat.removeModelFromComparison")}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleTabRemoveClick(modelId);
                    }}
                    className={`relative mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors before:absolute before:-inset-1.5 before:content-[''] ${
                      isActive
                        ? "text-white/80 hover:bg-white/20"
                        : "text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!isConversationEmpty && selectedModels.length > 1 && currentChatId && (
        <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
          <button
            type="button"
            data-testid="quick-comparison-button"
            onClick={onCompareSummary}
            disabled={isCompareSummaryDisabled}
            title={readyForCompareCount < 2 ? t("chat.aiReviewResponsesRequired") : undefined}
            className="flex h-11 w-full items-center justify-between gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-2 text-[11px] font-black text-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200"
          >
            <span className="truncate">
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
              className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-2 text-[11px] font-black text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t("chat.aiReviewLoginToUnlock")}</span>
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                onClick={onComparisonReview}
                className="flex h-11 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-xl bg-blue-600 px-2 text-[11px] font-black text-white"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-cyan-300 via-white to-purple-300"
                  />
                  <span className="truncate">{t("chat.aiReviewButton")}</span>
                </span>
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
                mobile
                align="right"
                testId="ai-review-help-mobile"
              />
            </div>
          )}
        </div>
      )}

      <section
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950"
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartXRef.current = touch.clientX;
          touchStartYRef.current = touch.clientY;
        }}
        onTouchEnd={(event) => {
          const startX = touchStartXRef.current;
          const startY = touchStartYRef.current;
          touchStartXRef.current = null;
          touchStartYRef.current = null;
          if (startX === null || startY === null) return;

          const touch = event.changedTouches[0];
          const deltaX = touch.clientX - startX;
          const deltaY = touch.clientY - startY;
          if (Math.abs(deltaX) < 72 || Math.abs(deltaY) > 48) return;
          switchModelByOffset(deltaX < 0 ? 1 : -1);
        }}
      >
        {isConversationEmpty && selectedModels.length > 0 && (
          <div className="absolute inset-0 z-10 bg-zinc-50 dark:bg-zinc-950">
            <ChatWelcomeScreen
              recentConversations={recentConversations}
              onSelectConversation={onSelectConversation}
              inputSlotRef={setWelcomeInputSlot}
              consentSlotRef={setWelcomeConsentSlot}
            />
          </div>
        )}
        {selectedModels.length > 0 ? (
          selectedModels.map((modelId, panelIndex) => {
            const isActive = resolvedActiveModelId === modelId;

            return (
              <div
                key={`${currentChatId || "new"}:panel:${panelIndex}`}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${
                  isActive ? "flex" : "hidden"
                }`}
                style={isActive ? undefined : { contentVisibility: "hidden" }}
                aria-hidden={!isActive}
              >
                <ChatApp
                  modelId={modelId}
                  initialConversationId={currentChatId}
                  promptPayload={promptPayload}
                  isPanelDisabled={disabledPanels.includes(modelId)}
                  isGuestMode={isGuestMode}
                  webSearchMode={webSearchMode}
                  onBeforeSend={onBeforeModelSend}
                  hideModelOnlyInput
                  useCenteredWelcome
                  onEmptyStateChange={handleEmptyStateChange}
                  onStatusChange={handleModelStatusChange}
                  onResponseComplete={onResponseComplete}
                  onFollowupSent={onFollowupSent}
                  onRequestCloseModel={() => onToggleModel(modelId)}
                  hasMultipleActiveModels={selectedModels.length > 1}
                  stopSignal={stopSignal}
                />
              </div>
            );
          })
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-zinc-500">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-blue-500/10 text-blue-500">
              <Sparkles className="h-7 w-7" />
            </div>
            <p className="text-base font-bold text-zinc-800 dark:text-zinc-100">{t("chat.inactivePanel")}</p>
            <p className="mt-2 max-w-xs text-sm leading-6">{t("chat.chooseModel")}</p>
            <button
              type="button"
              onClick={onNewChat}
              className="mt-5 rounded-full bg-blue-600 px-4 py-2 text-sm font-bold text-white shadow-sm shadow-blue-950/20"
            >
              {t("sidebar.newChat")}
            </button>
          </div>
        )}
      </section>

      <div ref={setBottomConsentSlot} className="shrink-0" />
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
            isNewConversation={isActiveConversationEmpty}
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
            hideDisclaimer
          />,
          inputPortalTarget
        )}

      <p
        data-testid="chat-ai-disclaimer-mobile"
        className="shrink-0 px-2 pb-[calc(0.4rem+env(safe-area-inset-bottom))] pt-1 text-center text-[10px] leading-4 text-zinc-400 dark:text-zinc-500"
      >
        {t("chat.aiDisclaimer")}
      </p>

      {isDrawerOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t("sidebar.title")}
        >
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setIsDrawerOpen(false)}
            aria-label={t("auth.cancel")}
          />
          <div
            ref={drawerPanelRef}
            className="absolute inset-y-0 left-0 z-10 flex w-[min(24rem,92vw)] max-w-full bg-zinc-50 pt-[env(safe-area-inset-top)] shadow-2xl dark:bg-zinc-950"
          >
            <div className="absolute right-[-0.45rem] top-1/2 h-12 w-1.5 -translate-y-1/2 rounded-full bg-white/70 shadow dark:bg-zinc-700/80" aria-hidden="true" />
            <ChatSidebar
              conversations={conversations}
              currentChatId={currentChatId}
              onNewChat={() => {
                setIsDrawerOpen(false);
                onNewChat();
              }}
              onSelectConversation={(id) => {
                setIsDrawerOpen(false);
                onSelectConversation(id);
              }}
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
              currentModelId={resolvedActiveModelId}
              attachmentCount={attachments.length}
              isMobileDrawer
            />
            <button
              ref={drawerCloseButtonRef}
              type="button"
              onClick={() => setIsDrawerOpen(false)}
              className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-900/80 text-white"
              aria-label={t("auth.cancel")}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      <ModeInfoSheet
        mode={modeSheet}
        onClose={() => setModeSheet(null)}
        guestMessageCount={guestMessageCount}
        maxGuestMessages={maxGuestMessages}
        activeModelCount={selectedModels.length}
      />
    </main>
  );
}
