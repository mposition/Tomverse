/**
 * When a broken Chat stream is handed to durable attempt polling instead of
 * ending as an error, and what the panel shows when it is.
 *
 * ## The failure this replaces
 *
 * A saved Chat turn has a durable attempt row the server checkpoints about
 * once a second (lib/chatDurableAttemptStream.ts), and the panel already knew
 * how to read it: a reload discovers active attempts and polls
 * `GET /api/products/chat/attempts/[assistantMessageId]` until each is
 * terminal. But that poller started only from a history load or a
 * `durable-attempt` reattach response. A stream that broke while the panel was
 * open -- a locked phone, an app switch, a network change, an idle timeout --
 * ended as a generic error with whatever text had arrived, even when the
 * server went on to finish the answer.
 *
 * Now the same breaks hand the turn to that poller, and the panel shows what
 * the server ends with: the completed answer, or the partial answer with the
 * same error the panel would have shown before.
 *
 * ## What is never handed over
 *
 * - A stop. The user ended the turn; polling it would argue with them.
 * - A failure the server classified and reported in the stream trailer. That
 *   turn is already terminal on the server, and its signed error report is
 *   worth more than a second read of the same failure.
 * - Anything that is not a durable stream: a Review panel, a guest, a
 *   response that never reached its headers. Those have no attempt to read,
 *   or none this panel may claim.
 *
 * A turn handed over is not ended because the user left the conversation: the
 * record waits on its runtime key for the next panel (see the hand-off below).
 *
 * Pure, so the decision can be tested without mounting the panel.
 */

import {
  classifyChatAbort,
  type ChatAbortCause,
  type ChatTimeoutErrorCode,
} from "@/lib/chatStreamLiveness";

/** The response header value that says this 200 stream has an attempt row. */
export const CHAT_DURABLE_STREAM_RESPONSE_MODE = "stream";

export type ChatStreamInterruption =
  /** The client's own liveness watchdog gave up on the stream. */
  | { kind: "timeout"; errorCode: ChatTimeoutErrorCode }
  /** The body read rejected with nothing the server signed in the trailer. */
  | { kind: "transport" };

export const isDurableChatStreamResponse = (input: {
  responseMode: string | null;
  transcriptScope: "model" | "conversation";
  isGuest: boolean;
  /** A Review panel's provider projection. Never durable on this path. */
  isReviewProjection: boolean;
  conversationId: string | null | undefined;
}): boolean =>
  input.responseMode === CHAT_DURABLE_STREAM_RESPONSE_MODE &&
  input.transcriptScope === "conversation" &&
  !input.isGuest &&
  !input.isReviewProjection &&
  Boolean(input.conversationId);

export const decideChatStreamReattach = (input: {
  durableStream: boolean;
  /** The run's controller was aborted. */
  aborted: boolean;
  /** Why, as recorded beside the controller (lib/chatStreamRuntime.ts). */
  abortCause: ChatAbortCause | null;
  /** The body read rejected (`consumeChatStream`'s `onInterrupted` fired). */
  streamReadFailed: boolean;
  /** That rejection followed a trailer carrying the server's error report. */
  serverReportedFailure: boolean;
}): ChatStreamInterruption | null => {
  if (!input.durableStream) return null;
  if (input.aborted) {
    // A stop, a stop-all, an identity switch and an abort nobody recorded
    // all classify as `cancelled` and stay exactly what they were.
    const outcome = classifyChatAbort(input.abortCause);
    return outcome.kind === "timeout"
      ? { kind: "timeout", errorCode: outcome.errorCode }
      : null;
  }
  if (input.streamReadFailed && !input.serverReportedFailure) {
    return { kind: "transport" };
  }
  return null;
};

/**
 * The text an interrupted turn keeps when it ends without an answer.
 *
 * The server's checkpoint can be ahead of the panel (it kept generating after
 * the connection broke) or up to a second behind it (the last chunks were
 * shown but not yet checkpointed). The panel never shows less than it already
 * showed.
 */
export const recoveredPartialText = (
  shown: string,
  checkpointed: string | null | undefined
): string =>
  typeof checkpointed === "string" && checkpointed.length > shown.length
    ? checkpointed
    : shown;

/**
 * Whether a poll of a still-active interrupted attempt may replace what the
 * panel shows. A checkpoint shorter than the text on screen would roll the
 * answer backwards for a second; it waits for the next one instead.
 */
export const shouldApplyPolledPartial = (
  shown: string,
  checkpointed: string
): boolean => checkpointed.length >= shown.length;

/* -------------------------------------------------------------------------- */
/* The hand-off                                                                */
/* -------------------------------------------------------------------------- */

/*
  Held per runtime key, beside the run rather than inside a panel, for the
  reason lib/chatStreamRuntime.ts holds the run there: both shells unmount
  every panel when the conversation changes, and a panel that remounts on the
  same key adopts the run that is already going. The first message of a new
  conversation is exactly that -- the stream is read by the closure of a panel
  that has since been replaced -- so a hand-off addressed to "this panel"
  would reach nobody.
*/

export type InterruptedChatAttempt = {
  assistantMessageId: string;
  conversationId: string;
  sourceUserMessageId: string;
  analyticsPromptId: string | null;
  /**
   * Ends the turn the way it ended before reattaching existed. Called once,
   * only when the attempt ends without an answer or nobody is left to poll it.
   */
  finish: (checkpointed: string | null) => void;
  /**
   * Called once when the poller shows the server's completed answer for this
   * turn instead, so the send that handed it off can record the turn as the
   * completion it became rather than the broken stream it handed off.
   */
  completed?: () => void;
};

const pendingByKey = new Map<string, Map<string, InterruptedChatAttempt>>();
const watchersByKey = new Map<string, Set<() => void>>();

/**
 * A panel showing `runtimeKey` that can poll attempts. Returns the
 * unsubscribe.
 *
 * Leaving the conversation does not end what was handed over. The server may
 * well finish the answer after the user has walked away, and ending the turn
 * as an error when the last panel unmounts froze that into the transcript
 * (the runtime outlives the panel, so coming back showed the error, not the
 * answer). The record stays on its key instead: the next panel mounted on the
 * key adopts it and polls, and a history read of the conversation settles it
 * the same way.
 */
export const watchInterruptedChatAttempts = (
  runtimeKey: string,
  onHandOff: () => void
): (() => void) => {
  const watchers = watchersByKey.get(runtimeKey) ?? new Set<() => void>();
  watchers.add(onHandOff);
  watchersByKey.set(runtimeKey, watchers);
  return () => {
    watchers.delete(onHandOff);
    if (watchers.size > 0) return;
    if (watchersByKey.get(runtimeKey) === watchers) watchersByKey.delete(runtimeKey);
  };
};

/**
 * Hands a broken stream to the key's attempt poller. Always accepted: with a
 * panel on the key it is told at once, and with none -- the user left the
 * conversation before the stream broke -- the record waits for the next panel
 * that mounts on the key. The caller's `finish` runs only when polling shows
 * the server ended the turn without an answer.
 */
export const handOffInterruptedChatAttempt = (
  runtimeKey: string,
  attempt: InterruptedChatAttempt
): boolean => {
  const pending = pendingByKey.get(runtimeKey) ?? new Map();
  pending.set(attempt.assistantMessageId, attempt);
  pendingByKey.set(runtimeKey, pending);
  for (const watcher of [...(watchersByKey.get(runtimeKey) ?? [])]) watcher();
  return true;
};

export const pendingInterruptedChatAttempts = (
  runtimeKey: string
): InterruptedChatAttempt[] => [...(pendingByKey.get(runtimeKey)?.values() ?? [])];

export const isInterruptedChatAttempt = (
  runtimeKey: string,
  assistantMessageId: string
): boolean => pendingByKey.get(runtimeKey)?.has(assistantMessageId) === true;

/** Removes the record and returns it; the caller decides whether to finish. */
export const settleInterruptedChatAttempt = (
  runtimeKey: string,
  assistantMessageId: string
): InterruptedChatAttempt | null => {
  const pending = pendingByKey.get(runtimeKey);
  const attempt = pending?.get(assistantMessageId) ?? null;
  if (!attempt) return null;
  pending!.delete(assistantMessageId);
  if (pending!.size === 0) pendingByKey.delete(runtimeKey);
  return attempt;
};

/**
 * Forgets the hand-offs of every identity but the one now in force. A record
 * can outlive its panel, so it must not outlive its account: nothing in this
 * tab may finish or poll another account's turn
 * (lib/chatStreamRuntime.ts `releaseChatRuntimeForOtherIdentities`).
 */
export const releaseInterruptedChatAttemptsForOtherIdentities = (
  identityKey: string
): void => {
  const identityOf = (key: string) => {
    const separator = key.indexOf("|");
    return separator === -1 ? key : key.slice(0, separator);
  };
  for (const key of [...pendingByKey.keys()]) {
    if (identityOf(key) !== identityKey) pendingByKey.delete(key);
  }
};

/** Tests only. */
export const resetInterruptedChatAttempts = () => {
  pendingByKey.clear();
  watchersByKey.clear();
};
