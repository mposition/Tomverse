"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import {
  AVAILABLE_MODELS,
  type ChatAttachment,
  type Conversation,
} from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";
import {
  CheckCircle2,
  Lock,
  Menu,
  Plus,
  Share2,
  Shield,
  Sparkles,
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
  attachments: ChatAttachment[];
  setAttachments: (attachments: ChatAttachment[]) => void;
  isSending: boolean;
  focusToken: number;
  isGuestMode: boolean;
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
  onToggleModel: (modelId: string) => void;
  onSubmit: () => void;
};

export function MobileChatShell({
  conversations,
  currentChatId,
  selectedModels,
  disabledPanels,
  promptPayload,
  inputValue,
  setInputValue,
  attachments,
  setAttachments,
  isSending,
  focusToken,
  isGuestMode,
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
  onSubmit,
}: MobileChatShellProps) {
  const { t } = useLanguage();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(
    selectedModels[0] || null
  );
  const [modelStatuses, setModelStatuses] = useState<Record<string, ModelRuntimeStatus>>({});

  useEffect(() => {
    if (!selectedModels.length) {
      setActiveModelId(null);
      return;
    }

    setActiveModelId((current) =>
      current && selectedModels.includes(current) ? current : selectedModels[0]
    );
  }, [selectedModels]);

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

  const activeModelIndex = activeModelId
    ? selectedModels.indexOf(activeModelId)
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
    () => AVAILABLE_MODELS.find((model) => model.id === activeModelId),
    [activeModelId]
  );
  const currentConversation = conversations.find(
    (conversation) => conversation.id === currentChatId
  );
  const isCurrentLocked = Boolean(currentConversation?.isLocked);
  const isCurrentShared = Boolean(currentConversation?.shareEnabled);
  const activeStatus = activeModelId ? modelStatuses[activeModelId] : "idle";
  const isAnyResponding = Object.values(modelStatuses).some(
    (status) => status === "responding" || status === "loading"
  );

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="shrink-0 border-b border-zinc-200 bg-white px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          aria-label={t("chat.moreActions")}
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">
            {currentConversation?.title || t("sidebar.newChat")}
          </p>
          <p className="truncate text-[11px] font-medium text-zinc-500">
            {activeModel?.name || t("chat.modelSelect")}
          </p>
        </div>
        <button
          type="button"
          onClick={onNewChat}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-950/20"
          aria-label={t("sidebar.newChat")}
        >
          <Plus className="h-5 w-5" />
        </button>
        </div>
        <div className="mt-2 flex min-h-6 gap-1.5 overflow-x-auto">
          {isPrivateMode && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-500/10 px-2 py-1 text-[11px] font-bold text-purple-600 dark:text-purple-300">
              <Shield className="h-3 w-3" />
              Private
            </span>
          )}
          {isGuestMode && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/10 px-2 py-1 text-[11px] font-bold text-blue-600 dark:text-blue-300">
              <Sparkles className="h-3 w-3" />
              Guest {guestMessageCount}/{maxGuestMessages}
            </span>
          )}
          {isCurrentLocked && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-bold text-amber-600 dark:text-amber-300">
              <Lock className="h-3 w-3" />
              {t("sidebar.lockedBadge")}
            </span>
          )}
          {isCurrentShared && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-300">
              <Share2 className="h-3 w-3" />
              {t("sidebar.sharedBadge")}
            </span>
          )}
          {activeModelId && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-bold text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
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
        </div>
      </header>

      {selectedModels.length > 0 && (
        <div className="shrink-0 overflow-x-auto border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="flex min-w-max gap-2" role="tablist" aria-label={t("chat.modelSelect")}>
            {selectedModels.map((modelId) => {
              const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
              const isActive = activeModelId === modelId;
              const isDisabled = disabledPanels.includes(modelId);
              const status = isDisabled ? "paused" : modelStatuses[modelId] || "idle";

              return (
                <button
                  key={modelId}
                  type="button"
                  onClick={() => setActiveModelId(modelId)}
                  aria-pressed={isActive}
                  role="tab"
                  aria-selected={isActive}
                  className={`relative flex h-10 touch-manipulation items-center gap-2 rounded-full border px-3 text-xs font-semibold shadow-sm transition-colors ${
                    isActive
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                  } ${isDisabled ? "opacity-50" : ""}`}
                >
                  <span>{model?.icon}</span>
                  <span>{model?.name || modelId}</span>
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

      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950"
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
        {selectedModels.length > 0 ? (
          selectedModels.map((modelId) => {
            const isActive = activeModelId === modelId;

            return (
              <div
                key={`${modelId}:${currentChatId || "new"}`}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${
                  isActive ? "flex" : "hidden"
                }`}
                aria-hidden={!isActive}
              >
                <ChatApp
                  modelId={modelId}
                  initialConversationId={currentChatId}
                  promptPayload={promptPayload}
                  isPanelDisabled={disabledPanels.includes(modelId)}
                  isGuestMode={isGuestMode}
                  hideModelOnlyInput
                  onStatusChange={handleModelStatusChange}
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

      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSubmit={onSubmit}
        onCancel={() => {}}
        isSending={isSending}
        focusToken={focusToken}
        selectedModels={selectedModels}
        onToggleModel={onToggleModel}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        canAttach={!isGuestMode}
        isGuestMode={isGuestMode}
        isGuestLimitReached={isGuestMode && guestMessageCount >= maxGuestMessages}
      />

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
            className="absolute inset-y-0 left-0 z-10 flex w-[min(21rem,90vw)] max-w-full bg-zinc-50 pt-[env(safe-area-inset-top)] shadow-2xl dark:bg-zinc-950"
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
    </main>
  );
}
