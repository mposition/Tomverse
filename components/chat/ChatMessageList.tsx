"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import type { ComponentPropsWithoutRef } from "react";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Paperclip } from "lucide-react";
import { Message, AVAILABLE_MODELS } from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";

type ChatMessageListProps = {
  messages: Message[];
  isPrivate?: boolean;
  isGuestMode?: boolean; // 💡 게스트 모드 여부 추가  
};
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> &
  ExtraProps & { inline?: boolean };

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500 [animation-delay:-0.2s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500 [animation-delay:-0.1s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500" />
    </div>
  );
}

// 💡 Named Export 형태 유지로 이전의 모듈 엇박자 에러 재발을 차단합니다.
export function ChatMessageList({ messages, isPrivate = false, isGuestMode = false }: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const showScrollButton = !isNearBottom;
    const { t, lang, setLang } = useLanguage(); // 💡 t 함수 꺼내기

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
  };

  const checkIsNearBottom = () => {
    const container = containerRef.current;
    if (!container) return true;

    const threshold = 80;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    return distanceFromBottom < threshold;
  };

  const handleScroll = () => {
    const nearBottom = checkIsNearBottom();
    setIsNearBottom(nearBottom);
  };

  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom("smooth");
    }
  }, [messages, isNearBottom]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-6 md:px-8"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-4">
          
          {/* 프라이빗 배너 (하단 여백 mb-6 추가로 첫 인사글과 시원하게 띄움) */}
          {isPrivate && (
            <div className="mb-6 rounded-xl border border-purple-200 bg-purple-50 p-4 text-center text-sm text-purple-700 shadow-sm animate-fadeIn dark:border-purple-800/50 dark:bg-purple-950/30 dark:text-purple-300">
                <p className="mb-1.5 flex items-center justify-center gap-2 font-bold text-purple-800 dark:text-purple-200">
                              <span className="text-lg">🔒</span> {t("chat.onPrivateMode")}
              </p>
              <p className="break-keep text-xs opacity-90 dark:opacity-80">
                              {t("chat.privateModeMessage")}
              </p>
            </div>
          )}

          {/* 💡 게스트 모드 안내 배너 추가 */}
          {isGuestMode && (
            <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-center text-sm text-blue-700 shadow-sm animate-fadeIn dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-300">
              <p className="mb-1.5 flex items-center justify-center gap-2 font-bold text-blue-800 dark:text-blue-200">
                              <span className="text-lg">👤</span> {t("chat.onGuestMode")}
              </p>
              <p className="break-keep text-xs opacity-90 dark:opacity-80">
                              {t("chat.guestModeMessage")}<br/>
                              <span className="font-semibold text-blue-600 dark:text-blue-400">{t("chat.guestModeLimitMessage")}</span>
              </p>
            </div>
          )}          

          {/* 💡 2. message -> msg 변수명 완벽 통일 */}
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
                className={`flex w-full flex-col [content-visibility:auto] [contain-intrinsic-size:auto_160px] ${isUser ? "items-end" : "items-start"}`}
              >
                {/* AI 뱃지 */}
                {!isUser && modelInfo && (
                  <div className="mb-1.5 ml-1 flex select-none items-center gap-1.5">
                    <span className="text-sm">{modelInfo.icon}</span>
                    <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                      {modelInfo.name}
                    </span>
                  </div>
                )}
                
                {/* 웰컴 메시지 뱃지 */}
                {!isUser && !modelInfo && msg.id === "welcome" && (
                  <div className="mb-1.5 ml-1 flex select-none items-center gap-1.5">
                    <span className="text-sm">🤖</span>
                            <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t("chat.aiAssistant")}</span>
                  </div>
                )}

                <div
                  className={`relative max-w-[90%] md:max-w-[85%] break-words rounded-2xl px-4 py-3 text-[15px] leading-relaxed shadow-sm ${
                    isUser ? `${userBoxClass} rounded-br-sm` : `${assistantBoxClass} rounded-bl-sm`
                  }`}
                >
                  {isUser && msg.attachments && msg.attachments.length > 0 && (
                    <div className={`flex flex-wrap gap-1.5 ${msg.content ? "mb-2" : ""}`}>
                      {msg.attachments.map((attachment) => (
                        <span
                          key={attachment.id}
                          className="flex max-w-52 items-center gap-1 rounded-md bg-white/15 px-2 py-1 text-xs"
                          title={attachment.name}
                        >
                          <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />
                          <span className="truncate">{attachment.name}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {msg.role === "assistant" && !msg.content ? (
                    <TypingIndicator />
                  ) : msg.role === "assistant" ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={{
                        p: ({ children }) => <p className="mb-3 last:mb-0 whitespace-pre-wrap">{children}</p>,
                        ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
                        li: ({ children }) => <li className="mb-1">{children}</li>,
                        pre: ({ children }) => (
                          <pre className="mb-3 overflow-x-auto rounded-lg bg-zinc-950 p-3 last:mb-0">
                            {children}
                          </pre>
                        ),
                        code: ({ inline, children, ...props }: MarkdownCodeProps) =>
                          inline ? (
                            <code className="rounded bg-zinc-200 text-zinc-800 px-1 py-0.5 text-[0.9em] dark:bg-zinc-800 dark:text-zinc-100" {...props}>
                              {children}
                            </code>
                          ) : (
                            <code {...props}>{children}</code>
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
          최신 메시지로 이동
        </button>
      )}
    </div>
  );
}
