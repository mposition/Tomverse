"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { Message, type ChatAttachment } from "@/components/chat/types";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { ArrowUp, PauseCircle } from "lucide-react";
import {
  formatChatCostSafetyDetails,
  isChatCostSafetyCode,
} from "@/lib/chatCostSafetyCore";
import { useIsMobileShell } from "@/components/chat/useIsMobileShell";
import {
  getChatEnterKeyAction,
  isComposingKeydown,
} from "@/lib/chatKeyboardPolicy";
import type { WebSearchMode } from "@/lib/appDefaults";
import { splitSearchMetadataTrailer } from "@/lib/webSearchStreamTrailer";
import type { WebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import { guestMessagesStorageKey } from "@/lib/guestConversationStorage";

const processedPromptKeys = new Set<string>();
const CHAT_STREAM_IDLE_TIMEOUT_MS = 90_000;

// The greeting bubble an empty conversation renders. It is UI, not
// transcript: it is never persisted, and it must never be sent to
// /api/chat. Doing so put an assistant turn ahead of the first user turn,
// which Perplexity's async deep-research endpoint rejects outright
// ("user or tool message(s) should alternate with assistant message(s)")
// and every other provider merely pays for as a wasted input turn.
const WELCOME_MESSAGE_ID = "welcome";

const isTranscriptMessage = (message: Message) =>
  message.id !== WELCOME_MESSAGE_ID;

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
  promptPayload?: {
    id: string;
    text: string;
    chatId: string;
    userMessageId: string;
    attachments: ChatAttachment[];
    deepResearchDepth?: "quick" | "standard" | "deep";
  } | null;
  isPanelDisabled?: boolean;
  isGuestMode?: boolean;
  webSearchMode?: WebSearchMode;
  hideModelOnlyInput?: boolean;
  useCenteredWelcome?: boolean;
  onEmptyStateChange?: (modelId: string, isEmpty: boolean) => void;
  onStatusChange?: (
    modelId: string,
    status: "idle" | "loading" | "responding" | "error" | "cancelled" | "paused"
  ) => void;
  onResponseComplete?: (
    promptId: string | null,
    modelId: string,
    responseText: string,
    searchMetadata?: WebSearchExecution | null
  ) => void;
  onFollowupSent?: (modelId: string) => void;
  onBeforeSend?: (chatId: string) => Promise<boolean>;
  onRequestCloseModel?: () => void;
  hasMultipleActiveModels?: boolean;
  currentPlan?: string | null;
  // Bumped by the parent (e.g. a global "stop all" button) to abort this
  // panel's in-flight request, if any. A counter rather than a boolean so
  // every increment reliably re-triggers the effect even if the previous
  // stop request already completed.
  stopSignal?: number;
};

function ChatAppComponent({
  modelId,
  initialConversationId = null,
  promptPayload,
  isPanelDisabled = false,
  isGuestMode = false,
  webSearchMode,
  hideModelOnlyInput = false,
  useCenteredWelcome = false,
  onEmptyStateChange,
  onStatusChange,
  onResponseComplete,
  onFollowupSent,
  onBeforeSend,
  onRequestCloseModel,
  hasMultipleActiveModels = false,
  currentPlan,
  stopSignal,
}: ChatAppProps) {
  const [isMessagesLoaded, setIsMessagesLoaded] = useState(false);
  const [loadedMessageViewKey, setLoadedMessageViewKey] = useState<string | null>(null);
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id || null;
    const { t } = useLanguage();
  // No panel owns a Turnstile widget any more: verification is a property of
  // the guest session, so the chat shell's single coordinator runs it (and
  // shows it, once, in the shell's own verification surface).
  const { runGuestChatRequest } = useGuestVerification();

  const [messages, setMessages] = useState<Message[]>([
    {
      id: WELCOME_MESSAGE_ID,
      role: "assistant",
          content: t("chat.welcome"),
	  status: "normal",
    },
  ]);
  
    const isMobileShell = useIsMobileShell();
    const [isSending, setIsSending] = useState(false);
    const [modelInputs, setModelInputs] = useState<Record<string, string>>({});
    const modelInput = modelInputs[modelId] || "";
    const setModelInput = (value: string) => {
      setModelInputs((current) => ({ ...current, [modelId]: value }));
    };
  
  const isSendingRef = useRef(false);
  /** True while an IME composition is in progress in the model-only composer. */
  const isModelInputComposingRef = useRef(false);
  const streamingChatIdRef = useRef<string | null>(null);
  // Guards for the message-view loader below. `requestedViewKeyRef` dedupes
  // repeat loads of the same view; `loadRequestIdRef` identifies the newest
  // load so a superseded one settles nothing and the current one always does.
  const requestedViewKeyRef = useRef<string | null>(null);
  const loadRequestIdRef = useRef(0);
  // Bumped whenever this panel adds messages of its own. Lets an in-flight
  // history load tell "still describes the current conversation" from
  // "superseded by a send that happened while I was loading".
  const localMessageRevisionRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
    const loadedChatIdRef = useRef<string | null>(null);
  const lastPromptRef = useRef<{
    text: string;
    targetChatId: string;
    attachments: ChatAttachment[];
  } | null>(null);

  const expectedMessageViewKey = `${
    isGuestMode ? "guest" : sessionUserId || "account"
  }:${initialConversationId || "new"}:${modelId}`;
  const isCurrentMessageViewLoaded =
    isMessagesLoaded && loadedMessageViewKey === expectedMessageViewKey;

  useEffect(() => {
    if (isPanelDisabled) {
      onStatusChange?.(modelId, "paused");
      return;
    }

    if (isSending) {
      onStatusChange?.(modelId, "responding");
      return;
    }

    // Only the most recent assistant reply should count -- otherwise a
    // successful retry after an earlier failure could never clear the
    // "error"/"cancelled" status, since that old reply never leaves history.
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");
    // A user-stopped response must not read as "idle"/ready: it's what lets
    // a comparison-summary or AI Review request wrongly treat a stopped
    // panel as a real, completed answer.
    const status =
      lastAssistantMessage?.status === "error"
        ? "error"
        : lastAssistantMessage?.status === "cancelled"
          ? "cancelled"
          : "idle";
    onStatusChange?.(modelId, status);
  }, [isPanelDisabled, isSending, messages, modelId, onStatusChange]);

  // Bumped by the parent to request an abort of this panel's in-flight
  // request, if any. AbortController.abort() on an already-settled (or
  // already-null) controller is a safe no-op, so this stays correct even if
  // clicked repeatedly or after this panel already finished on its own.
  useEffect(() => {
    if (stopSignal === undefined) return;
    abortControllerRef.current?.abort();
  }, [stopSignal]);

  // Lets the message list offer a per-panel stop button, distinct from the
  // shell's "stop all" button which drives every panel via stopSignal.
  const stopThisPanel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const isConversationEmpty =
    messages.length === 0 ||
    (messages.length === 1 && messages[0]?.id === WELCOME_MESSAGE_ID);

  useLayoutEffect(() => {
    if (!isCurrentMessageViewLoaded) return;
    onEmptyStateChange?.(modelId, isConversationEmpty);
  }, [isCurrentMessageViewLoaded, isConversationEmpty, modelId, onEmptyStateChange]);

  const setAssistantMessage = useCallback((
    id: string,
    content: string,
    status?: Message["status"],
    errorMeta?: { errorCode?: string; errorHadAttachments?: boolean },
    extraFields?: Partial<Message>
  ) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id
          ? { ...message, content, status, ...errorMeta, ...extraFields }
          : message
      )
    );
  }, []);

  const deepResearchPhaseText = useCallback(
    (elapsedMs: number) => {
      if (elapsedMs < 30_000) return t("chat.deepResearchRequestingStatus");
      if (elapsedMs < 120_000) return t("chat.deepResearchSearchingStatus");
      return t("chat.deepResearchWritingStatus");
    },
    [t]
  );

  // Perplexity's sonar-deep-research model can't stream -- app/api/chat/route.ts
  // submits it as an async job and returns immediately, so this polls the
  // dedicated status endpoint until Perplexity reports a terminal state. No
  // idle-timeout/AbortController-driven fetch is involved here on purpose:
  // each poll is a short, independent request, so there's no single
  // long-held connection that can stall. `signal` only stops this loop
  // client-side (the job keeps running server-side either way) -- checked
  // between ticks rather than passed into fetch, so a stop takes effect
  // within one poll interval instead of needing its own abort plumbing.
  const pollDeepResearchJob = useCallback(
    async (
      jobAssistantMessageId: string,
      submittedAtMs: number,
      signal: AbortSignal,
      analyticsPromptId: string | null = null
    ) => {
      const POLL_INTERVAL_MS = 5_000;
      const TAKING_LONGER_THRESHOLD_MS = 5 * 60 * 1000;

      while (true) {
        if (signal.aborted) {
          setAssistantMessage(jobAssistantMessageId, t("chat.responseCancelled"), "cancelled");
          return;
        }

        const elapsedMs = Date.now() - submittedAtMs;
        const phaseText =
          elapsedMs > TAKING_LONGER_THRESHOLD_MS
            ? `${deepResearchPhaseText(elapsedMs)}\n${t("chat.deepResearchTakingLonger")}`
            : deepResearchPhaseText(elapsedMs);
        setAssistantMessage(jobAssistantMessageId, phaseText, "normal");

        let poll: { status?: string; content?: string; error?: string } | null = null;
        try {
          const res = await fetch("/api/chat/deep-research/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assistantMessageId: jobAssistantMessageId }),
          });
          if (res.ok) poll = await res.json();
        } catch {
          // Transient network error talking to our own status endpoint --
          // just retry on the next tick instead of failing the job.
        }

        if (poll?.status === "completed") {
          const content = poll.content || "";
          setAssistantMessage(jobAssistantMessageId, content, "normal");
          onResponseComplete?.(analyticsPromptId, modelId, content);
          return;
        }
        if (poll?.status === "failed") {
          setAssistantMessage(
            jobAssistantMessageId,
            poll.error || t("chat.responseError"),
            "error",
            { errorCode: "DEEP_RESEARCH_FAILED" }
          );
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
    [deepResearchPhaseText, modelId, onResponseComplete, setAssistantMessage, t]
  );

  // Resumes polling for a deep-research job that was still pending when this
  // panel (re)mounted -- e.g. the user refreshed mid-research. The job keeps
  // running server-side regardless of whether any tab is open, so this just
  // reattaches the UI to it using the persisted pendingJobId instead of
  // losing track of an in-flight request on every reload.
  const resumedDeepResearchJobsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isCurrentMessageViewLoaded || isSendingRef.current) return;
    const pendingMessage = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.status === "pending" &&
        Boolean(message.pendingJobId)
    );
    if (!pendingMessage || resumedDeepResearchJobsRef.current.has(pendingMessage.id)) {
      return;
    }
    resumedDeepResearchJobsRef.current.add(pendingMessage.id);

    setIsSending(true);
    isSendingRef.current = true;
    streamingChatIdRef.current = initialConversationId;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const submittedAtMs = pendingMessage.createdAt
      ? new Date(pendingMessage.createdAt).getTime()
      : Date.now();

    pollDeepResearchJob(pendingMessage.id, submittedAtMs, controller.signal).finally(() => {
      setIsSending(false);
      isSendingRef.current = false;
      streamingChatIdRef.current = null;
      abortControllerRef.current = null;
    });
  }, [initialConversationId, isCurrentMessageViewLoaded, messages, pollDeepResearchJob]);

  // Loads the message view for the current (account, conversation, model)
  // triple. Two rules keep it deterministic:
  //
  //  * Only the newest load may settle `isMessagesLoaded` /
  //    `loadedMessageViewKey`, tracked by `loadRequestIdRef` rather than by
  //    invalidating the in-flight load from the effect cleanup. The old
  //    cleanup-based version combined with a dedup guard that returned
  //    *before* settling, so an effect re-run while a fetch was in flight
  //    left the view permanently unloaded: the previous run could no longer
  //    settle it and the new run returned early without settling it either.
  //    The panel then rendered its loading placeholder forever, which is why
  //    a send could clear the composer and create the sidebar conversation
  //    while the main panel showed no user message at all.
  //  * The current load always settles, including when it bails out because
  //    this panel started streaming in the meantime.
  useEffect(() => {
    if (!isGuestMode && !sessionUserId) return;

    if (isGuestMode) {
      // Resolves synchronously from localStorage, so no interim "loading"
      // state is needed: `isCurrentMessageViewLoaded` already reads as false
      // for this view until `loadedMessageViewKey` catches up below.
      // Bookkeeping stays synchronous so a second effect run in the same tick
      // cannot start a competing load; only the state writes are deferred.
      const requestId = (loadRequestIdRef.current += 1);
      requestedViewKeyRef.current = expectedMessageViewKey;

      queueMicrotask(() => {
        if (loadRequestIdRef.current !== requestId) return;

        if (initialConversationId) {
          loadedChatIdRef.current = initialConversationId;

          const storageKey = guestMessagesStorageKey(initialConversationId, modelId);
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
              { id: WELCOME_MESSAGE_ID, role: "assistant", content: t("chat.guestWelcome"), status: "normal" },
            ]);
          }
        } else {
          setMessages([]);
        }

        setIsMessagesLoaded(true);
        setLoadedMessageViewKey(expectedMessageViewKey);
      });
      return;
    }

    if (initialConversationId && initialConversationId !== "guest-chat") {
      // Already loaded, or a load for this exact view is still running.
      // Safe to skip only because that load is guaranteed to settle.
      if (requestedViewKeyRef.current === expectedMessageViewKey) return;

      requestedViewKeyRef.current = expectedMessageViewKey;
      const requestId = (loadRequestIdRef.current += 1);
      const isCurrentLoad = () => loadRequestIdRef.current === requestId;
      const revisionAtStart = localMessageRevisionRef.current;
      setIsMessagesLoaded(false);

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
            while (data.messagePage?.hasMore && nextCursor && isCurrentLoad()) {
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
            if (!isCurrentLoad()) return;
            // This panel sent something while the history request was in
            // flight, so the response describes the conversation as it was
            // before that send. Applying it would replace the optimistic user
            // message and the reply with pre-send history -- which is exactly
            // how a completed send could end up showing an empty panel when
            // the two responses landed in the wrong order. Checking a
            // revision counter rather than `isSendingRef` also covers the
            // window just *after* streaming finishes, where the old guard had
            // already been released.
            if (localMessageRevisionRef.current !== revisionAtStart) return;
            if (isSendingRef.current && streamingChatIdRef.current === initialConversationId) {
              return;
            }

          if (data.messages && data.messages.length > 0) {
            const filteredMessages: Message[] = [];
            const seenUserIds = new Set();
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

              setMessages(filteredMessages.length > 0 ? filteredMessages : [{ id: WELCOME_MESSAGE_ID, role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          } else {
              setMessages([{ id: WELCOME_MESSAGE_ID, role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          }
        } else {
          throw new Error(`Conversation message load failed: ${response.status}`);
        }
      } catch (error) {
        console.error("Failed to load conversation messages:", error);
        // Let a later re-run retry instead of pinning the view to a failed load.
        if (isCurrentLoad()) requestedViewKeyRef.current = null;
      } finally {
        if (isCurrentLoad()) {
          setIsMessagesLoaded(true);
          setLoadedMessageViewKey(expectedMessageViewKey);
        }
      }
    };

      fetchPastMessages();
      return;
    }

    // No conversation selected yet: nothing to fetch, just the welcome view.
    const requestId = (loadRequestIdRef.current += 1);
    requestedViewKeyRef.current = expectedMessageViewKey;

    queueMicrotask(() => {
      if (loadRequestIdRef.current !== requestId) return;
      setMessages([
        {
          id: WELCOME_MESSAGE_ID,
          role: "assistant",
          content: t("chat.welcome"),
          status: "normal",
        },
      ]);
      setIsMessagesLoaded(true);
      setLoadedMessageViewKey(expectedMessageViewKey);
    });
  }, [
    initialConversationId,
    isGuestMode,
    modelId,
    sessionUserId,
    t,
    expectedMessageViewKey,
  ]);
  
  useEffect(() => {
      if (isGuestMode && initialConversationId && isMessagesLoaded && messages.length > 0) {
          if (loadedChatIdRef.current === initialConversationId) {
              const storageKey = guestMessagesStorageKey(initialConversationId, modelId);
              try {
                  // The same `data` strip the request already does. A guest
                  // image attachment carries a multi-megabyte data URL for its
                  // preview, and writing that into localStorage would blow the
                  // origin's quota -- taking the whole guest transcript with
                  // it. The bytes live in ephemeral object storage, keyed by
                  // objectKey; the preview is worth less than the history.
                  localStorage.setItem(
                      storageKey,
                      JSON.stringify(messages.map(toChatRequestMessage))
                  );
              } catch (error) {
                  console.error("Failed to persist guest messages:", error);
              }
          }
    }
  }, [messages, isGuestMode, initialConversationId, modelId, isMessagesLoaded]);

  const handleSendPrompt = useCallback(async (
    text: string,
    targetChatId: string,
    userMsgId: string,
    attachments: ChatAttachment[] = [],
    analyticsPromptId: string | null = null,
    deepResearchDepth?: "quick" | "standard" | "deep"
  ) => {
  	if ((!text && attachments.length === 0) || isSendingRef.current) return;

    lastPromptRef.current = { text, targetChatId, attachments };
    // Marks this panel's history as locally advanced. A history load that was
    // already in flight when this send started describes the conversation as
    // it was *before* the send, so it must not be applied afterwards.
    localMessageRevisionRef.current += 1;
    setIsSending(true);
	isSendingRef.current = true;
    streamingChatIdRef.current = targetChatId;
	
    const userMessage: Message = {
      id: userMsgId,
      role: "user",
      content: text,
      attachments,
	  status: "normal",
	  createdAt: new Date().toISOString(),
    };

    const assistantMessageId = crypto.randomUUID();
    const assistantMessage: Message = {
		id: assistantMessageId,
		role: "assistant",
		content: "",
		status: "normal",
		modelId: modelId,
		createdAt: new Date().toISOString(),
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
    // Declared here (not inside the try block below) so a stop mid-stream
    // can still show whatever was generated before the abort, instead of
    // discarding it -- the catch block needs to read it too.
    let assistantText = "";

    try {
      const sendChatRequest = async (turnstileToken?: string) => {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            // UI-only turns never go to a provider, and this turn's own user
            // message is appended exactly once -- `messages` is the pre-send
            // snapshot, and the id filter keeps a re-render or a resend from
            // duplicating it.
            messages: [
              ...messages.filter(
                (message) =>
                  isTranscriptMessage(message) && message.id !== userMessage.id
              ),
              userMessage,
            ].map(toChatRequestMessage),
            modelId: modelId,
            ...(turnstileToken ? { turnstileToken } : {}),
            ...(!isGuestMode
              ? {
                  conversationId: targetChatId,
                  assistantMessageId,
                }
              : {}),
            ...(deepResearchDepth ? { deepResearchDepth } : {}),
            ...(webSearchMode && webSearchMode !== "off" ? { webSearchMode } : {}),
          }),
          signal: controller.signal,
        });
        resetIdleTimeout();
        requestTraceId = res.headers.get("X-Request-ID");

        if (!res.ok) {
          const errorBody = await res.json().catch(() => null);
          requestTraceId =
            typeof errorBody?.traceId === "string"
              ? errorBody.traceId
              : requestTraceId;
          const requestError = new Error(`Chat request failed: ${res.status}`);
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

        return res;
      };

      // Guests no longer solve Turnstile proactively on every send (each
      // panel independently doing so was tripping Cloudflare's risk engine
      // into showing a checkbox on nearly every message). Try without a
      // token first; the server only asks for one when its short-lived
      // "already verified" grant is missing or has expired.
      let response: Response;
      try {
        response = await sendChatRequest();
      } catch (error) {
        const code =
          error && typeof error === "object"
            ? (error as { code?: string }).code
            : undefined;
        if (isGuestMode && code === "TURNSTILE_REQUIRED") {
          // The coordinator guarantees only one panel actually runs the
          // challenge; the rest wait for that panel's verified retry to finish
          // and then retry without a token, because the grant cookie it
          // received already covers them. One widget, one token, one challenge.
          response = await runGuestChatRequest({
            sendWithToken: (turnstileToken) => sendChatRequest(turnstileToken),
            sendAfterGrant: () => sendChatRequest(),
          });
        } else {
          throw error;
        }
      }

      if (response.headers.get("X-Chat-Response-Mode") === "async-job") {
        // Deep research doesn't stream -- the idle-timeout watchdog is
        // meaningless here (there's no single connection for it to guard),
        // and pollDeepResearchJob checks the abort signal itself instead.
        if (idleTimeoutId !== null) {
          window.clearTimeout(idleTimeoutId);
          idleTimeoutId = null;
        }
        await pollDeepResearchJob(
          assistantMessageId,
          Date.now(),
          controller.signal,
          analyticsPromptId
        );
        return;
      }

      if (!response.body) {
        throw new Error(t("chat.responseBodyMissing"));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // The stream ends with one extra out-of-band chunk carrying this
      // turn's WebSearchExecution JSON (see lib/webSearchStreamTrailer.ts) --
      // rawStreamText keeps the untouched accumulation so the marker can be
      // found even if it arrives split across reads, while assistantText
      // (used for display and the empty-response check below) always has it
      // stripped back out.
      let rawStreamText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetIdleTimeout();
        rawStreamText += decoder.decode(value, { stream: true });
        assistantText = splitSearchMetadataTrailer(rawStreamText).displayText;
		setAssistantMessage(assistantMessageId, assistantText, "normal");
      }

      const { searchMetadataJson } = splitSearchMetadataTrailer(rawStreamText);
      let searchMetadata: WebSearchExecution | null = null;
      if (searchMetadataJson) {
        try {
          searchMetadata = JSON.parse(searchMetadataJson) as WebSearchExecution;
        } catch {
          searchMetadata = null;
        }
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
          "error",
          { errorCode: "EMPTY_RESPONSE", errorHadAttachments: attachments.length > 0 }
        );
      } else {
        setAssistantMessage(assistantMessageId, assistantText, "normal", undefined, {
          searchMetadata,
        });
        onResponseComplete?.(analyticsPromptId, modelId, assistantText, searchMetadata);
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
        // Keep whatever was already generated -- a stop mid-answer
        // shouldn't throw away useful partial content, only mark it as
        // stopped. Only fall back to the placeholder text if nothing had
        // streamed in yet (e.g. aborted before the first token).
        setAssistantMessage(
          assistantMessageId,
          assistantText.trim() ? assistantText : t("chat.responseCancelled"),
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
        const retryAfterSeconds =
          requestError.details &&
          typeof requestError.details === "object" &&
          typeof (requestError.details as Record<string, unknown>).retryAfterSeconds === "number"
            ? (requestError.details as Record<string, number>).retryAfterSeconds
            : null;
        const localizedRequestError =
          errorCode === "CHAT_RATE_LIMITED"
            ? t("chat.tooManyRequestsRetry").replace(
                "{seconds}",
                String(Math.max(1, retryAfterSeconds ?? 5))
              )
            : errorCode === "PLAN_ENTITLEMENT_EXHAUSTED"
              ? t("chat.planEntitlementExhausted")
            : errorCode === "CONCURRENT_RESERVATION_CONFLICT"
              ? t("chat.concurrentReservationConflict")
            : errorCode === "CREDIT_BALANCE_INSUFFICIENT" ||
          errorCode === "CREDIT_COST_ALLOWANCE_INSUFFICIENT"
            ? t("chat.comparisonCreditsInsufficient")
            : errorCode === "OPERATIONAL_COST_GUARDRAIL_TRIGGERED"
              ? t("chat.operationalCostGuardrail")
              : errorCode === "INTERNAL_DAILY_COST_SAFETY_LIMIT"
              ? t("chat.internalDailyCostSafetyLimit")
              : errorCode === "INTERNAL_MONTHLY_COST_SAFETY_LIMIT"
                ? t("chat.internalMonthlyCostSafetyLimit")
                : errorCode === "PROVIDER_BUDGET_EXHAUSTED" ||
                    errorCode === "PROVIDER_DAILY_SPEND_LIMIT_REACHED" ||
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
        // The replacement travels as data (see the MODEL_RETIRED branch in
        // app/api/chat/route.ts) so the sentence stays in the user's language
        // and still names the model that actually took over. Without a
        // replacement the copy stays generic rather than naming a model that
        // has nothing to do with the one that was retired.
        const replacementModelName =
          requestError.details &&
          typeof requestError.details === "object" &&
          typeof (requestError.details as Record<string, unknown>)
            .replacementModelName === "string"
            ? ((requestError.details as Record<string, string>)
                .replacementModelName)
            : null;
        const retiredMessage = replacementModelName
          ? t("chat.modelRetiredWithReplacement").replace(
              "{model}",
              replacementModelName
            )
          : t("chat.modelRetired");
        setAssistantMessage(
          assistantMessageId,
          `${errorCode === "MODEL_RETIRED"
            ? retiredMessage
            : localizedRequestError || typeof requestError.publicMessage === "string"
              ? localizedRequestError || requestError.publicMessage
              : t("chat.responseError")}${
            costSafetyDetails ? `\n${costSafetyDetails}` : ""
          }${
            traceId ? `\n${t("chat.traceId")}: ${traceId}` : ""
          }`,
          "error",
          { errorCode: errorCode || "UNKNOWN_ERROR", errorHadAttachments: attachments.length > 0 }
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
    isGuestMode,
    messages,
    modelId,
    onResponseComplete,
    pollDeepResearchJob,
    runGuestChatRequest,
    setAssistantMessage,
    t,
    webSearchMode,
  ]);

  const handleRetryLast = useCallback(() => {
    const lastPrompt = lastPromptRef.current;
    if (!lastPrompt || isSendingRef.current) return;

    // Unlike a fresh send, a retry doesn't go through handleGlobalSubmit or
    // handleModelOnlySubmit -- both of which flush any pending model-list
    // sync via onBeforeSend first. Skipping that here means a request that
    // failed because the server hadn't yet seen a just-added model would
    // keep failing on every retry, since nothing ever re-flushes the sync.
    void (async () => {
      const settingsReady = (await onBeforeSend?.(lastPrompt.targetChatId)) ?? true;
      if (!settingsReady) return;

      const retryUserMessageId = crypto.randomUUID();
      void handleSendPrompt(
        lastPrompt.text,
        lastPrompt.targetChatId,
        retryUserMessageId,
        lastPrompt.attachments
      );
    })();
  }, [handleSendPrompt, onBeforeSend]);

  const handleRetryWithoutAttachments = useCallback(() => {
    const lastPrompt = lastPromptRef.current;
    if (!lastPrompt || isSendingRef.current) return;

    void (async () => {
      const settingsReady = (await onBeforeSend?.(lastPrompt.targetChatId)) ?? true;
      if (!settingsReady) return;

      void handleSendPrompt(
        lastPrompt.text,
        lastPrompt.targetChatId,
        crypto.randomUUID(),
        []
      );
    })();
  }, [handleSendPrompt, onBeforeSend]);

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
          promptPayload.id,
          modelId === "perplexity/sonar-deep-research"
            ? promptPayload.deepResearchDepth
            : undefined
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

        const settingsReady = await onBeforeSend?.(initialConversationId) ?? true;
        if (!settingsReady) return;

        const userMsgId = crypto.randomUUID();

        if (!isGuestMode) {
            try {
                const response = await fetch(`/api/conversations/${initialConversationId}/messages`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        messages: [{ id: userMsgId, role: "user", content: trimmed, modelId }],
                    }),
                });
                if (!response.ok) {
                  throw new Error(`Model-only user message save failed: ${response.status}`);
                }
            } catch (error) {
                console.error("model-only user message save failed:", error);
                return;
            }
        }

        setModelInput("");
        onFollowupSent?.(modelId);
        await handleSendPrompt(trimmed, initialConversationId, userMsgId);
    };

  return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {!isPanelDisabled ? (
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                  <div className="min-h-0 flex-1 overflow-hidden">
      {!isCurrentMessageViewLoaded ? (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">
          {t("auth.loading")}
        </div>
      ) : useCenteredWelcome && isConversationEmpty ? null : <ChatMessageList
        messages={useCenteredWelcome ? messages.filter(isTranscriptMessage) : messages}
        onRetryLast={handleRetryLast}
        onRetryWithoutAttachments={handleRetryWithoutAttachments}
        onRequestCloseModel={onRequestCloseModel}
        hasMultipleActiveModels={hasMultipleActiveModels}
        currentModelId={modelId}
        currentPlan={currentPlan}
        isGuestMode={isGuestMode}
        currentChatId={initialConversationId}
        isSending={isSending}
        onStopGenerating={stopThisPanel}
      />}
                  </div>

                  {!hideModelOnlyInput && (
                  <form
                      onSubmit={(event) => {
                          event.preventDefault();
                          handleModelOnlySubmit();
                      }}
                      data-testid="model-only-form"
                      data-model-id={modelId}
                      className="flex shrink-0 items-end gap-2 border-t border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/95"
                  >
                      <div className="flex min-w-0 flex-1 items-end gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 shadow-sm focus-within:border-blue-500 dark:border-zinc-800 dark:bg-zinc-900">
                          <textarea
                              value={modelInput}
                              onChange={(event) => setModelInput(event.target.value)}
                              onKeyDown={(event) => {
                                  const action = getChatEnterKeyAction(
                                      event,
                                      isComposingKeydown(event),
                                      isMobileShell
                                  );
                                  if (action !== "submit") return;

                                  event.preventDefault();
                                  handleModelOnlySubmit();
                              }}
                              onCompositionStart={() => {
                                  isModelInputComposingRef.current = true;
                              }}
                              onCompositionEnd={() => {
                                  requestAnimationFrame(() => {
                                      isModelInputComposingRef.current = false;
                                  });
                              }}
                              disabled={isSending || !initialConversationId}
                              enterKeyHint={isMobileShell ? "enter" : undefined}
                              rows={1}
                              data-testid="model-only-input"
                              data-model-id={modelId}
                              placeholder={t("chat.modelOnlyPlaceholder")}
                              className="max-h-28 min-h-7 flex-1 resize-none border-0 bg-transparent py-1 text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                          />
                      </div>
                      <button
                          type="submit"
                          data-testid="model-only-send"
                          data-model-id={modelId}
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
