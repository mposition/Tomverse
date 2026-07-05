"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Message } from "@/components/chat/types";

type ChatMessageListProps = {
  messages: Message[];
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

export function ChatMessageList({ messages }: ChatMessageListProps) {
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
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.map((message) => {
			const isUser = message.role === "user";

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
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-6 ${
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
