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
 * finishes: front-loaded for the common 20-135 s run, then backing off to one
 * lookup a minute. Over a full TTL that is 18 lookups (at 3, 8, 18, 38, 68 s,
 * then every 60 s up to 848 s).
 */
export const COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS = [3_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;

/**
 * The most lookups one wait may make, whatever the schedule, the clock or a
 * rate limit does. Pinned by tests/comparisonReviewInFlight.test.mjs.
 */
export const COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS = 18;

/**
 * Exact-turn lookups have their own rate-limit bucket, apart from the setup
 * preview's 20/minute and 300/day: a wait on a run that never saves must not
 * spend the budget the dialog and Studio need to load a setup or a saved
 * result. 120 a day is six full waits; a typical wait makes two to seven.
 */
export const COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE = "comparison-review-in-flight-lookup";
export const COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_RATE_LIMIT = { minute: 10, day: 120 } as const;

/**
 * The GET's answer when the exact turn a client is waiting on no longer
 * exists (an answer was deleted or regenerated). It is never replaced by
 * another turn's review.
 */
export const COMPARISON_REVIEW_TURN_NOT_FOUND = "COMPARISON_REVIEW_TURN_NOT_FOUND";

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
 * before another answer finished. With them, the route answers only for that
 * turn -- saved, not yet saved, or COMPARISON_REVIEW_TURN_NOT_FOUND -- and
 * counts against its own rate-limit bucket.
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

/** One exact-turn lookup, classified. */
export type StoredComparisonReviewLookup<Review> =
  | { status: "saved"; review: Review }
  /** No saved row yet, or a transient failure worth another (later) look. */
  | { status: "pending"; retryAfterMs?: number }
  /** The turn being waited on no longer exists: stop, never substitute. */
  | { status: "gone" };

/** A refusal that ends the wait for good (gone conversation, lock, bad request). */
export class ComparisonReviewLookupError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(code ?? `HTTP ${status}`);
  }
}

const retryAfterMs = (header: string | null) => {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

/**
 * Reads one exact-turn saved result. Every path reads the body. A rate limit
 * is "pending" with its Retry-After, so the wait backs off further instead of
 * retrying sooner.
 */
export async function lookupStoredComparisonReview<Review>(
  path: string,
  { signal, fetchImpl = (input, init) => fetch(input, init) }: {
    signal?: AbortSignal;
    fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  } = {}
): Promise<StoredComparisonReviewLookup<Review>> {
  let response: Response;
  try {
    response = await fetchImpl(path, { cache: "no-store", signal });
  } catch {
    return { status: "pending" };
  }
  const body = (await response.json().catch(() => null)) as
    | { code?: unknown; storedReview?: Review | null }
    | null;
  if (response.ok) {
    return body?.storedReview ? { status: "saved", review: body.storedReview } : { status: "pending" };
  }
  if (response.status === 404 && body?.code === COMPARISON_REVIEW_TURN_NOT_FOUND) return { status: "gone" };
  if (response.status === 429) {
    return { status: "pending", retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
  }
  if (response.status >= 500) return { status: "pending" };
  throw new ComparisonReviewLookupError(
    response.status,
    typeof body?.code === "string" ? body.code : null
  );
}

export type ComparisonReviewWaitOutcome<Review> =
  | { outcome: "saved"; review: Review }
  | { outcome: "gone" }
  /** The deadline, the lookup budget or a Retry-After beyond either ran out. */
  | { outcome: "expired" }
  | { outcome: "aborted" };

/**
 * Looks the saved result up until it appears, the turn disappears, the
 * deadline or lookup budget runs out, or the caller aborts. Never POSTs: the
 * run being waited on is somebody else's, and the server would refuse a
 * second one anyway. A `lookup` that throws ends the wait with its error.
 */
export async function waitForStoredComparisonReview<Review>({
  lookup,
  signal,
  deadlineMs = COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS * 1000,
  delaysMs = COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS,
  maxLookups = COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS,
  now = () => Date.now(),
  sleep = pause,
}: {
  lookup: () => Promise<StoredComparisonReviewLookup<Review>>;
  signal?: AbortSignal;
  deadlineMs?: number;
  delaysMs?: readonly number[];
  maxLookups?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<ComparisonReviewWaitOutcome<Review>> {
  const stopAt = now() + deadlineMs;
  let notBeforeMs = 0;
  for (let attempt = 0; attempt < maxLookups; attempt += 1) {
    const delay = Math.max(delaysMs[Math.min(attempt, delaysMs.length - 1)], notBeforeMs);
    if (now() + delay > stopAt) return { outcome: "expired" };
    await sleep(delay, signal);
    if (signal?.aborted) return { outcome: "aborted" };
    const result = await lookup();
    if (signal?.aborted) return { outcome: "aborted" };
    if (result.status === "saved") return { outcome: "saved", review: result.review };
    if (result.status === "gone") return { outcome: "gone" };
    notBeforeMs = result.retryAfterMs ?? 0;
  }
  return { outcome: "expired" };
}
