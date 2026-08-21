/**
 * How long the standard lane keeps trying, by classification.
 *
 * Contract: docs/policy/email-notifications.md §9.4.
 *
 * Pure and dependency-free, so every curve can be driven without a database or
 * a provider. The storage side lives in lib/standardEmailLane.ts.
 *
 * The curves differ because the cost of giving up differs, not because the
 * messages differ in importance to us. A legal notice that never arrives is a
 * duty unmet, so it is tried for a day and a half and then escalated. A
 * promotion that never arrives is a promotion nobody missed -- and a failed
 * marketing send retried hard is how a momentary block becomes a lasting
 * reputation problem, so it gives up almost immediately and quietly.
 */

export type RetryClassification =
  | "transactional"
  | "service"
  | "legal"
  | "marketing";

/**
 * Delay before the attempt at each index, in milliseconds.
 *
 * The length of each array is the attempt cap: run off the end and the message
 * is abandoned.
 */
export const STANDARD_RETRY_CURVES: Record<
  RetryClassification,
  readonly number[]
> = {
  // Someone is likely waiting on this one -- a receipt, a security notice --
  // so it starts fast and still rides out a provider outage of a few hours.
  transactional: [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000],
  // Same shape, one fewer attempt: a maintenance notice that is half a day
  // late has already missed its moment.
  service: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000],
  // The longest, and the only curve that stretches past a working day: a
  // breach notification or a deletion notice has to reach someone, and the
  // escalation at the end of it is a person, not a log line.
  legal: [
    10_000,
    30_000,
    60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
    4 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
  ],
  // Two attempts and done. Deliberately the most forgiving curve, because
  // persistence is the failure mode here rather than the remedy.
  marketing: [5 * 60_000, 60 * 60_000],
} as const;

/**
 * How long a claim is honoured before another worker may take the row.
 *
 * Longer than any single send could reasonably take, short enough that a
 * process killed mid-send does not strand its rows until someone notices. The
 * cost of getting this wrong in the short direction is a duplicate send that
 * the provider's idempotency key absorbs; in the long direction it is a message
 * that silently stops moving, which nothing absorbs.
 */
export const STANDARD_LANE_CLAIM_TTL_MS = 5 * 60_000;

export type StandardAttemptDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: "attempts_exhausted" };

export const nextStandardAttempt = (input: {
  attemptsMade: number;
  classification: RetryClassification;
}): StandardAttemptDecision => {
  const curve = STANDARD_RETRY_CURVES[input.classification];
  const delayMs = curve[input.attemptsMade - 1];
  if (delayMs === undefined) {
    return { retry: false, reason: "attempts_exhausted" };
  }
  return { retry: true, delayMs };
};

/** Attempts a classification is allowed before it is abandoned. */
export const standardMaxAttempts = (classification: RetryClassification) =>
  STANDARD_RETRY_CURVES[classification].length + 1;
