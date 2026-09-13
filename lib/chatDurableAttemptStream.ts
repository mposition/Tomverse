import "server-only";

import {
  CHAT_RESPONSE_ATTEMPT_MAX_LEASE_MS,
  type ChatResponseAttemptRecord,
} from "@/lib/chatResponseAttemptCore";
import { checkpointChatResponseAttempt } from "@/lib/chatResponseAttemptPersistence";

export const CHAT_DURABLE_PARTIAL_MAX_CHARACTERS = 100_000;
export const CHAT_DURABLE_CHECKPOINT_CHARACTER_STEP = 2_048;
export const CHAT_DURABLE_CHECKPOINT_INTERVAL_MS = 1_000;
const LEASE_RENEWAL_HEADROOM_MS = 15_000;

const durablePrefix = (content: string) =>
  content.slice(0, CHAT_DURABLE_PARTIAL_MAX_CHARACTERS);

/**
 * Coalesces high-frequency stream chunks into serial CAS checkpoints. observe()
 * is called only after a chunk was enqueued to the browser. flush() is the
 * terminal barrier: the assistant Message cannot commit until every earlier
 * visible prefix has either persisted or failed its lease/owner CAS.
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
  let lastStartedAt = Date.now();
  let actualModelId: string | null = null;
  let provider: string | null = null;

  const pump = () => {
    if (scheduled) {
      clearTimeout(scheduled);
      scheduled = null;
    }
    if (running || failure || pendingContent === null) return;
    running = (async () => {
      while (pendingContent !== null && !failure) {
        const next = pendingContent;
        pendingContent = null;
        if (next === persistedContent) continue;
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
      }
    })()
      .catch((error) => {
        failure = error;
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
    if (
      next.length - persistedContent.length < CHAT_DURABLE_CHECKPOINT_CHARACTER_STEP &&
      Date.now() - lastStartedAt < CHAT_DURABLE_CHECKPOINT_INTERVAL_MS
    ) {
      if (!scheduled) {
        const remaining = Math.max(
          0,
          CHAT_DURABLE_CHECKPOINT_INTERVAL_MS - (Date.now() - lastStartedAt)
        );
        scheduled = setTimeout(pump, remaining);
        scheduled.unref?.();
      }
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
    pendingContent = durablePrefix(content);
    pump();
    while (running) await running;
    if (failure) throw failure;
    // Even when no new characters arrived since the last coalesced write, the
    // terminal path needs a fresh owner/revision/DB-clock CAS. Otherwise an
    // expired writer whose final prefix already matched could skip persistence
    // entirely and continue into billing or Message side effects.
    if (revision === revisionAtFlushStart) {
      const updated = await persistCheckpoint({
        userId: input.userId,
        assistantMessageId: input.assistantMessageId,
        ownerId: input.ownerId,
        expectedRevision: revision,
        partialContent: durablePrefix(content),
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

  return { setAttribution, observe, flush };
}

export type ChatResponseAttemptCheckpointWriter = ReturnType<
  typeof createChatResponseAttemptCheckpointWriter
>;

export const attemptTerminalContent = (record: Pick<ChatResponseAttemptRecord, "partialContent">) =>
  durablePrefix(record.partialContent);
