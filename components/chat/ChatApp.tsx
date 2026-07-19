"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { Message, type ChatAttachment } from "@/components/chat/types";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { useTurnstile } from "@/components/chat/useTurnstile";
import { ArrowUp, PauseCircle } from "lucide-react";
import {
  formatChatCostSafetyDetails,
  isChatCostSafetyCode,
} from "@/lib/chatCostSafetyCore";

const processedPromptKeys = new Set<string>();
const CHAT_STREAM_IDLE_TIMEOUT_MS = 90_000;

const toChatRequestMessage = (message: Message): Message => {
  if (!message.attachments?.length) return message;

  return {
    ...message,
    attachments: message.attachments.map((attachment) => {
      if (!attachment.objectKey) return attachment;

      const requestAttachment = { ...attachment };
      delete requestAttachment.data;
      return requestAttachment;
    }),
  };
};

type ChatAppProps = {
  modelId: string;
  initialConversationId?: string | null;
  promptPayload?: { id: string; text: string; chatId: string; userMessageId: string; attachments: ChatAttachment[] } | null;
  isPanelDisabled?: boolean;
  isGuestMode?: boolean;
  hideModelOnlyInput?: boolean;
  onStatusChange?: (
    modelId: string,
    status: "idle" | "loading" | "responding" | "error" | "paused"
  ) => void;
  onResponseComplete?: (
    promptId: string | null,
    modelId: string,
    responseText: string
  ) => void;
  onFollowupSent?: (modelId: string) => void;
};

function ChatAppComponent({
  modelId,
  initialConversationId = null,
  promptPayload,
  isPanelDisabled = false,
  isGuestMode = false,
  hideModelOnlyInput = false,
  onStatusChange,
  onResponseComplete,
  onFollowupSent,
}: ChatAppProps) {
  const [isMessagesLoaded, setIsMessagesLoaded] = useState(false);
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id || null;
    const { t } = useLanguage();
  const {
    containerRef: turnstileContainerRef,
    getToken: getTurnstileToken,
  } = useTurnstile(isGuestMode && !isPanelDisabled);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
          content: t("chat.welcome"),
	  status: "normal",
    },
  ]);
  
    const [isSending, setIsSending] = useState(false);
    const [modelInput, setModelInput] = useState("");
  
  const isSendingRef = useRef(false);
  const streamingChatIdRef = useRef<string | null>(null);
  const lastFetchedConversationKeyRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
    const loadedChatIdRef = useRef<string | null>(null);
  const lastPromptRef = useRef<{
    text: string;
    targetChatId: string;
    attachments: ChatAttachment[];
  } | null>(null);

  const isPrivate = initialConversationId === "private-chat";

  useEffect(() => {
    if (isPanelDisabled) {
      onStatusChange?.(modelId, "paused");
      return;
    }

    if (isSending) {
      onStatusChange?.(modelId, "responding");
      return;
    }

    const hasError = messages.some(
      (message) => message.role === "assistant" && message.status === "error"
    );
    onStatusChange?.(modelId, hasError ? "error" : "idle");
  }, [isPanelDisabled, isSending, messages, modelId, onStatusChange]);

  const setAssistantMessage = useCallback((id: string, content: string, status?: Message["status"]) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id ? { ...message, content, status } : message
      )
    );
  }, []);

    useEffect(() => {
        if (!isPrivate && !isGuestMode && !sessionUserId) {
        return;
    }

	  let isMounted = true;
    queueMicrotask(() => {
    if (!isMounted) return;

    if (isPrivate) {
      lastFetchedConversationKeyRef.current = "private-chat";
      return;
    }

    if (isGuestMode) {
      setIsMessagesLoaded(false);

        if (initialConversationId) {
            loadedChatIdRef.current = initialConversationId;

        const storageKey = `guest_messages_${initialConversationId}_${modelId}`;
        const savedMessages = localStorage.getItem(storageKey);
        if (savedMessages) {
          try {
            setMessages(JSON.parse(savedMessages));
          } catch (e) {
            console.error("Failed to load guest messages:", e);
            setMessages([]);
          }
        } else {
          setMessages([
            { id: "welcome", role: "assistant", content: t("chat.guestWelcome"), status: "normal" }
          ]);
        }
      } else {
        setMessages([]);
      }

      setIsMessagesLoaded(true);
      return;
    }

	if (initialConversationId && initialConversationId !== "guest-chat") {
      const conversationKey = `${sessionUserId || "guest"}:${initialConversationId}:${modelId}`;
      if (conversationKey === lastFetchedConversationKeyRef.current) return;
      lastFetchedConversationKeyRef.current = conversationKey;
	  
      const fetchPastMessages = async () => {
        try {
          const modelQuery = `modelId=${encodeURIComponent(modelId)}`;
		      const response = await fetch(`/api/conversations/${initialConversationId}?${modelQuery}`, {
            cache: "no-store",
            headers: { 'Cache-Control': 'no-cache' }
          });			
          if (response.ok) {
            const data = await response.json();
            let nextCursor = data.messagePage?.nextCursor;
            while (data.messagePage?.hasMore && nextCursor && isMounted) {
              const pageResponse = await fetch(
                `/api/conversations/${initialConversationId}?${modelQuery}&cursor=${encodeURIComponent(nextCursor)}`,
                {
                  cache: "no-store",
                  headers: { "Cache-Control": "no-cache" },
                }
              );
              if (!pageResponse.ok) break;
              const pageData = await pageResponse.json();
              if (Array.isArray(pageData.messages)) {
                data.messages.push(...pageData.messages);
              }
              data.messagePage = pageData.messagePage;
              nextCursor = pageData.messagePage?.nextCursor;
            }
			    if (isMounted) {              
              if (isSendingRef.current && streamingChatIdRef.current === initialConversationId) {
                return; 
              }
          }

          if (data.messages && data.messages.length > 0) {
            const filteredMessages: Message[] = [];
            const seenUserIds = new Set();
				    let hasMyAssistantMsg = false;

            for (const msg of data.messages) {
              if (msg.role === "assistant" && (!msg.modelId || msg.modelId === modelId)) {
                hasMyAssistantMsg = true;
                break;
              }
            }

            if (!hasMyAssistantMsg) {
              setMessages([{ id: "welcome", role: "assistant", content: t("chat.welcome"), status: "normal" }]);
            } else {				
              for (const msg of data.messages) {
                if (msg.role === "user") {
                    if ((!msg.modelId || msg.modelId === modelId) && !seenUserIds.has(msg.id)) {
                        seenUserIds.add(msg.id);
                        filteredMessages.push(msg);
                    }
                } 
                else if (msg.role === "assistant" && msg.modelId === modelId) {
                  filteredMessages.push(msg);
					      }
					    }
				    }
				
              setMessages(filteredMessages.length > 0 ? filteredMessages : [{ id: "welcome", role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          } else {
              setMessages([{ id: "welcome", role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          }
        }
      } catch (error) {
        console.error("Failed to load conversation messages:", error);
      }
    };

      fetchPastMessages();
  } 
    else {
	    lastFetchedConversationKeyRef.current = null;
	  
        setMessages([
        {
          id: "welcome",
          role: "assistant",
                content: t("chat.welcome"),
          status: "normal",
        },
        ]);
    }
    });
	
	  return () => {
      isMounted = false;
    };	
  }, [
    initialConversationId,
    isPrivate,
    isGuestMode,
    modelId,
    sessionUserId,
    t,
  ]);
  
  useEffect(() => {
      if (isGuestMode && initialConversationId && isMessagesLoaded && messages.length > 0) {
          if (loadedChatIdRef.current === initialConversationId) {
              const storageKey = `guest_messages_${initialConversationId}_${modelId}`;
              localStorage.setItem(storageKey, JSON.stringify(messages));
          }
    }
  }, [messages, isGuestMode, initialConversationId, modelId, isMessagesLoaded]);

  const handleSendPrompt = useCallback(async (
    text: string,
    targetChatId: string,
    userMsgId: string,
    attachments: ChatAttachment[] = [],
    analyticsPromptId: string | null = null
  ) => {
  	if ((!text && attachments.length === 0) || isSendingRef.current) return;

    lastPromptRef.current = { text, targetChatId, attachments };
    setIsSending(true);
	isSendingRef.current = true;
    streamingChatIdRef.current = targetChatId;
	
    const userMessage: Message = {
      id: userMsgId,
      role: "user",
      content: text,
      attachments,
	  status: "normal",
    };

    const assistantMessageId = crypto.randomUUID();
    const assistantMessage: Message = { 
		id: assistantMessageId, 
		role: "assistant", 
		content: "", 
		status: "normal", 
		modelId: modelId 
	};
	
    setMessages((prev) => [
      ...prev,
      userMessage,
      assistantMessage,
    ]);

    setIsSending(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let idleTimeoutId: number | null = null;
    const resetIdleTimeout = () => {
      if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
      }
      idleTimeoutId = window.setTimeout(() => {
        controller.abort();
      }, CHAT_STREAM_IDLE_TIMEOUT_MS);
    };
    resetIdleTimeout();
    let requestTraceId: string | null = null;
	
    try {
      const turnstileToken = isGuestMode
        ? await getTurnstileToken()
        : undefined;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(toChatRequestMessage),
          modelId: modelId,
          ...(turnstileToken ? { turnstileToken } : {}),
          ...(!isPrivate && !isGuestMode
            ? {
                conversationId: targetChatId,
                assistantMessageId,
              }
            : {}),
        }),
        signal: controller.signal,
      });
      resetIdleTimeout();
      requestTraceId = response.headers.get("X-Request-ID");

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        requestTraceId =
          typeof errorBody?.traceId === "string"
            ? errorBody.traceId
            : requestTraceId;
        const requestError = new Error(`Chat request failed: ${response.status}`);
        (requestError as Error & { traceId?: string }).traceId =
          requestTraceId || undefined;
        (requestError as Error & { code?: string }).code =
          typeof errorBody?.code === "string" ? errorBody.code : undefined;
        (requestError as Error & { publicMessage?: string }).publicMessage =
          typeof errorBody?.error === "string" ? errorBody.error : undefined;
        (requestError as Error & { details?: unknown }).details =
          errorBody?.details;
        throw requestError;
      }

      if (!response.body) {
        throw new Error(t("chat.responseBodyMissing"));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetIdleTimeout();
        assistantText += decoder.decode(value, { stream: true });
		setAssistantMessage(assistantMessageId, assistantText, "normal");
      }

	  if (!assistantText.trim()) {
        if (requestTraceId && typeof window !== "undefined") {
          window.localStorage.setItem(
            "tomverse_last_error_trace_id",
            requestTraceId
          );
        }
        setAssistantMessage(
          assistantMessageId,
          `${t("chat.responseEmpty")}${
            requestTraceId
              ? `\n${t("chat.traceId")}: ${requestTraceId}`
              : ""
          }`,
          "error"
        );
      } else {
        onResponseComplete?.(analyticsPromptId, modelId, assistantText);
      }
    } catch (error: unknown) {
      const requestError =
        error && typeof error === "object"
          ? (error as {
              name?: unknown;
              code?: unknown;
              traceId?: unknown;
              publicMessage?: unknown;
              details?: unknown;
            })
          : {};
      if (requestError.name === "AbortError") {
        setAssistantMessage(
          assistantMessageId,
          t("chat.responseCancelled"),
          "cancelled"
        );
      } else {
        const traceId =
          typeof requestError.traceId === "string"
            ? requestError.traceId
            : requestTraceId;
        console.error("Chat request failed", {
          traceId: traceId || undefined,
        });
        if (traceId && typeof window !== "undefined") {
          window.localStorage.setItem("tomverse_last_error_trace_id", traceId);
        }
        const errorCode =
          typeof requestError.code === "string" ? requestError.code : "";
        const localizedRequestError =
          errorCode === "CREDIT_BALANCE_INSUFFICIENT" ||
          errorCode === "CREDIT_COST_ALLOWANCE_INSUFFICIENT"
            ? t("chat.comparisonCreditsInsufficient")
            : errorCode === "INTERNAL_DAILY_COST_SAFETY_LIMIT"
              ? t("chat.internalDailyCostSafetyLimit")
              : errorCode === "INTERNAL_MONTHLY_COST_SAFETY_LIMIT"
                ? t("chat.internalMonthlyCostSafetyLimit")
                : errorCode === "PROVIDER_DAILY_SPEND_LIMIT_REACHED" ||
                    errorCode === "PROVIDER_SPEND_LIMIT_REACHED"
                  ? t("chat.providerCostSafetyLimit")
                  : errorCode === "PLAN_DAILY_CREDIT_LIMIT_REACHED"
                    ? t("chat.dailyPlanCreditsUnavailable")
                    : errorCode === "CHAT_CONCURRENCY_EXCEEDED"
                    ? t("chat.comparisonConcurrencyLimit")
                    : errorCode === "FREE_PRO_MODEL_QUOTA_EXCEEDED"
                      ? t("chat.comparisonHigherCostQuotaExceeded")
                  : errorCode === "CHAT_QUOTA_EXCEEDED"
                    ? t("chat.comparisonDailyCreditsInsufficient")
                    : null;
        const costSafetyDetails = isChatCostSafetyCode(errorCode)
          ? formatChatCostSafetyDetails(requestError.details)
          : "";
        setAssistantMessage(
          assistantMessageId,
          `${errorCode === "MODEL_RETIRED"
            ? t("chat.modelRetired")
            : localizedRequestError || typeof requestError.publicMessage === "string"
              ? localizedRequestError || requestError.publicMessage
              : t("chat.responseError")}${
            costSafetyDetails ? `\n${costSafetyDetails}` : ""
          }${
            traceId ? `\n${t("chat.traceId")}: ${traceId}` : ""
          }`,
          "error"
        );
      }	
    } finally {
	  if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
      }

      setIsSending(false);
      isSendingRef.current = false;
      streamingChatIdRef.current = null;
      abortControllerRef.current = null;
    }
  }, [
    getTurnstileToken,
    isGuestMode,
    isPrivate,
    messages,
    modelId,
    onResponseComplete,
    setAssistantMessage,
    t,
  ]);

  const handleRetryLast = useCallback(() => {
    const lastPrompt = lastPromptRef.current;
    if (!lastPrompt || isSendingRef.current) return;

    const retryUserMessageId = crypto.randomUUID();
    void handleSendPrompt(
      lastPrompt.text,
      lastPrompt.targetChatId,
      retryUserMessageId,
      lastPrompt.attachments
    );
  }, [handleSendPrompt]);

  const handleRetryWithoutAttachments = useCallback(() => {
    const lastPrompt = lastPromptRef.current;
    if (!lastPrompt || isSendingRef.current) return;

    void handleSendPrompt(
      lastPrompt.text,
      lastPrompt.targetChatId,
      crypto.randomUUID(),
      []
    );
  }, [handleSendPrompt]);

  useEffect(() => {
    if (!isGuestMode && status === "loading") return;
    if (!isGuestMode && !session?.user) return;
    if (!promptPayload || promptPayload.chatId !== initialConversationId) return;

    const promptKey = `${promptPayload.id}:${promptPayload.chatId}:${modelId}`;
    if (processedPromptKeys.has(promptKey)) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || isPanelDisabled) return;
      if (processedPromptKeys.has(promptKey)) return;
      processedPromptKeys.add(promptKey);
      void handleSendPrompt(
          promptPayload.text,
          promptPayload.chatId,
          promptPayload.userMessageId,
          promptPayload.attachments,
          promptPayload.id
        );
    });
    return () => {
      cancelled = true;
    };
  }, [
    handleSendPrompt,
    initialConversationId,
    isGuestMode,
    isPanelDisabled,
    modelId,
    promptPayload,
    session?.user,
    status,
  ]);

    const handleModelOnlySubmit = async () => {
        const trimmed = modelInput.trim();
        if (!trimmed || isSendingRef.current || isPanelDisabled || !initialConversationId) return;

        const userMsgId = crypto.randomUUID();
        setModelInput("");
        onFollowupSent?.(modelId);

        if (!isPrivate && !isGuestMode) {
            try {
                await fetch(`/api/conversations/${initialConversationId}/messages`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        messages: [{ id: userMsgId, role: "user", content: trimmed, modelId }],
                    }),
                });
            } catch (error) {
                console.error("model-only user message save failed:", error);
            }
        }

        await handleSendPrompt(trimmed, initialConversationId, userMsgId);
    };

  return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {!isPanelDisabled ? (
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                  <div className="min-h-0 flex-1 overflow-hidden">
      <ChatMessageList
        messages={messages}
        isPrivate={isPrivate}
        isGuestMode={isGuestMode}
        onRetryLast={handleRetryLast}
        onRetryWithoutAttachments={handleRetryWithoutAttachments}
      />
                  </div>
                  {isGuestMode ? (
                    <div
                      ref={turnstileContainerRef}
                      className="shrink-0 px-3 pb-2"
                    />
                  ) : null}

                  {!hideModelOnlyInput && (
                  <form
                      onSubmit={(event) => {
                          event.preventDefault();
                          handleModelOnlySubmit();
                      }}
                      className="flex shrink-0 items-end gap-2 border-t border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/95"
                  >
                      <div className="flex min-w-0 flex-1 items-end gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 shadow-sm focus-within:border-blue-500 dark:border-zinc-800 dark:bg-zinc-900">
                          <textarea
                              value={modelInput}
                              onChange={(event) => setModelInput(event.target.value)}
                              onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                      event.preventDefault();
                                      handleModelOnlySubmit();
                                  }
                              }}
                              disabled={isSending || !initialConversationId}
                              rows={1}
                              placeholder={t("chat.modelOnlyPlaceholder")}
                              className="max-h-28 min-h-7 flex-1 resize-none border-0 bg-transparent py-1 text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                          />
                      </div>
                      <button
                          type="submit"
                          disabled={!modelInput.trim() || isSending || !initialConversationId}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500"
                          title={t("chat.modelOnlySendTitle")}
                          aria-label={t("chat.modelOnlySendTitle")}
                      >
                          <ArrowUp className="h-5 w-5" />
                      </button>
                  </form>
                  )}
              </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-4 select-none">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
            <PauseCircle className="h-6 w-6" />
          </div>
          <div className="text-xs text-zinc-600 font-medium text-center break-keep dark:text-zinc-400">
            {t("chat.panelPaused")}
          </div>
        </div>
      )}
    </div>
  );
}

export const ChatApp = memo(ChatAppComponent);
