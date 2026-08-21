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
 * `maxAttempts` counts the first send, so a curve always holds one fewer delay
 * than the cap it implies: `delays.length === maxAttempts - 1`. Run off the end
 * and the message is abandoned. `standardMaxAttempts` below is the only place
 * that arithmetic is written down, and a test pins it against §9.4's table.
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
  // One send and one retry, and done -- two attempts, matching §9.4's cap.
  // Deliberately the most forgiving curve, because persistence is the failure
  // mode here rather than the remedy: a promotion nobody received is a
  // promotion nobody missed, while a failed promotion retried hard is how a
  // momentary block becomes a lasting reputation problem.
  //
  // §9.4's marketing row lists two backoffs beside a cap of 2, which cannot
  // both hold. Every other row is consistent as delays = cap - 1, and the cap
  // is the number the prose is about, so the second delay goes rather than the
  // cap (resolved 2026-08-21).
  marketing: [5 * 60_000],
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

/**
 * What an operator is told when a message runs out of attempts.
 *
 * Contract: docs/policy/email-notifications.md §9.4, "소진 시" column, and §9.5.
 *
 * The column is per classification, and the differences are the point:
 *
 *  - **legal** is the only `fatal`, and the only one that bypasses the
 *    cooldown. §9.4 asks for manual follow-up and an alternate channel, which
 *    are things a person does, so the incident has to reach a person on the
 *    occurrence rather than on the second one after a quiet window.
 *  - **transactional** and **service** are ordinary incidents. Somebody was
 *    waiting on a receipt or a notice and did not get it; that is worth
 *    knowing, on a cooldown, like everything else.
 *  - **marketing** is silent. §9.4 says give up quietly, and a promotion
 *    nobody received is a promotion nobody missed. It is still counted, and
 *    still visible in the drain's own log line -- silence here means no
 *    incident, not no record.
 *
 * ## Why each classification has its own code
 *
 * `reportOperationalIncident` gates its notification on the incident *code*
 * (`lib/operationalMonitoring.ts`), so one shared code makes the cooldown a
 * shared resource. Under a single `EMAIL_DELIVERY_ABANDONED`, a marketing
 * abandonment -- the one the policy says to keep quiet about -- would start a
 * thirty-minute window and swallow a legal abandonment that happened five
 * minutes later. The quietest classification would silence the loudest, which
 * is the exact inversion of what the table asks for.
 *
 * Splitting the codes also means an alert rule can be written per
 * classification, which is what "critical incident" has to mean if it is to
 * mean anything operationally.
 */
export type AbandonmentEscalation =
  | { notify: false }
  | {
      notify: true;
      code: string;
      title: string;
      severity: "error" | "fatal";
      /**
       * Whether the incident is raised even inside its own cooldown window.
       *
       * True only for legal. Two legal abandonments in half an hour are two
       * duties unmet, not one event repeating, and the follow-up is per
       * message.
       */
      forceNotification: boolean;
    };

const ESCALATIONS: Record<RetryClassification, AbandonmentEscalation> = {
  legal: {
    notify: true,
    code: "EMAIL_LEGAL_DELIVERY_ABANDONED",
    title: "A legal notice was abandoned after exhausting its retries",
    severity: "fatal",
    forceNotification: true,
  },
  transactional: {
    notify: true,
    code: "EMAIL_TRANSACTIONAL_DELIVERY_ABANDONED",
    title: "A transactional email was abandoned after exhausting its retries",
    severity: "error",
    forceNotification: false,
  },
  service: {
    notify: true,
    code: "EMAIL_SERVICE_DELIVERY_ABANDONED",
    title: "A service email was abandoned after exhausting its retries",
    severity: "error",
    forceNotification: false,
  },
  marketing: { notify: false },
};

export const abandonmentEscalation = (
  classification: RetryClassification
): AbandonmentEscalation => ESCALATIONS[classification];

/** Every classification, for callers that tally by one. */
export const RETRY_CLASSIFICATIONS = [
  "transactional",
  "service",
  "legal",
  "marketing",
] as const satisfies readonly RetryClassification[];
