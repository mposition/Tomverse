
import { AMUX_INFRA_RETRY_BASE_MS, AMUX_INFRA_RETRY_MAX_MS } from "./infraFailureCore.ts";

/**
 * No fixed number of attempts stops an ordinary card (owner direction
 * 2026-11-15: "내부 개발용 Flow입니다. 제한을 줄 이유가 없습니다."), and since
 * 2026-11-18 the same result failure repeating does not hand it to a person or
 * the Decision Maker either (the `repeated_failure` stop is gone). A failed
 * result goes back to `todo` and is assigned again; the claim only waits
 * longer between tries while the same failure keeps coming
 * (`amuxResultRetryDelayMs`), so a failing card is slowed to one try an hour,
 * never parked. An infrastructure failure never counts
 * (lib/amux/infraFailureCore.ts).
 *
 * A caller that names no `max_attempts` has no bound: "none" is `null`, never
 * a large number or Infinity, so nothing unbounded reaches JSON or the
 * database. The only bounds left are ones that cap real spend, which the
 * caller passes itself: a paid (risk-accepted) read-only retry
 * (lib/amux/v22TaskRecoveryCore.ts). The operational cost guard
 * (lib/amux/resourcePolicy.ts) still bounds any other spend.
 */

/** The same result failure more than this many runs in a row delays the next try. */
export const AMUX_REPEATED_FAILURE_RUNS = 3;

/** One run's result failure as the repeat check compares it. */
export const amuxResultFailureSignature = (outcome: string | null, reason: string | null) =>
  `${outcome ?? "unknown"}:${reason ?? "unknown"}`;

/**
 * How many of the newest runs (newest first) are the same result failure in a
 * row. The newest run counts as the first.
 */
export function amuxResultFailureStreak(signatures: readonly string[]): number {
  if (signatures.length === 0) return 0;
  let streak = 1;
  while (streak < signatures.length && signatures[streak] === signatures[0]) streak += 1;
  return streak;
}

/**
 * How long the claim waits after the newest run before it assigns the card
 * again, given how many runs in a row failed the same way (the same shape as
 * `amuxInfraRetryDelayMs`): none up to AMUX_REPEATED_FAILURE_RUNS repeats,
 * then a minute that doubles up to an hour. Never a stop.
 */
export const amuxResultRetryDelayMs = (repeats: number): number => {
  if (!Number.isFinite(repeats) || repeats <= AMUX_REPEATED_FAILURE_RUNS) return 0;
  return Math.min(AMUX_INFRA_RETRY_MAX_MS, AMUX_INFRA_RETRY_BASE_MS *
    2 ** Math.min(Math.trunc(repeats) - AMUX_REPEATED_FAILURE_RUNS - 1, 20));
};

export type AmuxAttemptBudgetDecision =
  | {
      allowed: true;
      next_attempt_number: number;
      /** The bound the caller named, or null when it named none. */
      max_attempts: number | null;
    }
  | {
      allowed: false;
      exhausted_limit: "attempts";
      attempts_used: number;
      max_attempts: number;
    };

/**
 * Historical NULL attempt numbers count toward spend, but never receive an
 * invented task-local order. New numbering starts above both the historical
 * row count and the greatest explicit number.
 *
 * `infra_rows` are the Task's attempts stored with an infrastructure failure
 * reason (lib/amux/infraFailureCore.ts, owner decision 2026-11-15): they keep
 * their number, so the next one is still unique, but they do not use the
 * card's attempts and have no bound: they only delay the next try
 * (amuxInfraRetryDelayMs).
 */
/** The bound a caller named, or null: no bound (never Infinity or a sentinel). */
const namedBound = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : Math.max(1, Math.trunc(value));

export const decideAmuxAttemptBudget = (input: {
  historical_rows: number;
  greatest_attempt_number: number | null;
  /** A paid retry's own exact bound; without it the card has none. */
  max_attempts?: number;
  infra_rows?: number;
}): AmuxAttemptBudgetDecision => {
  const maxAttempts = namedBound(input.max_attempts);
  const numbered = Math.max(
    Math.max(0, Math.trunc(input.historical_rows)),
    Math.max(0, Math.trunc(input.greatest_attempt_number ?? 0)),
  );
  const infraRows = Math.max(0, Math.trunc(input.infra_rows ?? 0));
  const attemptsUsed = Math.max(0, numbered - infraRows);
  if (maxAttempts !== null && attemptsUsed >= maxAttempts) {
    return {
      allowed: false,
      exhausted_limit: "attempts",
      attempts_used: attemptsUsed,
      max_attempts: maxAttempts,
    };
  }
  return {
    allowed: true,
    next_attempt_number: numbered + 1,
    max_attempts: maxAttempts,
  };
};

/**
 * Where a settled attempt sends its Task within the budget. An attempt the
 * caller classified as an infrastructure failure (`infra_failure`) never uses
 * the card's attempts and has no bound: it goes back to `todo` and waits
 * (amuxInfraRetryDelayMs). `infra_attempts_before` are the Task's earlier
 * infrastructure failures, which the attempt number still counts. A failed
 * result is never stopped by repeating (owner direction 2026-11-18): it goes
 * back to `todo` and the claim waits longer (amuxResultRetryDelayMs). Only a
 * caller that names `max_attempts` (a paid retry) is stopped at it.
 */
export const settlementDestinationForBudget = (input: {
  requested_status: "todo" | "review" | "done" | "blocked";
  attempt_number: number | null;
  max_attempts?: number;
  infra_attempts_before?: number;
  infra_failure?: boolean;
}) => {
  const maxAttempts = namedBound(input.max_attempts);
  const infraBefore = Math.max(0, Math.trunc(input.infra_attempts_before ?? 0));
  if (input.requested_status === "todo" && input.infra_failure === true) {
    return { to_status: "todo" as const, exhausted_limit: null, max_attempts: maxAttempts };
  }
  if (
    maxAttempts !== null &&
    input.requested_status === "todo" &&
    input.attempt_number !== null &&
    input.attempt_number - infraBefore >= maxAttempts
  ) {
    return {
      to_status: "blocked" as const,
      exhausted_limit: "attempts" as const,
      max_attempts: maxAttempts,
    };
  }
  return {
    to_status: input.requested_status,
    exhausted_limit: null,
    max_attempts: maxAttempts,
  };
};

export type AmuxApprovedCeilingOverrun = {
  ceilingMicroUsd: string;
  priorReservedMicroUsd: string;
  projectedMicroUsd: string;
};

/**
 * Whether one more attempt takes a Task's reserved total past the ceiling its
 * owner approved (the receipt's per-attempt maximum times its maxAttempts).
 * The attempt budget above has no fixed bound for an ordinary Task, so an
 * ordinary Task can reserve more than that ceiling. Owner decision 2026-11-14:
 * the overrun is recorded, never refused -- a higher cost still never stops an
 * ordinary Task (v4TaskCeilingDecision). Claim and execution start share this
 * one calculation. An unreadable receipt records nothing.
 */
export const amuxApprovedCeilingOverrun = (input: {
  approvedReceipt: unknown;
  priorReservedMicroUsd: bigint;
  nextAttemptMicroUsd: bigint;
}): AmuxApprovedCeilingOverrun | null => {
  const receipt = input.approvedReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      !("ceilingMicroUsd" in receipt) ||
      typeof receipt.ceilingMicroUsd !== "string" ||
      !/^\d{1,30}$/.test(receipt.ceilingMicroUsd)) return null;
  const ceiling = BigInt(receipt.ceilingMicroUsd);
  const projected = input.priorReservedMicroUsd + input.nextAttemptMicroUsd;
  if (projected <= ceiling) return null;
  return { ceilingMicroUsd: ceiling.toString(),
    priorReservedMicroUsd: input.priorReservedMicroUsd.toString(),
    projectedMicroUsd: projected.toString() };
};
