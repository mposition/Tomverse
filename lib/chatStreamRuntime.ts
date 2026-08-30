import type { ChatAttachment, Message } from "@/components/chat/types";
import type { ChatAbortCause } from "@/lib/chatStreamLiveness";
import type { WebSearchToggleMode } from "@/lib/appDefaults";

/**
 * Where a comparison panel's transcript and its in-flight request actually
 * live.
 *
 * Both shells key their model panels by the open conversation
 * (`${currentChatId}:panel:${index}`), so switching conversations unmounts
 * every `ChatApp` and mounts a fresh set. That was fine while a panel's state
 * was disposable, and it was not: the streamed answer accumulated in the
 * panel's own `useState`, and `app/api/chat/route.ts` only persists the
 * assistant message once the stream *finishes*. Leaving a conversation
 * mid-answer therefore threw the partial answer away with the component --
 * the request kept running (nothing aborts it on unmount) and kept spending
 * the user's credits, but coming back showed an empty panel with no way to
 * tell whether it was still generating, finished, or stopped.
 *
 * So the transcript and the run are held here, outside React, keyed by
 * **(identity, conversation, model)**:
 *
 *  * *identity* -- a guest browser and a signed-in account are different
 *    namespaces (docs/policy/chat-concurrency-and-identity.md §5), and one
 *    account's transcript must never be readable as another's;
 *  * *conversation* -- the unit the user switches between, and the only scope
 *    in which "is something running" is a meaningful question;
 *  * *model* -- three panels stream at once and each owns its own answer.
 *
 * A panel that remounts on the same key adopts what is already there: the
 * partial text, whether a run is still in flight, and the `AbortController`
 * that stops it. Nothing is aborted or discarded because the user navigated;
 * navigation is not a decision about the request.
 *
 * This module holds mutable module-level state, which is only ever correct
 * because every writer is a browser event: `getChatRuntimeServerSnapshot()`
 * returns a frozen constant and mutates nothing, so a server render can never
 * observe or populate it.
 */

/**
 * Separator between the three parts of a key. A pipe cannot occur in an
 * identity key (`guest` / `account:<cuid>`), a conversation id (cuid, or
 * `guest_<timestamp>`) or a model id (`provider/model-name`).
 */
const KEY_SEPARATOR = "|";

/**
 * How many keys are retained before the least recently used ones are dropped.
 * A long session compares three models across many conversations, and a
 * transcript nobody is looking at is only worth keeping while it is cheap.
 * Streaming keys, loading keys and keys a mounted panel is subscribed to are
 * never evicted.
 */
const MAX_RETAINED_KEYS = 48;

export type ChatRuntimeIdentity =
  | { kind: "guest" }
  | { kind: "account"; userId: string | null };

/**
 * The identity half of a runtime key. `account` with no user id is the window
 * before the session resolves; it gets its own namespace rather than sharing
 * the guest one, and nothing is ever loaded into it (ChatApp's loader waits
 * for a resolved identity).
 */
export function chatRuntimeIdentityKey(identity: ChatRuntimeIdentity): string {
  if (identity.kind === "guest") return "guest";
  return identity.userId ? `account:${identity.userId}` : "account";
}

export function chatRuntimeKey(input: {
  identityKey: string;
  conversationId: string | null;
  modelId: string;
}): string {
  return [
    input.identityKey,
    input.conversationId || "new",
    input.modelId,
  ].join(KEY_SEPARATOR);
}

/** The identity a runtime key belongs to, for namespace-scoped clean-up. */
export function chatRuntimeKeyIdentity(key: string): string {
  const separator = key.indexOf(KEY_SEPARATOR);
  return separator === -1 ? key : key.slice(0, separator);
}

/** What a subscribed panel renders. Replaced wholesale on every change. */
export type ChatRuntimeSnapshot = {
  /** This key's transcript, including any answer still streaming into it. */
  messages: Message[];
  /** True once `messages` describes this exact key -- not a previous view. */
  isLoaded: boolean;
  /** A request, stream or deep-research poll this key owns is in flight. */
  isStreaming: boolean;
};

export type ChatRuntimeLastPrompt = {
  text: string;
  targetChatId: string;
  attachments: ChatAttachment[];
  /**
   * The one-shot web-search mode this send carried, when it carried one.
   *
   * Recorded so the panel's own "retry" repeats the request that was made
   * rather than a differently-configured one. A send from the web-search offer
   * searches without changing the conversation's stored switch, so without
   * this the retry button silently sends the same question with search off --
   * and the user, who pressed retry on a searching answer, would have no way
   * to tell why the second attempt came back without sources.
   *
   * Absent on every composer send, which reads the conversation's mode as
   * before.
   */
  webSearchMode?: WebSearchToggleMode;
};

const EMPTY_MESSAGES = Object.freeze([]) as unknown as Message[];

/**
 * The snapshot of a key nothing has touched. A frozen singleton so
 * `useSyncExternalStore` sees a stable value for an unvisited key, on the
 * server as well as in the browser.
 */
export const EMPTY_CHAT_RUNTIME_SNAPSHOT: ChatRuntimeSnapshot = Object.freeze({
  messages: EMPTY_MESSAGES,
  isLoaded: false,
  isStreaming: false,
});

type ChatRuntimeRecord = {
  snapshot: ChatRuntimeSnapshot;
  listeners: Set<() => void>;
  /** Stops the run this key owns. Null when nothing is in flight. */
  controller: AbortController | null;
  /**
   * Why this key's run was aborted, or null while it is live.
   *
   * The controller lives here rather than in a panel ref, so the reason has
   * to live here too: `AbortError` is the same exception whether the user
   * pressed stop or a liveness deadline expired, and the panel that catches
   * it has no other way to tell them apart
   * (lib/chatStreamLiveness.ts). Reset by `beginChatRuntimeRun`, so a retry
   * never inherits the previous run's reason.
   */
  abortCause: ChatAbortCause | null;
  /** Newest load ticket; only the newest may settle the view. */
  loadRequestId: number;
  /** True while a history load for this key is running (across remounts). */
  isLoading: boolean;
  /** Bumped whenever a send advances this transcript locally. */
  revision: number;
  lastPrompt: ChatRuntimeLastPrompt | null;
  /** Deep-research jobs this key already re-attached to, so it polls once. */
  resumedJobIds: Set<string>;
  touchedAt: number;
};

const records = new Map<string, ChatRuntimeRecord>();

const notify = (record: ChatRuntimeRecord) => {
  for (const listener of record.listeners) listener();
};

const evictIfNeeded = () => {
  if (records.size <= MAX_RETAINED_KEYS) return;
  const evictable = [...records.entries()]
    .filter(
      ([, record]) =>
        !record.snapshot.isStreaming &&
        !record.isLoading &&
        record.listeners.size === 0
    )
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
  let excess = records.size - MAX_RETAINED_KEYS;
  for (const [key] of evictable) {
    if (excess <= 0) break;
    records.delete(key);
    excess -= 1;
  }
};

const ensureRecord = (key: string): ChatRuntimeRecord => {
  const existing = records.get(key);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const created: ChatRuntimeRecord = {
    snapshot: EMPTY_CHAT_RUNTIME_SNAPSHOT,
    listeners: new Set(),
    controller: null,
    abortCause: null,
    loadRequestId: 0,
    isLoading: false,
    revision: 0,
    lastPrompt: null,
    resumedJobIds: new Set(),
    touchedAt: Date.now(),
  };
  records.set(key, created);
  evictIfNeeded();
  return created;
};

const patchSnapshot = (key: string, patch: Partial<ChatRuntimeSnapshot>): void => {
  const record = ensureRecord(key);
  const next: ChatRuntimeSnapshot = { ...record.snapshot, ...patch };
  if (
    next.messages === record.snapshot.messages &&
    next.isLoaded === record.snapshot.isLoaded &&
    next.isStreaming === record.snapshot.isStreaming
  ) {
    return;
  }
  record.snapshot = next;
  notify(record);
};

/* -------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------- */

/** Never creates a record: a render must not have side effects. */
export function getChatRuntimeSnapshot(key: string): ChatRuntimeSnapshot {
  return records.get(key)?.snapshot ?? EMPTY_CHAT_RUNTIME_SNAPSHOT;
}

/** Nothing is ever running during a server render. */
export function getChatRuntimeServerSnapshot(): ChatRuntimeSnapshot {
  return EMPTY_CHAT_RUNTIME_SNAPSHOT;
}

export function subscribeChatRuntime(
  key: string,
  listener: () => void
): () => void {
  const record = ensureRecord(key);
  record.listeners.add(listener);
  return () => {
    record.listeners.delete(listener);
  };
}

export function isChatRuntimeStreaming(key: string): boolean {
  return records.get(key)?.snapshot.isStreaming ?? false;
}

export function getChatRuntimeRevision(key: string): number {
  return records.get(key)?.revision ?? 0;
}

export function getChatRuntimeLastPrompt(
  key: string
): ChatRuntimeLastPrompt | null {
  return records.get(key)?.lastPrompt ?? null;
}

/* -------------------------------------------------------------------------
 * Transcript
 * ---------------------------------------------------------------------- */

export type ChatRuntimeMessagesUpdate =
  | Message[]
  | ((current: Message[]) => Message[]);

export function writeChatRuntimeMessages(
  key: string,
  update: ChatRuntimeMessagesUpdate
): void {
  const record = ensureRecord(key);
  const next =
    typeof update === "function" ? update(record.snapshot.messages) : update;
  patchSnapshot(key, { messages: next });
}

/**
 * Marks this key's transcript as locally advanced.
 *
 * A history load that was already in flight when a send started describes the
 * conversation as it was *before* that send, so it must not be applied
 * afterwards. The counter outlives the panel that started the send, which is
 * what makes the check survive a conversation switch and back.
 */
export function advanceChatRuntimeRevision(key: string): number {
  const record = ensureRecord(key);
  record.revision += 1;
  return record.revision;
}

export function setChatRuntimeLastPrompt(
  key: string,
  prompt: ChatRuntimeLastPrompt | null
): void {
  ensureRecord(key).lastPrompt = prompt;
}

/* -------------------------------------------------------------------------
 * Loading a view
 * ---------------------------------------------------------------------- */

/**
 * Whether this key's transcript is this session's own rather than a view of
 * the server's.
 *
 * A key that is streaming, or that a send has already advanced, must not be
 * re-loaded: re-reading it would either overwrite an answer still arriving, or
 * replace a just-finished answer with a server copy written before it landed.
 * That is the difference between coming back to a conversation and seeing the
 * answer exactly once, and seeing it flicker back to the question that
 * produced it.
 */
export function ownsChatRuntimeTranscript(key: string): boolean {
  const record = records.get(key);
  if (!record) return false;
  if (!record.snapshot.isLoaded) return false;
  return record.snapshot.isStreaming || record.revision > 0;
}

export function isChatRuntimeLoadInFlight(key: string): boolean {
  return records.get(key)?.isLoading ?? false;
}

/** Claims the newest load ticket for this key. */
export function claimChatRuntimeLoad(key: string): number {
  const record = ensureRecord(key);
  record.loadRequestId += 1;
  record.isLoading = true;
  return record.loadRequestId;
}

export function isCurrentChatRuntimeLoad(
  key: string,
  requestId: number
): boolean {
  return records.get(key)?.loadRequestId === requestId;
}

/**
 * Settles a load. Only the newest ticket may settle, so a superseded load
 * neither marks the view loaded nor releases the in-flight flag.
 */
export function settleChatRuntimeLoad(
  key: string,
  requestId: number,
  outcome: { loaded: boolean }
): void {
  const record = records.get(key);
  if (!record || record.loadRequestId !== requestId) return;
  record.isLoading = false;
  patchSnapshot(key, { isLoaded: outcome.loaded });
}

/**
 * Releases the claim without settling the view, so a later re-run may retry.
 * Used when a load failed: pinning the key to a failed load would leave the
 * panel showing its loading placeholder for good.
 */
export function releaseChatRuntimeLoad(key: string, requestId: number): void {
  const record = records.get(key);
  if (!record || record.loadRequestId !== requestId) return;
  record.isLoading = false;
}

/* -------------------------------------------------------------------------
 * A run
 * ---------------------------------------------------------------------- */

/**
 * Opens a run for this key and returns the controller that stops it. The
 * controller is held here rather than in a panel ref so the stop button of a
 * panel that remounted later still aborts the run that is actually going.
 */
export function beginChatRuntimeRun(key: string): AbortController {
  const record = ensureRecord(key);
  const controller = new AbortController();
  record.controller = controller;
  // A fresh run, so a fresh reason. Carrying the previous one over would let
  // a retry that the user simply let finish report itself as stopped.
  record.abortCause = null;
  patchSnapshot(key, { isStreaming: true });
  return controller;
}

/**
 * Closes a run. Idempotent, and deliberately ignores a controller that is no
 * longer this key's: a retry that started while the previous run was settling
 * owns the key now, and must not be marked finished by its predecessor.
 */
export function endChatRuntimeRun(
  key: string,
  controller: AbortController
): void {
  const record = records.get(key);
  if (!record) return;
  if (record.controller !== controller) return;
  record.controller = null;
  patchSnapshot(key, { isStreaming: false });
}

/**
 * Stops this key's run, if any, and records why.
 *
 * Safe to call when nothing is running, when the run already finished, and
 * repeatedly -- `AbortController.abort()` on a settled controller is a no-op.
 *
 * The cause is required rather than optional. Every abort in this app has a
 * reason, and the failure this parameter exists to prevent is a new call site
 * quietly reverting to the state where a liveness deadline and the stop
 * button were indistinguishable. The first cause wins: the stop button and a
 * watchdog can race, and what ended the run is whichever got there first.
 */
export function abortChatRuntime(key: string, cause: ChatAbortCause): void {
  const record = records.get(key);
  if (!record?.controller) return;
  record.abortCause ??= cause;
  record.controller.abort();
}

/**
 * Stops a run only while it is still the one this key owns.
 *
 * For an aborter that belongs to one particular run -- a liveness watchdog --
 * rather than to the panel. A superseded run's watchdog firing must not kill
 * the retry that replaced it, which is the same rule `endChatRuntimeRun`
 * applies to finishing.
 */
export function abortChatRuntimeRun(
  key: string,
  controller: AbortController,
  cause: ChatAbortCause
): void {
  const record = records.get(key);
  if (!record || record.controller !== controller) return;
  record.abortCause ??= cause;
  controller.abort();
}

/**
 * Why this run was aborted, or null.
 *
 * Scoped to the controller for the reason above: a run that has already been
 * replaced is not the one asking, and answering with the current run's cause
 * would attribute one request's ending to another. Null classifies as a stop
 * (lib/chatStreamLiveness.ts), which is the conservative direction.
 */
export function getChatRuntimeAbortCause(
  key: string,
  controller: AbortController
): ChatAbortCause | null {
  const record = records.get(key);
  if (!record || record.controller !== controller) return null;
  return record.abortCause;
}

export function hasResumedChatRuntimeJob(key: string, jobId: string): boolean {
  return records.get(key)?.resumedJobIds.has(jobId) ?? false;
}

export function markChatRuntimeJobResumed(key: string, jobId: string): void {
  ensureRecord(key).resumedJobIds.add(jobId);
}

/* -------------------------------------------------------------------------
 * Identity clean-up
 * ---------------------------------------------------------------------- */

/**
 * Drops everything that does not belong to the identity now in force.
 *
 * Signing in, signing out and switching accounts each move the tab into a new
 * namespace (docs/policy/chat-concurrency-and-identity.md §5). Runs started
 * under the previous identity are aborted here because nothing in this tab may
 * still be writing another account's answer into memory -- the request was
 * authorized under the identity that issued it, and abandoning it client-side
 * cannot make it un-happen server-side.
 *
 * Guest transcripts in localStorage are untouched: the import modal still
 * needs them.
 */
export function releaseChatRuntimeForOtherIdentities(identityKey: string): void {
  for (const [key, record] of [...records]) {
    if (chatRuntimeKeyIdentity(key) === identityKey) continue;
    record.abortCause ??= "identity_released";
    record.controller?.abort();
    record.controller = null;
    records.delete(key);
  }
}

/** Test-only: drops every key, aborting anything still running. */
export function resetChatStreamRuntime(): void {
  for (const record of records.values()) {
    record.abortCause ??= "identity_released";
    record.controller?.abort();
  }
  records.clear();
}
