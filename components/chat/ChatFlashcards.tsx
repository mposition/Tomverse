"use client";

import { useContext, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { AnswerRenderContext } from "@/components/chat/MermaidDiagram";
import { FIRST_CARD, flipCard, moveCard, type CardPosition, type FlashcardSpec } from "@/lib/chatStudy";
import { chatStudyCopy, fillStudyCopy, type ChatStudyCopy } from "@/locales/chatStudy";

const NAV_BUTTON =
  "inline-flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-800 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700";

/**
 * The flashcards as the reader sees them. The card is one button: pressing it
 * (Enter or Space on the keyboard) turns it over, and the face that is showing
 * is named in words, not only by its colour. After the reader has done
 * something, a polite live region says which face is up and what it reads, so
 * a screen reader hears the card turn.
 */
export function FlashcardsView({
  spec,
  position,
  announce,
  copy,
  onFlip,
  onMove,
}: {
  spec: FlashcardSpec;
  position: CardPosition;
  announce: boolean;
  copy: ChatStudyCopy;
  onFlip: () => void;
  onMove: (delta: number) => void;
}) {
  const count = spec.cards.length;
  const card = spec.cards[position.index];
  const face = position.flipped ? copy.cardBack : copy.cardFront;
  const text = position.flipped ? card.back : card.front;
  const label = spec.title ? `${copy.cardsLabel}: ${spec.title}` : copy.cardsLabel;
  const counter = fillStudyCopy(copy.cardCounter, { n: position.index + 1, total: count });
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onMove(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onMove(-1);
    }
  };
  return (
    <section
      data-testid="chat-flashcards"
      aria-label={label}
      className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-zinc-900 last:mb-0 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-100 sm:p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold">{label}</p>
        <p data-testid="chat-flashcards-counter" className="text-xs text-zinc-600 dark:text-zinc-300">
          {counter}
        </p>
      </header>
      <button
        type="button"
        data-testid="chat-flashcard"
        data-face={position.flipped ? "back" : "front"}
        aria-pressed={position.flipped}
        onClick={onFlip}
        onKeyDown={onKeyDown}
        className={`mt-3 flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 px-4 py-6 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          position.flipped
            ? "border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40"
            : "border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        }`}
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">{face}</span>
        <span className="break-words text-base font-medium leading-7 [overflow-wrap:anywhere]">{text}</span>
        <span className="sr-only">{copy.cardFlip}</span>
      </button>
      <p role="status" aria-live="polite" className="sr-only" data-testid="chat-flashcards-announce">
        {announce ? `${counter}. ${face}: ${text}` : ""}
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          data-testid="chat-flashcards-previous"
          onClick={() => onMove(-1)}
          disabled={position.index === 0}
          aria-label={copy.cardPrevious}
          title={copy.cardPrevious}
          className={NAV_BUTTON}
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <p className="text-xs text-zinc-600 dark:text-zinc-300" aria-hidden="true">
          {counter}
        </p>
        <button
          type="button"
          data-testid="chat-flashcards-next"
          onClick={() => onMove(1)}
          disabled={position.index === count - 1}
          aria-label={copy.cardNext}
          title={copy.cardNext}
          className={NAV_BUTTON}
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function FlashcardsBody({ spec, copy }: { spec: FlashcardSpec; copy: ChatStudyCopy }) {
  const [position, setPosition] = useState<CardPosition>(FIRST_CARD);
  const [announce, setAnnounce] = useState(false);
  return (
    <FlashcardsView
      spec={spec}
      position={position}
      announce={announce}
      copy={copy}
      onFlip={() => {
        setAnnounce(true);
        setPosition((current) => flipCard(current));
      }}
      onMove={(delta) => {
        setAnnounce(true);
        setPosition((current) => moveCard(current, delta, spec.cards.length));
      }}
    />
  );
}

/**
 * A ```flashcards block drawn as a deck once the answer is final. While the
 * answer streams, and for any spec that did not validate, `fallback` (the
 * ordinary code block) is what the reader sees. Which card is up lives in this
 * component only.
 */
export function ChatFlashcards({ spec, fallback }: { spec: FlashcardSpec; fallback: ReactNode }) {
  const streaming = useContext(AnswerRenderContext)?.streaming ?? false;
  const { lang } = useLanguage();
  if (streaming) return <>{fallback}</>;
  return <FlashcardsBody spec={spec} copy={chatStudyCopy[lang]} />;
}
