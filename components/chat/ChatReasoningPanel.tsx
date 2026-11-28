"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnswerMarkdown } from "@tomverse/chat-ui";
import { Brain, ChevronRight } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { Message } from "@/components/chat/types";
import { readStoredChatReasoning, type ChatReasoningView } from "@/lib/chatReasoningDisplay";
import { chatReasoningCopy, thoughtLabel } from "@/locales/chatReasoning";

/**
 * The reasoning summary above an answer: streamed while the model thinks,
 * folded to "Thought for N seconds" once the answer starts, opened again by a
 * click (lib/chatReasoningDisplay.ts says where the text comes from).
 *
 * Kept out of ChatMessageList so that file changes in one place only.
 *
 * ## What it renders, and how
 *
 * The summary is model output, so it gets the answer renderer's rules and no
 * more: no link is made clickable, an image is never loaded (the same notice
 * the answer shows), raw HTML is not parsed. It is also length-bounded
 * upstream, and the box scrolls instead of growing.
 *
 * ## Screen readers
 *
 * Nothing here is a live region. The transcript itself is not one either
 * (ChatMessageList announces only the start and end of a response), so a
 * summary arriving a few words at a time is never read out piece by piece; a
 * reader meets it, whole, when it moves to the control.
 */

/** What the card shows for a message: this run's stream, or the saved copy. */
export const chatMessageReasoning = (
  message: Pick<Message, "reasoning" | "searchMetadata" | "role">
): ChatReasoningView | null =>
  message.role !== "assistant"
    ? null
    : message.reasoning ?? readStoredChatReasoning(message.searchMetadata);

export function ChatReasoningPanel({
  reasoning,
  generating,
}: {
  reasoning: ChatReasoningView;
  /** This message is the one being written right now. */
  generating: boolean;
}) {
  const { t, lang } = useLanguage();
  const copy = chatReasoningCopy[lang];
  const regionId = useId();
  // null: follow the default (open while thinking, folded after). A click
  // overrides it for the rest of this card's life.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // A stream that ended without saying "done" (the connection broke) is not
  // still thinking.
  const thinking = generating && !reasoning.done;
  const hasText = reasoning.text.trim().length > 0;
  const open = hasText && (chosen ?? thinking);
  const label = thinking ? copy.thinking : thoughtLabel(copy, reasoning.durationMs);

  // Follows the newest line while the summary streams, unless it is folded.
  useEffect(() => {
    const body = bodyRef.current;
    if (body && thinking) body.scrollTop = body.scrollHeight;
  }, [reasoning.text, thinking, open]);

  const heading = (
    <>
      <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className={thinking ? "motion-safe:animate-pulse" : undefined}>{label}</span>
    </>
  );
  const headingClass =
    "inline-flex max-w-full items-center gap-1.5 rounded-full text-[12px] font-medium text-zinc-500 dark:text-zinc-400";

  return (
    <div
      data-testid="chat-reasoning"
      data-reasoning-state={thinking ? "thinking" : "done"}
      className="mb-1.5 ml-1 max-w-[94%] md:max-w-[88%]"
    >
      {hasText ? (
        <button
          type="button"
          data-testid="chat-reasoning-toggle"
          aria-expanded={open}
          aria-controls={open ? regionId : undefined}
          onClick={() => setChosen(!open)}
          className={`${headingClass} px-1 py-0.5 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:hover:text-zinc-200`}
        >
          {heading}
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
        </button>
      ) : (
        <span data-testid="chat-reasoning-label" className={`${headingClass} px-1 py-0.5`}>
          {heading}
        </span>
      )}
      {open && (
        <div
          id={regionId}
          ref={bodyRef}
          role="region"
          aria-label={copy.summaryLabel}
          data-testid="chat-reasoning-body"
          className="mt-1 max-h-64 overflow-y-auto break-words border-l-2 border-zinc-200 pl-3 text-[12px] leading-relaxed text-zinc-500 dark:border-zinc-700 dark:text-zinc-400 md:text-[13px] [&:lang(ko)]:break-keep"
        >
          <AnswerMarkdown
            components={{
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="mb-2 list-disc pl-4 last:mb-0">{children}</ul>,
              ol: ({ children }) => <ol className="mb-2 list-decimal pl-4 last:mb-0">{children}</ol>,
              h1: ({ children }) => <p className="mb-1 font-semibold last:mb-0">{children}</p>,
              h2: ({ children }) => <p className="mb-1 font-semibold last:mb-0">{children}</p>,
              h3: ({ children }) => <p className="mb-1 font-semibold last:mb-0">{children}</p>,
              h4: ({ children }) => <p className="mb-1 font-semibold last:mb-0">{children}</p>,
              h5: ({ children }) => <p className="mb-1 font-semibold last:mb-0">{children}</p>,
              h6: ({ children }) => <p className="mb-1 font-semibold last:mb-0">{children}</p>,
              pre: ({ children }) => (
                <pre className="mb-2 overflow-x-auto rounded bg-zinc-100 p-2 text-[0.9em] last:mb-0 dark:bg-zinc-800">{children}</pre>
              ),
              // Text, not a link: a summary is not a place to send anyone.
              a: ({ children }) => <span className="underline decoration-dotted">{children}</span>,
              // Never a model-controlled image URL in `src`.
              img: () => (
                <span
                  className="inline-flex rounded-md border border-zinc-300 bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  role="note"
                >
                  {t("chat.markdownImageBlocked")}
                </span>
              ),
            }}
          >
            {reasoning.truncated ? `${reasoning.text}…` : reasoning.text}
          </AnswerMarkdown>
        </div>
      )}
    </div>
  );
}
