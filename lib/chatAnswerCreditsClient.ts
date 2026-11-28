import { parseAnswerCreditsResponse } from "@/lib/chatAnswerCreditsCore";

/**
 * How long after an answer ends to ask what it was charged. Settlement runs as
 * the stream closes, so the first ask normally finds it; the later ones cover
 * a slow settlement and then give up. A reload shows the figure regardless.
 */
export const ANSWER_CREDIT_POLL_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000, 20_000];

/** The settled credits of these answers; null when the read did not succeed. */
export async function fetchAnswerCredits(
  conversationId: string,
  messageIds: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, number> | null> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/answer-credits?ids=${encodeURIComponent(messageIds.join(","))}`,
    { cache: "no-store", signal }
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return parseAnswerCreditsResponse(await response.json().catch(() => null));
}

const wait = (ms: number) => new Promise<void>((settle) => setTimeout(settle, ms));

/**
 * Asks after one finished answer's credits until settlement has written them,
 * then reports the figure once. An answer that is never charged (refunded, or
 * free) is simply never reported. Read-only: this only displays what the
 * server already settled. Returns a function that stops asking.
 */
export function watchAnswerCredits(input: {
  conversationId: string;
  messageId: string;
  onSettled: (credits: number) => void;
  delaysMs?: readonly number[];
  fetchCredits?: typeof fetchAnswerCredits;
  sleep?: (ms: number) => Promise<void>;
}): () => void {
  const {
    conversationId,
    messageId,
    onSettled,
    delaysMs = ANSWER_CREDIT_POLL_DELAYS_MS,
    fetchCredits = fetchAnswerCredits,
    sleep = wait,
  } = input;
  let stopped = false;
  const controller = new AbortController();
  void (async () => {
    for (const delay of delaysMs) {
      await sleep(delay);
      if (stopped) return;
      const credits = await fetchCredits(conversationId, [messageId], controller.signal).catch(
        () => null
      );
      if (stopped) return;
      const settled = credits?.get(messageId);
      if (settled !== undefined) {
        onSettled(settled);
        return;
      }
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}

/**
 * The conversation whose answer credits a panel may ask after, or null.
 *
 * Only a signed-in Chat panel on a saved conversation: those are the only
 * turns the server links to their answer, so anything else would ask a
 * question with no possible answer. A conversation without a server id (none
 * yet, or the guest placeholder) is not saved.
 */
export function answerCreditsConversationId(input: {
  transcriptScope?: "model" | "conversation";
  currentProduct?: string;
  isGuestMode: boolean;
  conversationId: string | null | undefined;
}): string | null {
  if (
    input.transcriptScope !== "conversation" ||
    input.currentProduct !== "chat" ||
    input.isGuestMode
  ) {
    return null;
  }
  const id = input.conversationId?.trim();
  return id && id !== "guest-chat" ? id : null;
}

/**
 * The credit watches one panel has running, so they stop with it.
 *
 * One watch per answer: asking again for an answer already being watched
 * keeps the first. A watch leaves the set once it reports, and `stopAll` ends
 * every one that has not -- the panel calls it when it unmounts or moves to
 * another conversation, so no ask outlives the screen it was for.
 */
export function createAnswerCreditWatches(
  watch: typeof watchAnswerCredits = watchAnswerCredits
) {
  const running = new Map<string, () => void>();
  return {
    follow(input: {
      conversationId: string;
      messageId: string;
      onSettled: (credits: number) => void;
    }): void {
      const key = `${input.conversationId}\0${input.messageId}`;
      if (running.has(key)) return;
      let reported = false;
      const stop = watch({
        conversationId: input.conversationId,
        messageId: input.messageId,
        onSettled: (credits) => {
          reported = true;
          running.delete(key);
          input.onSettled(credits);
        },
      });
      if (!reported) running.set(key, stop);
    },
    stopAll(): void {
      for (const stop of running.values()) stop();
      running.clear();
    },
    get size(): number {
      return running.size;
    },
  };
}
