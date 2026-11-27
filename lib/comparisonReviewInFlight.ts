/**
 * One account AI Review run at a time per input, shared by the route that
 * enforces it and the clients that wait on it.
 *
 * `POST /api/conversations/:id/comparison-reviews` writes its ComparisonReview
 * row only after the reviewers finish (tens of seconds, minutes at worst), so
 * without a claim a second POST for the same input in that window -- a second
 * tab, a retry after a dropped stream, Studio and the Classic dialog both
 * asked -- ran and billed the whole review again. The route now holds a
 * `(user, input hash)` claim for the run and answers a duplicate with
 * `409 DUPLICATE_REQUEST`; the client then waits for the saved result through
 * the read-only GET instead of running anything.
 *
 * This module is client-safe: no server-only imports.
 */

/**
 * How long a claim lives when the process holding it dies before its
 * `finally` can release it.
 *
 * Derived from the run's worst case in lib/comparisonReviewService.ts: each
 * reviewer request is aborted at 45 s, a non-timeout failure is retried once
 * (2 x 45 s = 90 s per candidate), and the sequential path can try every
 * candidate for the primary review and every other one for the secondary
 * ((2N - 1) x 90 s). With the default three-reviewer panel that is 450 s.
 * Fifteen minutes is twice that, and still covers a five-reviewer panel
 * (810 s). The cost of a crashed holder is that this one review cannot be
 * re-run for at most this long; nothing is charged meanwhile.
 *
 * tests/server-contract/comparison-review-run-claim.test.ts recomputes the
 * bound from the default panel, so growing it past this TTL fails a test.
 */
export const COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS = 15 * 60;

/**
 * Pauses between saved-result lookups while another run of the same review
 * finishes. Front-loaded for the common 20-135 s run, then one lookup every
 * 10 s: about 90 reads over a full TTL, inside the GET's 20/minute limit.
 */
export const COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS = [2_000, 3_000, 5_000, 5_000, 10_000] as const;

/** The route's answer to a second POST while the same input is still running. */
export const isComparisonReviewAlreadyRunning = (status: number, body: unknown) =>
  status === 409 &&
  typeof body === "object" &&
  body !== null &&
  (body as { code?: unknown }).code === "DUPLICATE_REQUEST";

/**
 * The read-only GET that returns the saved result of one exact turn.
 *
 * The exact ids matter: the GET otherwise looks the saved result up by the
 * conversation's *latest* turn, and the run being waited on may have started
 * before another answer finished.
 */
export const storedComparisonReviewPath = (
  conversationId: string,
  input: {
    reviewMode: string;
    includeSynthesis: boolean;
    promptMessageId: string;
    assistantMessageIds: readonly string[];
  }
) =>
  `/api/conversations/${conversationId}/comparison-reviews?${new URLSearchParams({
    reviewMode: input.reviewMode,
    includeSynthesis: String(input.includeSynthesis),
    promptMessageId: input.promptMessageId,
    assistantMessageIds: input.assistantMessageIds.join(","),
  })}`;

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Looks the saved result up until it appears, the deadline passes or the
 * caller aborts. Never POSTs: the run being waited on is somebody else's, and
 * the server would refuse a second one anyway.
 *
 * `lookup` resolves to the saved review, or `undefined` while there is none
 * yet (a transient failure is also `undefined`); it throws to stop waiting for
 * good, e.g. the conversation is gone or locked. Resolves to `null` on
 * deadline or abort.
 */
export async function waitForStoredComparisonReview<Review>({
  lookup,
  signal,
  deadlineMs = COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS * 1000,
  delaysMs = COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS,
  now = () => Date.now(),
  sleep = pause,
}: {
  lookup: () => Promise<Review | undefined>;
  signal?: AbortSignal;
  deadlineMs?: number;
  delaysMs?: readonly number[];
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<Review | null> {
  const stopAt = now() + deadlineMs;
  for (let attempt = 0; ; attempt += 1) {
    const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
    if (now() + delay > stopAt) return null;
    await sleep(delay, signal);
    if (signal?.aborted) return null;
    const review = await lookup();
    if (signal?.aborted) return null;
    if (review !== undefined) return review;
  }
}
