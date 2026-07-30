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

/** Removes every per-model transcript for one guest conversation. */
export const removeGuestConversationMessages = (conversationId: string) => {
  if (typeof window === "undefined") return;
  const keys = Object.keys(window.localStorage);
  for (const key of guestMessageKeysForConversation(keys, conversationId)) {
    window.localStorage.removeItem(key);
  }
};

/** Removes every guest transcript, for "delete all" style flows. */
export const removeAllGuestConversationMessages = () => {
  if (typeof window === "undefined") return;
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith(GUEST_MESSAGES_PREFIX)) {
      window.localStorage.removeItem(key);
    }
  }
};
