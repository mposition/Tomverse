"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatAttachment } from "./types";
import {
  collectReleasablePreviewUrls,
  draftKeyFor,
  EMPTY_DRAFT,
  isDraftEmpty,
  moveDraftEntry,
  readDraftEntry,
  removeDraftEntry,
  resolveDraftUpdate,
  writeDraftEntry,
  type ConversationDraft,
  type ConversationDraftStore,
  type DraftUpdate,
} from "@/lib/conversationDraftStore";

export {
  draftKeyFor,
  NEW_CONVERSATION_DRAFT_SEGMENT,
  type AttachmentsChangeHandler,
  type ConversationDraft,
} from "@/lib/conversationDraftStore";

export type ConversationDraftsApi = {
  /** The key the composer currently reads and writes. */
  activeDraftKey: string;
  draftText: string;
  draftAttachments: ChatAttachment[];
  /**
   * Writes text into a draft. `scopeId` is optional and defaults to whatever
   * conversation is open at call time (read through a ref, so a response that
   * resolves after a conversation switch can never land in the wrong draft).
   */
  setDraftText: (update: DraftUpdate<string>, scopeId?: string | null) => void;
  setDraftAttachments: (
    update: DraftUpdate<ChatAttachment[]>,
    scopeId?: string | null
  ) => void;
  /** The draft as it stands right now, without waiting for a re-render. */
  readDraft: (scopeId?: string | null) => ConversationDraft;
  hasDraft: (scopeId?: string | null) => boolean;
  /**
   * Drops one conversation's draft and releases its previews. Used when the
   * draft has actually left the composer -- the message was accepted, the
   * conversation was deleted, or the user explicitly asked for a blank new
   * chat -- never on a plain conversation switch.
   */
  discardDraft: (scopeId?: string | null, keep?: ChatAttachment[]) => void;
  /**
   * Hands the pending-conversation draft over to the real id the server just
   * issued, so a send that fails after the conversation was created still
   * shows the user their own text under the conversation now on screen.
   */
  migrateDraft: (fromScopeId: string | null, toScopeId: string | null) => void;
};

const releasePreviews = (items: ChatAttachment[], keep: ChatAttachment[]) => {
  if (typeof window === "undefined") return;
  collectReleasablePreviewUrls(items, keep).forEach((url) => {
    URL.revokeObjectURL(url);
  });
};

/**
 * Composer drafts, one per conversation, held for this tab only.
 *
 * The composer used to be a single `inputValue` shared by every conversation,
 * so opening another conversation from the sidebar carried the half-written
 * question along with it. Keying drafts by conversation id keeps each
 * conversation's unsent question (and its attachments) to itself; both shells
 * read this one store, so the desktop/mobile switch is not a draft boundary.
 *
 * Deliberately in-memory: persisting an unsent question to localStorage or to
 * the server is a separate product decision, not an implementation detail of
 * conversation switching. That also bounds this store's whole life to the tab,
 * which is what keeps the identity namespaces below from outliving the person
 * who filled them.
 *
 * ## Drafts belong to a person as well as to a conversation
 *
 * docs/policy/conversation-draft-identity-scope.md. `identityKey` names who the
 * tab is operating as (`identityNamespaceKey`, so `account:` and the user id),
 * or `null` before the session resolves. It is part of every key rather than a
 * selector over several stores, for the reason `draftKeyFor` gives: an upload
 * that finishes after the tab changes hands must land in the draft of the
 * person who started it, not of the person now looking at the screen.
 *
 * The consequence at this level is simply that one identity's drafts are not
 * reachable from another's. The previous account's text and attachments stay in
 * memory — coming back to that account restores them — and the composer for the
 * new one starts blank because it is reading keys that have never been written.
 */
export function useConversationDrafts(
  currentConversationId: string | null,
  identityKey: string | null
): ConversationDraftsApi {
  const [drafts, setDrafts] = useState<ConversationDraftStore>({});
  const activeDraftKey = draftKeyFor(currentConversationId, identityKey);

  // Every writer resolves its target key through these refs rather than
  // through the render's closure: uploads, conversation-detail responses and
  // submit all finish after an await, by which point the user may be looking
  // at a different conversation.
  const draftsRef = useRef(drafts);
  const activeDraftKeyRef = useRef(activeDraftKey);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  useEffect(() => {
    activeDraftKeyRef.current = activeDraftKey;
  }, [activeDraftKey]);

  const activeDraft = readDraftEntry(drafts, activeDraftKey);

  // The identity is read through a ref for the same reason the active key is:
  // a caller that passes a raw conversation id means "this conversation, as the
  // person this tab is now", and that person may have changed since the render
  // this callback was created in. A caller that passes a whole key keeps the
  // identity already in it — see `draftKeyFor`.
  const identityKeyRef = useRef(identityKey);
  useEffect(() => {
    identityKeyRef.current = identityKey;
  }, [identityKey]);

  const resolveKey = useCallback(
    (scopeId?: string | null) =>
      scopeId === undefined
        ? activeDraftKeyRef.current
        : draftKeyFor(scopeId, identityKeyRef.current),
    []
  );

  const setDraftText = useCallback(
    (update: DraftUpdate<string>, scopeId?: string | null) => {
      const key = resolveKey(scopeId);
      setDrafts((current) =>
        writeDraftEntry(current, key, (existing) => ({
          ...existing,
          text: resolveDraftUpdate(update, existing.text),
        }))
      );
    },
    [resolveKey]
  );

  const setDraftAttachments = useCallback(
    (update: DraftUpdate<ChatAttachment[]>, scopeId?: string | null) => {
      const key = resolveKey(scopeId);
      setDrafts((current) =>
        writeDraftEntry(current, key, (existing) => ({
          ...existing,
          attachments: resolveDraftUpdate(update, existing.attachments),
        }))
      );
    },
    [resolveKey]
  );

  const readDraft = useCallback(
    (scopeId?: string | null) =>
      readDraftEntry(draftsRef.current, resolveKey(scopeId)),
    [resolveKey]
  );

  const hasDraft = useCallback(
    (scopeId?: string | null) => !isDraftEmpty(readDraft(scopeId)),
    [readDraft]
  );

  const discardDraft = useCallback(
    (scopeId?: string | null, keep: ChatAttachment[] = []) => {
      const key = resolveKey(scopeId);
      const existing = draftsRef.current[key];
      if (existing) releasePreviews(existing.attachments, keep);
      setDrafts((current) => removeDraftEntry(current, key));
    },
    [resolveKey]
  );

  const migrateDraft = useCallback(
    (fromScopeId: string | null, toScopeId: string | null) => {
      const fromKey = draftKeyFor(fromScopeId, identityKeyRef.current);
      const toKey = draftKeyFor(toScopeId, identityKeyRef.current);
      if (fromKey === toKey) return;
      const moving = draftsRef.current[fromKey];
      if (!moving) return;
      // moveDraftEntry lets an existing target draft win, which means the
      // source is being dropped rather than moved -- so its previews go with
      // it. EMPTY_DRAFT's `keep` is the honest answer here: nothing survives.
      if (draftsRef.current[toKey]) {
        releasePreviews(moving.attachments, EMPTY_DRAFT.attachments);
      }
      setDrafts((current) => moveDraftEntry(current, fromKey, toKey));
    },
    []
  );

  return {
    activeDraftKey,
    draftText: activeDraft.text,
    draftAttachments: activeDraft.attachments,
    setDraftText,
    setDraftAttachments,
    readDraft,
    hasDraft,
    discardDraft,
    migrateDraft,
  };
}
