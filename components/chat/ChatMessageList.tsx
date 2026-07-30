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
  Clipboard,
  Copy,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Presentation,
  RotateCcw,
  Sheet,
  UserRound,
} from "lucide-react";
import { Message, type ChatAttachment } from "@/components/chat/types";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";

type ChatMessageListProps = {
  messages: Message[];
  onRetryLast?: () => void;
  onRetryWithoutAttachments?: () => void;
};
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;

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

function TypingIndicator({ label }: { label: string }) {
  return (
    // The three bouncing dots are purely visual: without a text alternative,
    // assistive technology has no way to tell that a model is generating a
    // response. The announcement itself comes from the dedicated live region in
    // ChatMessageList, so no role is needed (and adding one would make existing
    // getByRole("status") toast assertions ambiguous).
    <div className="flex items-center gap-1 py-1">
      <span className="sr-only">{label}</span>
          <span aria-hidden="true" className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500 [animation-delay:-0.2s]" />
          <span aria-hidden="true" className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500 [animation-delay:-0.1s]" />
          <span aria-hidden="true" className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500" />
    </div>
  );
}

export function ChatMessageList({
  messages,
  onRetryLast,
  onRetryWithoutAttachments,
}: ChatMessageListProps) {
  const { models: AVAILABLE_MODELS } = useModelCatalog();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousLastMessageIdRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  const autoStickUntilRef = useRef(0);
  const scheduledScrollsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const showScrollButton = !isNearBottom;
    const { t } = useLanguage();
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
    return t("chat.responseComplete");
  })();

  const copyErrorDetails = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch (error) {
      console.error("Failed to copy error details:", error);
    }
  };

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

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const clearScheduledScrolls = useCallback(() => {
    scheduledScrollsRef.current.forEach((timer) => clearTimeout(timer));
    scheduledScrollsRef.current = [];
  }, []);

  const forceScrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    autoStickUntilRef.current = Date.now() + 650;
    setIsNearBottom(true);
    clearScheduledScrolls();

    const run = () => {
      scrollToBottom(behavior);
      setIsNearBottom(true);
    };

    run();
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });

    scheduledScrollsRef.current = [60, 160, 320, 520].map((delay) =>
      setTimeout(run, delay)
    );
  }, [clearScheduledScrolls, scrollToBottom]);

  const checkIsNearBottom = () => {
    const container = containerRef.current;
    if (!container) return true;

    const threshold = 80;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    return distanceFromBottom < threshold;
  };

  const handleScroll = () => {
    if (Date.now() < autoStickUntilRef.current) {
      setIsNearBottom(true);
      return;
    }

    const nearBottom = checkIsNearBottom();
    setIsNearBottom(nearBottom);
  };

  useLayoutEffect(() => {
    const lastMessage = messages[messages.length - 1];
    const lastMessageId = lastMessage?.id || null;
    const previousLastMessageId = previousLastMessageIdRef.current;
    const previousMessageCount = previousMessageCountRef.current;
    const isInitialLoad =
      previousMessageCount === 0 ||
      (messages.length > 0 && previousLastMessageId === null);
    const didAppendMessage =
      messages.length > previousMessageCount ||
      (lastMessageId !== null && lastMessageId !== previousLastMessageId);

    previousLastMessageIdRef.current = lastMessageId;
    previousMessageCountRef.current = messages.length;

    if (!isInitialLoad && !didAppendMessage && !isNearBottom) return;

    const behavior: ScrollBehavior = isInitialLoad ? "auto" : "smooth";
    forceScrollToBottom(behavior);
  }, [forceScrollToBottom, messages, isNearBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (Date.now() >= autoStickUntilRef.current) return;
      scrollToBottom("auto");
      setIsNearBottom(true);
    });

    observer.observe(container);
    if (container.firstElementChild) {
      observer.observe(container.firstElementChild);
    }

    return () => {
      observer.disconnect();
      clearScheduledScrolls();
    };
  }, [clearScheduledScrolls, scrollToBottom]);

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
        className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3 md:px-6 md:py-6"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3.5 pb-3 md:gap-5 md:pb-4">
          {messages.map((msg, idx) => {
            const isUser = msg.role === "user";

            const modelInfo = !isUser && msg.modelId 
              ? AVAILABLE_MODELS.find(m => m.id === msg.modelId) 
              : null;

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
                  <div className="mb-1.5 ml-1 flex select-none items-center gap-2">
                    <ModelLogo model={modelInfo} size="sm" />
                    <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                      {modelInfo.name}
                    </span>
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
                          const showImagePreview = hasImagePreview(attachment);
                          return (
                        <div
                          key={attachment.id}
                          className={
                            showImagePreview
                              ? "relative h-20 w-20 overflow-hidden rounded-xl border border-white/20 bg-white/10 shadow-sm"
                              : "flex h-16 min-w-52 max-w-64 items-center gap-3 rounded-xl border border-white/15 bg-white/10 py-2 pl-2 pr-3 shadow-sm backdrop-blur"
                          }
                          title={attachment.name}
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
                              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/15 text-white ring-1 ring-white/10">
                                {getAttachmentIcon(attachment)}
                              </span>
                              <span className="flex min-w-0 flex-col text-left">
                                <span className="truncate text-sm font-semibold text-white">
                                  {attachment.name}
                                </span>
                                <span className="text-[11px] font-semibold text-blue-100/80">
                                  {getAttachmentLabel(attachment)}
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
                    <TypingIndicator label={t("chat.responseGenerating")} />
                  ) : msg.role === "assistant" ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={{
                        p: ({ children }) => <p className="mb-3 last:mb-0 whitespace-pre-wrap">{children}</p>,
                        ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
                        li: ({ children }) => <li className="mb-1">{children}</li>,
                        // Tailwind's preflight resets headings to `font-size:
                        // inherit; font-weight: inherit` and zeroes every border,
                        // so without these overrides a model's "## Heading"
                        // rendered pixel-identical to a paragraph and GFM tables
                        // came out borderless and unpadded.
                        h1: ({ children }) => <h1 className="mb-2 mt-4 text-[1.35em] font-black leading-snug first:mt-0">{children}</h1>,
                        h2: ({ children }) => <h2 className="mb-2 mt-4 text-[1.2em] font-black leading-snug first:mt-0">{children}</h2>,
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
                        table: ({ children }) => (
                            <div className="mb-3 max-w-full overflow-x-auto last:mb-0">
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
                        pre: ({ children }) => (
                          <pre className="mb-3 overflow-x-auto rounded-lg bg-zinc-950 p-3 text-zinc-100 last:mb-0 [&>code]:block [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-zinc-100">
                            {children}
                          </pre>
                        ),
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
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                  {!isUser && msg.status === "error" && (
                    <div className="mt-3 border-t border-red-200 pt-3 dark:border-red-800">
                      {isFileParsingError(msg.content) && (
                        <div className="mb-3 rounded-xl border border-red-200 bg-white/80 p-3 text-xs leading-5 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
                          <p className="font-black">{t("chat.fileErrorHelpTitle")}</p>
                          <ul className="mt-1 list-disc space-y-1 pl-4">
                            <li>{t("chat.fileErrorHelpResave")}</li>
                            <li>{t("chat.fileErrorHelpLimit")}</li>
                            <li>{t("chat.fileErrorHelpRetry")}</li>
                          </ul>
                          <Link
                            href="/support/help-centre"
                            className="mt-2 inline-flex font-black text-red-700 underline underline-offset-2 dark:text-red-100"
                          >
                            {t("chat.fileErrorHelpLink")}
                          </Link>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                      {onRetryLast && (
                        <button
                          type="button"
                          onClick={onRetryLast}
                          className="inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          {t("chat.retry")}
                        </button>
                      )}
                      {onRetryWithoutAttachments && (
                        <button
                          type="button"
                          onClick={onRetryWithoutAttachments}
                          className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:bg-red-950 dark:text-red-100 dark:hover:bg-red-900"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          {t("chat.retryWithoutFiles")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void copyErrorDetails(msg.content)}
                        className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:bg-red-950 dark:text-red-100 dark:hover:bg-red-900"
                      >
                        <Clipboard className="h-3.5 w-3.5" />
                        {t("chat.copyErrorDetails")}
                      </button>
                      <span className="flex items-center text-xs font-semibold text-red-600/80 dark:text-red-200/80">
                        {t("chat.tryAnotherModelHint")}
                      </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showScrollButton && (
        <button
          type="button"
          onClick={() => {
            scrollToBottom("smooth");
            setIsNearBottom(true);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 shadow-lg hover:bg-zinc-800"
        >
          <span className="flex items-center gap-2">
            <ArrowDown className="h-4 w-4" />
            {t("chat.scrollToLatest")}
          </span>
        </button>
      )}
    </div>
  );
}
