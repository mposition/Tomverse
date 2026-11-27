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
 * `finally` can release it. A live run renews its claim every
 * COMPARISON_REVIEW_IN_FLIGHT_HEARTBEAT_MS, so it keeps the claim however
 * long it runs (a larger COMPARISON_REVIEW_MODEL_IDS panel, sequential
 * failures and retries); this bound only decides how long a dead holder can
 * lock one review out. Nothing is charged meanwhile.
 *
 * Sized from the run's worst case in lib/comparisonReviewService.ts all the
 * same: each reviewer request is aborted at 45 s, a non-timeout failure is
 * retried once (2 x 45 s = 90 s per candidate), and the sequential path can
 * try every candidate for the primary review and every other one for the
 * secondary ((2N - 1) x 90 s) -- 450 s with the default three-reviewer panel.
 * tests/server-contract/comparison-review-run-claim.test.ts recomputes it.
 */
export const COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS = 15 * 60;

/**
 * How often a live run renews its claim: a third of the TTL, so two renewals
 * can be missed (a slow database, a busy event loop) before the claim could
 * be taken over.
 */
export const COMPARISON_REVIEW_IN_FLIGHT_HEARTBEAT_MS = (COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS * 1000) / 3;

/** The route's answer to a second POST while the same input is still running. */
export const isComparisonReviewAlreadyRunning = (status: number, body: unknown) =>
  status === 409 &&
  typeof body === "object" &&
  body !== null &&
  (body as { code?: unknown }).code === "DUPLICATE_REQUEST";
