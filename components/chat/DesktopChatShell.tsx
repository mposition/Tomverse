"use client";

import React from "react";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatInput } from "@/components/chat/ChatInput";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ProviderStatusBanner } from "@/components/chat/ProviderStatusBanner";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import {
  AVAILABLE_MODELS,
  ENABLED_MODELS,
  getModelUsageProfile,
  type ChatAttachment,
  type Conversation,
} from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";

type PromptPayload = {
  id: string;
  text: string;
  chatId: string;
  userMessageId: string;
  attachments: ChatAttachment[];
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
  onSubmit: () => void;
  onChangePanelModel: (oldModelId: string, newModelId: string) => void;
  onTogglePanelDisable: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onCompareSummary: () => void;
  onComparisonReview: () => void;
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
  onChangePanelModel,
  onTogglePanelDisable,
  onRemoveModel,
  onCompareSummary,
  onComparisonReview,
  onResponseComplete,
  onFollowupSent,
}: DesktopChatShellProps) {
  const { t, lang } = useLanguage();
  const helpCopy = chatHelpCopy[lang];

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
        isPrivateMode={isPrivateMode}
        onTogglePrivateMode={onTogglePrivateMode}
        currentModelId={selectedModels[0]}
        attachmentCount={attachments.length}
      />

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ProviderStatusBanner selectedModels={selectedModels} compact onToggleModel={onToggleModel} />
        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden bg-zinc-100/80 px-4 pb-4 pt-3 dark:bg-zinc-950">
          {selectedModels.length === 0 && (
            <div className="flex flex-1 select-none flex-col items-center justify-center text-zinc-500">
              <div className="mb-4 text-4xl opacity-50">AI</div>
              <p className="text-sm font-medium">{t("chat.inactivePanel")}</p>
              <p className="mt-1 text-xs opacity-70">{t("chat.chooseModel")}</p>
            </div>
          )}

          {selectedModels.map((modelId) => {
            const modelInfo = AVAILABLE_MODELS.find((model) => model.id === modelId);
            const usageProfile = modelInfo
              ? getModelUsageProfile(modelInfo)
              : null;
            const isPanelDisabled = disabledPanels.includes(modelId);

            return (
              <div
                key={modelId}
                data-testid="desktop-model-panel"
                data-model-id={modelId}
                className={`relative flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm shadow-zinc-200/60 transition-all duration-300 ease-in-out dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-black/20 ${
                  isPanelDisabled ? "w-44 shrink-0" : "min-w-0 flex-1"
                }`}
              >
                <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400">
                  <div className={`flex min-w-0 flex-1 items-center gap-2 transition-opacity ${isPanelDisabled ? "opacity-50" : ""}`}>
                    <ModelLogo model={modelInfo} size="md" />

                    {isPanelDisabled ? (
                      <span className="flex min-w-0 select-none flex-col truncate">
                        <span className="truncate text-sm font-semibold text-zinc-600 dark:text-zinc-300">{modelInfo?.name}</span>
                        <span className="truncate text-[10px] font-medium text-zinc-400">{modelInfo?.provider}</span>
                      </span>
                    ) : (
                      <span className="flex min-w-0 flex-col">
                        <select
                          value={modelId}
                          onChange={(event) => onChangePanelModel(modelId, event.target.value)}
                          disabled={isPanelDisabled}
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
                        <span className="truncate text-[10px] font-medium text-zinc-400">
                          {modelInfo?.provider}
                          {usageProfile
                            ? ` · ${t(`modelUsageClasses.${usageProfile.category.toLowerCase()}`)} · ${usageProfile.credits}`
                            : ""}
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
                  key={`${modelId}:${currentChatId || "new"}`}
                  modelId={modelId}
                  initialConversationId={currentChatId}
                  promptPayload={promptPayload}
                  isPanelDisabled={isPanelDisabled}
                  isGuestMode={isGuestMode}
                  onResponseComplete={onResponseComplete}
                  onFollowupSent={onFollowupSent}
                />
              </div>
            );
          })}
        </div>

        {selectedModels.length > 1 && currentChatId && (
          <div className="flex gap-2 border-t border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
            <button
              type="button"
              data-testid="quick-comparison-button"
              onClick={onCompareSummary}
              className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-black text-blue-700 hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200 dark:hover:bg-blue-950"
            >
              {t("chat.quickDifferenceSummary")}
            </button>
            {!isGuestMode && currentChatId !== "private-chat" && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onComparisonReview}
                  className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-black text-white hover:bg-blue-500"
                >
                  {t("chat.aiReviewButton")}
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

        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          personalizedPrompt={personalizedPrompt}
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
      </section>
    </main>
  );
}
