/**
 * What to do with a message whose verdict could not be reached.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6, last
 * bullet; invariant 11.
 *
 * ## Why this is a third outcome
 *
 * The drain has two endings for a message it cannot send: `skipped`, which says
 * a rule refused it, and `failed`, which says rendering it will never work. A
 * database error while *deciding* is neither. The rules did not refuse anything
 * -- nobody asked them -- and nothing about the message is wrong.
 *
 * The current drain turns an unexpected error into a permanent `failed`, and
 * section 7.6 asks for this branch precisely because of that: a connection reset
 * while reading the country rules would otherwise retire a message the law
 * allows, permanently, with `lastErrorKind` naming a Prisma class. Nobody looking
 * at that row later could tell it from a message that was genuinely unsendable.
 *
 * So: release the claim, set `nextAttemptAt` on the existing curve, leave the
 * row `pending`, and raise an incident. The message is not decided; it is
 * undecided and queued, which is what actually happened.
 *
 * ## And it still runs out
 *
 * Retrying for ever is its own failure -- a message that cannot be decided after
 * every attempt on the curve is one an operator has to look at, and holding it
 * `pending` for ever means nobody does. The curve is the classification's own,
 * so an exhausted verdict retry abandons exactly where an exhausted send does.
 *
 * Pure: the caller supplies the attempt count, the classification and the clock.
 */

import {
  nextStandardAttempt,
  type RetryClassification,
} from "@/lib/standardEmailRetryCore";

export type VerdictRetryDecision =
  | {
      outcome: "retry";
      /** The row stays `pending`; only the claim and the schedule move. */
      attempts: number;
      nextAttemptAt: Date;
      delayMs: number;
    }
  | {
      outcome: "abandoned";
      attempts: number;
      /** Why an operator is being told, in the words the incident uses. */
      reason: "verdict_unavailable_attempts_exhausted";
    };

/**
 * The error a verdict loader raises when the database could not answer.
 *
 * A class rather than a flag, because the drain's `catch` has to tell this from
 * a render failure and the two arrive at the same place. Anything that is not
 * this stays what it was: permanently failed.
 */
export class VerdictUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "VerdictUnavailableError";
    this.cause = options?.cause;
  }
}

export const verdictRetry = (input: {
  attemptsMade: number;
  classification: RetryClassification;
  now: Date;
}): VerdictRetryDecision => {
  const attempts = input.attemptsMade + 1;
  const decision = nextStandardAttempt({
    attemptsMade: attempts,
    classification: input.classification,
  });
  if (!decision.retry) {
    return { outcome: "abandoned", attempts, reason: "verdict_unavailable_attempts_exhausted" };
  }
  return {
    outcome: "retry",
    attempts,
    nextAttemptAt: new Date(input.now.getTime() + decision.delayMs),
    delayMs: decision.delayMs,
  };
};
