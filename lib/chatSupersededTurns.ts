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
 * The note is per browser, shared by its tabs through localStorage: a tab that
 * replaces a turn tells the others (the `storage` event), and every write
 * merges with what is stored instead of overwriting it. Another browser that
 * opens the same conversation shows both turns undimmed and sends both as
 * context, which is the same as having asked the question twice.
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
let watchingStorage = false;

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

function readStored(): Map<string, string[]> {
  const stored = new Map<string, string[]>();
  const store = storage();
  if (!store) return stored;
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return stored;
    for (const [conversationId, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) {
        stored.set(conversationId, ids.filter((id): id is string => typeof id === "string"));
      }
    }
  } catch {
    // An unreadable note is the same as no note.
  }
  return stored;
}

/**
 * Folds what another tab wrote into what this page holds. A note only ever
 * grows (a replaced turn is never restored), so a union loses nothing from
 * either side: without it the tab that saved last would erase the other tab's
 * notes, and a tab that read once would keep sending a turn the other replaced.
 * Returns whether anything changed.
 */
function mergeStored(): boolean {
  let changed = false;
  for (const [conversationId, ids] of readStored()) {
    const current = sets.get(conversationId);
    if (current && ids.every((id) => current.has(id))) continue;
    changed = true;
    const merged = new Set([...ids, ...(current ?? [])]);
    while (merged.size > MAX_IDS_PER_CONVERSATION) merged.delete(merged.values().next().value as string);
    sets.set(conversationId, merged);
  }
  return changed;
}

function load() {
  if (loaded) return;
  loaded = true;
  mergeStored();
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
  // Read again just before writing: another tab may have saved since this page
  // last looked, and this write must add to its notes, not replace them.
  mergeStored();
  const next = new Set([...(sets.get(conversationId) ?? []), ...ids]);
  while (next.size > MAX_IDS_PER_CONVERSATION) next.delete(next.values().next().value as string);
  // Re-insert so the most recently touched conversation is the last one kept.
  sets.delete(conversationId);
  sets.set(conversationId, next);
  persist();
  for (const listener of listeners) listener();
}

/** Another tab wrote the note: take it in and tell this page. */
function onStorageEvent(event: StorageEvent) {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  if (mergeStored()) for (const listener of listeners) listener();
}

export function subscribeSuperseded(listener: () => void): () => void {
  listeners.add(listener);
  if (!watchingStorage && typeof window !== "undefined") {
    watchingStorage = true;
    window.addEventListener("storage", onStorageEvent);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watchingStorage && typeof window !== "undefined") {
      watchingStorage = false;
      window.removeEventListener("storage", onStorageEvent);
    }
  };
}

/**
 * Brings this page up to date with other tabs before a send reads the note.
 * The `storage` event already does this while a component is subscribed; a
 * send calls it too, so the request never leans on a stale copy.
 */
export function refreshSupersededFromStorage() {
  load();
  if (mergeStored()) for (const listener of listeners) listener();
}

/**
 * One send that replaces a turn. The replaced messages leave this request's
 * context at once, but they are recorded as replaced only when the new answer
 * is written as finished: a send that is refused (no credits), fails or is
 * stopped leaves the earlier answer standing, undimmed and in later context.
 */
export function beginReplacement(conversationId: string, ids: readonly string[] | null) {
  let pending = ids && ids.length > 0 ? [...ids] : null;
  return {
    /** Everything the request must leave out: the saved note plus this turn. */
    excludedIds(): ReadonlySet<string> {
      // Another tab may have replaced a turn since this page last looked.
      refreshSupersededFromStorage();
      const saved = getSupersededIds(conversationId);
      return pending ? new Set([...saved, ...pending]) : saved;
    },
    /** Call with the status of each write to the new answer. */
    answerWritten(status: Message["status"]) {
      if (!pending || (status !== "normal" && status !== "incomplete")) return;
      const done = pending;
      pending = null;
      markTurnSuperseded(conversationId, done);
    },
  };
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
