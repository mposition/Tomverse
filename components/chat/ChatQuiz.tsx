"use client";

import { useContext, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { AnswerRenderContext } from "@/components/chat/MermaidDiagram";
import {
  emptyQuizAnswers,
  pickQuizOption,
  quizFollowUpDraft,
  quizProgress,
  type QuizAnswers,
  type QuizSpec,
} from "@/lib/chatStudy";
import { requestChatDraftText } from "@/lib/chatQuote";
import { chatStudyCopy, fillStudyCopy, type ChatStudyCopy } from "@/locales/chatStudy";

const LETTERS = "ABCDEF";

const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700";

const optionClass = (state: "open" | "correct" | "wrong" | "other") => {
  const base =
    "flex min-h-11 w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
  if (state === "correct") {
    return `${base} border-green-600 bg-green-50 text-green-950 dark:border-green-500 dark:bg-green-950/40 dark:text-green-100`;
  }
  if (state === "wrong") {
    return `${base} border-red-600 bg-red-50 text-red-950 dark:border-red-500 dark:bg-red-950/40 dark:text-red-100`;
  }
  if (state === "other") {
    return `${base} cursor-default border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300`;
  }
  return `${base} border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800`;
};

/**
 * The quiz as the reader sees it, with its answers passed in so the same
 * markup can be rendered in any state. Answered options stay focusable but
 * ignore a second press (`aria-disabled`), and each question has a polite live
 * region that says whether the pick was right, so a screen reader hears the
 * result and does not have to find a colour.
 */
export function QuizView({
  spec,
  answers,
  copy,
  onPick,
  onRetry,
  onExplain,
}: {
  spec: QuizSpec;
  answers: QuizAnswers;
  copy: ChatStudyCopy;
  onPick: (question: number, option: number) => void;
  onRetry: () => void;
  onExplain: () => void;
}) {
  const progress = quizProgress(spec, answers);
  const label = spec.title ? `${copy.quizLabel}: ${spec.title}` : copy.quizLabel;
  return (
    <section
      data-testid="chat-quiz"
      aria-label={label}
      className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-zinc-900 last:mb-0 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-100 sm:p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold">{label}</p>
        <p data-testid="chat-quiz-progress" className="text-xs text-zinc-600 dark:text-zinc-300">
          {fillStudyCopy(copy.quizProgress, { answered: progress.answered, total: progress.total })}
        </p>
      </header>
      <ol className="mt-3 space-y-5">
        {spec.questions.map((question, questionIndex) => {
          const picked = answers[questionIndex] ?? null;
          const answered = picked !== null;
          return (
            <li key={questionIndex} data-testid="chat-quiz-question">
              <fieldset>
                <legend className="text-sm font-medium leading-6">
                  <span className="sr-only">{fillStudyCopy(copy.quizQuestionNumber, { n: questionIndex + 1 })}. </span>
                  <span aria-hidden="true">{questionIndex + 1}. </span>
                  {question.question}
                </legend>
                <ul className="mt-2 space-y-1.5">
                  {question.options.map((option, optionIndex) => {
                    const isAnswer = optionIndex === question.answer;
                    const isPicked = optionIndex === picked;
                    const state = !answered ? "open" : isAnswer ? "correct" : isPicked ? "wrong" : "other";
                    return (
                      <li key={optionIndex}>
                        <button
                          type="button"
                          data-testid="chat-quiz-option"
                          data-state={state}
                          aria-pressed={isPicked}
                          aria-disabled={answered ? true : undefined}
                          onClick={() => onPick(questionIndex, optionIndex)}
                          className={optionClass(state)}
                        >
                          <span aria-hidden="true" className="mt-0.5 w-5 shrink-0 font-semibold">
                            {LETTERS[optionIndex]}.
                          </span>
                          <span className="min-w-0 flex-1 break-words">{option}</span>
                          {answered && isAnswer ? (
                            <span className="flex shrink-0 items-center gap-1 text-xs font-semibold">
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              {copy.quizOptionCorrect}
                            </span>
                          ) : null}
                          {answered && isPicked && !isAnswer ? (
                            <span className="flex shrink-0 items-center gap-1 text-xs font-semibold">
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                              {copy.quizOptionPicked}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              <div role="status" aria-live="polite" data-testid="chat-quiz-feedback" className="mt-2 text-sm">
                {answered ? (
                  <>
                    <p className="font-semibold">
                      {picked === question.answer
                        ? copy.quizResultCorrect
                        : fillStudyCopy(copy.quizResultWrong, {
                            answer: `${LETTERS[question.answer]}. ${question.options[question.answer]}`,
                          })}
                    </p>
                    {question.explanation ? (
                      <p className="mt-1 text-zinc-700 dark:text-zinc-300">{question.explanation}</p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div role="status" aria-live="polite" className="mt-4" data-testid="chat-quiz-summary">
        {progress.done ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
            <p data-testid="chat-quiz-score" className="text-sm font-semibold">
              {fillStudyCopy(copy.quizScore, { correct: progress.correct, total: progress.total })}
              {progress.missed.length === 0 ? ` ${copy.quizAllCorrect}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {progress.missed.length > 0 ? (
                <button type="button" data-testid="chat-quiz-explain" onClick={onExplain} className={BUTTON}>
                  {copy.quizExplainMissed}
                </button>
              ) : null}
              <button type="button" data-testid="chat-quiz-retry" onClick={onRetry} className={BUTTON}>
                {copy.quizRetry}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function QuizBody({ spec, copy }: { spec: QuizSpec; copy: ChatStudyCopy }) {
  const [answers, setAnswers] = useState<QuizAnswers>(() => emptyQuizAnswers(spec));
  return (
    <QuizView
      spec={spec}
      answers={answers}
      copy={copy}
      onPick={(question, option) => setAnswers((current) => pickQuizOption(spec, current, question, option))}
      onRetry={() => setAnswers(emptyQuizAnswers(spec))}
      // Fills the composer and sends nothing; the reader decides what to ask.
      onExplain={() => requestChatDraftText(quizFollowUpDraft(spec, answers, copy.quizExplainIntro))}
    />
  );
}

/**
 * A ```quiz block drawn as a quiz once the answer is final. While the answer
 * streams, and for any spec that did not validate, `fallback` (the ordinary
 * code block) is what the reader sees. The picks live in this component only.
 */
export function ChatQuiz({ spec, fallback }: { spec: QuizSpec; fallback: ReactNode }) {
  const streaming = useContext(AnswerRenderContext)?.streaming ?? false;
  const { lang } = useLanguage();
  if (streaming) return <>{fallback}</>;
  return <QuizBody spec={spec} copy={chatStudyCopy[lang]} />;
}
