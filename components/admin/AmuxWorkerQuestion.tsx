"use client";

import { useEffect, useId, useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";

/** A v22 worker's question, as `GET /api/admin/amux/v22-task-result` returns it. */
export type AmuxWorkerQuestion = {
  id: string; sequence: number; state: string; question: string;
  unblocks: string; options: Array<{ id: string; label: string }>;
};

export type AmuxAnswerOutcome = "sent" | { failed: string };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Records the owner's answer through the existing route, which sends the Task
 * back to the same worker with the question and the answer.
 */
export async function sendAmuxWorkerAnswer(
  input: { taskId: string; questionId: string; answer: string },
  fetcher: Fetcher = adminFetch,
): Promise<AmuxAnswerOutcome> {
  try {
    const response = await fetcher("/api/admin/amux/v22-owner-question", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input) });
    if (response.ok) return "sent";
    const body = await response.json().catch(() => null);
    return { failed: typeof body?.error === "string" ?
      body.error : String(response.status) };
  } catch { return { failed: "network" }; }
}

/** The question in a result response body, or null when it carries none. */
export const amuxWorkerQuestionFrom = (body: unknown): AmuxWorkerQuestion | null => {
  const question = (body as { question?: unknown } | null)?.question;
  return question && typeof question === "object" &&
    typeof (question as { id?: unknown }).id === "string" ?
    question as AmuxWorkerQuestion : null;
};

export type AmuxTaskQuestionRead = { kind: "question"; question: AmuxWorkerQuestion } |
  { kind: "none" | "missing" | "purged" | "unavailable" };

/** Reads a Task's newest result and the question it asked, for the detail view. */
export async function readAmuxTaskQuestion(taskId: string,
  fetcher: Fetcher = adminFetch): Promise<AmuxTaskQuestionRead> {
  try {
    const response = await fetcher(
      `/api/admin/amux/v22-task-result?taskId=${encodeURIComponent(taskId)}`,
      { cache: "no-store" });
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) return { kind: "unavailable" };
    const body = await response.json();
    if (body?.result?.state === "purged") return { kind: "purged" };
    if (body?.result?.state !== "available") return { kind: "unavailable" };
    const question = amuxWorkerQuestionFrom(body);
    return question ? { kind: "question", question } : { kind: "none" };
  } catch { return { kind: "unavailable" }; }
}

/**
 * One worker question with its answer form. The parent keys it by question
 * id, so a different question starts with an empty answer.
 */
export function AmuxWorkerQuestionBox({ taskId, question, onAnswered, send = sendAmuxWorkerAnswer }: {
  taskId: string; question: AmuxWorkerQuestion; onAnswered?: () => void;
  send?: typeof sendAmuxWorkerAnswer;
}) {
  const messages = useAdminMessages(adminAmuxCardsMessages);
  const answerId = useId();
  const [answer, setAnswer] = useState("");
  const [answerState, setAnswerState] = useState<"sending" | AmuxAnswerOutcome | null>(null);
  // The question on screen; an answer's response for another one is dropped.
  const shownQuestion = useRef(question.id);
  useEffect(() => { shownQuestion.current = question.id; }, [question.id]);
  const state = answerState === "sent" ? "answered" : question.state;
  async function submit() {
    const questionId = question.id;
    setAnswerState("sending");
    const outcome = await send({ taskId, questionId, answer });
    if (shownQuestion.current !== questionId) return;
    setAnswerState(outcome);
    if (outcome === "sent") { setAnswer(""); onAnswered?.(); }
  }
  return (
    <div className="mt-3 rounded border p-3 border-amber-500" data-testid="amux-worker-question">
      <p className="font-semibold">{messages.questionTitle(question.sequence)} · {messages.questionState(state)}</p>
      <p className="mt-1 whitespace-pre-wrap break-words">{question.question}</p>
      <p className="mt-1 text-sm text-zinc-300">{messages.questionUnblocks}: {question.unblocks}</p>
      {question.options.length > 0 && (
        <>
        <p className="mt-1 text-sm text-zinc-300">{messages.questionOptions}</p>
        <ul className="mt-1 list-disc pl-5 text-sm">
          {question.options.map((option) => (
            <li key={option.id}><span className="font-mono">{option.id}</span>: {option.label}</li>
          ))}
        </ul>
        </>
      )}
      {state === "open" && (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
          <label className="text-sm" htmlFor={answerId}>{messages.answerLabel}</label>
          <textarea id={answerId} className="min-h-24 rounded border bg-transparent p-2 border-zinc-600"
            maxLength={8000} value={answer} onChange={(event) => setAnswer(event.target.value)} />
          <button type="submit" className="self-start rounded border px-3 py-1 border-zinc-500"
            disabled={answer.trim().length === 0 || answerState === "sending"}>
            {answerState === "sending" ? messages.answerSending : messages.answerSubmit}
          </button>
        </form>
      )}
      {answerState === "sent" && <p className="mt-2 text-sm">{messages.answerSent}</p>}
      {answerState && typeof answerState === "object" &&
        <p className="mt-2 text-sm text-red-400">{messages.answerFailed(answerState.failed)}</p>}
    </div>
  );
}

/**
 * The detail view's question: read once when the card says one is waiting,
 * shown only while it is open or answered but not yet resumed. Reading needs
 * the owner, as the route does; anyone else is told so instead.
 */
export function AmuxTaskQuestionSection({ taskId, canAnswer, onAnswered,
  read = readAmuxTaskQuestion, send }: {
  taskId: string; canAnswer: boolean; onAnswered?: () => void;
  read?: typeof readAmuxTaskQuestion; send?: typeof sendAmuxWorkerAnswer;
}) {
  const messages = useAdminMessages(adminAmuxCardsMessages);
  const [loaded, setLoaded] = useState<AmuxTaskQuestionRead | "loading">("loading");
  useEffect(() => {
    if (!canAnswer) return;
    let cancelled = false;
    void read(taskId).then((result) => { if (!cancelled) setLoaded(result); });
    return () => { cancelled = true; };
  }, [taskId, canAnswer, read]);
  if (!canAnswer) return <p className="rounded border p-3 text-sm border-amber-500"
    data-testid="amux-worker-question-owner-only">{messages.questionOwnerOnly}</p>;
  if (loaded === "loading") return <p role="status" className="text-sm">{messages.resultLoading}</p>;
  if (loaded.kind === "question") {
    if (!["open", "answered"].includes(loaded.question.state)) return null;
    return <AmuxWorkerQuestionBox key={loaded.question.id} taskId={taskId}
      question={loaded.question} onAnswered={onAnswered} send={send} />;
  }
  if (loaded.kind === "none") return null;
  return <p className="text-sm" data-testid="amux-worker-question-unavailable">{
    loaded.kind === "missing" ? messages.resultMissing :
    loaded.kind === "purged" ? messages.resultPurged : messages.resultUnavailable}</p>;
}
