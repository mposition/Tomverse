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
 * The conversation segment for a composer that has no conversation id yet. An
 * authenticated "New chat" only gets an id when the first send creates one, so
 * its in-progress question needs a name of its own.
 */
export const NEW_CONVERSATION_DRAFT_SEGMENT = "new-conversation";

/**
 * The identity segment for a tab whose session has not resolved.
 *
 * Its own namespace, never a fallback to somebody else's: see `draftKeyFor`.
 */
export const UNRESOLVED_IDENTITY_DRAFT_SEGMENT = "unresolved";

const DRAFT_KEY_PREFIX = "draft";
const DRAFT_KEY_SEPARATOR = "|";

/** Whether a string is already a draft key rather than a conversation id. */
export const isDraftKey = (value: string) =>
  value.startsWith(`${DRAFT_KEY_PREFIX}${DRAFT_KEY_SEPARATOR}`);

export const EMPTY_DRAFT: ConversationDraft = { text: "", attachments: [] };

/**
 * The key one draft lives under: an identity *and* a conversation.
 *
 * Contract: docs/policy/conversation-draft-identity-scope.md.
 *
 * ## Why the identity is in the key rather than around the store
 *
 * A store per identity, selected by whoever is signed in now, would answer the
 * question the composer asks on every render — and get the other one wrong.
 * Writes here are not all synchronous: `uploadOneFile` captures a key when the
 * upload starts and passes it back when the file finishes, which can be after
 * the tab has changed hands. Resolving such a write against "the identity that
 * is current now" would drop account A's attachment into account B's draft.
 * A key that carries its own namespace cannot do that: the late write lands in
 * A's draft, which B's composer never reads.
 *
 * ## Why an unresolved session is its own namespace, not a fallback
 *
 * `identityKey` is `null` while the session provider has not settled. That is
 * not "nobody", and it is certainly not "everybody" — a shared bucket for it is
 * exactly the defect this key format exists to close, because every identity in
 * the tab would take turns reading it. It gets its own segment instead, which
 * no resolved identity ever reads. The cost is that text typed before the
 * session resolves stays in that namespace rather than moving to whoever turns
 * out to be signed in; the alternative is guessing which person typed it.
 *
 * ## Idempotent on purpose
 *
 * A caller holding a key can pass it straight back as a `scopeId` without
 * converting it to a conversation id first — and, per the first section above,
 * without its identity being re-resolved to whoever is current. The composer
 * relies on this: it scopes its own upload state by key.
 */
export const draftKeyFor = (
  conversationId: string | null | undefined,
  identityKey: string | null
) => {
  if (conversationId && isDraftKey(conversationId)) return conversationId;
  return [
    DRAFT_KEY_PREFIX,
    identityKey ?? UNRESOLVED_IDENTITY_DRAFT_SEGMENT,
    conversationId || NEW_CONVERSATION_DRAFT_SEGMENT,
  ].join(DRAFT_KEY_SEPARATOR);
};

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
