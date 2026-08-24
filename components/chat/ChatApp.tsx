"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { Message, type ChatAttachment } from "@/components/chat/types";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { isGuestVerificationError } from "@/components/chat/guestVerificationFailure";
import { guestVerificationFailureKey } from "@/components/chat/guestVerificationCopy";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
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
import { prepareChatContextBundle } from "@/lib/chatContextBundleClient";
import { decideBundleStaleRecovery } from "@/lib/chatContextBundleRecovery";
import {
  parseChatStreamTrailer,
  splitSearchMetadataTrailer,
} from "@/lib/webSearchStreamTrailer";
import { splitArtifactProgressSignal } from "@/lib/generatedArtifactProgressSignal";
import { splitRoutingRetrySignal } from "@/lib/routingRetrySignal";
import type { WebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import { guestMessagesStorageKey } from "@/lib/guestConversationStorage";
import {
  toChatRequestMessage,
  toGuestPersistableMessage,
} from "@/lib/chatMessageSerialization";
import {
  ERROR_CLASSIFICATION_SOURCE,
  ERROR_REPORT_TOKEN_HEADER,
  TRACE_PROVENANCE,
  type MessageErrorReportContext,
} from "@/lib/errorReportContract";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { ChatContentState } from "@/lib/chatContentState";
import type { ModelRuntimeStatus } from "@/lib/chatRuntimeStatus";
import {
  abortChatRuntime,
  advanceChatRuntimeRevision,
  beginChatRuntimeRun,
  chatRuntimeIdentityKey,
  chatRuntimeKey,
  claimChatRuntimeLoad,
  endChatRuntimeRun,
  getChatRuntimeLastPrompt,
  getChatRuntimeRevision,
  getChatRuntimeServerSnapshot,
  getChatRuntimeSnapshot,
  hasResumedChatRuntimeJob,
  isChatRuntimeLoadInFlight,
  isChatRuntimeStreaming,
  isCurrentChatRuntimeLoad,
  markChatRuntimeJobResumed,
  ownsChatRuntimeTranscript,
  releaseChatRuntimeLoad,
  setChatRuntimeLastPrompt,
  settleChatRuntimeLoad,
  subscribeChatRuntime,
  writeChatRuntimeMessages,
} from "@/lib/chatStreamRuntime";

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

type ChatAppProps = {
  modelId: string;
  initialConversationId?: string | null;
  promptPayload?: {
    id: string;
    text: string;
    chatId: string;
    userMessageId: string;
    /**
     * The models this send was actually made for. A panel only auto-sends a
     * payload that names its own model: the payload outlives the send that
     * created it, so a model swapped into a panel afterwards would otherwise
     * pick it up and replay the previous question -- against a selection the
     * server has not been told about yet (MODEL_NOT_SELECTED), consuming an
     * admission slot the preflight never reserved for it.
     */
    modelIds: string[];
    attachments: ChatAttachment[];
    deepResearchDepth?: "quick" | "standard" | "deep";
    /**
     * Concurrency slot this panel was already admitted for by the aggregate
     * comparison preflight. Opaque, signed and single-use server-side; a panel
     * that has none (a retry, a single-model send) simply takes the ordinary
     * per-request admission path.
     */
    admissionToken?: string | null;
    /**
     * The §10 context bundle this send was priced against. Opaque and
     * single-use per (bundle, model); absent means the request was priced
     * with no memory context, and the server then sends none.
     */
    contextBundle?: string | null;
    /**
     * Whether that bundle covers this panel alone or a whole comparison.
     * It decides what a stale bundle may do about itself, and only the step
     * that prepared the context knows which it issued.
     */
    contextLayout?: "single" | "comparison";
  } | null;
  /**
   * Asks the shell for a context the whole run can share, after this panel's
   * bundle was refused for drift (§10). The shell prepares once per prompt
   * however many panels ask, so the run ends up on one new snapshot rather
   * than one per panel -- which is the difference between re-preparing the
   * set and the per-panel retry the policy forbids.
   *
   * Resolves to `null` when there is no recovery to offer, and the refusal is
   * then the user's to act on.
   */
  onContextBundleStale?: (input: {
    promptId: string | null;
    modelId: string;
  }) => Promise<string | null>;
  isPanelDisabled?: boolean;
  isGuestMode?: boolean;
  webSearchMode?: WebSearchMode;
  hideModelOnlyInput?: boolean;
  useCenteredWelcome?: boolean;
  /**
   * Reports what this panel knows about its own transcript. Three states, not
   * a boolean: "unknown" is what the panel is between mounting and finishing
   * the restore for its current view, and it is the state the shells used to
   * have no way to receive -- so they guessed "empty" and painted the welcome
   * screen over conversations that were still loading. See
   * lib/chatContentState.ts.
   */
  onContentStateChange?: (modelId: string, state: ChatContentState) => void;
  /**
   * Reports this panel's runtime status *and the conversation it belongs to*.
   *
   * The conversation is not decoration: the shells key what they receive by
   * (conversation, model), because a status keyed by model alone let a run
   * started in one conversation disable the composer of another
   * (lib/chatRuntimeStatus.ts).
   */
  onStatusChange?: (
    modelId: string,
    status: ModelRuntimeStatus,
    conversationId: string | null
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

/**
 * UX-021. The follow-up field's accessible name. Kept as an interpolation so
 * the copy stays in `locales/*.ts` -- the model name is the only part that
 * varies, and it is not translated.
 */
const interpolateModelOnlyLabel = (template: string, modelName: string) =>
    template.replace("{model}", modelName);

function ChatAppComponent({
  modelId,
  initialConversationId = null,
  promptPayload,
  onContextBundleStale,
  isPanelDisabled = false,
  isGuestMode = false,
  webSearchMode,
  hideModelOnlyInput = false,
  useCenteredWelcome = false,
  onContentStateChange,
  onStatusChange,
  onResponseComplete,
  onFollowupSent,
  onBeforeSend,
  onRequestCloseModel,
  hasMultipleActiveModels = false,
  currentPlan,
  stopSignal,
}: ChatAppProps) {
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id || null;
    const { t } = useLanguage();
    // UX-021. Only used to name this panel's follow-up field. Three panels
    // render three of these, so a name that does not say *which* model is the
    // same as no name at all for anyone navigating by form field.
    const { getModel } = useModelCatalog();
  // No panel owns a Turnstile widget any more: verification is a property of
  // the guest session, so the chat shell's single coordinator runs it (and
  // shows it, once, in the shell's own verification surface).
  const { runGuestChatRequest } = useGuestVerification();

  /**
   * This panel's runtime identity: (identity namespace, conversation, model).
   *
   * Everything that has to survive the user walking away -- the transcript, an
   * answer still streaming into it, the controller that stops it -- is held
   * against this key in lib/chatStreamRuntime.ts rather than in this
   * component, because both shells unmount every panel when the conversation
   * changes. Remounting on the same key adopts the run that is already going
   * instead of starting over with nothing.
   */
  const runtimeKey = chatRuntimeKey({
    identityKey: chatRuntimeIdentityKey(
      isGuestMode ? { kind: "guest" } : { kind: "account", userId: sessionUserId }
    ),
    conversationId: initialConversationId,
    modelId,
  });
  const subscribeRuntime = useCallback(
    (listener: () => void) => subscribeChatRuntime(runtimeKey, listener),
    [runtimeKey]
  );
  const readRuntime = useCallback(
    () => getChatRuntimeSnapshot(runtimeKey),
    [runtimeKey]
  );
  const runtime = useSyncExternalStore(
    subscribeRuntime,
    readRuntime,
    getChatRuntimeServerSnapshot
  );
  const messages = runtime.messages;
  const isSending = runtime.isStreaming;
  /**
   * The key the *current* view writes to.
   *
   * A run captures its own key when it starts and keeps writing to it, so an
   * answer keeps arriving in the conversation it was sent in even after this
   * panel has been rebuilt for a different one. This ref is only for the
   * handlers that act on whatever is on screen right now.
   */
  const runtimeKeyRef = useRef(runtimeKey);
  useLayoutEffect(() => {
    runtimeKeyRef.current = runtimeKey;
  });
    const isMobileShell = useIsMobileShell();
    const [modelInputs, setModelInputs] = useState<Record<string, string>>({});
    const modelInput = modelInputs[modelId] || "";
    const setModelInput = (value: string) => {
      setModelInputs((current) => ({ ...current, [modelId]: value }));
    };
  
  /** True while an IME composition is in progress in the model-only composer. */
  const isModelInputComposingRef = useRef(false);
  /**
   * Dedupes repeat loads *within this component instance*.
   *
   * The cross-instance half of the same job lives on the runtime record
   * (`isChatRuntimeLoadInFlight`), because a panel that remounts while its
   * history request is still on the wire must not start a second one -- the
   * first will settle the record either way.
   */
  const settledViewKeyRef = useRef<string | null>(null);
  /**
   * The send barrier and this panel's current model, read through refs by the
   * auto-send effect below.
   *
   * `onBeforeSend` is redefined on every render of the page component, so
   * depending on it directly would re-run (and therefore cancel) that effect
   * on every parent render -- including while it is waiting on the barrier,
   * which would drop the send it had already claimed. The model ref is how
   * the send re-checks, after the wait, that this panel is still the one the
   * payload was claimed for.
   */
  const onBeforeSendRef = useRef(onBeforeSend);
  const panelModelIdRef = useRef(modelId);
  useLayoutEffect(() => {
    onBeforeSendRef.current = onBeforeSend;
    panelModelIdRef.current = modelId;
  });

  // `runtime.isLoaded` is already per (identity, conversation, model): the
  // snapshot a panel reads can only describe the key it asked for, so there is
  // no separate "which view is this?" comparison to get wrong.
  const isCurrentMessageViewLoaded = runtime.isLoaded;

  // Reported in a layout effect, like the content state below and for the same
  // reason: a panel that mounts on a conversation whose answer finished while
  // it was unmounted has to correct the shell's last report *before* the
  // browser paints, or the composer it comes back to is briefly disabled by a
  // run that is no longer happening.
  useLayoutEffect(() => {
    if (isPanelDisabled) {
      onStatusChange?.(modelId, "paused", initialConversationId);
      return;
    }

    if (isSending) {
      onStatusChange?.(modelId, "responding", initialConversationId);
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
    onStatusChange?.(modelId, status, initialConversationId);
  }, [
    initialConversationId,
    isPanelDisabled,
    isSending,
    messages,
    modelId,
    onStatusChange,
  ]);

  // Bumped by the parent to request an abort of this panel's in-flight
  // request, if any. `abortChatRuntime` on a key with nothing running (or an
  // already-settled controller) is a safe no-op, so this stays correct even if
  // clicked repeatedly or after this panel already finished on its own.
  //
  // The last value seen is remembered, and a mount that merely *inherits* the
  // shell's current counter aborts nothing: the shell's counter is one number
  // for the whole page, so returning to a conversation that is still streaming
  // would otherwise stop it on arrival with a "stop all" nobody pressed here.
  const lastStopSignalRef = useRef(stopSignal);
  useEffect(() => {
    if (stopSignal === undefined) return;
    if (lastStopSignalRef.current === stopSignal) return;
    lastStopSignalRef.current = stopSignal;
    abortChatRuntime(runtimeKeyRef.current);
  }, [stopSignal]);

  // Lets the message list offer a per-panel stop button, distinct from the
  // shell's "stop all" button which drives every panel via stopSignal. Both
  // stop the run belonging to the conversation on screen, never one left
  // running in a conversation the user walked away from.
  const stopThisPanel = useCallback(() => {
    abortChatRuntime(runtimeKeyRef.current);
  }, []);

  const isConversationEmpty =
    messages.length === 0 ||
    (messages.length === 1 && messages[0]?.id === WELCOME_MESSAGE_ID);

  // Reported in a layout effect so the shell has it before the browser paints
  // the commit that produced it. "unknown" is reported explicitly rather than
  // by staying silent: a view that goes back to loading (a different
  // conversation, a different model) has to retract what it said about the
  // previous one, and a missing report is exactly what the shells used to fill
  // in with a guess.
  useLayoutEffect(() => {
    onContentStateChange?.(
      modelId,
      !isCurrentMessageViewLoaded
        ? "unknown"
        : isConversationEmpty
          ? "empty"
          : "non-empty"
    );
  }, [isCurrentMessageViewLoaded, isConversationEmpty, modelId, onContentStateChange]);

  /**
   * A writer bound to one runtime key.
   *
   * A run has to keep writing into the conversation it was sent in, whatever
   * the user is looking at by the time the next chunk arrives, so every path
   * that streams (the send, the deep-research poll) takes the key it started
   * with and writes through this rather than through the panel's current view.
   */
  const assistantMessageWriter = useCallback(
    (key: string) =>
      (
        id: string,
        content: string,
        status?: Message["status"],
        errorMeta?: {
          errorCode?: string;
          errorHadAttachments?: boolean;
          errorReport?: MessageErrorReportContext;
        },
        extraFields?: Partial<Message>
      ) => {
        writeChatRuntimeMessages(key, (prev) =>
          prev.map((message) =>
            message.id === id
              ? { ...message, content, status, ...errorMeta, ...extraFields }
              : message
          )
        );
      },
    []
  );

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
      // The conversation this job belongs to. The poll outlives the panel that
      // started it -- that is the point -- so every write names the key rather
      // than whatever this component is showing when the tick lands.
      key: string,
      jobAssistantMessageId: string,
      submittedAtMs: number,
      signal: AbortSignal,
      analyticsPromptId: string | null = null
    ) => {
      const POLL_INTERVAL_MS = 5_000;
      const TAKING_LONGER_THRESHOLD_MS = 5 * 60 * 1000;
      const setAssistantMessage = assistantMessageWriter(key);

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
        let pollTraceId: string | null = null;
        let pollErrorReportToken: string | null = null;
        try {
          const res = await fetch("/api/chat/deep-research/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assistantMessageId: jobAssistantMessageId }),
          });
          if (res.ok) {
            poll = await res.json();
            pollTraceId = res.headers.get("X-Request-ID");
            pollErrorReportToken = res.headers.get(ERROR_REPORT_TOKEN_HEADER);
          } else {
            await discardResponseBody(res);
          }
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
            {
              errorCode: "DEEP_RESEARCH_FAILED",
              errorReport: pollTraceId
                ? {
                    traceId: pollTraceId,
                    traceProvenance: TRACE_PROVENANCE.serverGenerated,
                    ...(pollErrorReportToken
                      ? { errorReportToken: pollErrorReportToken }
                      : {}),
                    errorCode: "DEEP_RESEARCH_FAILED",
                    errorClassificationSource:
                      ERROR_CLASSIFICATION_SOURCE.server,
                    occurredAt: new Date().toISOString(),
                  }
                : undefined,
            }
          );
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
    [assistantMessageWriter, deepResearchPhaseText, modelId, onResponseComplete, t]
  );

  // Resumes polling for a deep-research job that was still pending when this
  // panel (re)mounted -- e.g. the user refreshed mid-research. The job keeps
  // running server-side regardless of whether any tab is open, so this just
  // reattaches the UI to it using the persisted pendingJobId instead of
  // losing track of an in-flight request on every reload.
  //
  // Which jobs have already been re-attached to is recorded on the runtime key
  // rather than in a ref, so switching away from a deep-research conversation
  // and back does not start a second poll for the job the first one is still
  // watching.
  useEffect(() => {
    if (!isCurrentMessageViewLoaded || isChatRuntimeStreaming(runtimeKey)) return;
    const pendingMessage = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.status === "pending" &&
        Boolean(message.pendingJobId)
    );
    if (!pendingMessage || hasResumedChatRuntimeJob(runtimeKey, pendingMessage.id)) {
      return;
    }
    markChatRuntimeJobResumed(runtimeKey, pendingMessage.id);

    const controller = beginChatRuntimeRun(runtimeKey);
    const submittedAtMs = pendingMessage.createdAt
      ? new Date(pendingMessage.createdAt).getTime()
      : Date.now();

    pollDeepResearchJob(
      runtimeKey,
      pendingMessage.id,
      submittedAtMs,
      controller.signal
    ).finally(() => {
      endChatRuntimeRun(runtimeKey, controller);
    });
  }, [isCurrentMessageViewLoaded, messages, pollDeepResearchJob, runtimeKey]);

  // Loads the message view for the current (identity, conversation, model)
  // triple. Four rules keep it deterministic:
  //
  //  * Only the newest load may settle the view, tracked by a load ticket on
  //    the runtime record rather than by invalidating the in-flight load from
  //    the effect cleanup. The old cleanup-based version combined with a dedup
  //    guard that returned *before* settling, so an effect re-run while a
  //    fetch was in flight left the view permanently unloaded: the previous
  //    run could no longer settle it and the new run returned early without
  //    settling it either. The panel then rendered its loading placeholder
  //    forever, which is why a send could clear the composer and create the
  //    sidebar conversation while the main panel showed no user message at
  //    all.
  //  * The current load always settles, including when it bails out because
  //    this key started streaming in the meantime.
  //  * A key whose transcript this session already owns -- streaming, or
  //    advanced by a send -- is never re-read. Coming back to a conversation
  //    mid-answer must show the answer that is arriving, and coming back just
  //    after one finished must not replace it with a server copy written
  //    before it landed. This is what makes the completed answer appear
  //    exactly once.
  //  * The ticket lives on the runtime record, so a panel that remounts while
  //    its own history request is still on the wire waits for that request
  //    instead of starting a second one.
  useEffect(() => {
    if (!isGuestMode && !sessionUserId) return;
    if (ownsChatRuntimeTranscript(runtimeKey)) return;
    if (settledViewKeyRef.current === runtimeKey) return;
    if (isChatRuntimeLoadInFlight(runtimeKey)) return;

    const loadKey = runtimeKey;

    if (isGuestMode) {
      // Resolves synchronously from localStorage, so no interim "loading"
      // state is needed: the runtime snapshot already reads as not loaded for
      // this key until the microtask below settles it. Bookkeeping stays
      // synchronous so a second effect run in the same tick cannot start a
      // competing load; only the state writes are deferred.
      const requestId = claimChatRuntimeLoad(loadKey);

      queueMicrotask(() => {
        if (!isCurrentChatRuntimeLoad(loadKey, requestId)) return;

        if (initialConversationId) {
          const storageKey = guestMessagesStorageKey(initialConversationId, modelId);
          const savedMessages = localStorage.getItem(storageKey);
          if (savedMessages) {
            try {
              writeChatRuntimeMessages(loadKey, JSON.parse(savedMessages));
            } catch (e) {
              console.error("Failed to load guest messages:", e);
              writeChatRuntimeMessages(loadKey, []);
            }
          } else {
            writeChatRuntimeMessages(loadKey, [
              { id: WELCOME_MESSAGE_ID, role: "assistant", content: t("chat.guestWelcome"), status: "normal" },
            ]);
          }
        } else {
          writeChatRuntimeMessages(loadKey, []);
        }

        settleChatRuntimeLoad(loadKey, requestId, { loaded: true });
      });
      return;
    }

    if (initialConversationId && initialConversationId !== "guest-chat") {
      // Only the account branch is deduped per instance: the two synchronous
      // branches cost nothing to re-run, and re-running them is how a language
      // change reaches the welcome copy they render.
      settledViewKeyRef.current = loadKey;
      const requestId = claimChatRuntimeLoad(loadKey);
      const isCurrentLoad = () => isCurrentChatRuntimeLoad(loadKey, requestId);
      const revisionAtStart = getChatRuntimeRevision(loadKey);
      let loadFailed = false;

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
              if (!pageResponse.ok) {
                await discardResponseBody(pageResponse);
                break;
              }
              const pageData = await pageResponse.json();
              if (Array.isArray(pageData.messages)) {
                data.messages.push(...pageData.messages);
              }
              data.messagePage = pageData.messagePage;
              nextCursor = pageData.messagePage?.nextCursor;
            }
            if (!isCurrentLoad()) return;
            // This key sent something while the history request was in
            // flight, so the response describes the conversation as it was
            // before that send. Applying it would replace the optimistic user
            // message and the reply with pre-send history -- which is exactly
            // how a completed send could end up showing an empty panel when
            // the two responses landed in the wrong order. Checking a
            // revision counter rather than a "still sending" flag also covers
            // the window just *after* streaming finishes, where the old guard
            // had already been released.
            if (getChatRuntimeRevision(loadKey) !== revisionAtStart) return;
            if (isChatRuntimeStreaming(loadKey)) return;

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

              writeChatRuntimeMessages(loadKey, filteredMessages.length > 0 ? filteredMessages : [{ id: WELCOME_MESSAGE_ID, role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          } else {
              writeChatRuntimeMessages(loadKey, [{ id: WELCOME_MESSAGE_ID, role: "assistant", content: t("chat.welcome"), status: "normal" }]);
          }
        } else {
          await discardResponseBody(response);
          throw new Error(`Conversation message load failed: ${response.status}`);
        }
      } catch (error) {
        console.error("Failed to load conversation messages:", error);
        loadFailed = true;
      } finally {
        // The current load always settles, including when it bailed out above
        // because a send advanced this key while the request was in flight:
        // the transcript on screen is then the send's, and it is loaded.
        if (isCurrentLoad()) {
          if (loadFailed) {
            // Let a later re-run retry instead of pinning the view to a failed
            // load, which would leave the loading placeholder up for good.
            settledViewKeyRef.current = null;
            releaseChatRuntimeLoad(loadKey, requestId);
          } else {
            settleChatRuntimeLoad(loadKey, requestId, { loaded: true });
          }
        }
      }
    };

      fetchPastMessages();
      return;
    }

    // No conversation selected yet: nothing to fetch, just the welcome view.
    const requestId = claimChatRuntimeLoad(loadKey);

    queueMicrotask(() => {
      if (!isCurrentChatRuntimeLoad(loadKey, requestId)) return;
      writeChatRuntimeMessages(loadKey, [
        {
          id: WELCOME_MESSAGE_ID,
          role: "assistant",
          content: t("chat.welcome"),
          status: "normal",
        },
      ]);
      settleChatRuntimeLoad(loadKey, requestId, { loaded: true });
    });
  }, [
    initialConversationId,
    isGuestMode,
    modelId,
    sessionUserId,
    t,
    runtimeKey,
  ]);
  
  /**
   * Writes a guest's transcript back to localStorage.
   *
   * Kept as a plain function rather than only an effect because a guest answer
   * can now finish while no panel is mounted on it: the run writes its last
   * chunk into the runtime key of a conversation the user has left, and an
   * effect on `messages` of an unmounted component never fires. The send path
   * calls this as it settles, with the key it ran under.
   */
  const persistGuestTranscript = useCallback(
    (key: string, conversationId: string | null) => {
      if (!isGuestMode || !conversationId) return;
      const transcript = getChatRuntimeSnapshot(key).messages;
      if (transcript.length === 0) return;
      const storageKey = guestMessagesStorageKey(conversationId, modelId);
      try {
        // The same `data` strip the request already does. A guest image
        // attachment carries a multi-megabyte data URL for its preview, and
        // writing that into localStorage would blow the origin's quota --
        // taking the whole guest transcript with it. The bytes live in
        // ephemeral object storage, keyed by objectKey; the preview is worth
        // less than the history.
        localStorage.setItem(
          storageKey,
          JSON.stringify(transcript.map(toGuestPersistableMessage))
        );
      } catch (error) {
        console.error("Failed to persist guest messages:", error);
      }
    },
    [isGuestMode, modelId]
  );

  useEffect(() => {
    if (!isCurrentMessageViewLoaded) return;
    persistGuestTranscript(runtimeKey, initialConversationId);
  }, [
    initialConversationId,
    isCurrentMessageViewLoaded,
    messages,
    persistGuestTranscript,
    runtimeKey,
  ]);

  const handleSendPrompt = useCallback(async (
    text: string,
    targetChatId: string,
    userMsgId: string,
    attachments: ChatAttachment[] = [],
    analyticsPromptId: string | null = null,
    deepResearchDepth?: "quick" | "standard" | "deep",
    admissionToken?: string | null,
    contextBundle?: string | null,
    contextLayout: "single" | "comparison" = "single"
  ) => {
    // The key this run owns for its whole life. `targetChatId` is the
    // conversation the send was made in, and every write below names this key
    // rather than the panel's current view: the user may open another
    // conversation a chunk later, and the answer still belongs here.
    const runKey = chatRuntimeKey({
      identityKey: chatRuntimeIdentityKey(
        isGuestMode ? { kind: "guest" } : { kind: "account", userId: sessionUserId }
      ),
      conversationId: targetChatId,
      modelId,
    });
    if ((!text && attachments.length === 0) || isChatRuntimeStreaming(runKey)) {
      return;
    }

    const setAssistantMessage = assistantMessageWriter(runKey);
    setChatRuntimeLastPrompt(runKey, { text, targetChatId, attachments });
    // Marks this conversation's history as locally advanced. A history load
    // that was already in flight when this send started describes the
    // conversation as it was *before* the send, so it must not be applied
    // afterwards.
    advanceChatRuntimeRevision(runKey);

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
	
    writeChatRuntimeMessages(runKey, (prev) => [
      ...prev,
      userMessage,
      assistantMessage,
    ]);

    // Opening the run here, on the key, is what lets a panel that mounts later
    // for this same conversation show it as still generating and stop it.
    const controller = beginChatRuntimeRun(runKey);

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
    // The signed error report token from the response headers, when the
    // server issued one. Lives only in this closure and in the error
    // message's runtime `errorReport` context -- never persisted.
    let requestErrorReportToken: string | null = null;
    // Declared here (not inside the try block below) so a stop mid-stream
    // can still show whatever was generated before the abort, instead of
    // discarding it -- the catch block needs to read it too.
    let assistantText = "";
    const buildErrorReport = (
      traceId: string | null,
      errorCode: string,
      classificationSource: MessageErrorReportContext["errorClassificationSource"]
    ): MessageErrorReportContext | undefined =>
      traceId
        ? {
            traceId,
            // Every trace this closure sees arrived in a server response
            // (header or body); the token is what proves it, so a missing
            // token simply verifies as unverified later.
            traceProvenance: TRACE_PROVENANCE.serverGenerated,
            ...(requestErrorReportToken
              ? { errorReportToken: requestErrorReportToken }
              : {}),
            errorCode,
            errorClassificationSource: classificationSource,
            occurredAt: new Date().toISOString(),
          }
        : undefined;

    // The bundle actually presented, which a stale-recovery retry replaces.
    // `contextBundle` is what this send was prepared with; after one refusal
    // for drift the request is re-prepared and this becomes the new one.
    let activeContextBundle = contextBundle ?? null;
    let contextBundleRetries = 0;
    let memoryUsedCount = 0;
    // Set only on a turn the Router actually chose the model for. The server
    // omits both headers on a manual turn and on an Auto turn that fell back,
    // so "absent" already means "no routing decision to show".
    let routedModelId: string | null = null;
    let routedReason: string | null = null;
    let knowledgeChunkCount = 0;

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
            ...(admissionToken ? { admissionToken } : {}),
            ...(activeContextBundle ? { contextBundle: activeContextBundle } : {}),
            ...(webSearchMode && webSearchMode !== "off" ? { webSearchMode } : {}),
          }),
          signal: controller.signal,
        });
        resetIdleTimeout();
        requestTraceId = res.headers.get("X-Request-ID");
        // §13.4: the server's own count, taken from the response rather than
        // derived here. Absent means memory played no part -- which is not
        // the same as zero, and must not be shown as one.
        const reportedMemoryUsed = Number(
          res.headers.get("X-Chat-Memory-Used")
        );
        memoryUsedCount =
          Number.isSafeInteger(reportedMemoryUsed) && reportedMemoryUsed > 0
            ? reportedMemoryUsed
            : 0;
        // docs/policy/external-conversation-import-and-memory.md §14.3, read exactly as the line
        // above: a missing header is not a
        // zero, and both collapse to 0 here because the renderer states
        // neither.
        const reportedKnowledgeUsed = Number(
          res.headers.get("X-Chat-Knowledge-Used")
        );
        knowledgeChunkCount =
          Number.isSafeInteger(reportedKnowledgeUsed) &&
          reportedKnowledgeUsed > 0
            ? reportedKnowledgeUsed
            : 0;
        // Always this response's own header (or null): the token must never
        // outlive the trace it was signed for, or a retried request would
        // pair a stale token with a fresh trace and verify as a mismatch.
        // The badge on the reply is what makes the Auto toggle's promise --
        // "the one that answered is shown on the reply" -- keepable. Read from
        // this response rather than remembered, so a retry cannot pair a stale
        // routing decision with a fresh answer.
        routedModelId = res.headers.get("X-Chat-Routed-Model");
        routedReason = res.headers.get("X-Chat-Routed-Reason");
        requestErrorReportToken = res.headers.get(ERROR_REPORT_TOKEN_HEADER);

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
        } else if (code === "CHAT_CONTEXT_BUNDLE_STALE") {
          // The user changed their memory while this send was in flight, so
          // the context that was priced is not the context that would be
          // sent. §10 decides what may be done about it, and the decision is
          // a pure function rather than an `if` written twice.
          //
          // `streamStarted: false` is a fact about where this code sits, not
          // an assumption: this catch runs before the response body is read,
          // so nothing has reached the user yet.
          const recovery = decideBundleStaleRecovery({
            layout: contextLayout,
            priorAutomaticRetries: contextBundleRetries,
            streamStarted: false,
          });
          if (recovery.action === "surface_to_user") throw error;

          // Both surviving actions re-prepare; they differ in *whose* context
          // is prepared. A comparison must not put this panel on a snapshot
          // its siblings are not on, so the shell prepares one context for the
          // whole run and hands the same bundle to every panel that asks --
          // which is re-preparing the set, not retrying a panel. A
          // single-model send has no set, so the two collapse to the same
          // call.
          const refreshed = onContextBundleStale
            ? await onContextBundleStale({
                promptId: analyticsPromptId,
                modelId,
              })
            : recovery.action === "retry_after_preflight"
              ? await prepareChatContextBundle({
                  conversationId: isGuestMode ? null : targetChatId,
                  modelIds: [modelId],
                  prompt: text,
                })
              : null;
          // Nothing to retry with. Re-sending the bundle that was just
          // refused would be a replay, and the server would refuse it again.
          if (!refreshed) throw error;

          contextBundleRetries += 1;
          activeContextBundle = refreshed;
          // Same assistant message id, same user message, same admission
          // token: the retry replaces the refused request rather than adding a
          // second turn or taking a second concurrency slot. The refused
          // request never reached `acquireChatAccess`, so its slot is still
          // this panel's to spend.
          response = await sendChatRequest();
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
          runKey,
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
      // Set when the server announced a model change mid-response. Kept so the
      // finished message can say which model actually answered -- the routed
      // header named the model that was asked first, and it is no longer true.
      let retryingWithModelId: string | null = null;
      // Set by the out-of-band "generating" marker and cleared when the
      // trailer says what actually happened. Held on the message rather than
      // in component state because three panels stream at once and the status
      // belongs to one of them.
      let isGeneratingArtifact = false;
      let generatingArtifactFormat: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetIdleTimeout();
        rawStreamText += decoder.decode(value, { stream: true });
        // §7's `retrying_with_another_model` arrives as a leading out-of-band
        // chunk, because a fallback is decided after the headers are gone.
        // Stripped here on every pass rather than once at the end: the answer
        // is rendered as it streams, and a marker left in for even one frame
        // is a marker the user reads.
        const routing = splitRoutingRetrySignal(rawStreamText);
        if (routing.signal) retryingWithModelId = routing.signal.modelId;
        // The "creating the Excel file" marker, stripped on every pass for
        // the same reason the routing one is: the answer is rendered as it
        // streams, and a marker left in for even one frame is a marker the
        // user reads.
        const artifactProgress = splitArtifactProgressSignal(routing.text);
        if (artifactProgress.signal) {
          isGeneratingArtifact = true;
          generatingArtifactFormat = artifactProgress.signal.format;
        }
        assistantText = splitSearchMetadataTrailer(
          artifactProgress.text
        ).displayText;
		setAssistantMessage(
          assistantMessageId,
          assistantText,
          "normal",
          undefined,
          isGeneratingArtifact
            ? {
                isGeneratingArtifact: true,
                ...(generatingArtifactFormat
                  ? { generatingArtifactFormat }
                  : {}),
              }
            : undefined
        );
      }

      const finalRouting = splitRoutingRetrySignal(rawStreamText);
      if (finalRouting.signal) retryingWithModelId = finalRouting.signal.modelId;
      const { searchMetadataJson } = splitSearchMetadataTrailer(
        splitArtifactProgressSignal(finalRouting.text).text
      );
      const trailer = parseChatStreamTrailer(searchMetadataJson);
      const searchMetadata =
        (trailer?.searchMetadata as WebSearchExecution | null | undefined) ??
        null;
      // A `length` finish reason means the provider stopped at its output
      // ceiling: the text is real and stays exactly as streamed, but the
      // answer must not read as finished. No follow-up request is sent from
      // here -- continuing costs credits and is the user's decision.
      const completionStatus = trailer?.completion?.status ?? "normal";
      /*
        The files this turn produced, as the server recorded them.

        `?? []` rather than `?? undefined`: a turn that announced it was
        generating and then sent no artifacts in the trailer failed somewhere
        the collector could not name, and the honest end state is no card at
        all rather than a spinner that never resolves.
      */
      const artifacts = trailer?.artifacts ?? [];

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
          {
            errorCode: "EMPTY_RESPONSE",
            errorHadAttachments: attachments.length > 0,
            // EMPTY_RESPONSE is a *client* classification: the stream ended
            // normally (HTTP 200) with no text, so no server error was
            // emitted and no token exists. The report stays unverified by
            // design -- see docs/policy/trace-feedback-automation.md.
            errorReport: buildErrorReport(
              requestTraceId,
              "EMPTY_RESPONSE",
              ERROR_CLASSIFICATION_SOURCE.client
            ),
          }
        );
      } else {
        setAssistantMessage(
          assistantMessageId,
          assistantText,
          completionStatus,
          undefined,
          {
            searchMetadata,
            // Always written, so a retry that produces no file clears the
            // cards the previous attempt left behind.
            artifacts,
            isGeneratingArtifact: false,
            generatingArtifactFormat: undefined,
            ...(memoryUsedCount > 0 ? { memoryUsedCount } : {}),
            // Only when the Router chose it, and only when the answer did not
            // then fall back to something else: `retryingWithModelId` means a
            // different model produced the text, so a badge naming the routed
            // one would attribute the answer to a model that wrote none of it.
            ...(routedModelId && !retryingWithModelId
              ? { routedModelId, routedReason }
              : {}),
            ...(knowledgeChunkCount > 0 ? { knowledgeChunkCount } : {}),
            // §7: when the server fell back mid-response, the model that
            // answered is not the one this request was sent to. Recording the
            // request's model here would attribute the answer to a model that
            // produced none of it.
            ...(retryingWithModelId ? { modelId: retryingWithModelId } : {}),
          }
        );
        onResponseComplete?.(
          analyticsPromptId,
          retryingWithModelId ?? modelId,
          assistantText,
          searchMetadata
        );
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
      } else if (isGuestVerificationError(error)) {
        // The challenge itself ended without a token (failed / cancelled /
        // timeout / expired / unavailable) -- either in this panel or in the
        // verifying panel this one was waiting on. The panel gets the same
        // localized sentence every verification surface uses; the draft and
        // attachments live in the optimistic user turn, which stays.
        const failureTraceId = requestTraceId;
        if (failureTraceId && typeof window !== "undefined") {
          window.localStorage.setItem(
            "tomverse_last_error_trace_id",
            failureTraceId
          );
        }
        setAssistantMessage(
          assistantMessageId,
          `${t(guestVerificationFailureKey(error.kind))}${
            failureTraceId ? `\n${t("chat.traceId")}: ${failureTraceId}` : ""
          }`,
          "error",
          {
            errorCode: `GUEST_VERIFICATION_${error.kind.toUpperCase()}`,
            errorHadAttachments: attachments.length > 0,
            errorReport: buildErrorReport(
              failureTraceId,
              `GUEST_VERIFICATION_${error.kind.toUpperCase()}`,
              ERROR_CLASSIFICATION_SOURCE.client
            ),
          }
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
          // A verification code surfacing here means the recovery flow itself
          // was refused again (e.g. the grant cookie was not honoured). The
          // server's English sentence must never reach the panel raw -- the
          // guest reads the same localized verification copy as everywhere
          // else, and the trace id below keeps it diagnosable.
          errorCode === "TURNSTILE_REQUIRED" || errorCode === "TURNSTILE_FAILED"
            ? t("chat.guestVerificationFailed")
          : errorCode === "TURNSTILE_UNAVAILABLE" ||
              errorCode === "TURNSTILE_NOT_CONFIGURED" ||
              errorCode === "SECURITY_NOT_CONFIGURED"
            ? t("chat.guestVerificationUnavailable")
          : errorCode === "CHAT_RATE_LIMITED"
            ? t("chat.tooManyRequestsRetry").replace(
                "{seconds}",
                String(Math.max(1, retryAfterSeconds ?? 5))
              )
            : errorCode === "CHAT_CONTEXT_BUNDLE_STALE"
              // The terminal state of §10: this send was priced against a
              // memory context that no longer matches, and the recovery was
              // either already spent (a single-model retry) or is not this
              // panel's to take (a comparison). The server's English sentence
              // never reaches the panel -- the user is told what happened in
              // their own language, and that sending again is what fixes it.
              ? t("chat.contextBundleStale")
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
                    : errorCode === "CHAT_IP_CONCURRENCY_EXCEEDED"
                    ? t("chat.networkConcurrencyLimit")
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
          {
            errorCode: errorCode || "UNKNOWN_ERROR",
            errorHadAttachments: attachments.length > 0,
            errorReport: buildErrorReport(
              traceId,
              errorCode || "UNKNOWN_ERROR",
              errorCode
                ? ERROR_CLASSIFICATION_SOURCE.server
                : ERROR_CLASSIFICATION_SOURCE.client
            ),
          }
        );
      }	
    } finally {
	  if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
      }

      endChatRuntimeRun(runKey, controller);
      // A guest answer can finish while no panel is mounted on this
      // conversation, and an effect on `messages` of an unmounted component
      // never fires. Written here so the transcript localStorage holds is the
      // finished one, not the last frame the user happened to be looking at.
      persistGuestTranscript(runKey, targetChatId);
    }
  }, [
    assistantMessageWriter,
    isGuestMode,
    onContextBundleStale,
    messages,
    modelId,
    onResponseComplete,
    persistGuestTranscript,
    pollDeepResearchJob,
    runGuestChatRequest,
    sessionUserId,
    t,
    webSearchMode,
  ]);

  const handleRetryLast = useCallback(() => {
    const lastPrompt = getChatRuntimeLastPrompt(runtimeKeyRef.current);
    if (!lastPrompt || isChatRuntimeStreaming(runtimeKeyRef.current)) return;

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
    const lastPrompt = getChatRuntimeLastPrompt(runtimeKeyRef.current);
    if (!lastPrompt || isChatRuntimeStreaming(runtimeKeyRef.current)) return;

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
    // The payload is not cleared once its panels have consumed it, so this
    // effect re-runs for whatever model the panel is showing later. Only the
    // models the send was made for may answer it -- a model swapped in
    // afterwards was not part of this run and has no answer to give here.
    if (!promptPayload.modelIds.includes(modelId)) return;

    const promptKey = `${promptPayload.id}:${promptPayload.chatId}:${modelId}`;
    if (processedPromptKeys.has(promptKey)) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || isPanelDisabled) return;
      if (processedPromptKeys.has(promptKey)) return;
      // Claimed before the barrier is awaited, not after: a re-render during
      // the await must not let a second pass start the same send.
      processedPromptKeys.add(promptKey);
      void (async () => {
        // Every other send path (global submit, per-panel follow-up, both
        // retries) flushes the model-settings sync before it sends. This one
        // did not, which made it the one way a request could reach /api/chat
        // ahead of the PATCH that puts its model into the conversation's
        // stored selection. Normally the flush is already satisfied and
        // resolves without a request; when it is not, the send waits for the
        // server rather than racing it.
        const settingsReady =
          (await onBeforeSendRef.current?.(promptPayload.chatId)) ?? true;
        // Abandoned stays abandoned, exactly like the other send paths: a
        // refused flush has already told the user and put the screen back on
        // the selection the server confirmed, so re-sending behind that would
        // contradict it. The claim is deliberately kept so nothing picks the
        // payload up again. The model check catches the panel having moved on
        // while the flush was running -- sending then would file this answer
        // under a model the panel is no longer showing.
        if (!settingsReady || panelModelIdRef.current !== modelId) return;
        void handleSendPrompt(
          promptPayload.text,
          promptPayload.chatId,
          promptPayload.userMessageId,
          promptPayload.attachments,
          promptPayload.id,
          modelId === "perplexity/sonar-deep-research"
            ? promptPayload.deepResearchDepth
            : undefined,
          promptPayload.admissionToken,
          promptPayload.contextBundle,
          promptPayload.contextLayout
        );
      })();
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
        if (!trimmed || isChatRuntimeStreaming(runtimeKey) || isPanelDisabled || !initialConversationId) return;

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
                await discardResponseBody(response);
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
        <div
          data-testid="chat-panel-loading"
          aria-busy="true"
          className="flex h-full items-center justify-center text-xs text-zinc-500"
        >
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
                              aria-label={interpolateModelOnlyLabel(
                                  t("chat.modelOnlyInputLabel"),
                                  getModel(modelId)?.name || modelId
                              )}
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
