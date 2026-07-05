"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Message } from "@/components/chat/types";

type ChatMessageListProps = {
  messages: Message[];
  isPrivate?: boolean; // 💡 프라이빗 모드 배너용 프롭 추가  
};

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1">
      <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.2s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.1s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
    </div>
  );
}

export function ChatMessageList({ messages, isPrivate = false }: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

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

    if (nearBottom) {
      setShowScrollButton(false);
    }
  };

  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom("smooth");
      setShowScrollButton(false);
    } else {
      setShowScrollButton(true);
    }
  }, [messages]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-6 md:px-8"
      >
	  
	  {/* 💡 프라이빗 모드인 경우 최상단에 은은한 퍼플 톤의 고지 배너 노출 */}
      {isPrivate && (
		<div className="mb-6 rounded-xl border border-purple-800/50 bg-purple-950/30 p-4 text-center text-sm text-purple-300 shadow-sm animate-fadeIn">
            <p className="mb-1.5 flex items-center justify-center gap-2 font-bold text-purple-200">
            🔒 프라이빗 보안 모드 활성화
          </p>
          <p className="opacity-80">
            해당 대화는 서버에 기록이 되지 않는 프라이빗 모드입니다. 새로고침시 내용이 모두 사라짐을 유의 바랍니다.
          </p>
        </div>
      )}
	  
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {messages.map((message) => {
			const isUser = message.role === "user";

			// 💡 현재 메시지를 작성한 모델의 정보를 AVAILABLE_MODELS에서 찾아옵니다.
			const modelInfo = !isUser && msg.modelId 
			  ? AVAILABLE_MODELS.find(m => m.id === msg.modelId) 
			  : null;

            const assistantBoxClass =
              message.status === "error"
                ? "bg-red-950 text-red-100 border border-red-800"
                : message.status === "cancelled"
                  ? "bg-zinc-800 text-zinc-300 italic"
                  : "bg-zinc-900 text-zinc-100";

            const userBoxClass = "bg-blue-600 text-white";
		  
			return (		  
            <div
              key={message.id}
              className={`flex ${ isUser ? "justify-end" : "justify-start"}`}
            >
			{/* 💡 AI 뱃지 (아이콘 + 이름) 렌더링 영역 */}
            {!isUser && modelInfo && (
              <div className="flex items-center gap-1.5 mb-1.5 ml-1 select-none">
                <span className="text-sm">{modelInfo.icon}</span>
                <span className="text-[11px] font-semibold text-zinc-400">
                  {modelInfo.name}
                </span>
              </div>
            )}
            
            {/* 웰컴 메시지용 특별한 뱃지 (모델 정보가 없을 때) */}
            {!isUser && !modelInfo && messages.id === "welcome" && (
              <div className="flex items-center gap-1.5 mb-1.5 ml-1 select-none">
                <span className="text-sm">🤖</span>
                <span className="text-[11px] font-semibold text-zinc-400">AI Assistant</span>
              </div>
            )}
			
              <div
                className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                 isUser ? userBoxClass : assistantBoxClass                
                }`}
              >
                {message.role === "assistant" && !message.content ? (
                  <TypingIndicator />
                ) : message.role === "assistant" ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      p: ({ children }) => (
                        <p className="mb-3 last:mb-0 whitespace-pre-wrap">
                          {children}
                        </p>
                      ),
                      ul: ({ children }) => (
                        <ul className="mb-3 list-disc pl-5 last:mb-0">
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="mb-3 list-decimal pl-5 last:mb-0">
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => <li className="mb-1">{children}</li>,
                      pre: ({ children }) => (
                        <pre className="mb-3 overflow-x-auto rounded-lg bg-zinc-950 p-3 last:mb-0">
                          {children}
                        </pre>
                      ),
                      code: ({ inline, children, ...props }: any) =>
                        inline ? (
                          <code
                            className="rounded bg-zinc-800 px-1 py-0.5 text-[0.9em] text-zinc-100"
                            {...props}
                          >
                            {children}
                          </code>
                        ) : (
                          <code {...props}>{children}</code>
                        ),
                      a: ({ children, href }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-400 underline"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                ) : (
                  <p className="whitespace-pre-wrap">{message.content}</p>
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
            setShowScrollButton(false);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 shadow-lg hover:bg-zinc-800"
        >
          최신 메시지로 이동
        </button>
      )}
    </div>
  );
}
