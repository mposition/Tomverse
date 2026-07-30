import type { ChatAttachment } from "@/components/chat/types";

/**
 * The unsent question of one conversation: its text and its attachments are
 * one draft, because an attachment is part of the question being written and
 * has to travel with it.
 */
export type ConversationDraft = {
  text: string;
  attachments: ChatAttachment[];
};

/** Every conversation's draft, keyed by draft key (see `draftKeyFor`). */
export type ConversationDraftStore = Record<string, ConversationDraft>;

/**
 * Both a plain value and a reducer are accepted, because the two writers need
 * different things: the textarea knows the exact next value, while an upload
 * that finished asynchronously only knows "append this file to whatever that
 * conversation's draft holds now" -- possibly a conversation the user has
 * since navigated away from.
 */
export type DraftUpdate<T> = T | ((current: T) => T);

/**
 * How the composer reports an attachment change. `scopeId` names the
 * conversation the change belongs to and defaults to the open one; an upload
 * that resolves after the user switched conversations passes the id it was
 * started in, so the file lands in that conversation's draft rather than in
 * whatever is on screen when the request finally comes back.
 */
export type AttachmentsChangeHandler = (
  update: DraftUpdate<ChatAttachment[]>,
  scopeId?: string | null
) => void;

/**
 * Draft key for the composer of a conversation that has no id yet. An
 * authenticated "New chat" only gets a conversation id when the first send
 * creates one, so its in-progress question needs a key of its own. The colon
 * makes it impossible to collide with a real conversation id (cuid) or with a
 * guest id (`guest_<timestamp>`).
 */
export const NEW_CONVERSATION_DRAFT_KEY = "draft:new-conversation";

export const EMPTY_DRAFT: ConversationDraft = { text: "", attachments: [] };

/**
 * Idempotent on purpose: callers that already hold a draft key (the composer,
 * which needs one to scope its own per-conversation upload state) can pass it
 * straight back in as a `scopeId` without converting it to a conversation id
 * first.
 */
export const draftKeyFor = (conversationId: string | null | undefined) =>
  conversationId || NEW_CONVERSATION_DRAFT_KEY;

export const isDraftEmpty = (draft: ConversationDraft) =>
  draft.text.length === 0 && draft.attachments.length === 0;

export const readDraftEntry = (
  store: ConversationDraftStore,
  key: string
): ConversationDraft => store[key] ?? EMPTY_DRAFT;

export const resolveDraftUpdate = <T,>(
  update: DraftUpdate<T>,
  current: T
): T => (typeof update === "function" ? (update as (value: T) => T)(current) : update);

const withoutKey = (store: ConversationDraftStore, key: string) => {
  if (!(key in store)) return store;
  const remaining = { ...store };
  delete remaining[key];
  return remaining;
};

/**
 * Applies one change to one conversation's draft and leaves every other
 * conversation's draft byte-for-byte identical. Returns the same store object
 * when nothing changed, so React can skip the render.
 */
export const writeDraftEntry = (
  store: ConversationDraftStore,
  key: string,
  update: (current: ConversationDraft) => ConversationDraft
): ConversationDraftStore => {
  const existing = readDraftEntry(store, key);
  const next = update(existing);
  if (
    next.text === existing.text &&
    next.attachments === existing.attachments
  ) {
    return store;
  }
  // An emptied draft is removed rather than kept as an empty record, so the
  // store never grows one entry per conversation the user merely visited.
  if (isDraftEmpty(next)) return withoutKey(store, key);
  return { ...store, [key]: next };
};

/** Drops one conversation's draft; every other draft is untouched. */
export const removeDraftEntry = (
  store: ConversationDraftStore,
  key: string
): ConversationDraftStore => withoutKey(store, key);

/**
 * Hands a draft over to the id the server just issued for the conversation it
 * was written in. A draft already sitting on the target wins: moving over it
 * would be exactly the cross-conversation overwrite this store exists to
 * prevent, so the source is dropped instead.
 */
export const moveDraftEntry = (
  store: ConversationDraftStore,
  fromKey: string,
  toKey: string
): ConversationDraftStore => {
  if (fromKey === toKey) return store;
  const moving = store[fromKey];
  if (!moving) return store;
  const remaining = withoutKey(store, fromKey);
  if (store[toKey]) return remaining;
  return { ...remaining, [toKey]: moving };
};

/**
 * The `blob:` preview URLs a discarded draft is allowed to free.
 *
 * A preview is owned by the draft that created it, so it may only be revoked
 * once that draft is genuinely gone -- never merely because the user looked at
 * another conversation. `keep` covers the send path: the message now on its
 * way holds cloned previews, but cloneAttachmentPreviews falls back to the
 * original URL when a clone fails, and revoking that would blank the
 * attachment the user just sent.
 */
export const collectReleasablePreviewUrls = (
  items: ChatAttachment[],
  keep: ChatAttachment[] = []
): string[] => {
  const keptUrls = new Set(
    keep
      .map((item) => item.data)
      .filter((data): data is string => Boolean(data))
  );
  return items
    .map((item) => item.data)
    .filter(
      (data): data is string =>
        Boolean(data?.startsWith("blob:")) && !keptUrls.has(data as string)
    );
};
