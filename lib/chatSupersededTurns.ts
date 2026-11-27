/**
 * "Regenerate" and "edit your last message" replace the last turn without a
 * conversation tree (docs/policy/conversation-fork-adr-draft.md stays a draft).
 *
 * What is stored does not change: the replaced question and answer remain in
 * the conversation, and the new question is saved as an ordinary new turn.
 * The server marks the two replaced messages (`Message.supersededAt`,
 * lib/chatSupersededMessages.ts), so that on every device and browser
 *
 *   - the model is not shown the replaced turn when it answers again, and
 *   - the replaced turn is drawn dimmed, labelled as replaced.
 *
 * This module is the page's side of that: which turn can be replaced, the
 * send that replaces it, and the page's copy of the server's note.
 */

import type { Message } from "@/components/chat/types";

export type ReplaceableTurn = { question: Message; answer: Message };

const isCompletedAnswer = (message: Message | undefined): message is Message =>
  Boolean(message) &&
  message!.role === "assistant" &&
  (message!.status === undefined || message!.status === "normal" || message!.status === "incomplete") &&
  message!.content.trim().length > 0 &&
  !message!.imported &&
  !message!.imageTurn &&
  !message!.researchRunId &&
  !message!.pendingJobId &&
  !message!.carriedAnswer &&
  message!.id !== "welcome";

/**
 * The newest question and its finished answer: the only turn that can be
 * regenerated or edited. Null while the newest message is anything else (an
 * error, a stopped answer, an image, an unanswered question), which have their
 * own retry controls.
 */
export function lastReplaceableTurn(messages: readonly Message[]): ReplaceableTurn | null {
  const answer = messages[messages.length - 1];
  const question = messages[messages.length - 2];
  if (!isCompletedAnswer(answer)) return null;
  if (!question || question.role !== "user" || question.imported) return null;
  if (!question.id || !answer.id) return null;
  if (!question.content.trim() && !question.attachments?.length) return null;
  return { question, answer };
}

/** An edit resends text only: a question that carried files cannot be edited. */
export function canEditQuestion(turn: ReplaceableTurn): boolean {
  return !turn.question.attachments?.length && turn.question.content.trim().length > 0;
}

/** A plain resend carries no files either; same rule as the failed-turn retry. */
export function canResendQuestion(turn: ReplaceableTurn): boolean {
  return canEditQuestion(turn);
}

export function withoutSuperseded<T extends { id: string }>(
  messages: readonly T[],
  superseded: ReadonlySet<string>
): T[] {
  return superseded.size === 0 ? [...messages] : messages.filter((message) => !superseded.has(message.id));
}

/* ------------------------------------------------------------------ store */

/**
 * This page's copy of the conversation's note. It is filled from what the
 * server says when the conversation loads (`rememberSupersededMessages`) and
 * grows when a replacement this page made finishes. Nothing is kept in the
 * browser: another tab or device learns of a replacement on its next load, and
 * its requests are already right before then, because the chat route leaves
 * replaced turns out of the context on its own.
 */
const EMPTY: ReadonlySet<string> = new Set();
const sets = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

function addIds(conversationId: string, ids: readonly string[]): boolean {
  const current = sets.get(conversationId) ?? EMPTY;
  if (ids.every((id) => current.has(id))) return false;
  sets.set(conversationId, new Set([...current, ...ids]));
  return true;
}

export function getSupersededIds(conversationId: string | null | undefined): ReadonlySet<string> {
  return conversationId ? sets.get(conversationId) ?? EMPTY : EMPTY;
}

export function subscribeSuperseded(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Takes in the replaced flags of a loaded conversation's messages (the
 * server's `superseded: true`). A note only grows: a replaced turn is never
 * restored, so a page that has not heard yet loses nothing by a union.
 */
export function rememberSupersededMessages(
  conversationId: string | null | undefined,
  messages: readonly { id?: unknown; superseded?: unknown }[] | null | undefined
) {
  if (!conversationId || !Array.isArray(messages)) return;
  const ids = messages
    .filter((message) => message?.superseded === true && typeof message.id === "string")
    .map((message) => message.id as string);
  if (ids.length > 0 && addIds(conversationId, ids)) notify();
}

/**
 * Tells the server, which keeps the note for every device. Best effort: the
 * chat route records the same turn in the transaction that saved the answer,
 * so a lost request here loses nothing.
 */
function saveToServer(conversationId: string, ids: readonly string[]) {
  if (typeof fetch !== "function") return;
  void fetch(`/api/conversations/${encodeURIComponent(conversationId)}/superseded`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageIds: ids }),
    keepalive: true,
  })
    .then((response) => response.arrayBuffer())
    .catch(() => undefined);
}

export function markTurnSuperseded(conversationId: string, ids: readonly string[], save = false) {
  if (addIds(conversationId, ids)) notify();
  if (save) saveToServer(conversationId, ids);
}

/**
 * One send that replaces a turn. The replaced messages leave this request's
 * context at once (and the request names them, so the server can record the
 * replacement with the answer), but they are recorded as replaced only when
 * the new answer is reported finished through `complete`: a send that is
 * refused (no credits), fails or is stopped leaves the earlier answer
 * standing, undimmed and in later context.
 *
 * The progress writes of a streaming answer carry the same "normal" status as
 * the final one, so the status of a write says nothing about completion. Only
 * the code that knows the answer is finished calls `complete`: the end of the
 * stream, a durable attempt that arrives completed, and the poll or history
 * load that later finds it completed (`parkReplacement`).
 *
 * `save` is false for a guest, whose conversation exists in this browser only.
 */
export function beginReplacement(conversationId: string, ids: readonly string[] | null, save = false) {
  let pending = ids && ids.length > 0 ? [...ids] : null;
  return {
    /** The turn this send replaces, for the request body. */
    replacing(): readonly string[] | null {
      return pending;
    },
    /** Everything the request must leave out: the note plus this turn. */
    excludedIds(): ReadonlySet<string> {
      const saved = getSupersededIds(conversationId);
      return pending ? new Set([...saved, ...pending]) : saved;
    },
    /** The new answer is finished: as written, or cut short by the provider. */
    complete(status: Message["status"]) {
      if (!pending || (status !== "normal" && status !== "incomplete")) return;
      const done = pending;
      pending = null;
      markTurnSuperseded(conversationId, done, save);
    },
  };
}

export type Replacement = ReturnType<typeof beginReplacement>;

/**
 * A durable attempt that has not finished when the request returns: the
 * replacement waits here, under the new answer's id, until a poll or a history
 * load finds the answer finished, or the attempt ends without one. A page that
 * is reloaded first forgets it; the server has recorded the replacement with
 * the answer, and the reloaded history carries it.
 */
const parked = new Map<string, Replacement>();

export function parkReplacement(answerId: string, replacement: Replacement) {
  parked.set(answerId, replacement);
}

/** `status` null: the attempt ended without a finished answer. */
export function settleParkedReplacement(answerId: string, status: Message["status"] | null) {
  const replacement = parked.get(answerId);
  if (!replacement) return;
  parked.delete(answerId);
  if (status) replacement.complete(status);
}

/** Test seam: forget everything held in memory. */
export function resetSupersededForTests() {
  sets.clear();
  parked.clear();
  armed = null;
}

/* ------------------------------------------------------------------- arming */

/**
 * The replaced turn is recorded when the replacing question is actually sent,
 * not when the button is pressed: a send that is refused (no credits, locked
 * conversation) must leave the earlier answer as it was. The press arms the
 * note; the send consumes it, and only for the same conversation and text.
 */
const ARM_TTL_MS = 20_000;
let armed: { conversationId: string; text: string; ids: string[]; at: number } | null = null;

export function armSupersede(conversationId: string, text: string, ids: readonly string[], now = Date.now()) {
  armed = { conversationId, text: text.trim(), ids: [...ids], at: now };
}

export function takeArmedSupersede(conversationId: string, text: string, now = Date.now()): string[] | null {
  const current = armed;
  armed = null;
  if (!current) return null;
  if (now - current.at > ARM_TTL_MS) return null;
  if (current.conversationId !== conversationId || current.text !== text.trim()) return null;
  return current.ids;
}
