/**
 * Study mode is remembered per conversation in this browser only.
 *
 * The turn carries the setting (`studyMode: true` in the chat request), so the
 * server stores nothing: no column, no migration. What this file keeps is which
 * conversations the reader switched it on in, so reopening one finds it still
 * on. Another browser starts with it off, which is the same state as a new
 * conversation.
 */

const STORAGE_KEY = "tomverse.chat.studyMode.v1";
const MAX_REMEMBERED = 200;

const read = (): string[] => {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

/** Whether study mode was left on in this conversation. A blank chat (no id) is off. */
export function readStudyMode(conversationId: string | null | undefined): boolean {
  if (!conversationId || typeof window === "undefined") return false;
  return read().includes(conversationId);
}

/** Remembers the switch for one conversation; the oldest entries go first past the cap. */
export function writeStudyMode(conversationId: string | null | undefined, on: boolean): void {
  if (!conversationId || typeof window === "undefined") return;
  try {
    const rest = read().filter((id) => id !== conversationId);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify((on ? [...rest, conversationId] : rest).slice(-MAX_REMEMBERED)));
  } catch {
    // Storage can be blocked or full; the switch still works for this page view.
  }
}
