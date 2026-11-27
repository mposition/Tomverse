import "server-only";

import {
  CHAT_ATTEMPT_REVISION_CONFLICT,
  CHAT_RESPONSE_ATTEMPT_MAX_LEASE_MS,
  type ChatResponseAttemptRecord,
} from "@/lib/chatResponseAttemptCore";
import {
  ChatAttemptCasError,
  checkpointChatResponseAttempt,
} from "@/lib/chatResponseAttemptPersistence";

export const CHAT_DURABLE_PARTIAL_MAX_CHARACTERS = 100_000;
export const CHAT_DURABLE_CHECKPOINT_CHARACTER_STEP = 2_048;
export const CHAT_DURABLE_CHECKPOINT_INTERVAL_MS = 1_000;
/**
 * Renew the lease on its own when nothing has been written for this long.
 *
 * Checkpoints renew the lease, but they follow visible text. A model that
 * reasons for minutes before its first token (Fable 5.2 on three PDFs, 290 to
 * 516 s, 2026-11-21) outlived the claim's 4-minute lease, so the answer it
 * then streamed was refused at the terminal CAS (CHAT_ATTEMPT_REVISION_CONFLICT)
 * and the turn failed after the user had read it.
 */
export const CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS = 60_000;
const LEASE_RENEWAL_HEADROOM_MS = 15_000;

const durablePrefix = (content: string) =>
  content.slice(0, CHAT_DURABLE_PARTIAL_MAX_CHARACTERS);

/**
 * The row refused this writer: its lease is gone, another owner holds it, the
 * revision moved, or the user's stop made it terminal. That is the end of
 * this writer, surfaced at once. Anything else -- a dropped connection, a
 * pool timeout -- is transient: the checkpoint is tried again on the next
 * cycle, and the terminal flush writes the latest content regardless.
 */
const isAttemptRefusal = (error: unknown) =>
  error instanceof ChatAttemptCasError ||
  (error as { code?: unknown } | null)?.code === CHAT_ATTEMPT_REVISION_CONFLICT ||
  (error instanceof Error && error.message === "CHAT_ATTEMPT_CHECKPOINT_NOT_FOUND");

/**
 * Coalesces high-frequency stream chunks into serial CAS checkpoints. observe()
 * is called only after a chunk was enqueued to the browser. flush() is the
 * terminal barrier: the assistant Message cannot commit until the final
 * visible prefix has persisted under a fresh lease/owner CAS.
 *
 * A CAS refusal ends the writer and is thrown by the next flush. A transient
 * write failure is not latched: a single dropped connection mid-answer used to
 * fail the whole turn after the user had read it (AI_STREAM_FAILED, unsaved).
 * It is logged, the content stays pending, and the write is tried again one
 * interval later; flush writes the final content itself whatever an earlier
 * cycle managed. The 2026-11-21 lease invariant is untouched: every write
 * still carries a fresh lease, and the terminal flush is still the
 * authoritative owner/revision/lease CAS.
 */
export function createChatResponseAttemptCheckpointWriter(input: {
  userId: string;
  assistantMessageId: string;
  ownerId: string;
  initialRevision: number;
  requestedModelId: string;
}, persistCheckpoint: typeof checkpointChatResponseAttempt = checkpointChatResponseAttempt) {
  let revision = input.initialRevision;
  let persistedContent = "";
  let pendingContent: string | null = null;
  let running: Promise<void> | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let failure: unknown = null;
  /** After a transient failure, no checkpoint before this. */
  let retryAt = 0;
  let lastStartedAt = Date.now();
  let actualModelId: string | null = null;
  let provider: string | null = null;

  const scheduleAt = (at: number) => {
    if (scheduled) return;
    scheduled = setTimeout(pump, Math.max(0, at - Date.now()));
    scheduled.unref?.();
  };

  const pump = () => {
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    if (running || failure || pendingContent === null) return;
    let inFlight: string | null = null;
    running = (async () => {
      while (pendingContent !== null && !failure) {
        const next = pendingContent;
        pendingContent = null;
        if (next === persistedContent) continue;
        inFlight = next;
        lastStartedAt = Date.now();
        const updated = await persistCheckpoint({
          userId: input.userId,
          assistantMessageId: input.assistantMessageId,
          ownerId: input.ownerId,
          expectedRevision: revision,
          partialContent: next,
          actualModelId,
          provider,
          leaseExpiresAt: new Date(
            Date.now() + CHAT_RESPONSE_ATTEMPT_MAX_LEASE_MS - LEASE_RENEWAL_HEADROOM_MS
          ),
        });
        if (!updated) throw new Error("CHAT_ATTEMPT_CHECKPOINT_NOT_FOUND");
        revision = updated.checkpointRevision;
        persistedContent = updated.partialContent;
        inFlight = null;
      }
    })()
      .catch((error) => {
        if (isAttemptRefusal(error)) {
          failure = error;
          return;
        }
        // Not latched. Keep what did not land, unless newer content already
        // replaced it, and try again one interval from now.
        if (pendingContent === null && inFlight !== null) pendingContent = inFlight;
        retryAt = Date.now() + CHAT_DURABLE_CHECKPOINT_INTERVAL_MS;
        const named = error as { name?: unknown; code?: unknown } | null;
        console.warn(JSON.stringify({
          event: "chat_attempt_checkpoint_retry",
          assistantMessageId: input.assistantMessageId,
          name: typeof named?.name === "string" ? named.name : "Error",
          code: typeof named?.code === "string" ? named.code : null,
        }));
      })
      .finally(() => {
        running = null;
        if (pendingContent === null || failure) return;
        if (Date.now() < retryAt) scheduleAt(retryAt);
        else pump();
      });
  };

  /**
   * Renews the lease with the content already persisted, while no text is
   * arriving. Called from the first-token keepalive tick; a no-op until
   * CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS has passed since the last write,
   * and whenever a checkpoint is queued or running (which renews it anyway).
   *
   * A failed renewal is logged and left for the next tick, never turned into
   * the writer's failure: the terminal flush still performs the authoritative
   * owner/revision/lease CAS, and a turn short enough to need no renewal must
   * not fail on one.
   */
  const renewLease = () => {
    if (failure || running || pendingContent !== null) return;
    if (Date.now() - lastStartedAt < CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS) return;
    lastStartedAt = Date.now();
    running = (async () => {
      const updated = await persistCheckpoint({
        userId: input.userId,
        assistantMessageId: input.assistantMessageId,
        ownerId: input.ownerId,
        expectedRevision: revision,
        partialContent: persistedContent,
        actualModelId,
        provider,
        leaseExpiresAt: new Date(
          Date.now() + CHAT_RESPONSE_ATTEMPT_MAX_LEASE_MS - LEASE_RENEWAL_HEADROOM_MS
        ),
      });
      if (!updated) throw new Error("CHAT_ATTEMPT_CHECKPOINT_NOT_FOUND");
      revision = updated.checkpointRevision;
      persistedContent = updated.partialContent;
    })()
      .catch((error) => {
        const named = error as { name?: unknown; code?: unknown } | null;
        console.warn(JSON.stringify({
          event: "chat_attempt_lease_renewal_failed",
          assistantMessageId: input.assistantMessageId,
          name: typeof named?.name === "string" ? named.name : "Error",
          code: typeof named?.code === "string" ? named.code : null,
        }));
      })
      .finally(() => {
        running = null;
        if (pendingContent !== null && !failure) pump();
      });
  };

  const setAttribution = (nextModelId: string, nextProvider: string) => {
    actualModelId = nextModelId;
    provider = nextProvider;
  };

  const observe = (content: string) => {
    if (failure) return;
    const next = durablePrefix(content);
    // Never discard a prefix which was already visible to the browser. Small
    // chunks are coalesced, but they still become pending durable state and a
    // timer guarantees persistence even when no later chunk arrives.
    pendingContent = next;
    // A write just failed transiently: wait out the interval rather than
    // hammering a database that is struggling with one write per chunk.
    if (Date.now() < retryAt) {
      scheduleAt(retryAt);
      return;
    }
    if (
      next.length - persistedContent.length < CHAT_DURABLE_CHECKPOINT_CHARACTER_STEP &&
      Date.now() - lastStartedAt < CHAT_DURABLE_CHECKPOINT_INTERVAL_MS
    ) {
      scheduleAt(lastStartedAt + CHAT_DURABLE_CHECKPOINT_INTERVAL_MS);
      return;
    }
    pump();
  };

  const flush = async (content: string) => {
    if (failure) throw failure;
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    const revisionAtFlushStart = revision;
    const finalContent = durablePrefix(content);
    pendingContent = finalContent;
    pump();
    while (running) await running;
    if (failure) throw failure;
    // Anything still pending is the final content itself, written below.
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    pendingContent = null;
    // Even when no new characters arrived since the last coalesced write, the
    // terminal path needs a fresh owner/revision/DB-clock CAS. Otherwise an
    // expired writer whose final prefix already matched could skip persistence
    // entirely and continue into billing or Message side effects. And a final
    // prefix an earlier cycle failed to write is written here, directly: an
    // error now is the turn's.
    if (revision === revisionAtFlushStart || persistedContent !== finalContent) {
      const updated = await persistCheckpoint({
        userId: input.userId,
        assistantMessageId: input.assistantMessageId,
        ownerId: input.ownerId,
        expectedRevision: revision,
        partialContent: finalContent,
        actualModelId,
        provider,
        leaseExpiresAt: new Date(
          Date.now() + CHAT_RESPONSE_ATTEMPT_MAX_LEASE_MS - LEASE_RENEWAL_HEADROOM_MS
        ),
      });
      if (!updated) throw new Error("CHAT_ATTEMPT_CHECKPOINT_NOT_FOUND");
      revision = updated.checkpointRevision;
      persistedContent = updated.partialContent;
    }
    return { revision, partialContent: persistedContent, actualModelId, provider };
  };

  return { setAttribution, observe, flush, renewLease };
}

export type ChatResponseAttemptCheckpointWriter = ReturnType<
  typeof createChatResponseAttemptCheckpointWriter
>;

export const attemptTerminalContent = (record: Pick<ChatResponseAttemptRecord, "partialContent">) =>
  durablePrefix(record.partialContent);
