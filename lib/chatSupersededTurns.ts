/**
 * "Regenerate" and "edit your last message" replace the last turn without a
 * conversation tree (docs/policy/conversation-fork-adr-draft.md stays a draft).
 *
 * What is stored does not change: the replaced question and answer remain in
 * the conversation, and the new question is saved as an ordinary new turn. What
 * this module keeps is a small, browser-local note of which two messages were
 * replaced, so that
 *
 *   - the model is not shown the replaced turn when it answers again, and
 *   - the replaced turn is drawn dimmed, labelled as replaced.
 *
 * The note is per browser. Another browser that opens the same conversation
 * shows both turns undimmed and sends both as context, which is the same as
 * having asked the question twice.
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

const STORAGE_KEY = "tomverse:superseded-turns:v1";
const MAX_IDS_PER_CONVERSATION = 100;
const MAX_CONVERSATIONS = 50;
const ARM_TTL_MS = 20_000;

const EMPTY: ReadonlySet<string> = new Set();
const sets = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let loaded = false;

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

function load() {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) return;
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return;
    for (const [conversationId, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) {
        sets.set(conversationId, new Set(ids.filter((id): id is string => typeof id === "string")));
      }
    }
  } catch {
    // An unreadable note is the same as no note.
  }
}

function persist() {
  const store = storage();
  if (!store) return;
  try {
    const entries = [...sets.entries()].slice(-MAX_CONVERSATIONS);
    store.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries.map(([id, ids]) => [id, [...ids]])))
    );
  } catch {
    // Storage full or blocked: the note then lasts for this page load only.
  }
}

export function getSupersededIds(conversationId: string | null | undefined): ReadonlySet<string> {
  if (!conversationId) return EMPTY;
  load();
  return sets.get(conversationId) ?? EMPTY;
}

export function markTurnSuperseded(conversationId: string, ids: readonly string[]) {
  load();
  const next = new Set([...(sets.get(conversationId) ?? []), ...ids]);
  while (next.size > MAX_IDS_PER_CONVERSATION) next.delete(next.values().next().value as string);
  // Re-insert so the most recently touched conversation is the last one kept.
  sets.delete(conversationId);
  sets.set(conversationId, next);
  persist();
  for (const listener of listeners) listener();
}

export function subscribeSuperseded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget everything held in memory (storage is not touched). */
export function resetSupersededForTests() {
  sets.clear();
  loaded = false;
  armed = null;
}

/* ------------------------------------------------------------------- arming */

/**
 * The replaced turn is recorded when the replacing question is actually sent,
 * not when the button is pressed: a send that is refused (no credits, locked
 * conversation) must leave the earlier answer as it was. The press arms the
 * note; the send consumes it, and only for the same conversation and text.
 */
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
