/**
 * Carries a provider's reasoning summary from the AI SDK stream into the Chat
 * response stream (lib/chatReasoningDisplay.ts is the wire format).
 *
 * ## Why a relay and not a different stream
 *
 * The Chat route reads `result.textStream` -- visible text only -- and a whole
 * settlement, fallback and durable-checkpoint machine is built on that one
 * reader. Reasoning parts never reach it. They do reach `onChunk`, which sees
 * every stream part and which the route already uses to count provider
 * activity, so this listens there and leaves the text path exactly as it was.
 * The switch off means no relay is built, no request option is added and no
 * chunk is written: the response is byte-for-byte what it was.
 *
 * ## What it does not do
 *
 * It does not decide whether the model reasons, or how much. The request
 * option that asks a provider for summaries lives in
 * lib/modelGenerationCompatibility.ts and is added only to a model that
 * already reasons; the summary changes what is returned, not what is billed.
 * It does not touch usage, credits or the answer text.
 */

import {
  CHAT_REASONING_MAX_CHARACTERS,
  buildChatReasoningChunk,
  storedChatReasoning,
  type ChatReasoningSignal,
  type StoredChatReasoning,
} from "@/lib/chatReasoningDisplay";

/** Default OFF: only the exact string `true` turns reasoning display on. */
export const chatReasoningDisplayEnabled = (
  env: Record<string, string | undefined> = process.env
): boolean => env.CHAT_REASONING_DISPLAY_ENABLED === "true";

export type ChatReasoningRelay = ReturnType<typeof createChatReasoningRelay>;

/** Gap between summary chunks on the wire; deltas inside it are coalesced. */
const DEFAULT_FLUSH_INTERVAL_MS = 150;
const BLOCK_SEPARATOR = "\n\n";

export function createChatReasoningRelay(options?: {
  now?: () => number;
  flushIntervalMs?: number;
}) {
  const now = options?.now ?? Date.now;
  const flushIntervalMs = options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  /** Returns false once the response stream can no longer take a chunk. */
  let sink: ((chunk: string) => boolean) | null = null;
  let stopped = false;
  let generation = 0;

  let text = "";
  let truncated = false;
  let pending = "";
  let signalPending = false;
  let started = false;
  let blockOpenAt: number | null = null;
  let elapsedMs = 0;
  let textStarted = false;
  let doneSentAtMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  /**
   * Chunks decided on but not yet accepted by the response stream. The
   * provider can report a reasoning block before the stream exists, and the
   * order of what is written (text, then "done") has to survive the wait.
   */
  const outbox: string[] = [];
  let deliveredAny = false;

  const totalMs = () => elapsedMs + (blockOpenAt === null ? 0 : now() - blockOpenAt);

  const drain = () => {
    if (!sink || stopped) return;
    while (outbox.length > 0) {
      if (!sink(outbox.shift()!)) {
        stopped = true;
        outbox.length = 0;
        return;
      }
      deliveredAny = true;
    }
  };

  const send = (signal: ChatReasoningSignal) => {
    if (stopped) return;
    outbox.push(buildChatReasoningChunk(signal));
    drain();
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (stopped || (!pending && !signalPending)) return;
    send({ state: "thinking", ...(pending ? { text: pending } : {}) });
    pending = "";
    signalPending = false;
    lastFlushAt = now();
  };

  const schedule = () => {
    if (timer || stopped) return;
    const wait = Math.max(0, lastFlushAt + flushIntervalMs - now());
    if (wait === 0) {
      flush();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, wait);
    timer.unref?.();
  };

  const openBlock = () => {
    if (blockOpenAt !== null) return;
    blockOpenAt = now();
    started = true;
    if (text) {
      // A second block (a later step of a tool loop) reads as a new paragraph.
      const room = CHAT_REASONING_MAX_CHARACTERS - text.length;
      if (room >= BLOCK_SEPARATOR.length) {
        text += BLOCK_SEPARATOR;
        pending += BLOCK_SEPARATOR;
      }
    }
    // The signal alone is worth sending: a model that reasons without sending
    // a summary still shows "Thinking".
    signalPending = true;
    doneSentAtMs = null;
    schedule();
  };

  const closeBlock = () => {
    if (blockOpenAt === null) return;
    elapsedMs += now() - blockOpenAt;
    blockOpenAt = null;
  };

  const sendDone = () => {
    if (!started) return;
    closeBlock();
    flush();
    const duration = Math.round(totalMs());
    if (doneSentAtMs === duration) return;
    doneSentAtMs = duration;
    send({ state: "done", durationMs: duration });
  };

  const append = (delta: string) => {
    const clean = delta.replaceAll(String.fromCharCode(0), "");
    if (!clean) return;
    const room = CHAT_REASONING_MAX_CHARACTERS - text.length;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const kept = clean.length > room ? clean.slice(0, room) : clean;
    if (kept.length < clean.length) truncated = true;
    text += kept;
    pending += kept;
    schedule();
  };

  /** A fallback model took over before anything visible: start over. */
  const startOver = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // What was queued for the displaced attempt never reached anyone.
    outbox.length = 0;
    const hadSent = deliveredAny;
    deliveredAny = false;
    text = "";
    truncated = false;
    pending = "";
    signalPending = false;
    started = false;
    blockOpenAt = null;
    elapsedMs = 0;
    textStarted = false;
    doneSentAtMs = null;
    // Only a browser that was shown the displaced summary needs telling.
    if (hadSent) send({ state: "reset" });
  };

  const handle = (event: { chunk: unknown }) => {
    const chunk = event.chunk as { type?: unknown; text?: unknown } | null;
    switch (chunk?.type) {
      case "reasoning-start":
        openBlock();
        return;
      case "reasoning-delta":
        // Some providers send a delta without a start.
        openBlock();
        if (typeof chunk.text === "string") append(chunk.text);
        return;
      case "reasoning-end":
        closeBlock();
        flush();
        return;
      case "text-delta":
        // The first visible text ends the thinking the user is watching. A
        // later reasoning block (between tool steps) is folded in silently
        // and the total is restated when the turn ends.
        if (!textStarted && typeof chunk.text === "string" && chunk.text) {
          textStarted = true;
          sendDone();
        }
        return;
      default:
    }
  };

  return {
    /**
     * An observer for one provider attempt. Starting another attempt makes
     * every earlier observer a no-op, so a displaced attempt's late parts
     * cannot write into the answer that replaced it, and starts the summary
     * over: what the displaced model thought is not what its replacement
     * thinks.
     */
    attempt() {
      if (generation > 0) startOver();
      generation += 1;
      const mine = generation;
      return (event: { chunk: unknown }) => {
        if (mine === generation && !stopped) handle(event);
      };
    },
    /** Where chunks go. Attached once the response stream exists. */
    setSink(next: (chunk: string) => boolean) {
      sink = next;
      flush();
      drain();
    },
    /** The provider stream ended: write what is left and the final time. */
    finish() {
      sendDone();
    },
    /** Stops all writing. Safe to call more than once. */
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stopped = true;
    },
    /** What to keep with the saved answer, or null when the model never reasoned. */
    snapshot(): StoredChatReasoning | null {
      if (!started) return null;
      return storedChatReasoning({
        text,
        durationMs: Math.round(totalMs()),
        truncated,
      });
    },
  };
}
