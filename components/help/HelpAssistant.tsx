"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, BookOpen, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { HelpAssistantAnswer, HelpAssistantTurn } from "@/lib/helpAssistantCore";
import { helpActionHref, helpGuideHref } from "@/lib/helpCentre/links";
import type { HelpGuideAction, HelpUiCopy } from "@/lib/helpCentre/types";
import type { Language } from "@/lib/language";

export type HelpGuideSummary = {
  id: string;
  title: string;
  categoryTitle: string;
  stepTitles: string[];
  action: HelpGuideAction | null;
};

export type HelpAssistantAvailability = { enabled: boolean; signedIn: boolean } | null;

/** Reads once per page whether the question box can answer for this reader. */
export function useHelpAssistantAvailability(): HelpAssistantAvailability {
  const [availability, setAvailability] = useState<HelpAssistantAvailability>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/help/assistant", { cache: "no-store" })
      .then(async (response) => {
        if (response.ok) return response.json();
        await discardResponseBody(response);
        return { enabled: false, signedIn: false };
      })
      .then((value: { enabled?: unknown; signedIn?: unknown }) => {
        if (!cancelled) setAvailability({ enabled: value.enabled === true, signedIn: value.signedIn === true });
      })
      .catch(() => {
        if (!cancelled) setAvailability({ enabled: false, signedIn: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return availability;
}

type Exchange = { id: number; question: string; answer: HelpAssistantAnswer | null; failed: boolean };

export function useHelpConversation(lang: Language, focusGuideId: string | null) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || pending) return;
      const id = nextId.current++;
      const history: HelpAssistantTurn[] = exchanges.flatMap((exchange) =>
        exchange.answer
          ? [
              { role: "user" as const, text: exchange.question },
              {
                role: "assistant" as const,
                text:
                  exchange.answer.status === "answered"
                    ? [exchange.answer.summary, ...exchange.answer.steps.map((step) => step.text)].join("\n")
                    : exchange.answer.summary,
              },
            ]
          : []
      );
      setExchanges((current) => [...current, { id, question: trimmed, answer: null, failed: false }]);
      setPending(true);
      try {
        const response = await fetch("/api/help/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang, question: trimmed, history: history.slice(-6), focusGuideId }),
        });
        const body = (await response.json().catch(() => null)) as { answer?: HelpAssistantAnswer } | null;
        setExchanges((current) =>
          current.map((exchange) =>
            exchange.id === id
              ? { ...exchange, answer: response.ok && body?.answer ? body.answer : null, failed: !response.ok || !body?.answer }
              : exchange
          )
        );
      } catch {
        setExchanges((current) => current.map((exchange) => (exchange.id === id ? { ...exchange, failed: true } : exchange)));
      } finally {
        setPending(false);
      }
    },
    [exchanges, focusGuideId, lang, pending]
  );

  const reset = useCallback(() => setExchanges([]), []);
  return { exchanges, pending, ask, reset };
}

function sendFeedback(helpful: boolean, guideIds: string[], lang: Language) {
  void fetch("/api/help/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ helpful, guideIds, lang }),
  })
    .then((response) => discardResponseBody(response))
    .catch(() => undefined);
}

function AnswerCard({
  exchange,
  ui,
  lang,
  guides,
  compact,
}: {
  exchange: Exchange;
  ui: HelpUiCopy;
  lang: Language;
  guides: ReadonlyMap<string, HelpGuideSummary>;
  compact: boolean;
}) {
  const [voted, setVoted] = useState<boolean | null>(null);
  const answer = exchange.answer;
  const shell = `rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60 ${compact ? "p-4" : "p-5 sm:p-6"}`;
  const header = (badge: string | null, tone: "ok" | "muted") => (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400 via-blue-400 to-purple-400 text-xs font-bold text-zinc-950">T</span>
      <span className="font-bold">{ui.assistantName}</span>
      {badge ? (
        <span className={`rounded-full border px-2.5 py-0.5 text-xs ${tone === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-300" : "border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"}`}>{badge}</span>
      ) : null}
    </div>
  );

  if (!answer && !exchange.failed) {
    return (
      <div className={shell} aria-live="polite" data-testid="help-answer-pending">
        {header(null, "muted")}
        <p className="mt-3 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {ui.askThinking}
        </p>
      </div>
    );
  }
  if (!answer) {
    return (
      <div className={shell} role="alert" data-testid="help-answer-error">
        {header(null, "muted")}
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">{ui.askError}</p>
      </div>
    );
  }
  if (answer.status === "not_found") {
    return (
      <div className={shell} data-testid="help-answer-not-found">
        {header(ui.notFound, "muted")}
        <p className="mt-3 text-[15px] leading-7">{answer.summary}</p>
        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{ui.notFoundBody}</p>
        <Link
          href={helpActionHref({ kind: "public", path: "/support" }, lang)}
          className="mt-4 inline-flex min-h-11 items-center rounded-full bg-blue-600 px-5 text-sm font-bold text-white hover:bg-blue-500"
        >
          {ui.contactButton}
        </Link>
      </div>
    );
  }

  const sourceIndex = new Map(answer.guideIds.map((id, index) => [id, index + 1]));
  const primary = answer.guideIds.map((id) => guides.get(id)).find((guide) => guide?.action) ?? null;
  return (
    <div className={shell} data-testid="help-answer">
      {header(ui.foundIn.replace("{count}", String(answer.guideIds.length)), "ok")}
      <p className="mt-4 text-[15px] leading-7">{answer.summary}</p>
      {answer.steps.length > 0 ? (
        <ol className="mt-4 space-y-3">
          {answer.steps.map((step, index) => (
            <li key={index} className="flex gap-3">
              <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700 dark:bg-slate-800 dark:text-blue-300">{index + 1}</span>
              <span className="text-[15px] leading-7">
                {step.text}
                {step.guideId && sourceIndex.has(step.guideId) ? (
                  <Link href={helpGuideHref(lang, step.guideId, step.step ?? undefined)} className="ml-1 align-super text-[11px] font-semibold text-blue-600 dark:text-blue-400">
                    [{sourceIndex.get(step.guideId)}]
                  </Link>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {answer.note ? (
        <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">{answer.note}</p>
      ) : null}
      <div className={`mt-4 grid gap-2 ${compact ? "" : "sm:grid-cols-3"}`}>
        {answer.guideIds.map((id, index) => {
          const guide = guides.get(id);
          if (!guide) return null;
          return (
            <Link key={id} href={helpGuideHref(lang, id)} className="rounded-xl border border-zinc-200 px-3 py-2.5 hover:border-blue-400 dark:border-zinc-800 dark:hover:border-blue-500">
              <span className="block text-[11px] font-bold text-blue-600 dark:text-blue-400">[{index + 1}] {guide.categoryTitle}</span>
              <span className="mt-0.5 block text-sm font-semibold">{guide.title}</span>
            </Link>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {primary?.action ? (
          <Link href={helpActionHref(primary.action, lang)} className="inline-flex min-h-11 items-center rounded-full bg-blue-600 px-5 text-sm font-bold text-white hover:bg-blue-500">
            {ui.tryItButton}
          </Link>
        ) : null}
        <Link href={helpGuideHref(lang, answer.guideIds[0])} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-zinc-300 px-4 text-sm font-semibold hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          {ui.openGuide}
        </Link>
        <div className="ml-auto flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {voted === null ? (
            <>
              <span>{ui.helpful}</span>
              {[true, false].map((helpful) => (
                <button
                  key={String(helpful)}
                  type="button"
                  aria-label={helpful ? "👍" : "👎"}
                  onClick={() => {
                    setVoted(helpful);
                    sendFeedback(helpful, answer.guideIds, lang);
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  {helpful ? <ThumbsUp className="h-4 w-4" aria-hidden="true" /> : <ThumbsDown className="h-4 w-4" aria-hidden="true" />}
                </button>
              ))}
            </>
          ) : (
            <span role="status">{ui.thanks}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The conversation under a question box: each question, its answer, and a
 * follow-up box once there is at least one answer.
 */
export function HelpConversation({
  lang,
  ui,
  guides,
  conversation,
  compact = false,
}: {
  lang: Language;
  ui: HelpUiCopy;
  guides: ReadonlyMap<string, HelpGuideSummary>;
  conversation: ReturnType<typeof useHelpConversation>;
  compact?: boolean;
}) {
  const [followUp, setFollowUp] = useState("");
  if (conversation.exchanges.length === 0) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!followUp.trim()) return;
    void conversation.ask(followUp);
    setFollowUp("");
  };
  return (
    <div className={`space-y-4 text-left ${compact ? "mt-4" : "mt-8"}`} data-testid="help-conversation">
      {conversation.exchanges.map((exchange) => (
        <div key={exchange.id} className="space-y-3">
          <p className={`ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-3 leading-7 dark:bg-zinc-800 ${compact ? "text-sm" : "text-[15px]"}`}>{exchange.question}</p>
          <AnswerCard exchange={exchange} ui={ui} lang={lang} guides={guides} compact={compact} />
        </div>
      ))}
      <form onSubmit={submit} className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
        <label className="sr-only" htmlFor={compact ? "help-follow-up-compact" : "help-follow-up"}>{ui.askFollowUp}</label>
        <input
          id={compact ? "help-follow-up-compact" : "help-follow-up"}
          value={followUp}
          onChange={(event) => setFollowUp(event.target.value)}
          placeholder={ui.askFollowUp}
          maxLength={2000}
          className="min-h-11 flex-1 bg-transparent text-[15px] outline-none placeholder:text-zinc-400"
        />
        <button type="submit" disabled={conversation.pending || !followUp.trim()} aria-label={ui.askButton} className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white disabled:opacity-40">
          <ArrowUp className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-500">
        <p>{ui.disclaimer}</p>
        <button type="button" onClick={conversation.reset} className="min-h-11 font-semibold text-blue-600 dark:text-blue-400">{ui.newQuestion}</button>
      </div>
    </div>
  );
}
