/**
 * One account AI Review run at a time per input, shared by the route that
 * enforces it and the clients that report it.
 *
 * `POST /api/conversations/:id/comparison-reviews` writes its ComparisonReview
 * row only after the reviewers finish (tens of seconds, minutes at worst), so
 * without a claim a second POST for the same input in that window -- a second
 * tab, a retry after a dropped stream, Studio and the Classic dialog both
 * asked -- ran and billed the whole review again. The route now holds a
 * `(user, input hash)` claim for the run and answers a duplicate with
 * `409 DUPLICATE_REQUEST`. The client says the review is already running and
 * leaves the run button available: pressed again it gets another 409 while
 * the run is in flight, and the saved row (the route's cache path) once it
 * has finished.
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

/** The route's answer to a second POST while the same input is still running. */
export const isComparisonReviewAlreadyRunning = (status: number, body: unknown) =>
  status === 409 &&
  typeof body === "object" &&
  body !== null &&
  (body as { code?: unknown }).code === "DUPLICATE_REQUEST";
