/**
 * Guest transcripts live in localStorage, one entry per (conversation, model)
 * pair. The key shape is defined here so readers, writers and the delete path
 * cannot drift apart: deleting a guest conversation previously removed
 * `guest_messages_<id>` while the transcripts were stored under
 * `guest_messages_<id>_<modelId>`, so nothing was ever deleted and the
 * "deleted" conversation reappeared on the next send.
 */

const GUEST_MESSAGES_PREFIX = "guest_messages_";

export const guestMessagesStorageKey = (
  conversationId: string,
  modelId: string
) => `${GUEST_MESSAGES_PREFIX}${conversationId}_${modelId}`;

/** Prefix shared by every per-model transcript of one guest conversation. */
export const guestMessagesConversationPrefix = (conversationId: string) =>
  `${GUEST_MESSAGES_PREFIX}${conversationId}_`;

/**
 * Selects every stored key belonging to a guest conversation.
 * Pure and storage-free so it can be unit tested directly.
 */
export const guestMessageKeysForConversation = (
  keys: readonly string[],
  conversationId: string
) => {
  const prefix = guestMessagesConversationPrefix(conversationId);
  // Also match the legacy suffix-less key so transcripts written before the
  // per-model split are cleaned up rather than orphaned forever.
  const legacyKey = `${GUEST_MESSAGES_PREFIX}${conversationId}`;
  return keys.filter((key) => key === legacyKey || key.startsWith(prefix));
};

/**
 * The turns a guest replaced (regenerate, edit) in one conversation. A signed-in
 * conversation keeps this on the server; a guest's transcript lives here, so its
 * note does too, or a reload would bring the replaced turn back into view and
 * into the model's context. Its own prefix, outside `guest_messages_`, so the
 * readers that walk transcript keys never take it for a model's transcript.
 */
const GUEST_SUPERSEDED_PREFIX = "guest_superseded_";
const GUEST_SUPERSEDED_MAX_IDS = 400;

export const guestSupersededStorageKey = (conversationId: string) =>
  `${GUEST_SUPERSEDED_PREFIX}${conversationId}`;

export const readGuestSupersededIds = (conversationId: string): string[] => {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(guestSupersededStorageKey(conversationId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

/** Adds to the stored note (a replaced turn is never restored). Best effort: storage may be full or blocked. */
export const addGuestSupersededIds = (conversationId: string, ids: readonly string[]) => {
  if (typeof window === "undefined" || ids.length === 0) return;
  try {
    const merged = [...new Set([...readGuestSupersededIds(conversationId), ...ids])].slice(-GUEST_SUPERSEDED_MAX_IDS);
    window.localStorage.setItem(guestSupersededStorageKey(conversationId), JSON.stringify(merged));
  } catch {
    // The page still has its own note for as long as it is open.
  }
};

/** Removes every per-model transcript for one guest conversation, and its replaced-turn note. */
export const removeGuestConversationMessages = (conversationId: string) => {
  if (typeof window === "undefined") return;
  const keys = Object.keys(window.localStorage);
  for (const key of guestMessageKeysForConversation(keys, conversationId)) {
    window.localStorage.removeItem(key);
  }
  window.localStorage.removeItem(guestSupersededStorageKey(conversationId));
};

/** Removes every guest transcript and replaced-turn note, for "delete all" style flows. */
export const removeAllGuestConversationMessages = () => {
  if (typeof window === "undefined") return;
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith(GUEST_MESSAGES_PREFIX) || key.startsWith(GUEST_SUPERSEDED_PREFIX)) {
      window.localStorage.removeItem(key);
    }
  }
};
