"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import {
  type ChatAttachment,
  type Conversation,
} from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import {
  CheckCircle2,
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
};

type ModelRuntimeStatus = "idle" | "loading" | "responding" | "error" | "paused";

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
  isPrivateMode: boolean;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onLock: (id: string, password: string) => void;
  onUnlock: (id: string) => void;
  onShare: (id: string, title: string) => void;
  onRevokeShare: (id: string) => void;
  onDownload: (id: string, title: string) => void;
  onTogglePrivateMode: () => void;
  onToggleModel: (modelId: string) => boolean;
  onQuickCompare?: () => void;
  onSubmit: () => void;
  onBeforeModelSend: (chatId: string) => Promise<boolean>;
  onCompareSummary: () => void;
  onComparisonReview: () => void;
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
  isPrivateMode,
  onNewChat,
  onSelectConversation,
  onRename,
  onDelete,
  onLock,
  onUnlock,
  onShare,
  onRevokeShare,
  onDownload,
  onTogglePrivateMode,
  onToggleModel,
  onQuickCompare,
  onSubmit,
  onBeforeModelSend,
  onCompareSummary,
  onComparisonReview,
  onResponseComplete,
  onFollowupSent,
}: MobileChatShellProps) {
  const { models: AVAILABLE_MODELS } = useModelCatalog();
  const { t, lang } = useLanguage();
  const helpCopy = chatHelpCopy[lang];
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(
    selectedModels[0] || null
  );
  const [modelStatuses, setModelStatuses] = useState<Record<string, ModelRuntimeStatus>>({});
  const [modelEmptyStates, setModelEmptyStates] = useState<Record<string, boolean>>({});
  const [modeSheet, setModeSheet] = useState<"guest" | "private" | null>(null);
  const resolvedActiveModelId =
    activeModelId && selectedModels.includes(activeModelId)
      ? activeModelId
      : selectedModels[0] || null;
  const conversationStateKey = currentChatId || "new";
  const emptyStateKey = useCallback(
    (modelId: string) => `${conversationStateKey}:${modelId}`,
    [conversationStateKey]
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

  const activeModel = useMemo(
    () => AVAILABLE_MODELS.find((model) => model.id === resolvedActiveModelId),
    [AVAILABLE_MODELS, resolvedActiveModelId]
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
  const isCurrentLocked = Boolean(currentConversation?.isLocked);
  const isCurrentShared = Boolean(currentConversation?.shareEnabled);
  const activeStatus = resolvedActiveModelId
    ? modelStatuses[resolvedActiveModelId]
    : "idle";
  const respondingCount = selectedModels.filter((modelId) => {
    const status = modelStatuses[modelId];
    return status === "responding" || status === "loading";
  }).length;
  const errorCount = selectedModels.filter(
    (modelId) => modelStatuses[modelId] === "error"
  ).length;
  const isAnyResponding = respondingCount > 0;
  const isAnyError = errorCount > 0;
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
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          aria-label={t("chat.moreActions")}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold">
            {currentConversation?.title || t("sidebar.newChat")}
          </p>
          <p className="truncate text-[10px] font-medium text-zinc-500">
            {activeModel?.name || t("chat.modelSelect")}
          </p>
        </div>
        {!isActiveConversationEmpty && (
          <button
            type="button"
            onClick={onNewChat}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-950/20"
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
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/10 px-2 py-1 text-[10px] font-bold text-blue-600 dark:text-blue-300"
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
          {resolvedActiveModelId && selectedModels.length > 1 && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-bold text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
              {isAnyResponding ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
              ) : activeStatus === "error" ? (
                <span className="h-2 w-2 rounded-full bg-red-500" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {activeModel?.name || t("chat.modelSelect")}
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

      {isPrivateMode && (
        <div className="flex shrink-0 items-center justify-between gap-2 bg-purple-500/10 px-3 py-1.5 text-purple-700 dark:text-purple-300">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {t("chat.privateModeHeaderTitle")} · {t("chat.privateModeHeaderNotice")}
            </span>
          </span>
          <button
            type="button"
            onClick={onTogglePrivateMode}
            className="shrink-0 rounded-full border border-purple-300 px-2 py-0.5 text-[10px] font-bold text-purple-700 dark:border-purple-700 dark:text-purple-300"
          >
            {t("chat.privateModeExit")}
          </button>
        </div>
      )}

      <ProviderStatusBanner selectedModels={selectedModels} compact onToggleModel={onToggleModel} />

      {!isConversationEmpty && selectedModels.length > 1 && (
        <div className="min-w-0 shrink-0 overflow-x-auto overscroll-x-contain border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="flex min-w-max gap-2" role="tablist" aria-label={t("chat.modelSelect")}>
            {selectedModels.map((modelId) => {
              const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
              const isActive = resolvedActiveModelId === modelId;
              const isDisabled = disabledPanels.includes(modelId);
              const status = isDisabled ? "paused" : modelStatuses[modelId] || "idle";

              return (
                <button
                  key={modelId}
                  type="button"
                  data-testid="mobile-model-tab"
                  data-model-id={modelId}
                  onClick={() => setActiveModelId(modelId)}
                  role="tab"
                  aria-selected={isActive}
                  aria-label={`${model?.name || modelId} ${status}`}
                  className={`relative flex h-8 max-w-[72vw] touch-manipulation items-center gap-2 rounded-full border px-2.5 text-[11px] font-semibold shadow-sm transition-colors ${
                    isActive
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                  } ${isDisabled ? "opacity-50" : ""}`}
                >
                  <ModelLogo model={model} size="xs" />
                  <span className="truncate">{model?.name || modelId}</span>
                  {status === "responding" || status === "loading" ? (
                    <span className={`h-2 w-2 animate-pulse rounded-full ${isActive ? "bg-white" : "bg-blue-500"}`} />
                  ) : status === "error" ? (
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                  ) : status === "paused" ? (
                    <span className="text-[10px]">OFF</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!isConversationEmpty && selectedModels.length > 1 && currentChatId && (
        <div className={`grid shrink-0 gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950 ${!isGuestMode && currentChatId !== "private-chat" ? "grid-cols-2" : "grid-cols-1"}`}>
          <button
            type="button"
            data-testid="quick-comparison-button"
            onClick={onCompareSummary}
            className="flex h-8 w-full items-center justify-between gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-2 text-[11px] font-black text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200"
          >
            <span className="truncate">{t("chat.quickDifferenceSummary")}</span>
            <CreditCostBadge
              credits={1}
              size="xs"
              label={t("chat.quickDifferenceSummaryCreditCost")}
              testId="quick-comparison-credit-cost"
            />
          </button>
          {!isGuestMode && currentChatId !== "private-chat" && (
            <div className="flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                onClick={onComparisonReview}
                className="flex h-8 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-xl bg-blue-600 px-2 text-[11px] font-black text-white"
              >
                <span className="truncate">{t("chat.aiReviewButton")}</span>
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
              isPrivate={isPrivateMode}
              recentConversations={[]}
              onSelectConversation={onSelectConversation}
              inputSlotRef={setWelcomeInputSlot}
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
                  onBeforeSend={onBeforeModelSend}
                  hideModelOnlyInput
                  useCenteredWelcome
                  onEmptyStateChange={handleEmptyStateChange}
                  onStatusChange={handleModelStatusChange}
                  onResponseComplete={onResponseComplete}
                  onFollowupSent={onFollowupSent}
                  onRequestCloseModel={() => onToggleModel(modelId)}
                  hasMultipleActiveModels={selectedModels.length > 1}
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

      <div ref={setBottomInputSlot} />
      {inputPortalTarget &&
        createPortal(
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            personalizedPrompt={personalizedPrompt}
            onSubmit={onSubmit}
            onCancel={() => {}}
            isSending={isSending}
            focusToken={focusToken}
            isNewConversation={isActiveConversationEmpty}
            isPrivateMode={isPrivateMode}
            selectedModels={selectedModels}
            disabledModelIds={disabledPanels}
            onToggleModel={onToggleModel}
            onQuickCompare={onQuickCompare}
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
              isPrivateMode={isPrivateMode}
              onTogglePrivateMode={onTogglePrivateMode}
              currentModelId={resolvedActiveModelId}
              attachmentCount={attachments.length}
              isMobileDrawer
            />
            <button
              ref={drawerCloseButtonRef}
              type="button"
              onClick={() => setIsDrawerOpen(false)}
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-900/80 text-white"
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
