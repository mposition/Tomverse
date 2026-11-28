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
