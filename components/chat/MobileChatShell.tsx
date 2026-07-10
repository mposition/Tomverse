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
import { Menu, Plus, X } from "lucide-react";

type PromptPayload = {
  id: string;
  text: string;
  chatId: string;
  userMessageId: string;
  attachments: ChatAttachment[];
};

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
  const [activeModelId, setActiveModelId] = useState<string | null>(
    selectedModels[0] || null
  );

  useEffect(() => {
    if (!selectedModels.length) {
      setActiveModelId(null);
      return;
    }

    setActiveModelId((current) =>
      current && selectedModels.includes(current) ? current : selectedModels[0]
    );
  }, [selectedModels]);

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

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-3 pt-[env(safe-area-inset-top)] dark:border-zinc-800 dark:bg-zinc-950">
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
      </header>

      {selectedModels.length > 0 && (
        <div className="shrink-0 overflow-x-auto border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="flex min-w-max gap-2">
            {selectedModels.map((modelId) => {
              const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
              const isActive = activeModelId === modelId;
              const isDisabled = disabledPanels.includes(modelId);

              return (
                <button
                  key={modelId}
                  type="button"
                  onClick={() => setActiveModelId(modelId)}
                  aria-pressed={isActive}
                  className={`flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold shadow-sm transition-colors ${
                    isActive
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                  } ${isDisabled ? "opacity-50" : ""}`}
                >
                  <span>{model?.icon}</span>
                  <span>{model?.name || modelId}</span>
                  {isDisabled && <span className="text-[10px]">OFF</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        {activeModelId ? (
          <ChatApp
            key={`${activeModelId}:${currentChatId || "new"}`}
            modelId={activeModelId}
            initialConversationId={currentChatId}
            promptPayload={promptPayload}
            isPanelDisabled={disabledPanels.includes(activeModelId)}
            isGuestMode={isGuestMode}
            hideModelOnlyInput
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-zinc-500">
            <div className="mb-4 text-4xl opacity-50">AI</div>
            <p className="text-sm font-semibold">{t("chat.inactivePanel")}</p>
            <p className="mt-1 text-xs">{t("chat.chooseModel")}</p>
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
            className="absolute inset-y-0 left-0 z-10 flex w-[min(20rem,88vw)] max-w-full bg-zinc-50 shadow-2xl dark:bg-zinc-950"
          >
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
