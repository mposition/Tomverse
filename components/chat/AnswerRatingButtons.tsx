"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import {
  CHAT_ANSWER_RATING_REASONS,
  publicChatAnswerRating,
  type ChatAnswerRatingReason,
  type ChatAnswerRatingValue,
  type PublicChatAnswerRating,
} from "@/lib/chatAnswerRatingCore";
import { chatPersonalizationCopy, type ChatPersonalizationCopy } from "@/locales/chatPersonalization";

/*
 * One read per open conversation, shared by every answer's buttons: the first
 * button for a conversation loads its ratings and the rest subscribe. Keyed by
 * account as well, so a sign-out or account switch never shows one person's
 * ratings to another.
 */
type Entry = { status: "loading" | "ready" | "failed"; ratings: Record<string, PublicChatAnswerRating> };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const setEntry = (key: string, entry: Entry) => { entries.set(key, entry); notify(); };

const load = (key: string, conversationId: string) => {
  if (entries.has(key)) return;
  entries.set(key, { status: "loading", ratings: {} });
  void fetch(`/api/chat/answer-ratings?${new URLSearchParams({ conversationId })}`, { cache: "no-store" })
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as { ratings?: unknown } | null;
      if (!response.ok || !Array.isArray(body?.ratings)) throw new Error("ratings unavailable");
      const ratings: Record<string, PublicChatAnswerRating> = {};
      for (const row of body.ratings as Array<{ messageId?: unknown; rating?: unknown; reason?: unknown }>) {
        if (typeof row?.messageId !== "string" || typeof row.rating !== "string") continue;
        const parsed = publicChatAnswerRating({
          messageId: row.messageId,
          rating: row.rating,
          reason: typeof row.reason === "string" ? row.reason : null,
        });
        if (parsed) ratings[parsed.messageId] = parsed;
      }
      setEntry(key, { status: "ready", ratings });
    })
    .catch(() => {
      // Forget the failure so the next mount tries again.
      entries.delete(key);
      notify();
    });
};

const REASON_LABEL: Record<ChatAnswerRatingReason, keyof ChatPersonalizationCopy> = {
  inaccurate: "rateReasonInaccurate",
  unhelpful: "rateReasonUnhelpful",
  incomplete: "rateReasonIncomplete",
  ignored_instructions: "rateReasonIgnoredInstructions",
  other: "rateReasonOther",
};

/**
 * Thumbs up and down under one answer (lib/chatAnswerRatingCore.ts). Pressing
 * the active button again withdraws the rating; a down rating offers one
 * optional reason. Signed-in accounts on a saved conversation only.
 */
export function AnswerRatingButtons({ conversationId, messageId }: { conversationId: string | null; messageId: string }) {
  const { lang } = useLanguage();
  const c = chatPersonalizationCopy(lang);
  const { data: session } = useSession();
  const owner = session?.user?.id ?? null;
  const key = owner && conversationId ? `${owner}:${conversationId}` : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? entries.get(key) : undefined), () => undefined);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => { if (key && conversationId) load(key, conversationId); }, [key, conversationId]);
  useEffect(() => {
    if (!reasonsOpen) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !rootRef.current?.contains(event.target as Node)) {
        setReasonsOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [reasonsOpen]);

  if (!key || !conversationId || entry?.status !== "ready") return null;
  const current = entry.ratings[messageId] ?? null;

  const write = async (rating: ChatAnswerRatingValue | null, reason: ChatAnswerRatingReason | null = null) => {
    if (busy) return;
    const previous = entries.get(key);
    if (!previous || previous.status !== "ready") return;
    const optimistic = { ...previous.ratings };
    if (rating === null) delete optimistic[messageId];
    else optimistic[messageId] = { messageId, rating, reason };
    setEntry(key, { status: "ready", ratings: optimistic });
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/chat/answer-ratings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, rating, ...(reason ? { reason } : {}) }),
      });
      const body = (await response.json().catch(() => null)) as { rating?: unknown } | null;
      if (!response.ok) throw new Error("rating refused");
      const latest = entries.get(key);
      if (latest?.status === "ready") {
        const ratings = { ...latest.ratings };
        const saved = body?.rating as { messageId?: unknown; rating?: unknown; reason?: unknown } | null | undefined;
        const parsed = saved && typeof saved.rating === "string"
          ? publicChatAnswerRating({ messageId, rating: saved.rating, reason: typeof saved.reason === "string" ? saved.reason : null })
          : null;
        if (parsed) ratings[messageId] = parsed;
        else delete ratings[messageId];
        setEntry(key, { status: "ready", ratings });
      }
    } catch {
      const latest = entries.get(key);
      if (latest?.status === "ready") {
        const ratings = { ...latest.ratings };
        if (previous.ratings[messageId]) ratings[messageId] = previous.ratings[messageId];
        else delete ratings[messageId];
        setEntry(key, { status: "ready", ratings });
      }
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const buttonClass = (pressed: boolean) =>
    `inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 ${
      pressed
        ? "border-zinc-700 bg-zinc-800 text-white dark:border-zinc-300 dark:bg-zinc-200 dark:text-zinc-900"
        : "border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
    }`;

  return (
    <span ref={rootRef} data-testid="answer-rating" className="relative inline-flex shrink-0 items-center gap-1">
      <button
        type="button"
        data-testid="answer-rating-up"
        aria-label={c.rateUp}
        title={c.rateUp}
        aria-pressed={current?.rating === "up"}
        disabled={busy}
        onClick={() => { setReasonsOpen(false); void write(current?.rating === "up" ? null : "up"); }}
        className={buttonClass(current?.rating === "up")}
      >
        <ThumbsUp className="h-3 w-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="answer-rating-down"
        aria-label={c.rateDown}
        title={c.rateDown}
        aria-pressed={current?.rating === "down"}
        aria-expanded={reasonsOpen}
        disabled={busy}
        onClick={() => {
          if (current?.rating === "down") { setReasonsOpen(false); void write(null); return; }
          setReasonsOpen(true);
          void write("down");
        }}
        className={buttonClass(current?.rating === "down")}
      >
        <ThumbsDown className="h-3 w-3" aria-hidden="true" />
      </button>
      {failed && <span role="alert" className="sr-only">{c.rateFailed}</span>}
      {reasonsOpen && current?.rating === "down" && (
        <span
          role="group"
          aria-label={c.rateReasonPrompt}
          data-testid="answer-rating-reasons"
          className="absolute left-0 top-full z-20 mt-1 flex w-56 flex-col gap-1 whitespace-normal rounded-xl border border-zinc-200 bg-white p-2 text-[11px] shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <span className="px-1 font-semibold text-zinc-600 dark:text-zinc-300">{c.rateReasonPrompt}</span>
          {CHAT_ANSWER_RATING_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              data-reason={reason}
              aria-pressed={current.reason === reason}
              disabled={busy}
              onClick={() => { setReasonsOpen(false); void write("down", reason); }}
              className={`rounded-lg px-2 py-1 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                current.reason === reason ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-300"
              }`}
            >
              {c[REASON_LABEL[reason]]}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
