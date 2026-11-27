"use client";

import { useEffect, useState, type RefObject } from "react";
import { Quote } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { requestChatQuote } from "@/lib/chatQuote";
import { chatTurnToolsCopy } from "@/locales/chatTurnTools";

type Placement = { left: number; top: number; text: string };

const BUTTON_WIDTH = 96;
const BUTTON_HEIGHT = 36;

/**
 * A floating "Quote" button over text selected inside an assistant answer.
 * Pressing it puts the selection into the composer as a `>` quote
 * (lib/chatQuote.ts) and leaves the reader to write the reply; nothing is sent.
 */
export function AnswerQuoteButton({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const { lang } = useLanguage();
  const copy = chatTurnToolsCopy[lang];
  const [placement, setPlacement] = useState<Placement | null>(null);

  useEffect(() => {
    let frame = 0;
    const evaluate = () => {
      frame = 0;
      const container = containerRef.current;
      const selection = window.getSelection();
      if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPlacement(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const message = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest('[data-message-role="assistant"]') ?? null;
      const start = message(range.startContainer);
      // Both ends inside the same answer, and that answer inside this list.
      if (!start || start !== message(range.endContainer) || !container.contains(start)) {
        setPlacement(null);
        return;
      }
      const text = selection.toString();
      if (text.trim().length < 2) {
        setPlacement(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPlacement(null);
        return;
      }
      // Touch screens put their own selection toolbar above the text.
      const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      const top = coarse ? rect.bottom + 8 : rect.top - BUTTON_HEIGHT - 6;
      setPlacement({
        left: Math.max(8, Math.min(window.innerWidth - BUTTON_WIDTH - 8, rect.left + rect.width / 2 - BUTTON_WIDTH / 2)),
        top: Math.max(8, Math.min(window.innerHeight - BUTTON_HEIGHT - 8, top)),
        text,
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(evaluate);
    };
    document.addEventListener("selectionchange", schedule);
    const container = containerRef.current;
    container?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      container?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [containerRef]);

  if (!placement) return null;
  return (
    <button
      type="button"
      data-testid="chat-quote-selection"
      aria-label={copy.quoteLabel}
      // Keeps the selection alive until the click has read it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        requestChatQuote(placement.text);
        window.getSelection()?.removeAllRanges();
        setPlacement(null);
      }}
      style={{ left: placement.left, top: placement.top, width: BUTTON_WIDTH, height: BUTTON_HEIGHT }}
      className="fixed z-40 inline-flex items-center justify-center gap-1.5 rounded-full border border-zinc-300 bg-white text-xs font-bold text-zinc-800 shadow-lg hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
    >
      <Quote className="h-3.5 w-3.5" aria-hidden="true" />
      {copy.quote}
    </button>
  );
}
