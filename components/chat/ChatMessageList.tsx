"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import type { ComponentPropsWithoutRef } from "react";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  ArrowDown,
  Bot,
  Braces,
  Check,
  Copy,
  File as FileIcon,
  FileText,
  FileWarning,
  Image as ImageIcon,
  Presentation,
  RotateCcw,
  Sheet,
  Square,
  UserRound,
} from "lucide-react";
import { Message, type ChatAttachment } from "@/components/chat/types";
import { AutoRoutedByBadge } from "@/components/chat/AutoRoutedByBadge";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { FeedbackButton } from "@/components/chat/FeedbackButton";
import {
  GeneratedArtifactList,
  GeneratedArtifactPending,
} from "@/components/chat/GeneratedArtifactCard";
import { writePendingGuestImportIntent } from "@/lib/guestImport";
import {
  nextModeForUserScroll,
  type ChatScrollMode,
} from "@/lib/chatAutoScroll";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import {
  modelEligibleForWebSearchSurcharge,
  WEB_SEARCH_SURCHARGE_CREDITS,
} from "@/lib/webSearchCredits";
import { decideWebSearchBadge } from "@/lib/webSearchStatusBadge";
import { decideAnswerContextDisclosure } from "@/lib/answerContextDisclosure";

type ChatMessageListProps = {
  messages: Message[];
  onRetryLast?: () => void;
  onRetryWithoutAttachments?: () => void;
  /**
   * Re-sends the last prompt with a set of already-missing stored files
   * acknowledged.
   *
   * Distinct from `onRetryWithoutAttachments`, which drops this turn's own
   * attachments. This one keeps every reference and only tells the server that
   * these specific files may be skipped for one request; nothing is deleted
   * and no stored message changes.
   */
  onContinueWithoutUnavailableAttachments?: (attachmentIds: string[]) => void;
  onRequestCloseModel?: () => void;
  hasMultipleActiveModels?: boolean;
  currentModelId?: string | null;
  currentPlan?: string | null;
  isGuestMode?: boolean;
  currentChatId?: string | null;
  // This panel's own in-flight state (not the other panels'), used to show
  // "connecting" vs "generating" on the message currently streaming in --
  // distinct from msg.status, which doesn't tell "still streaming" apart
  // from "finished normally".
  isSending?: boolean;
  // Aborts only this panel's in-flight request, distinct from the shell's
  // "stop all" button.
  onStopGenerating?: () => void;
};
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;

// Codes where the fix is changing what's being asked for (fewer/cheaper
// models, a different model) rather than repeating the same request.
const QUOTA_ERROR_CODES = new Set([
  "CREDIT_BALANCE_INSUFFICIENT",
  "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
  "PLAN_ENTITLEMENT_EXHAUSTED",
  "PLAN_DAILY_CREDIT_LIMIT_REACHED",
  "CHAT_QUOTA_EXCEEDED",
  "FREE_PRO_MODEL_QUOTA_EXCEEDED",
  "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
  "PROVIDER_BUDGET_EXHAUSTED",
  // Retired codes, still classified so a response cached from an older
  // deployment keeps offering the "change what you asked for" affordances.
  "INTERNAL_DAILY_COST_SAFETY_LIMIT",
  "INTERNAL_MONTHLY_COST_SAFETY_LIMIT",
  "PROVIDER_DAILY_SPEND_LIMIT_REACHED",
  "PROVIDER_SPEND_LIMIT_REACHED",
  "CHAT_CONCURRENCY_EXCEEDED",
  "CHAT_IP_CONCURRENCY_EXCEEDED",
]);

type ErrorCategory = "quota" | "model_retired" | "attachment" | "generic";

const classifyError = (message: Message): ErrorCategory => {
  if (message.errorCode === "MODEL_RETIRED") return "model_retired";
  if (message.errorCode && QUOTA_ERROR_CODES.has(message.errorCode)) return "quota";
  if (message.errorHadAttachments && isFileParsingError(message.content)) return "attachment";
  return "generic";
};

const getAttachmentLabel = (attachment: ChatAttachment) => {
  const extension = attachment.name.split(".").pop();
  return extension && extension !== attachment.name
    ? extension.toUpperCase()
    : attachment.mediaType.split("/").pop()?.toUpperCase() || "FILE";
};

const getAttachmentIcon = (attachment: ChatAttachment) => {
  if (attachment.mediaType.startsWith("image/")) {
    return <ImageIcon className="h-5 w-5" />;
  }
  if (attachment.mediaType === "application/json") {
    return <Braces className="h-5 w-5" />;
  }
  if (
    attachment.mediaType === "text/csv" ||
    attachment.mediaType.includes("spreadsheet") ||
    attachment.mediaType.includes("opendocument.spreadsheet")
  ) {
    return <Sheet className="h-5 w-5" />;
  }
  if (
    attachment.mediaType.includes("presentation") ||
    attachment.mediaType.includes("opendocument.presentation")
  ) {
    return <Presentation className="h-5 w-5" />;
  }
  if (
    attachment.mediaType === "application/pdf" ||
    attachment.mediaType.startsWith("text/")
  ) {
    return <FileText className="h-5 w-5" />;
  }
  return <FileIcon className="h-5 w-5" />;
};

const hasImagePreview = (attachment: ChatAttachment) =>
  attachment.mediaType.startsWith("image/") &&
  typeof attachment.data === "string" &&
  (attachment.data.startsWith("data:image/") || attachment.data.startsWith("blob:"));

const isFileParsingError = (content: string) => {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("pdf") ||
    normalized.includes("office") ||
    normalized.includes("unsupported") ||
    normalized.includes("invalid")
  );
};

type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;

/**
 * A markdown code block with its own copy control.
 *
 * Declared here at module scope rather than inline in `ReactMarkdown`'s
 * `components` map on purpose. A component written inside that map is a new
 * function -- a new element *type* -- on every render, so React unmounts the
 * old subtree and mounts a fresh one each time: the "copied" tick would be
 * wiped by the very next streamed chunk, or by any parent re-render. Given a
 * stable type, each block keeps its own state for as long as it is on screen.
 */
function MarkdownCodeBlock({ children }: MarkdownPreProps) {
  const { t } = useLanguage();
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedResetRef.current) clearTimeout(copiedResetRef.current);
    };
  }, []);

  const copyCode = async () => {
    const element = preRef.current;
    if (!element) return;
    // Read the rendered text, not `children`: rehype-highlight has already
    // split the code into nested <span>s, so anything derived from the React
    // children (`String(children)`, a join of the leaves) returns markup
    // artefacts instead of code. The copy button is a sibling of the <pre>,
    // never a child, so nothing but the code itself is in here.
    //
    // mdast-util-to-hast ends every code block with the one newline that
    // closes it for display; the author did not type it, so exactly that one
    // is dropped -- and only if it is there. A blank line the author did
    // write before it survives, as does every newline inside the block.
    const code = (element.textContent ?? "").replace(/\r?\n$/, "");
    try {
      await navigator.clipboard.writeText(code);
    } catch (error) {
      console.error("Failed to copy code block:", error);
      return;
    }
    if (copiedResetRef.current) clearTimeout(copiedResetRef.current);
    setCopied(true);
    copiedResetRef.current = setTimeout(() => setCopied(false), 1_500);
  };

  // The success state has to reach the accessible name as well as the icon --
  // a keyboard or screen reader user gets no result at all from a glyph swap.
  // Reusing the existing `responseCopied` string keeps one wording for "the
  // clipboard now holds this", and adds no second `role="status"` inside the
  // transcript (which would make the app's own toast assertions ambiguous).
  const label = copied ? t("chat.responseCopied") : t("chat.copyCode");

  return (
    <div className="relative mb-3 last:mb-0">
      {/*
        UX-031, same reasoning as the table above: a long line of code scrolls
        sideways and nothing inside a <pre> can take focus.

        The extra top padding is what the button sits in. The button is a
        sibling of the <pre> rather than a child, so scrolling the code
        sideways does not carry it off the edge, and `textContent` above stays
        the code alone.
      */}
      <pre
        ref={preRef}
        className="overflow-x-auto rounded-lg bg-zinc-950 px-3 pb-3 pt-11 text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&>code]:block [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-zinc-100"
        tabIndex={0}
        role="region"
        aria-label={t("chat.markdownCodeRegion")}
      >
        {children}
      </pre>
      {/*
        The icon stays small, but the touch target does not: `before:-inset-2`
        grows the hit area of the 28px button to 44x44. Offset by the same 8px
        it is inset from the corner, that square ends flush with the block's
        top and right edges -- a full-size target that still cannot be hit
        from outside the code block it belongs to.
      */}
      <button
        type="button"
        data-testid="chat-code-copy-button"
        onClick={() => void copyCode()}
        title={label}
        aria-label={label}
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors before:absolute before:-inset-2 before:content-[''] hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

function TypingIndicator({ label }: { label?: string }) {
  return (
    // The three bouncing dots are purely visual: without a text alternative,
    // assistive technology has no way to tell that a model is generating a
    // response. The announcement itself comes from the dedicated live region in
    // ChatMessageList, so no role is needed (and adding one would make existing
    // getByRole("status") toast assertions ambiguous).
    <div className="flex items-center gap-1 py-1">
      {label ? <span className="sr-only">{label}</span> : null}
      <span aria-hidden="true" className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 motion-reduce:animate-none dark:bg-zinc-500 [animation-delay:-0.2s]" />
      <span aria-hidden="true" className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 motion-reduce:animate-none dark:bg-zinc-500 [animation-delay:-0.1s]" />
      <span aria-hidden="true" className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 motion-reduce:animate-none dark:bg-zinc-500" />
    </div>
  );
}

export function ChatMessageList({
  messages,
  onRetryLast,
  onRetryWithoutAttachments,
  onContinueWithoutUnavailableAttachments,
  onRequestCloseModel,
  hasMultipleActiveModels = false,
  currentModelId,
  currentPlan,
  isGuestMode = false,
  currentChatId = null,
  isSending = false,
  onStopGenerating,
}: ChatMessageListProps) {
  const { models: AVAILABLE_MODELS, getModel } = useModelCatalog();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousLastUserMessageIdRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  // Mirrors scrollMode synchronously for callbacks that run outside React's
  // render cycle (ResizeObserver, the native scroll listener) and would
  // otherwise close over a stale value.
  const scrollModeRef = useRef<ChatScrollMode>("following");
  // True only for the lifetime of a scroll call this component itself
  // triggered -- not a fixed time window. Lets the scroll listener tell "we
  // just moved the viewport" apart from "the user (or their input device)
  // moved it", however long that scroll actually takes to settle.
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollRafRef = useRef<number | null>(null);
  const [scrollMode, setScrollModeState] = useState<ChatScrollMode>("following");
    const { t, lang } = useLanguage();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Coarse announcement of the response lifecycle. Deliberately NOT an
  // aria-live region around the transcript itself: streaming token-by-token
  // into a live region floods a screen reader with partial words. Only the
  // start/finish/fail transitions are announced; the answer stays readable by
  // navigating the transcript as normal.
  const lastMessage = messages[messages.length - 1];
  const liveStatusMessage = (() => {
    if (!lastMessage || lastMessage.role !== "assistant") return "";
    if (lastMessage.id === "welcome") return "";
    if (!lastMessage.content) return t("chat.responseGenerating");
    if (lastMessage.status === "error") return t("chat.responseFailed");
    if (lastMessage.status === "cancelled") return t("chat.responseCancelled");
    if (lastMessage.status === "incomplete") return t("chat.responseIncomplete");
    return t("chat.responseComplete");
  })();

  const copyMessageContent = async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch (error) {
      console.error("Failed to copy response:", error);
      return;
    }
    if (copiedResetRef.current) clearTimeout(copiedResetRef.current);
    setCopiedMessageId(messageId);
    copiedResetRef.current = setTimeout(() => setCopiedMessageId(null), 1_500);
  };

  useEffect(() => {
    return () => {
      if (copiedResetRef.current) clearTimeout(copiedResetRef.current);
    };
  }, []);

  // Keeps scrollModeRef (readable synchronously from non-React callbacks)
  // and the rendered scrollMode state in lockstep -- always go through this
  // instead of calling setScrollModeState directly.
  const setMode = useCallback((mode: ChatScrollMode) => {
    scrollModeRef.current = mode;
    setScrollModeState(mode);
  }, []);

  // Scrolls the container and marks the scroll that results as "ours" for
  // exactly as long as it actually takes -- via the `scrollend` event where
  // supported, with a couple of animation frames as a fallback/backstop --
  // rather than guessing a fixed duration. See lib/chatAutoScroll.ts for why
  // a clock-based window doesn't work once chunks arrive faster than it.
  const scrollToBottomNow = useCallback((behavior: ScrollBehavior) => {
    const container = containerRef.current;
    if (!container) return;

    if (programmaticScrollRafRef.current !== null) {
      cancelAnimationFrame(programmaticScrollRafRef.current);
      programmaticScrollRafRef.current = null;
    }
    isProgrammaticScrollRef.current = true;

    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      container.removeEventListener("scrollend", clear);
      isProgrammaticScrollRef.current = false;
    };

    container.addEventListener("scrollend", clear, { once: true });
    container.scrollTo({ top: container.scrollHeight, behavior });

    // Covers browsers without `scrollend`, and is also normally how an
    // "auto" (instant) scroll's own resulting scroll event gets seen.
    programmaticScrollRafRef.current = requestAnimationFrame(() => {
      programmaticScrollRafRef.current = requestAnimationFrame(clear);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (programmaticScrollRafRef.current !== null) {
        cancelAnimationFrame(programmaticScrollRafRef.current);
      }
    };
  }, []);

  // The only place a real (non-programmatic) scroll is interpreted. Covers
  // wheel, trackpad, touch swipe, scrollbar drag, and keyboard paging
  // uniformly -- all of them move scrollTop and fire this same native event;
  // none need their own listener.
  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    setMode(
      nextModeForUserScroll({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      })
    );
  }, [setMode]);

  useLayoutEffect(() => {
    const messageCount = messages.length;
    const previousMessageCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messageCount;

    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const lastUserMessageId = lastUserMessage?.id ?? null;
    const isNewUserTurn =
      lastUserMessageId !== null && lastUserMessageId !== previousLastUserMessageIdRef.current;
    previousLastUserMessageIdRef.current = lastUserMessageId;

    const isInitialLoad = previousMessageCount === 0 && messageCount > 0;

    if (isInitialLoad || isNewUserTurn) {
      // A fresh load or an explicitly-sent new message always follows the
      // new response, even if the user was reading history a moment ago.
      setMode("following");
      scrollToBottomNow("auto");
      return;
    }

    if (scrollModeRef.current === "following") {
      scrollToBottomNow("auto");
    }
    // Paused: streamed content growing must never move scrollTop.
  }, [messages, scrollToBottomNow, setMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    // Catches layout growth that doesn't come with a `messages` change --
    // an image finishing decode, code-block syntax highlighting landing
    // late, etc. Never allowed to touch scrollMode itself (only real user
    // scroll input does that), so it can't silently cancel a pause.
    const observer = new ResizeObserver(() => {
      if (scrollModeRef.current !== "following") return;
      scrollToBottomNow("auto");
    });

    observer.observe(container);
    if (container.firstElementChild) {
      observer.observe(container.firstElementChild);
    }

    return () => {
      observer.disconnect();
    };
  }, [scrollToBottomNow]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* aria-live + aria-atomic without role="status": the two are equivalent
          for announcement purposes, and an extra `status` role in the tree would
          make every existing getByRole("status") toast assertion ambiguous. */}
      <p
        data-testid="chat-response-status"
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {liveStatusMessage}
      </p>
      <div
        data-testid="chat-message-list"
        ref={containerRef}
        onScroll={handleScroll}
        // Focusable so PageUp/PageDown/Home/End/ArrowUp/ArrowDown reach this
        // scroll container natively once the user clicks into it, the same
        // as wheel/trackpad/touch/scrollbar input already does via the
        // browser's own scroll handling -- no extra key handling needed.
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 md:px-6 md:py-6"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3.5 pb-3 md:gap-5 md:pb-4">
          {messages.map((msg, idx) => {
            const isUser = msg.role === "user";

            const modelInfo = !isUser && msg.modelId
              ? AVAILABLE_MODELS.find(m => m.id === msg.modelId)
              : null;

            // Only the message this panel is actually streaming right now
            // (always the last one) gets the connecting/generating status --
            // msg.status alone can't tell "still streaming" apart from
            // "finished normally", both are "normal".
            const isActivelyGenerating =
              !isUser && isSending && idx === messages.length - 1 && msg.role === "assistant";

            // Only shown before the first token arrives (msg.content is
            // still empty) -- once real text starts streaming in, the
            // generic "generating" label takes over. Perplexity models
            // genuinely run a live web search first; a prior user turn with
            // attachments genuinely gets read first. Anything else falls
            // back to the plain "connecting" text rather than guessing.
            const connectingStatusText =
              modelInfo?.provider === "perplexity"
                ? t("chat.searchingWebStatus")
                : messages[idx - 1]?.attachments?.length
                  ? t("chat.readingFileStatus")
                  : t("chat.connectingStatus");

              // Technical detail lines (trace IDs, internal cost figures) are
            // appended to msg.content after a newline -- the first line is
            // the primary, user-facing message; any remaining lines are
            // rendered separately below as a de-emphasized auxiliary layer
            // (see errorAuxiliaryLines) rather than dropped entirely.
            const displayContent =
              !isUser && msg.status === "error"
                ? msg.content.split("\n")[0]
                : msg.content;
            const errorAuxiliaryLines =
              !isUser && msg.status === "error"
                ? msg.content.split("\n").slice(1).filter(Boolean)
                : [];

            const assistantBoxClass = msg.status === "error"
                  ? "bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-100 dark:border-red-800"
                  : msg.status === "cancelled"
                      ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300 italic"
                      : "bg-zinc-50 text-zinc-800 border border-zinc-200 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700/50";

            const userBoxClass = "bg-blue-600 text-white";

            return (
              <div
                key={msg.id || idx}
                data-testid="chat-message"
                data-message-role={msg.role}
                data-model-id={msg.modelId || ""}
                className={`flex w-full flex-col ${isUser ? "items-end" : "items-start"}`}
              >
                {!isUser && modelInfo && (
                  // Every control on this row states something the reader
                  // cannot recover from anywhere else -- the run mode, that
                  // the turn is live, how to stop it -- so none of them may
                  // wrap or shrink their own label. Only the model name
                  // gives way, and it keeps the full string in `title`
                  // beside a logo that already names the provider.
                  <div
                    data-testid="assistant-message-header"
                    className="mb-1.5 ml-1 flex max-w-full select-none items-center gap-2"
                  >
                    <ModelLogo model={modelInfo} size="sm" />
                    <span
                      data-testid="assistant-message-model-name"
                      title={modelInfo.name}
                      className="min-w-0 truncate text-[11px] font-semibold text-zinc-500 dark:text-zinc-400"
                    >
                      {modelInfo.name}
                    </span>
                    {msg.content && msg.status !== "error" && msg.status !== "pending" && (() => {
                      // The badge reports web search and nothing else. Why it
                      // no longer says "training knowledge", and why a message
                      // with no metadata gets no badge at all, is in
                      // lib/webSearchStatusBadge.ts.
                      const decision = decideWebSearchBadge({
                        searchMetadata: msg.searchMetadata,
                        usageClass: modelInfo.usageClass,
                        // The trailer that carries `searchMetadata` arrives at
                        // the end of the stream, so a running turn has none.
                        // Without this the Deep Research badge is absent for
                        // the whole run -- which, the job being asynchronous,
                        // is the state the panel is in the entire time.
                        generating: isActivelyGenerating,
                      });
                      if (!decision.shown) return null;
                      const status = decision.status;
                      // "requested-not-executed" only ever occurs for a
                      // dispatchable native capability -- unsupported,
                      // unverified and cost-unbounded models are routed to the
                      // "unsupported" status instead, so the surcharge was
                      // always reserved (and refunded) here.
                      //
                      // Asked of the same predicate that decides the charge,
                      // rather than re-read off `support`: a native capability
                      // no request may dispatch is never surcharged, and a
                      // badge quoting "+N" beside it would name a price nobody
                      // paid.
                      const nativeSearchSurcharged =
                        status === "executed" &&
                        modelEligibleForWebSearchSurcharge(
                          getWebSearchCapability(modelInfo.id)
                        );
                      const label =
                        status === "deep-research"
                          ? t("chat.searchStatusDeepResearch")
                          : status === "unsupported"
                            ? t("chat.searchStatusUnsupported")
                            : status === "failed"
                              ? t("chat.searchStatusFailed")
                              : status === "executed"
                                ? nativeSearchSurcharged
                                  ? `${t("chat.searchStatusWebSearch")} · +${WEB_SEARCH_SURCHARGE_CREDITS}`
                                  : t("chat.searchStatusWebSearch")
                                : status === "requested-not-executed"
                                  ? t("chat.searchStatusRequestedNotExecuted")
                                  : t("chat.searchStatusNotSearched");
                      const detail =
                        status === "requested-not-executed"
                          ? t("chat.searchStatusRefundDetail")
                          : undefined;
                      return (
                        <span
                          data-testid="search-status-badge"
                          data-search-status={status}
                          title={detail}
                          aria-label={detail ? `${label} — ${detail}` : undefined}
                          className="shrink-0 whitespace-nowrap rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                        >
                          {label}
                        </span>
                      );
                    })()}
                    {isActivelyGenerating && msg.content && (
                      <span className="shrink-0 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-blue-500 dark:text-blue-400">
                        {t("chat.generatingStatus")}
                      </span>
                    )}
                    {isActivelyGenerating && onStopGenerating && (
                      <button
                        type="button"
                        data-testid="stop-this-response"
                        onClick={onStopGenerating}
                        title={t("chat.stopThisResponse")}
                        aria-label={t("chat.stopThisResponse")}
                        className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] font-bold text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
                      >
                        <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                        {t("chat.stop")}
                      </button>
                    )}
                  </div>
                )}
                
                {!isUser && !modelInfo && msg.id === "welcome" && (
                  <div className="mb-1.5 ml-1 flex select-none items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                      <Bot className="h-3.5 w-3.5" />
                    </span>
                            <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t("chat.aiAssistant")}</span>
                  </div>
                )}

                {isUser && (
                  <div className="mb-1.5 mr-1 flex select-none items-center gap-2">
                    <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t("chat.you")}</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-600 text-white">
                      <UserRound className="h-3.5 w-3.5" />
                    </span>
                  </div>
                )}

                <div
                  role={!isUser && msg.status === "error" ? "alert" : undefined}
                  className={`relative max-w-[94%] break-words rounded-2xl px-3 py-2 text-[13px] leading-[1.55] shadow-sm md:max-w-[88%] md:px-4 md:py-3 md:text-[15px] md:leading-relaxed ${
                    isUser ? `${userBoxClass} rounded-br-md` : `${assistantBoxClass} rounded-bl-md`
                  } ${!isUser && msg.content && msg.status !== "error" ? "pr-8 md:pr-9" : ""}`}
                >
                  {!isUser && msg.content && msg.status !== "error" && (
                    <button
                      type="button"
                      onClick={() => void copyMessageContent(String(msg.id ?? idx), msg.content)}
                      title={t("chat.copyResponse")}
                      aria-label={t("chat.copyResponse")}
                      className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-200/70 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-100"
                    >
                      {copiedMessageId === String(msg.id ?? idx) ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  {isUser && msg.attachments && msg.attachments.length > 0 && (
                    <div className={`flex flex-wrap gap-2 ${msg.content ? "mb-3" : ""}`}>
                      {msg.attachments.map((attachment) => (
                        (() => {
                          /*
                            A file whose bytes object storage no longer holds.

                            The card stays. The name stays, the type stays, the
                            message stays -- what the person sent is part of
                            this conversation whether or not the bytes survived,
                            and a card that quietly vanished would leave them
                            asking about a document neither side can name
                            (docs/policy/user-attachment-persistence.md §11).

                            What changes is that it stops pretending: no
                            thumbnail, a stated reason, and an accessible name
                            that carries the state rather than only the colour.
                          */
                          const isUnavailable = Boolean(attachment.unavailableAt);
                          const showImagePreview =
                            !isUnavailable && hasImagePreview(attachment);
                          return (
                        <div
                          key={attachment.id}
                          data-testid={
                            isUnavailable
                              ? "chat-attachment-card-unavailable"
                              : "chat-attachment-card"
                          }
                          data-attachment-unavailable={
                            isUnavailable ? "true" : undefined
                          }
                          className={
                            showImagePreview
                              ? "relative h-20 w-20 overflow-hidden rounded-xl border border-white/20 bg-white/10 shadow-sm"
                              : `flex h-16 min-w-52 max-w-64 items-center gap-3 rounded-xl border py-2 pl-2 pr-3 shadow-sm backdrop-blur ${
                                  isUnavailable
                                    ? "border-dashed border-amber-200/60 bg-white/5"
                                    : "border-white/15 bg-white/10"
                                }`
                          }
                          title={
                            isUnavailable
                              ? `${attachment.name} — ${t("chat.attachmentUnavailableBadge")}`
                              : attachment.name
                          }
                        >
                          {showImagePreview ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={attachment.data}
                              alt={attachment.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <>
                              <span
                                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-white/10 ${
                                  isUnavailable
                                    ? "bg-white/10 text-amber-100"
                                    : "bg-white/15 text-white"
                                }`}
                                aria-hidden="true"
                              >
                                {isUnavailable ? (
                                  <FileWarning className="h-5 w-5" />
                                ) : (
                                  getAttachmentIcon(attachment)
                                )}
                              </span>
                              <span className="flex min-w-0 flex-col text-left">
                                <span className="truncate text-sm font-semibold text-white">
                                  {attachment.name}
                                </span>
                                <span
                                  className={
                                    isUnavailable
                                      ? "truncate text-[11px] font-semibold text-amber-100"
                                      : "text-[11px] font-semibold text-blue-100/80"
                                  }
                                >
                                  {isUnavailable
                                    ? t("chat.attachmentUnavailableBadge")
                                    : getAttachmentLabel(attachment)}
                                </span>
                              </span>
                            </>
                          )}
                        </div>
                          );
                        })()
                      ))}
                    </div>
                  )}
                  {msg.role === "assistant" && !msg.content ? (
                    isActivelyGenerating ? (
                      <div className="flex items-center gap-2">
                        <TypingIndicator />
                        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                          {connectingStatusText}
                        </span>
                      </div>
                    ) : (
                      <TypingIndicator label={t("chat.responseGenerating")} />
                    )
                  ) : msg.role === "assistant" ? (
                    <>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={{
                        /*
                          UI-026. No `whitespace-pre-wrap` here. CommonMark
                          collapses a single newline inside a paragraph into a
                          space, but react-markdown leaves that newline in the
                          text node -- so preserving whitespace turned every
                          soft wrap the model happened to emit into a hard line
                          break, and any run of spaces into visible gaps. The
                          user's own message below still preserves whitespace,
                          because that text is not markdown and was typed the
                          way it reads.
                        */
                        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                        ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
                        li: ({ children }) => <li className="mb-1">{children}</li>,
                        // Tailwind's preflight resets headings to `font-size:
                        // inherit; font-weight: inherit` and zeroes every border,
                        // so without these overrides a model's "## Heading"
                        // rendered pixel-identical to a paragraph and GFM tables
                        // came out borderless and unpadded.
                        h1: ({ children }) => <h1 className="mb-2 mt-4 text-[1.35em] font-bold leading-snug first:mt-0">{children}</h1>,
                        h2: ({ children }) => <h2 className="mb-2 mt-4 text-[1.2em] font-bold leading-snug first:mt-0">{children}</h2>,
                        h3: ({ children }) => <h3 className="mb-2 mt-3 text-[1.08em] font-bold leading-snug first:mt-0">{children}</h3>,
                        h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-[1em] font-bold leading-snug first:mt-0">{children}</h4>,
                        h5: ({ children }) => <h5 className="mb-1.5 mt-3 text-[0.95em] font-bold uppercase tracking-wide first:mt-0">{children}</h5>,
                        h6: ({ children }) => <h6 className="mb-1.5 mt-3 text-[0.9em] font-bold uppercase tracking-wide first:mt-0">{children}</h6>,
                        blockquote: ({ children }) => (
                            <blockquote className="mb-3 border-l-2 border-zinc-300 pl-3 italic text-zinc-600 last:mb-0 dark:border-zinc-600 dark:text-zinc-300">
                                {children}
                            </blockquote>
                        ),
                        hr: () => <hr className="my-4 border-t border-zinc-200 dark:border-zinc-700" />,
                        // The wrapper scrolls the table itself; without it a wide
                        // table forces the whole message list to scroll sideways.
                        // UX-031. A scroll container with nothing focusable in
                        // it cannot be scrolled by keyboard at all -- there is
                        // no way to reach the right-hand columns of a wide
                        // table without a pointer. `tabIndex={0}` makes the
                        // region itself a stop so the arrow keys reach it, and
                        // the role and name stop it being an unlabelled stop.
                        table: ({ children }) => (
                            <div
                                className="mb-3 max-w-full overflow-x-auto last:mb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                tabIndex={0}
                                role="region"
                                aria-label={t("chat.markdownTableRegion")}
                            >
                                <table className="w-full border-collapse text-left text-[0.95em]">{children}</table>
                            </div>
                        ),
                        th: ({ children }) => (
                            <th className="border border-zinc-300 bg-zinc-100 px-2 py-1 font-bold dark:border-zinc-600 dark:bg-zinc-800">
                                {children}
                            </th>
                        ),
                        td: ({ children }) => (
                            <td className="border border-zinc-300 px-2 py-1 align-top dark:border-zinc-600">{children}</td>
                        ),
                        // Block code, with its own copy control. Referenced
                        // by identity rather than written out here: an inline
                        // component would be remounted on every render and
                        // could not hold the copied state (see
                        // MarkdownCodeBlock).
                        pre: MarkdownCodeBlock,
                        code: ({ children, className, ...props }: MarkdownCodeProps) => (
                          <code
                            {...props}
                            className={`rounded bg-zinc-200 px-1 py-0.5 text-[0.9em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100 ${className || ""}`}
                          >
                            {children}
                          </code>
                        ),
                        a: ({ children, href }) => (
                          <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 underline">
                            {children}
                          </a>
                        ),
                        // Never put model-controlled image URLs in `src`.
                        // Retrieved pages and attachments can prompt-inject a
                        // model into embedding prior chat text in a tracking
                        // URL; a normal <img> would send it without a click.
                        img: ({ alt }) => (
                          <span
                            className="inline-flex rounded-md border border-zinc-300 bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                            role="note"
                          >
                            {t("chat.markdownImageBlocked")}
                            {alt ? `: ${alt}` : ""}
                          </span>
                        ),
                      }}
                    >
                      {displayContent}
                    </ReactMarkdown>
                    {isActivelyGenerating && (
                      <span
                        className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-zinc-400 align-middle motion-reduce:animate-none dark:bg-zinc-500"
                        aria-hidden="true"
                      />
                    )}
                    {/*
                      docs/policy/external-conversation-import-and-memory.md
                      §13.4 and §14.3: what this answer was given, shown to its
                      owner and counted by the server. Rendered only above zero
                      -- the policy forbids a misleading indication, and
                      "0 memories used" on an answer that never had any is one.
                      It is a statement about this answer, so it sits with the
                      answer rather than in any dock or rail, and touches
                      neither the mobile composer contract nor the comparison
                      rail's.

                      One sentence for two facts, each named: an answer built
                      from the user's own uploaded files and one built from
                      their stored memories are different claims, and a single
                      merged count would state neither.
                    */}
                    {!isUser &&
                      (() => {
                        const disclosure = decideAnswerContextDisclosure({
                          memoryUsedCount: msg.memoryUsedCount,
                          knowledgeChunkCount: msg.knowledgeChunkCount,
                        });
                        if (!disclosure.shown) return null;
                        return (
                          <p
                            data-testid="memory-usage-disclosure"
                            className="mt-3 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500"
                          >
                            {t("chat.answerContextLabel")}
                            {": "}
                            {disclosure.parts
                              .map((part) =>
                                t(
                                  part.kind === "memory"
                                    ? "chat.answerContextMemory"
                                    : "chat.answerContextKnowledge"
                                ).replaceAll("{count}", String(part.count))
                              )
                              .join(" · ")}
                          </p>
                        );
                      })()}
                    {/*
                      Which model answered, on a turn Auto routed
                      (docs/ui-contracts/auto-model-selection.md).

                      Only on a routed turn: `routedModelId` is set from a
                      response header the server writes when the Router chose
                      the model and omits when it did not, so a fallback turn
                      has nothing here rather than a badge claiming a decision
                      nobody made.

                      The display name, not the id -- the id is for logs. A
                      model that has since left the catalogue falls back to its
                      id rather than rendering an empty badge, because "this
                      answer came from something we no longer list" is still
                      the truth about the answer.

                      It is a statement about this answer, so it sits with the
                      answer. It touches neither the mobile composer contract
                      nor the comparison rail's.
                    */}
                    {!isUser && msg.routedModelId && (
                      <p className="mt-3">
                        <AutoRoutedByBadge
                          routed
                          modelName={
                            getModel(msg.routedModelId)?.name ?? msg.routedModelId
                          }
                          reason={msg.routedReason ?? null}
                          language={lang as Parameters<typeof AutoRoutedByBadge>[0]["language"]}
                        />
                      </p>
                    )}
                    {/*
                      The files this answer produced
                      (docs/policy/generated-artifacts.md section 9).

                      Below the body, never inside it: the answer is a short
                      sentence about the file and the card is the file itself,
                      so putting the card in the prose would be the second
                      copy of the same thing this feature exists to remove.

                      The pending row additionally requires the panel to be
                      actively streaming this message, so a cancelled or failed
                      turn cannot leave a spinner behind for work that stopped.
                    */}
                    {!isUser && msg.artifacts && msg.artifacts.length > 0 && (
                      <GeneratedArtifactList
                        artifacts={msg.artifacts}
                        modelNameFor={(modelId) =>
                          getModel(modelId)?.name ?? modelId
                        }
                        fallbackModelId={msg.modelId ?? null}
                        onRetry={onRetryLast}
                        isGuestMode={isGuestMode}
                      />
                    )}
                    {!isUser &&
                      isActivelyGenerating &&
                      msg.isGeneratingArtifact &&
                      !msg.artifacts?.length && (
                        <GeneratedArtifactPending
                          format={msg.generatingArtifactFormat}
                        />
                      )}
                    {msg.searchMetadata && msg.searchMetadata.citations.length > 0 && (
                      <div
                        data-testid="search-citation-list"
                        className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-700/60"
                      >
                        <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                          {t("chat.searchCitationsLabel")}
                        </p>
                        <ul className="space-y-1">
                          {msg.searchMetadata.citations.map((citation, citationIndex) => (
                            <li
                              key={`${citation.url}-${citationIndex}`}
                              data-testid="search-citation-item"
                              data-reference-number={citation.referenceNumber ?? ""}
                              className="flex items-baseline gap-1.5"
                            >
                              {/*
                                The number the answer text already used, shown
                                as the provider numbered it. Providers that
                                publish no citation order (OpenAI, Anthropic,
                                Google inline annotations) leave it undefined
                                and the row renders without one -- a made-up
                                sequence would point at the wrong source.
                              */}
                              {citation.referenceNumber !== undefined && (
                                <span className="shrink-0 text-[11px] font-bold tabular-nums text-zinc-400 dark:text-zinc-500">
                                  [{citation.referenceNumber}]
                                </span>
                              )}
                              <a
                                href={citation.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={citation.url}
                                className="truncate text-[11px] font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400"
                              >
                                {citation.title || citation.url}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                  {!isUser && msg.status === "error" && (() => {
                    const errorCategory = classifyError(msg);
                    const secondaryButtonClass =
                      "inline-flex items-center gap-2 rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:bg-red-950 dark:text-red-100 dark:hover:bg-red-900";
                    const primaryButtonClass =
                      "inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500";
                    return (
                      <div className="mt-3 border-t border-red-200 pt-3 dark:border-red-800">
                        {errorCategory === "attachment" && (
                          <div className="mb-3 rounded-xl border border-red-200 bg-white/80 p-3 text-xs leading-5 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
                            <p className="font-bold">{t("chat.fileErrorHelpTitle")}</p>
                            <ul className="mt-1 list-disc space-y-1 pl-4">
                              <li>{t("chat.fileErrorHelpResave")}</li>
                              <li>{t("chat.fileErrorHelpLimit")}</li>
                              <li>{t("chat.fileErrorHelpRetry")}</li>
                            </ul>
                            <Link
                              href="/support/help-centre"
                              className="mt-2 inline-flex font-bold text-red-700 underline underline-offset-2 dark:text-red-100"
                            >
                              {t("chat.fileErrorHelpLink")}
                            </Link>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          {errorCategory === "quota" && isGuestMode && (
                            <Link
                              href={`/auth/signin?callbackUrl=${encodeURIComponent("/chat")}`}
                              onClick={() => currentChatId && writePendingGuestImportIntent(currentChatId)}
                              className={primaryButtonClass}
                            >
                              {t("chat.continueConversationCta")}
                            </Link>
                          )}
                          {(errorCategory === "model_retired" ||
                            (errorCategory === "quota" && !isGuestMode)) &&
                            onRequestCloseModel && (
                              <button
                                type="button"
                                onClick={onRequestCloseModel}
                                className={primaryButtonClass}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {errorCategory === "quota" && hasMultipleActiveModels
                                  ? t("chat.reduceModelCount")
                                  : t("chat.chooseAnotherModel")}
                              </button>
                            )}
                          {errorCategory === "quota" && isGuestMode && onRequestCloseModel && (
                            <button
                              type="button"
                              onClick={onRequestCloseModel}
                              className={secondaryButtonClass}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              {hasMultipleActiveModels
                                ? t("chat.reduceModelCount")
                                : t("chat.chooseAnotherModel")}
                            </button>
                          )}
                          {(errorCategory === "generic" || errorCategory === "attachment") &&
                            onRetryLast && (
                              <button
                                type="button"
                                onClick={onRetryLast}
                                className={primaryButtonClass}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {t("chat.retry")}
                              </button>
                            )}
                          {errorCategory === "attachment" && onRetryWithoutAttachments && (
                            <button
                              type="button"
                              onClick={onRetryWithoutAttachments}
                              className={secondaryButtonClass}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              {t("chat.retryWithoutFiles")}
                            </button>
                          )}
                          {/*
                            Offered only when the server said it could be: a
                            file being attached right now has a better remedy
                            (attach it again), and offering to proceed there
                            would invite a question about a document the person
                            has just lost. The ids are the server's own, sent
                            straight back as the acknowledgement.
                          */}
                          {msg.errorCode === "ATTACHMENT_UNAVAILABLE" &&
                            msg.canContinueWithoutUnavailableAttachments &&
                            (msg.unavailableAttachmentIds?.length ?? 0) > 0 &&
                            onContinueWithoutUnavailableAttachments && (
                              <button
                                type="button"
                                data-testid="continue-without-unavailable-attachments"
                                onClick={() =>
                                  onContinueWithoutUnavailableAttachments(
                                    msg.unavailableAttachmentIds ?? []
                                  )
                                }
                                className={secondaryButtonClass}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {t("chat.attachmentContinueWithout")}
                              </button>
                            )}
                          <FeedbackButton
                            currentModelId={currentModelId}
                            currentPlan={currentPlan}
                            attachmentCount={msg.errorHadAttachments ? 1 : 0}
                            rawErrorDetails={msg.content}
                            errorReport={msg.errorReport}
                            triggerLabel={t("chat.reportError")}
                            triggerClassName={secondaryButtonClass}
                            triggerTestId="report-error-button"
                          />
                          {(errorCategory === "generic" || errorCategory === "attachment") && (
                            <span className="flex items-center text-xs font-semibold text-red-700 dark:text-red-200">
                              {t("chat.tryAnotherModelHint")}
                            </span>
                          )}
                        </div>
                        {errorCategory === "quota" && isGuestMode && (
                          <p className="mt-2 text-xs leading-5 text-red-700 dark:text-red-200">
                            {t("chat.guestQuotaLoginBenefitHint")}
                          </p>
                        )}
                        {errorAuxiliaryLines.length > 0 && (
                          <div data-testid="chat-error-auxiliary-info" className="mt-2 space-y-0.5">
                            {errorAuxiliaryLines.map((line, lineIndex) => (
                              <p
                                key={lineIndex}
                                // UI-003/UI-007. The trace ID is what a user
                                // has to read back to support, and at
                                // 10px/red-500-at-70% it measured 2.63:1 on
                                // light and 3.84:1 on dark against the card it
                                // sits on. Solid red at the readable floor
                                // clears AA in both themes.
                                className="text-[11px] leading-4 text-red-700 dark:text-red-200"
                              >
                                {line}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {/*
                    The provider stopped at its output-token ceiling. The
                    answer above is kept exactly as it arrived -- this only
                    says it is unfinished and how to continue. No follow-up
                    is sent from here: another turn costs credits, so asking
                    for one stays the user's action.
                  */}
                  {!isUser && msg.status === "incomplete" && (
                    <p
                      data-testid="response-incomplete-notice"
                      className="mt-3 border-t border-zinc-200 pt-2 text-[11px] leading-4 font-semibold text-zinc-500 dark:border-zinc-700/60 dark:text-zinc-400"
                    >
                      {t("chat.responseIncompleteNotice")}
                    </p>
                  )}
                  {!isUser && msg.status === "cancelled" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                      <span className="inline-flex items-center rounded-full bg-zinc-200 px-2.5 py-1 text-[11px] font-bold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                        {t("chat.stoppedBadge")}
                      </span>
                      {onRetryLast && (
                        <button
                          type="button"
                          onClick={onRetryLast}
                          className="inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-bold text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          {t("chat.regenerate")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {scrollMode === "paused" && (
        <button
          type="button"
          data-testid="scroll-to-latest-button"
          onClick={() => {
            const prefersReducedMotion =
              typeof window !== "undefined" &&
              window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            setMode("following");
            scrollToBottomNow(prefersReducedMotion ? "auto" : "smooth");
          }}
          aria-label={isSending ? t("chat.newResponseAvailable") : t("chat.scrollToLatest")}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 shadow-lg hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <span className="flex items-center gap-2">
            <ArrowDown className="h-4 w-4" />
            {isSending ? t("chat.newResponseAvailable") : t("chat.scrollToLatest")}
          </span>
        </button>
      )}
    </div>
  );
}
