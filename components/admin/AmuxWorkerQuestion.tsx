"use client";

import { useEffect, useId, useRef, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { dmJudgmentBody, runDmJudgment, type DmJudgmentIo,
  type DmJudgmentState } from "@/components/admin/AmuxDecisionMakerJudgmentPanel";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxCardsMessages } from "@/lib/adminMessages/amuxCards";
import { adminAmuxDecisionMakerJudgmentMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import { dmAdminRequestDetailHref } from "@/lib/amux/decisionMakerAdminHrefs";
import { DM_DEFAULT_DECLARATION_ACCURACY } from "@/lib/amux/decisionMakerJudgmentCore";
import type { AmuxV22QuestionDm } from "@/lib/amux/v22OwnerQuestionDmCore";

/** A v22 worker's question, as `GET /api/admin/amux/v22-task-result` returns it. */
export type AmuxWorkerQuestion = {
  id: string; sequence: number; state: string; question: string;
  unblocks: string; options: Array<{ id: string; label: string }>;
  /** What the worker found, and the files it points at, when it gave them. */
  context?: string; paths?: string[];
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

const DM_STATES: ReadonlySet<string> = new Set(["not_sent", "filed", "with_operator", "working",
  "proposal", "cannot_answer", "failed", "confirmed", "rejected", "closed", "restricted", "unavailable"]);

/** Where the question stands with the Decision Maker, or null when the body carries none. */
export const amuxWorkerQuestionDmFrom = (body: unknown): AmuxV22QuestionDm | null => {
  const dm = (body as { decisionMaker?: unknown } | null)?.decisionMaker;
  if (!dm || typeof dm !== "object") return null;
  const state = (dm as { state?: unknown }).state;
  if (typeof state !== "string" || !DM_STATES.has(state)) return null;
  // A proposal without what a confirmation must name is shown as unreadable, never as confirmable.
  if (state === "proposal") {
    const p = dm as { requestId?: unknown; rationale?: unknown; shown?: unknown; snapshot?: unknown };
    const snapshot = p.snapshot as { state?: unknown; paths?: unknown } | null | undefined;
    if (typeof p.requestId !== "string" || typeof p.rationale !== "string" ||
        !p.shown || typeof p.shown !== "object" || !snapshot || typeof snapshot.state !== "string" ||
        !Array.isArray(snapshot.paths)) return { state: "unavailable" };
  }
  return dm as AmuxV22QuestionDm;
};

export type AmuxTaskQuestionRead = { kind: "question"; question: AmuxWorkerQuestion;
  decisionMaker?: AmuxV22QuestionDm | null } |
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
    return question ? { kind: "question", question, decisionMaker: amuxWorkerQuestionDmFrom(body) } :
      { kind: "none" };
  } catch { return { kind: "unavailable" }; }
}

const JUDGMENT_PATH = "/api/admin/amux/decision-maker/judgments";

/** "Confirm as proposed": the judgment route's confirmation on the values Admin showed,
 * with the declaration accuracy left unjudged, as the request drawer's default. */
export const amuxWorkerQuestionDmConfirmBody = (dm: Extract<AmuxV22QuestionDm, { state: "proposal" }>) =>
  dmJudgmentBody(dm.requestId, "confirm", dm.shown,
    { accuracy: DM_DEFAULT_DECLARATION_ACCURACY, mismatchedItems: [], operatorAnswer: "" });

/**
 * The Decision Maker's part of a worker question (owner decision 2026-10-30:
 * it proposes, the operator confirms). A proposal shows its answer and why,
 * with one button that confirms it through the existing judgment route on the
 * values Admin showed; the relay applies a confirmed answer on its next tick.
 * Nothing here applies an answer. Every other state says in one line why the
 * Decision Maker has no answer to confirm.
 */
export function AmuxWorkerQuestionDm({ dm, options, io, canConfirm = true, line: stateLine, confirmedLine }: {
  dm: AmuxV22QuestionDm; options: AmuxWorkerQuestion["options"]; io?: DmJudgmentIo;
  /** The owner queue's settlement cards: false shows the proposal without the confirmation. */
  canConfirm?: boolean;
  /** Replaces the state line and the confirmed line, for a card whose answer is not a worker's. */
  line?: string; confirmedLine?: string;
}) {
  const messages = useAdminMessages(adminAmuxCardsMessages);
  const judgment = useAdminMessages(adminAmuxDecisionMakerJudgmentMessages);
  const { locale } = useAdminLocale();
  const [state, setState] = useState<DmJudgmentState>({ phase: "editing" });
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const reason = (code: string) => messages.dmReasons[code] ?? code;
  const line = state.phase === "recorded" ? confirmedLine ?? messages.dmConfirmed :
    stateLine ?? messages.dmState(dm, reason);
  const send: DmJudgmentIo = io ?? {
    post: (body) => adminFetch(JUDGMENT_PATH, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    failureOf: (response) => readAdminApiFailure(response, { fallback: judgment.failed, locale }),
  };
  const settled = state.phase === "refused" ?
    (judgment.refused as Record<string, string>)[state.reason] ?? judgment.failed :
    state.phase === "unknown" ? judgment.unknown : null;
  return (
    <div className="mt-2 rounded border p-2 border-sky-700" data-testid="amux-worker-question-dm"
      data-dm-state={dm.state}>
      <p className="text-sm font-semibold">{messages.dmTitle}</p>
      <p className="mt-1 text-sm" data-testid="amux-worker-question-dm-line">{line}</p>
      {dm.state === "proposal" && state.phase !== "recorded" && (
        <div className="mt-2 flex flex-col gap-1 text-sm" data-testid="amux-worker-question-dm-proposal">
          <p className="text-zinc-300">{messages.dmProposal}</p>
          <p className="whitespace-pre-wrap break-words">{dm.optionId !== null ?
            dm.optionId + ": " + (options.find((option) => option.id === dm.optionId)?.label ?? "") :
            dm.answer ?? ""}</p>
          <p className="text-zinc-300">{messages.dmRationale}</p>
          <p className="whitespace-pre-wrap break-words">{dm.rationale}</p>
          {/* docs/policy/amux-decision-maker.md §6: what the Decision Maker read, shown before the confirmation. */}
          <p className="text-zinc-300">{messages.dmSnapshot}</p>
          <p className="break-words" data-testid="amux-worker-question-dm-snapshot">
            {dm.snapshot.state === "none" ? messages.dmCardOnly :
              messages.dmSnapshotAt(dm.snapshot.state, dm.snapshot.targetSha ?? "")}</p>
          {dm.snapshot.state !== "none" && dm.snapshot.paths.length > 0 && (
            <>
            <p className="text-zinc-300">{messages.dmSnapshotPaths}</p>
            <ul className="font-mono text-xs" data-testid="amux-worker-question-dm-snapshot-paths">
              {dm.snapshot.paths.map((path) => <li key={path}>{path}</li>)}
            </ul>
            </>
          )}
          {dm.irreversible && <p className="font-semibold text-red-300"
            data-testid="amux-worker-question-dm-irreversible">{messages.dmIrreversible}</p>}
          {canConfirm && <div className="mt-1 flex flex-wrap items-center gap-3">
            <button type="button" className="rounded border px-3 py-1 border-sky-500"
              data-testid="amux-worker-question-dm-confirm"
              disabled={state.phase !== "editing"}
              onClick={() => {
                if (state.phase !== "editing") return;
                void runDmJudgment(amuxWorkerQuestionDmConfirmBody(dm), send, (changes) => {
                  if (changes.state) setState(changes.state);
                  if ("failure" in changes) setFailure(changes.failure ?? null);
                });
              }}>
              {state.phase === "sending" ? messages.dmConfirming : messages.dmConfirm}
            </button>
            <a className="text-sky-300 underline" href={dmAdminRequestDetailHref(dm.requestId)}>
              {messages.dmOpenDetail}</a>
          </div>}
        </div>
      )}
      {settled !== null && <p role="status" className="mt-1 text-sm"
        data-testid="amux-worker-question-dm-settled">{settled}</p>}
      {failure && <AdminApiFailureNotice failure={failure} />}
    </div>
  );
}

/**
 * One worker question with its answer form. The parent keys it by question
 * id, so a different question starts with an empty answer.
 */
export function AmuxWorkerQuestionBox({ taskId, question, decisionMaker = null, onAnswered,
  send = sendAmuxWorkerAnswer, judgmentIo }: {
  taskId: string; question: AmuxWorkerQuestion; onAnswered?: () => void;
  /** Where the question stands with the Decision Maker; null when not read. */
  decisionMaker?: AmuxV22QuestionDm | null;
  send?: typeof sendAmuxWorkerAnswer; judgmentIo?: DmJudgmentIo;
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
      {question.context && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-300"
        data-testid="amux-worker-question-context">{messages.questionContext}: {question.context}</p>}
      {question.paths && question.paths.length > 0 && (
        <ul className="mt-1 font-mono text-xs" aria-label={messages.questionPaths}
          data-testid="amux-worker-question-paths">
          {question.paths.map((path) => <li key={path}>{path}</li>)}
        </ul>
      )}
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
      {state === "open" && decisionMaker && <AmuxWorkerQuestionDm dm={decisionMaker}
        options={question.options} io={judgmentIo} />}
      {state === "open" && (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
          <label className="text-sm" htmlFor={answerId}>{decisionMaker?.state === "proposal" ?
            messages.dmDirect : messages.answerLabel}</label>
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
      question={loaded.question} decisionMaker={loaded.decisionMaker ?? null}
      onAnswered={onAnswered} send={send} />;
  }
  if (loaded.kind === "none") return null;
  return <p className="text-sm" data-testid="amux-worker-question-unavailable">{
    loaded.kind === "missing" ? messages.resultMissing :
    loaded.kind === "purged" ? messages.resultPurged : messages.resultUnavailable}</p>;
}
