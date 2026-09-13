"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ChatAttachment } from "./types";
import {
  collectReleasablePreviewUrls,
  draftKeyFor,
  EMPTY_DRAFT,
  isDraftEmpty,
  isDraftKey,
  moveDraftEntry,
  NEW_CONVERSATION_DRAFT_SEGMENT,
  readDraftEntry,
  removeDraftEntry,
  resolveDraftUpdate,
  UNRESOLVED_IDENTITY_DRAFT_SEGMENT,
  writeDraftEntry,
  type ConversationDraft,
  type ConversationDraftStore,
  type DraftUpdate,
} from "@/lib/conversationDraftStore";
import {
  draftAttachmentReferences,
  parseChatDraftConflict,
  parseChatDraftResponse,
  sameDraftSnapshot,
  type PublicChatDraft,
} from "@/components/chat/chatDurableRecoveryClient";
import { discardResponseBody } from "@/lib/discardResponseBody";

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
  migrateDraft: (
    fromScopeId: string | null,
    toScopeId: string | null,
    owner?: DraftSendCapture | PreparedDraftSend
  ) => void;
  /** A stale writer was refused. Local input remains untouched. */
  draftConflict: boolean;
  /** Resolves a stale-writer conflict only after an explicit user choice. */
  resolveDraftConflict: (choice: "use-server" | "overwrite-local") => void;
  /** The active draft could not be loaded or saved durably. */
  draftSyncFailed: boolean;
  /** Retries hydration or persistence without discarding local input. */
  retryDraftSync: () => void;
  /** Captures the exact local intent synchronously, before preflight awaits. */
  captureDraftSend: (
    draft: ConversationDraft,
    scopeId?: string | null
  ) => DraftSendCapture;
  /**
   * Freezes and persists the exact composer snapshot that is about to be
   * sent. A null result means the server refused a stale revision or an
   * attachment has not acquired an opaque reference yet; no provider request
   * may be made in either case.
   */
  prepareDraftSend: (
    capture: DraftSendCapture
  ) => Promise<PreparedDraftSend | null>;
  /** The message transaction consumed this exact server revision. */
  commitDraftSend: (
    prepared: PreparedDraftSend,
    scopeId?: string | null,
    keep?: ChatAttachment[]
  ) => boolean;
  /** Re-opens a frozen draft after any pre-save refusal. */
  abortDraftSend: (prepared: PreparedDraftSend) => void;
  /**
   * Applies the read-only server receipt after an indeterminate Message POST.
   * `unchanged` proves the draft is still authoritative and editable;
   * `ambiguous` deliberately keeps it frozen until a reload can rehydrate a
   * complete server view.
   */
  reconcileDraftSend: (
    prepared: PreparedDraftSend,
    outcome: "unchanged" | "ambiguous"
  ) => void;
};

export type PreparedDraftSend = {
  readonly token: string;
  readonly key: string;
  readonly scopeKey: string;
  readonly revision: number;
  readonly generation: number;
  /** Identity/session generation that owns every asynchronous send callback. */
  readonly identityKey: string | null;
  readonly identityEpoch: number;
  /** Canonical snapshot persisted and submitted. */
  readonly draft: ConversationDraft;
  /** Composer bytes used only to detect edits made while the send was frozen. */
  readonly localDraft: ConversationDraft;
};

export type DraftSendCapture = Omit<PreparedDraftSend, "revision">;

type DraftSyncMeta = {
  scopeKey: string;
  revision: number;
  generation: number;
  persistedGeneration: number;
  hydrated: boolean;
  conflict: boolean;
  conflictDraft: PublicChatDraft | null;
  frozen: boolean;
  inFlight: Promise<void> | null;
  writeEpoch: number;
  identityKey: string | null;
  identityEpoch: number;
  requestAbort: AbortController | null;
  failureCount: number;
};

const DRAFT_SAVE_DEBOUNCE_MS = 350;
const serverScopeKey = (scopeId: string | null | undefined) => scopeId || "new";
const draftKeyIdentitySegment = (identityKey: string | null) =>
  `draft|${identityKey ?? UNRESOLVED_IDENTITY_DRAFT_SEGMENT}|`;
const draftKeyBelongsToIdentity = (key: string, identityKey: string | null) =>
  key.startsWith(draftKeyIdentitySegment(identityKey));
const serverScopeKeyForDraft = (
  scopeId: string | null | undefined,
  currentConversationId: string | null
) => {
  if (scopeId && isDraftKey(scopeId)) {
    const segment = scopeId.split("|").at(-1);
    return segment === NEW_CONVERSATION_DRAFT_SEGMENT
      ? "new"
      : serverScopeKey(segment);
  }
  return serverScopeKey(
    scopeId === undefined ? currentConversationId : scopeId
  );
};

const releasePreviews = (items: ChatAttachment[], keep: ChatAttachment[]) => {
  if (typeof window === "undefined") return;
  collectReleasablePreviewUrls(items, keep).forEach((url) => {
    URL.revokeObjectURL(url);
  });
};

/**
 * Composer drafts, one per conversation. Guest/Review/continuation callers
 * keep the original tab-memory behavior; authenticated stored Chat callers
 * additionally synchronize through the revision-CAS draft endpoint.
 *
 * The composer used to be a single `inputValue` shared by every conversation,
 * so opening another conversation from the sidebar carried the half-written
 * question along with it. Keying drafts by conversation id keeps each
 * conversation's unsent question (and its attachments) to itself; both shells
 * read this one store, so the desktop/mobile switch is not a draft boundary.
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
  identityKey: string | null,
  durableSyncEnabled = false
): ConversationDraftsApi {
  const [drafts, setDrafts] = useState<ConversationDraftStore>({});
  const [, setSyncRevision] = useState(0);
  const [conflictKeys, setConflictKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [syncFailureKeys, setSyncFailureKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [hydrateRetryRevision, setHydrateRetryRevision] = useState(0);
  const activeDraftKey = draftKeyFor(currentConversationId, identityKey);
  const activeScopeKey = serverScopeKey(currentConversationId);

  // Every writer resolves its target key through these refs rather than
  // through the render's closure: uploads, conversation-detail responses and
  // submit all finish after an await, by which point the user may be looking
  // at a different conversation.
  const draftsRef = useRef(drafts);
  const activeDraftKeyRef = useRef(activeDraftKey);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  const syncMetaRef = useRef(new Map<string, DraftSyncMeta>());
  // Ordinary edit debounce may finish after navigation so the text just left
  // on screen is not lost. Failure retries are different: policy binds them
  // to the still-active scope and cancels them on a conversation transition.
  const saveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const persistRetryTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  // A Message transaction may outlive one or more identity epochs. Keeping
  // this ownership outside `syncMetaRef` is deliberate: A -> B -> A creates
  // fresh reconciliation metadata, but it must not forget that A's exact
  // server draft is currently being atomically consumed. Otherwise a GET
  // which observes the post-commit null row schedules a revision-0 PUT and
  // resurrects the submitted question before the Message response arrives.
  const pendingConsumesRef = useRef(new Map<string, DraftSendCapture>());
  const hydrateTicketRef = useRef(0);
  const hydrateAbortRef = useRef<AbortController | null>(null);
  const hydrateRetryTimerRef = useRef<{
    key: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const persistKeyRef = useRef<(key: string) => Promise<boolean>>(async () => false);
  const identityKeyRef = useRef(identityKey);
  const identityFenceRef = useRef({ identityKey, epoch: 0 });

  const cancelPersistRetry = useCallback((key: string) => {
    const retry = persistRetryTimersRef.current.get(key);
    if (retry) clearTimeout(retry);
    persistRetryTimersRef.current.delete(key);
  }, []);

  useLayoutEffect(() => {
    const previousKey = activeDraftKeyRef.current;
    activeDraftKeyRef.current = activeDraftKey;
    if (previousKey === activeDraftKey) return;

    const hydrateRetry = hydrateRetryTimerRef.current;
    if (hydrateRetry?.key === previousKey) {
      clearTimeout(hydrateRetry.timer);
      hydrateRetryTimerRef.current = null;
    }
    cancelPersistRetry(previousKey);
  }, [activeDraftKey, cancelPersistRetry]);

  // A session change is a hard network-authority boundary. Draft keys already
  // keep the local bytes separate, but an old timer/promise would otherwise
  // run with the browser's *new* cookie. Advance the epoch before passive
  // effects, cancel every old request, and require all continuations to prove
  // that the identity which scheduled them still owns the tab.
  useLayoutEffect(() => {
    const current = identityFenceRef.current;
    identityKeyRef.current = identityKey;
    if (current.identityKey === identityKey) return;
    identityFenceRef.current = {
      identityKey,
      epoch: current.epoch + 1,
    };
    hydrateTicketRef.current += 1;
    hydrateAbortRef.current?.abort();
    hydrateAbortRef.current = null;
    if (hydrateRetryTimerRef.current) {
      clearTimeout(hydrateRetryTimerRef.current.timer);
    }
    hydrateRetryTimerRef.current = null;
    saveTimersRef.current.forEach((timer) => clearTimeout(timer));
    saveTimersRef.current.clear();
    persistRetryTimersRef.current.forEach((timer) => clearTimeout(timer));
    persistRetryTimersRef.current.clear();
    syncMetaRef.current.forEach((meta) => {
      meta.requestAbort?.abort();
    });
    // Do not rebind the same metadata objects to the new authority epoch.
    // Awaiting continuations retain those objects; keeping them in this map
    // would let an A -> B -> A transition make an old A continuation current
    // again. A returning identity gets fresh metadata and must reconcile.
    syncMetaRef.current = new Map();
    setConflictKeys(new Set());
    setSyncFailureKeys(new Set());
  }, [identityKey]);

  const identityFenceIsCurrent = useCallback(
    (expectedIdentityKey: string | null, expectedEpoch: number) => {
      const current = identityFenceRef.current;
      return current.identityKey === expectedIdentityKey &&
        current.epoch === expectedEpoch;
    },
    []
  );

  const bumpSyncRevision = useCallback(() => {
    setSyncRevision((revision) => revision + 1);
  }, []);

  const metaFor = useCallback((key: string, scopeKey: string) => {
    const fence = identityFenceRef.current;
    const belongsToCurrentIdentity = draftKeyBelongsToIdentity(
      key,
      fence.identityKey
    );
    const current = syncMetaRef.current.get(key);
    if (current && current.identityKey === fence.identityKey &&
        current.identityEpoch === fence.epoch) {
      current.scopeKey = scopeKey;
      return current;
    }
    current?.requestAbort?.abort();
    const hasLocalDraft = Object.prototype.hasOwnProperty.call(
      draftsRef.current,
      key
    );
    const created: DraftSyncMeta = {
      scopeKey,
      revision: 0,
      generation: hasLocalDraft ? 1 : 0,
      persistedGeneration: 0,
      hydrated: false,
      conflict: false,
      conflictDraft: null,
      frozen: false,
      inFlight: null,
      writeEpoch: 0,
      identityKey: belongsToCurrentIdentity ? fence.identityKey : null,
      identityEpoch: belongsToCurrentIdentity ? fence.epoch : -1,
      requestAbort: null,
      failureCount: 0,
    };
    syncMetaRef.current.set(key, created);
    return created;
  }, []);

  const replaceDrafts = useCallback((next: ConversationDraftStore) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const setConflict = useCallback((key: string, conflicted: boolean) => {
    setConflictKeys((current) => {
      if (current.has(key) === conflicted) return current;
      const next = new Set(current);
      if (conflicted) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const setSyncFailure = useCallback((key: string, failed: boolean) => {
    setSyncFailureKeys((current) => {
      if (current.has(key) === failed) return current;
      const next = new Set(current);
      if (failed) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const applyConflict = useCallback(
    (
      key: string,
      meta: DraftSyncMeta,
      body: unknown,
      expectedIdentityKey = meta.identityKey,
      expectedIdentityEpoch = meta.identityEpoch
    ) => {
      if (!identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch) ||
          syncMetaRef.current.get(key) !== meta ||
          meta.identityKey !== expectedIdentityKey ||
          meta.identityEpoch !== expectedIdentityEpoch) return;
      const payload = parseChatDraftConflict(body, meta.scopeKey);
      if (!payload) return false;
      const { currentDraft, currentRevision } = payload;
      meta.revision = currentRevision;
      meta.conflict = true;
      meta.conflictDraft = currentDraft;
      meta.hydrated = true;
      meta.frozen = false;
      // A well-formed 409 is a successful server response carrying the
      // authoritative CAS state, not a continuing transport failure. Stop any
      // pending backoff and let the conflict UI be the sole required action.
      cancelPersistRetry(key);
      meta.failureCount = 0;
      setSyncFailure(key, false);
      setConflict(key, true);
      bumpSyncRevision();
      return true;
    },
    [
      bumpSyncRevision,
      cancelPersistRetry,
      identityFenceIsCurrent,
      setConflict,
      setSyncFailure,
    ]
  );

  const persistKey = useCallback(async (
    key: string,
    exact?: ConversationDraft,
    exactGeneration?: number
  ) => {
    if (!durableSyncEnabled) return true;
    const meta = syncMetaRef.current.get(key);
    if (!meta) return true;
    const expectedIdentityKey = meta.identityKey;
    const expectedIdentityEpoch = meta.identityEpoch;
    const operationIsCurrent = () =>
      identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch) &&
      syncMetaRef.current.get(key) === meta &&
      meta.identityKey === expectedIdentityKey &&
      meta.identityEpoch === expectedIdentityEpoch;
    if (!operationIsCurrent()) return false;
    const previous = meta.inFlight;
    meta.writeEpoch += 1;
    let succeeded = false;
    let shouldRetry = false;
    const operation = (async () => {
      if (previous) await previous;
      if (!operationIsCurrent()) return;
      // A queued autosave may discover a 409 while an exact send is waiting.
      // The send must re-check after that wait; an exact body is not authority
      // to bypass a conflict the user has not resolved.
      if (meta.conflict) return;
      if (exactGeneration !== undefined && meta.generation !== exactGeneration) {
        return;
      }
      const snapshot = exact ?? readDraftEntry(draftsRef.current, key);
      const references = draftAttachmentReferences(snapshot.attachments);
      // A file still being uploaded has no stable server reference. Keep the
      // whole local snapshot and let the upload completion schedule the write.
      if (!references) return;
      const controller = new AbortController();
      meta.requestAbort?.abort();
      meta.requestAbort = controller;
      try {
        if (isDraftEmpty(snapshot)) {
          if (meta.revision === 0) {
            if (!operationIsCurrent()) return;
            meta.persistedGeneration = meta.generation;
            meta.hydrated = true;
            meta.failureCount = 0;
            cancelPersistRetry(key);
            setSyncFailure(key, false);
            succeeded = true;
            return;
          }
          const response = await fetch(
            `/api/products/chat/drafts/${encodeURIComponent(meta.scopeKey)}`,
            {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expectedRevision: meta.revision }),
              signal: controller.signal,
            }
          );
          if (!operationIsCurrent() || controller.signal.aborted) {
            await discardResponseBody(response);
            return;
          }
          if (response.status === 409) {
            const payload = await response.json().catch(() => null);
            if (!operationIsCurrent() || controller.signal.aborted) return;
            if (!applyConflict(
              key,
              meta,
              payload,
              expectedIdentityKey,
              expectedIdentityEpoch
            )) shouldRetry = true;
            return;
          }
          await discardResponseBody(response);
          if (response.status !== 204) {
            shouldRetry = true;
            return;
          }
          if (!operationIsCurrent()) return;
          meta.revision = 0;
          meta.persistedGeneration = meta.generation;
          meta.hydrated = true;
          meta.conflict = false;
          meta.conflictDraft = null;
          cancelPersistRetry(key);
          setConflict(key, false);
          setSyncFailure(key, false);
          meta.failureCount = 0;
          succeeded = true;
          return;
        }
        const generation = exactGeneration ?? meta.generation;
        const expectedRevision = meta.revision;
        const response = await fetch(
          `/api/products/chat/drafts/${encodeURIComponent(meta.scopeKey)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRevision,
              text: snapshot.text,
              attachmentReferences: references,
            }),
            signal: controller.signal,
          }
        );
        if (!operationIsCurrent() || controller.signal.aborted) {
          await discardResponseBody(response);
          return;
        }
        if (response.status === 409) {
          const payload = await response.json().catch(() => null);
          if (!operationIsCurrent() || controller.signal.aborted) return;
          if (!applyConflict(
            key,
            meta,
            payload,
            expectedIdentityKey,
            expectedIdentityEpoch
          )) shouldRetry = true;
          return;
        }
        if (!response.ok) {
          await discardResponseBody(response);
          shouldRetry = true;
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!operationIsCurrent() || controller.signal.aborted) return;
        const parsedResponse = parseChatDraftResponse(payload, meta.scopeKey);
        const saved = parsedResponse?.draft;
        if (!saved || saved.revision !== expectedRevision + 1 ||
            !sameDraftSnapshot(snapshot, saved)) {
          shouldRetry = true;
          return;
        }
        meta.revision = saved.revision;
        meta.persistedGeneration = generation;
        meta.hydrated = true;
        meta.conflict = false;
        meta.conflictDraft = null;
        cancelPersistRetry(key);
        setConflict(key, false);
        setSyncFailure(key, false);
        meta.failureCount = 0;
        succeeded = true;
      } catch (error) {
        // Network failure keeps the local draft authoritative in this tab. A
        // later edit or explicit send tries again; nothing is discarded.
        if ((error as { name?: string })?.name !== "AbortError") {
          shouldRetry = true;
        }
      } finally {
        if (meta.requestAbort === controller) meta.requestAbort = null;
        if (shouldRetry && operationIsCurrent() && !meta.conflict && !meta.frozen) {
          setSyncFailure(key, true);
          meta.failureCount += 1;
          // A request may fail after its conversation has already been left.
          // Preserve visible failure state for a later visit, but navigation
          // has cancelled its automatic retry and must not be undone by this
          // late continuation.
          if (activeDraftKeyRef.current === key) {
            const priorRetry = persistRetryTimersRef.current.get(key);
            if (priorRetry) clearTimeout(priorRetry);
            const retryDelay = Math.min(
              30_000,
              1_000 * 2 ** Math.min(meta.failureCount - 1, 5)
            );
            const retry = setTimeout(() => {
              persistRetryTimersRef.current.delete(key);
              if (activeDraftKeyRef.current === key && operationIsCurrent() &&
                  !meta.conflict && !meta.frozen) {
                void persistKeyRef.current(key);
              }
            }, retryDelay);
            persistRetryTimersRef.current.set(key, retry);
          }
        }
        if (operationIsCurrent()) bumpSyncRevision();
      }
    })();
    meta.inFlight = operation;
    bumpSyncRevision();
    await operation;
    if (meta.inFlight === operation) meta.inFlight = null;
    if (operationIsCurrent()) bumpSyncRevision();
    return operationIsCurrent() && succeeded && !meta.conflict;
  }, [
    applyConflict,
    bumpSyncRevision,
    cancelPersistRetry,
    durableSyncEnabled,
    identityFenceIsCurrent,
    setConflict,
    setSyncFailure,
  ]);

  useEffect(() => {
    persistKeyRef.current = persistKey;
  }, [persistKey]);

  const scheduleSave = useCallback((key: string) => {
    if (!durableSyncEnabled) return;
    if (pendingConsumesRef.current.has(key)) return;
    const meta = syncMetaRef.current.get(key);
    if (!meta || !meta.hydrated || meta.frozen || meta.conflict ||
        !identityFenceIsCurrent(meta.identityKey, meta.identityEpoch)) return;
    const expectedIdentityKey = meta.identityKey;
    const expectedIdentityEpoch = meta.identityEpoch;
    // A new edit supersedes the snapshot owned by an older failure backoff.
    // If this debounce also fails it installs a fresh exponential retry.
    cancelPersistRetry(key);
    const prior = saveTimersRef.current.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(key);
      if (!identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch) ||
          syncMetaRef.current.get(key) !== meta ||
          meta.identityKey !== expectedIdentityKey ||
          meta.identityEpoch !== expectedIdentityEpoch) return;
      void persistKey(key);
    }, DRAFT_SAVE_DEBOUNCE_MS);
    saveTimersRef.current.set(key, timer);
  }, [cancelPersistRetry, durableSyncEnabled, identityFenceIsCurrent, persistKey]);

  useEffect(() => {
    if (!durableSyncEnabled || !identityKey?.startsWith("account:")) {
      hydrateAbortRef.current?.abort();
      return;
    }
    const key = activeDraftKey;
    const meta = metaFor(key, activeScopeKey);
    if (meta.hydrated) return;
    const expectedIdentityKey = identityKey;
    const expectedIdentityEpoch = identityFenceRef.current.epoch;
    if (!identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch)) return;
    const ticket = ++hydrateTicketRef.current;
    const generationAtStart = meta.generation;
    const localDirtyAtStart = meta.generation > meta.persistedGeneration;
    const writeEpochAtStart = meta.writeEpoch;
    const controller = new AbortController();
    hydrateAbortRef.current?.abort();
    hydrateAbortRef.current = controller;

    void (async () => {
      try {
        const response = await fetch(
          `/api/products/chat/drafts/${encodeURIComponent(activeScopeKey)}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!response.ok) {
          await discardResponseBody(response);
          throw new Error("CHAT_DRAFT_HYDRATE_FAILED");
        }
        const payload = await response.json().catch(() => null);
        if (controller.signal.aborted || ticket !== hydrateTicketRef.current ||
            !identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch) ||
            meta.identityKey !== expectedIdentityKey ||
            meta.identityEpoch !== expectedIdentityEpoch) return;
        const parsedResponse = parseChatDraftResponse(payload, activeScopeKey);
        if (!parsedResponse) {
          throw new Error("CHAT_DRAFT_HYDRATE_INVALID");
        }
        const remote = parsedResponse.draft;
        // A PUT/DELETE that started after this GET owns newer ordering
        // information. In particular, never let a late GET erase its 409.
        if (meta.writeEpoch !== writeEpochAtStart || meta.conflict) return;
        meta.hydrated = true;
        meta.failureCount = 0;
        setSyncFailure(key, false);
        if (pendingConsumesRef.current.has(key)) {
          // Preserve the captured local bytes while the Message transaction
          // owns them. A null row here means consume may already have
          // committed; it is not permission to recreate revision zero.
          meta.revision = remote?.revision ?? 0;
          meta.frozen = true;
          if (remote && sameDraftSnapshot(
            readDraftEntry(draftsRef.current, key),
            remote
          )) {
            meta.persistedGeneration = meta.generation;
          }
          return;
        }
        if (meta.generation === generationAtStart && !localDirtyAtStart) {
          meta.revision = remote?.revision ?? 0;
          meta.conflict = false;
          meta.conflictDraft = null;
          const current = draftsRef.current;
          const next = remote
            ? writeDraftEntry(current, key, () => ({
                text: remote.text,
                attachments: remote.attachments,
              }))
            : removeDraftEntry(current, key);
          replaceDrafts(next);
          meta.persistedGeneration = meta.generation;
        } else if (!remote) {
          // A locally edited empty server scope is the only late-hydrate case
          // that may become a revision-0 create without asking the user.
          meta.revision = 0;
          scheduleSave(key);
        } else {
          const local = readDraftEntry(draftsRef.current, key);
          meta.revision = remote.revision;
          if (sameDraftSnapshot(local, remote)) {
            meta.persistedGeneration = meta.generation;
          } else {
            // Both sides contain work. Adopt only the CAS revision and latch a
            // conflict; local bytes stay in the composer until an explicit
            // server/local choice.
            applyConflict(key, meta, {
              code: "CHAT_DRAFT_REVISION_CONFLICT",
              currentRevision: remote.revision,
              currentDraft: remote,
            });
          }
        }
      } catch (error) {
        if ((error as { name?: string })?.name !== "AbortError") {
          setSyncFailure(key, true);
          meta.failureCount += 1;
          if (hydrateRetryTimerRef.current) {
            clearTimeout(hydrateRetryTimerRef.current.timer);
          }
          const retryDelay = Math.min(
            30_000,
            1_000 * 2 ** Math.min(meta.failureCount - 1, 5)
          );
          const retryTimer = setTimeout(() => {
            if (hydrateRetryTimerRef.current?.timer === retryTimer) {
              hydrateRetryTimerRef.current = null;
            }
            if (
              activeDraftKeyRef.current === key &&
              identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch) &&
              syncMetaRef.current.get(key) === meta &&
              !meta.hydrated
            ) {
              setHydrateRetryRevision((revision) => revision + 1);
            }
          }, retryDelay);
          hydrateRetryTimerRef.current = { key, timer: retryTimer };
        }
      } finally {
        if (ticket === hydrateTicketRef.current &&
            identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch)) {
          bumpSyncRevision();
        }
      }
    })();
    return () => controller.abort();
  }, [
    activeDraftKey,
    activeScopeKey,
    applyConflict,
    bumpSyncRevision,
    durableSyncEnabled,
    identityKey,
    identityFenceIsCurrent,
    hydrateRetryRevision,
    metaFor,
    replaceDrafts,
    scheduleSave,
    setSyncFailure,
  ]);

  useLayoutEffect(
    () => () => {
      const current = identityFenceRef.current;
      identityFenceRef.current = {
        identityKey: current.identityKey,
        epoch: current.epoch + 1,
      };
      hydrateTicketRef.current += 1;
      hydrateAbortRef.current?.abort();
      hydrateAbortRef.current = null;
      if (hydrateRetryTimerRef.current) {
        clearTimeout(hydrateRetryTimerRef.current.timer);
      }
      hydrateRetryTimerRef.current = null;
      saveTimersRef.current.forEach((timer) => clearTimeout(timer));
      saveTimersRef.current.clear();
      persistRetryTimersRef.current.forEach((timer) => clearTimeout(timer));
      persistRetryTimersRef.current.clear();
      syncMetaRef.current.forEach((meta) => {
        meta.requestAbort?.abort();
      });
      syncMetaRef.current = new Map();
    },
    []
  );

  const activeDraft = readDraftEntry(drafts, activeDraftKey);

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
      const scopeKey = serverScopeKeyForDraft(scopeId, currentConversationId);
      const current = draftsRef.current;
      const next = writeDraftEntry(current, key, (existing) => ({
          ...existing,
          text: resolveDraftUpdate(update, existing.text),
        }));
      if (next === current) return;
      replaceDrafts(next);
      const meta = metaFor(key, scopeKey);
      meta.generation += 1;
      // A local edit after a 409 is still made against stale knowledge. Keep
      // the words in this tab, but neither clear the conflict nor issue a PUT
      // until the user explicitly chooses which draft should win.
      scheduleSave(key);
      bumpSyncRevision();
    },
    [bumpSyncRevision, currentConversationId, metaFor, replaceDrafts, resolveKey, scheduleSave]
  );

  const setDraftAttachments = useCallback(
    (update: DraftUpdate<ChatAttachment[]>, scopeId?: string | null) => {
      const key = resolveKey(scopeId);
      const scopeKey = serverScopeKeyForDraft(scopeId, currentConversationId);
      const current = draftsRef.current;
      const next = writeDraftEntry(current, key, (existing) => ({
          ...existing,
          attachments: resolveDraftUpdate(update, existing.attachments),
        }));
      if (next === current) return;
      replaceDrafts(next);
      const meta = metaFor(key, scopeKey);
      meta.generation += 1;
      // See setDraftText: attachments are part of the same stale snapshot.
      scheduleSave(key);
      bumpSyncRevision();
    },
    [bumpSyncRevision, currentConversationId, metaFor, replaceDrafts, resolveKey, scheduleSave]
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
      replaceDrafts(removeDraftEntry(draftsRef.current, key));
      const meta = metaFor(
        key,
        serverScopeKeyForDraft(scopeId, currentConversationId)
      );
      meta.generation += 1;
      meta.frozen = false;
      scheduleSave(key);
    },
    [currentConversationId, metaFor, replaceDrafts, resolveKey, scheduleSave]
  );

  const migrateDraft = useCallback(
    (
      fromScopeId: string | null,
      toScopeId: string | null,
      owner?: DraftSendCapture | PreparedDraftSend
    ) => {
      const expectedIdentityKey = owner?.identityKey ?? identityFenceRef.current.identityKey;
      const expectedIdentityEpoch = owner?.identityEpoch ?? identityFenceRef.current.epoch;
      if (!identityFenceIsCurrent(expectedIdentityKey, expectedIdentityEpoch)) return;
      const fromKey = draftKeyFor(fromScopeId, expectedIdentityKey);
      const toKey = draftKeyFor(toScopeId, expectedIdentityKey);
      if (fromKey === toKey) return;
      const moving = draftsRef.current[fromKey];
      if (!moving) return;
      // moveDraftEntry lets an existing target draft win, which means the
      // source is being dropped rather than moved -- so its previews go with
      // it. EMPTY_DRAFT's `keep` is the honest answer here: nothing survives.
      if (draftsRef.current[toKey]) {
        releasePreviews(moving.attachments, EMPTY_DRAFT.attachments);
      }
      replaceDrafts(moveDraftEntry(draftsRef.current, fromKey, toKey));
      if (!durableSyncEnabled) return;

      const fromMeta = metaFor(fromKey, serverScopeKey(fromScopeId));
      const toMeta = metaFor(toKey, serverScopeKey(toScopeId));
      toMeta.generation = Math.max(toMeta.generation, fromMeta.generation);
      toMeta.persistedGeneration = 0;
      toMeta.hydrated = true;
      toMeta.revision = 0;
      toMeta.frozen = false;
      toMeta.conflict = false;
      toMeta.conflictDraft = null;
      const sourceTimer = saveTimersRef.current.get(fromKey);
      if (sourceTimer) clearTimeout(sourceTimer);
      saveTimersRef.current.delete(fromKey);
      cancelPersistRetry(fromKey);
      syncMetaRef.current.delete(fromKey);
      setConflict(fromKey, false);
      setConflict(toKey, false);
      // The message transaction has already consumed the source server row.
      // Migration is local-only; any next-turn edits now create revision 0 in
      // the adopted conversation rather than copying then best-effort deleting
      // the submitted draft (which could resurrect after a network failure).
      if (!isDraftEmpty(readDraftEntry(draftsRef.current, toKey))) {
        scheduleSave(toKey);
      }
      bumpSyncRevision();
    },
    [
      bumpSyncRevision,
      cancelPersistRetry,
      durableSyncEnabled,
      identityFenceIsCurrent,
      metaFor,
      replaceDrafts,
      scheduleSave,
      setConflict,
    ]
  );

  const captureDraftSend = useCallback(
    (draft: ConversationDraft, scopeId?: string | null): DraftSendCapture => {
      const key = resolveKey(scopeId);
      const meta = metaFor(
        key,
        serverScopeKeyForDraft(scopeId, currentConversationId)
      );
      const localDraft = readDraftEntry(draftsRef.current, key);
      const fence = identityFenceRef.current;
      return {
        token: crypto.randomUUID(),
        key,
        scopeKey: meta.scopeKey,
        generation: meta.generation,
        identityKey: fence.identityKey,
        identityEpoch: fence.epoch,
        draft: { text: draft.text, attachments: [...draft.attachments] },
        localDraft: {
          text: localDraft.text,
          attachments: [...localDraft.attachments],
        },
      };
    },
    [currentConversationId, metaFor, resolveKey]
  );

  const prepareDraftSend = useCallback(
    async (capture: DraftSendCapture) => {
      if (!durableSyncEnabled) {
        return {
          ...capture,
          revision: 0,
        };
      }
      const key = capture.key;
      const releasePendingConsume = () => {
        if (pendingConsumesRef.current.get(key)?.token === capture.token) {
          pendingConsumesRef.current.delete(key);
        }
      };
      const meta = syncMetaRef.current.get(key);
      const captureIsCurrent = () =>
        identityFenceIsCurrent(capture.identityKey, capture.identityEpoch) &&
        syncMetaRef.current.get(key) === meta &&
        meta?.scopeKey === capture.scopeKey &&
        meta.identityKey === capture.identityKey &&
        meta.identityEpoch === capture.identityEpoch;
      if (!meta || !captureIsCurrent()) return null;
      pendingConsumesRef.current.set(key, capture);
      const timer = saveTimersRef.current.get(key);
      if (timer) clearTimeout(timer);
      saveTimersRef.current.delete(key);
      cancelPersistRetry(key);
      // Finish any write which started before the click/preflight. Its 409 or
      // the user's newer generation must be observed before an exact snapshot
      // can be frozen; otherwise this send can silently overwrite the next
      // draft and then consume it.
      const previous = meta.inFlight;
      if (previous) await previous;
      // A detached epoch owns no current state. In particular, it must not
      // unfreeze or schedule a writer on metadata created after A -> B -> A.
      if (!captureIsCurrent()) {
        releasePendingConsume();
        return null;
      }
      if (meta.generation !== capture.generation) {
        releasePendingConsume();
        meta.frozen = false;
        scheduleSave(key);
        return null;
      }
      // A 409 discovered by autosave must first be surfaced. The next explicit
      // send (after the user has seen it) may use the latest revision.
      if (meta.conflict) {
        releasePendingConsume();
        meta.frozen = false;
        return null;
      }
      meta.frozen = true;
      const ok = await persistKey(key, capture.draft, capture.generation);
      if (!captureIsCurrent()) {
        releasePendingConsume();
        return null;
      }
      if (meta.generation !== capture.generation || !ok || meta.conflict ||
          meta.revision < 1) {
        releasePendingConsume();
        meta.frozen = false;
        scheduleSave(key);
        return null;
      }
      return {
        ...capture,
        revision: meta.revision,
      };
    },
    [
      cancelPersistRetry,
      durableSyncEnabled,
      identityFenceIsCurrent,
      persistKey,
      scheduleSave,
    ]
  );

  const commitDraftSend = useCallback(
    (
      prepared: PreparedDraftSend,
      scopeId?: string | null,
      keep: ChatAttachment[] = []
    ) => {
      const key = prepared.key;
      if (pendingConsumesRef.current.get(key)?.token === prepared.token) {
        pendingConsumesRef.current.delete(key);
      }
      const meta = syncMetaRef.current.get(key);
      const preparedEpochIsCurrent = identityFenceIsCurrent(
        prepared.identityKey,
        prepared.identityEpoch
      );
      if (!preparedEpochIsCurrent) {
        // The Message transaction has already consumed A's server row even
        // when its response arrives while B owns the tab. Record only that
        // local fact against the captured A key; never navigate, fetch, save,
        // or mutate metadata belonging to the current identity/epoch.
        const staleCurrent = readDraftEntry(draftsRef.current, key);
        const submittedStillCurrent = sameDraftSnapshot(
          staleCurrent,
          prepared.localDraft
        );
        // The successful transaction is authoritative: retaining the exact
        // consumed A row would resurrect it on A's next visit. A genuinely
        // newer A snapshot still differs and is preserved.
        if (submittedStillCurrent) {
          releasePreviews(staleCurrent.attachments, keep);
          replaceDrafts(removeDraftEntry(draftsRef.current, key));
          setConflict(key, false);
        }
        // A may have returned while its Message response was pending. Its
        // fresh epoch metadata was intentionally frozen by hydration; finish
        // the local consume against that object without letting an old
        // continuation mutate any detached metadata.
        const currentFence = identityFenceRef.current;
        const freshMeta = syncMetaRef.current.get(key);
        if (currentFence.identityKey === prepared.identityKey && freshMeta &&
            freshMeta.identityKey === currentFence.identityKey &&
            freshMeta.identityEpoch === currentFence.epoch) {
          const timer = saveTimersRef.current.get(key);
          if (timer) clearTimeout(timer);
          saveTimersRef.current.delete(key);
          cancelPersistRetry(key);
          freshMeta.requestAbort?.abort();
          freshMeta.requestAbort = null;
          freshMeta.inFlight = null;
          freshMeta.revision = 0;
          freshMeta.conflict = false;
          freshMeta.conflictDraft = null;
          freshMeta.frozen = false;
          freshMeta.hydrated = true;
          freshMeta.generation += 1;
          if (submittedStillCurrent) {
            freshMeta.persistedGeneration = freshMeta.generation;
          } else {
            freshMeta.persistedGeneration = 0;
            scheduleSave(key);
          }
          bumpSyncRevision();
        }
        return false;
      }
      if (!meta || meta.scopeKey !== prepared.scopeKey ||
          meta.identityKey !== prepared.identityKey ||
          meta.identityEpoch !== prepared.identityEpoch) return false;
      meta.revision = 0;
      meta.persistedGeneration = 0;
      meta.conflict = false;
      meta.conflictDraft = null;
      setConflict(key, false);
      meta.frozen = false;
      const current = readDraftEntry(draftsRef.current, key);
      const submittedStillCurrent = sameDraftSnapshot(current, prepared.localDraft);
      if (submittedStillCurrent) {
        releasePreviews(current.attachments, keep);
        replaceDrafts(removeDraftEntry(draftsRef.current, key));
        meta.generation += 1;
        meta.persistedGeneration = meta.generation;
      } else {
        // Only genuinely newer input survives as a fresh revision-0 draft.
        // A model/conversation change cannot preserve the exact submitted
        // snapshot after the server has atomically consumed it.
        meta.generation += 1;
        scheduleSave(key);
      }
      bumpSyncRevision();
      return submittedStillCurrent;
    },
    [
      bumpSyncRevision,
      cancelPersistRetry,
      identityFenceIsCurrent,
      replaceDrafts,
      scheduleSave,
      setConflict,
    ]
  );

  const abortDraftSend = useCallback((prepared: PreparedDraftSend) => {
    if (pendingConsumesRef.current.get(prepared.key)?.token === prepared.token) {
      pendingConsumesRef.current.delete(prepared.key);
    }
    const meta = syncMetaRef.current.get(prepared.key);
    if (!meta || meta.scopeKey !== prepared.scopeKey ||
        meta.revision !== prepared.revision ||
        !identityFenceIsCurrent(prepared.identityKey, prepared.identityEpoch) ||
        meta.identityKey !== prepared.identityKey ||
        meta.identityEpoch !== prepared.identityEpoch) return;
    meta.frozen = false;
    scheduleSave(prepared.key);
    bumpSyncRevision();
  }, [bumpSyncRevision, identityFenceIsCurrent, scheduleSave]);

  const reconcileDraftSend = useCallback((
    prepared: PreparedDraftSend,
    outcome: "unchanged" | "ambiguous"
  ) => {
    const pending = pendingConsumesRef.current.get(prepared.key);
    if (pending?.token !== prepared.token) return;
    if (outcome === "unchanged") {
      pendingConsumesRef.current.delete(prepared.key);
    }

    // An A receipt may resolve while B owns the tab, or after A has returned
    // under a fresh epoch. Never mutate the detached object captured by the
    // old continuation. Only the metadata currently bound to A may be
    // reconciled; otherwise A's next hydrate observes the server directly.
    const fence = identityFenceRef.current;
    const meta = syncMetaRef.current.get(prepared.key);
    if (fence.identityKey !== prepared.identityKey || !meta ||
        meta.identityKey !== fence.identityKey ||
        meta.identityEpoch !== fence.epoch ||
        meta.scopeKey !== prepared.scopeKey) {
      return;
    }
    meta.frozen = outcome === "ambiguous";
    if (outcome === "unchanged") {
      meta.revision = prepared.revision;
      meta.hydrated = true;
      meta.conflict = false;
      meta.conflictDraft = null;
      setConflict(prepared.key, false);
      const current = readDraftEntry(draftsRef.current, prepared.key);
      if (sameDraftSnapshot(current, prepared.localDraft)) {
        meta.persistedGeneration = meta.generation;
      }
    }
    bumpSyncRevision();
  }, [bumpSyncRevision, setConflict]);

  const resolveDraftConflict = useCallback(
    (choice: "use-server" | "overwrite-local") => {
      const key = activeDraftKeyRef.current;
      const meta = syncMetaRef.current.get(key);
      if (!meta?.conflict) return;
      if (choice === "use-server") {
        const current = readDraftEntry(draftsRef.current, key);
        const remote = meta.conflictDraft;
        const next = remote
          ? writeDraftEntry(draftsRef.current, key, () => ({
              text: remote.text,
              attachments: remote.attachments,
            }))
          : removeDraftEntry(draftsRef.current, key);
        releasePreviews(current.attachments, remote?.attachments ?? []);
        replaceDrafts(next);
        meta.generation += 1;
        meta.persistedGeneration = meta.generation;
        meta.hydrated = true;
      }
      // `applyConflict` recorded the server's latest revision. Only this
      // explicit overwrite choice is allowed to use it as the next CAS base.
      meta.conflict = false;
      meta.conflictDraft = null;
      setConflict(key, false);
      if (choice === "overwrite-local") scheduleSave(key);
      bumpSyncRevision();
    },
    [bumpSyncRevision, replaceDrafts, scheduleSave, setConflict]
  );

  const retryDraftSync = useCallback(() => {
    const key = activeDraftKeyRef.current;
    const meta = syncMetaRef.current.get(key);
    if (!meta || !identityFenceIsCurrent(meta.identityKey, meta.identityEpoch)) return;
    const prior = saveTimersRef.current.get(key);
    if (prior) clearTimeout(prior);
    saveTimersRef.current.delete(key);
    cancelPersistRetry(key);
    if (hydrateRetryTimerRef.current?.key === key) {
      clearTimeout(hydrateRetryTimerRef.current.timer);
      hydrateRetryTimerRef.current = null;
    }
    meta.failureCount = 0;
    setSyncFailure(key, false);
    if (!meta.hydrated) {
      setHydrateRetryRevision((revision) => revision + 1);
      return;
    }
    void persistKey(key);
  }, [cancelPersistRetry, identityFenceIsCurrent, persistKey, setSyncFailure]);

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
    draftConflict: conflictKeys.has(activeDraftKey),
    resolveDraftConflict,
    draftSyncFailed: syncFailureKeys.has(activeDraftKey),
    retryDraftSync,
    captureDraftSend,
    prepareDraftSend,
    commitDraftSend,
    abortDraftSend,
    reconcileDraftSend,
  };
}
