import { AMUX_MAX_INFRA_FAILURES_PER_TASK, amuxInfraFailureRoutingEnabled } from
  "./infraFailureCore.ts";

/**
 * No fixed number of attempts stops an ordinary card (owner direction
 * 2026-11-15: "내부 개발용 Flow입니다. 제한을 줄 이유가 없습니다."). Until then a
 * card stopped after five, whatever its failures were. Now it stops only when
 * its worker's own result failed the same way AMUX_REPEATED_FAILURE_RUNS times
 * in a row (`amuxRepeatedResultFailure`), and then it goes to a person and the
 * Decision Maker with that reason (`repeated_failure`), not merely blocked.
 * An infrastructure failure never counts (lib/amux/infraFailureCore.ts).
 *
 * This is a runaway guard, not a budget: the most counted attempts a card
 * whose failures keep changing may run before it is handed over the same way.
 * A subscription CLI run costs nothing more; the operational cost guard
 * (lib/amux/resourcePolicy.ts) still bounds any spend. A paid retry passes its
 * own exact bound as `max_attempts`.
 */
export const AMUX_MAX_EXECUTION_ATTEMPTS = 30;

/** The fixed count before 2026-11-15, restored by
 * TOMVERSE_AMUX_INFRA_FAILURE_ROUTING=disabled. */
export const AMUX_LEGACY_MAX_EXECUTION_ATTEMPTS = 5;

/** The bound a caller that names none gets. */
export const amuxDefaultMaxAttempts = () =>
  amuxInfraFailureRoutingEnabled() ? AMUX_MAX_EXECUTION_ATTEMPTS : AMUX_LEGACY_MAX_EXECUTION_ATTEMPTS;

/** The same result failure this many runs in a row hands the card over. */
export const AMUX_REPEATED_FAILURE_RUNS = 3;

/** The escalation and attempt reason of a card handed over for that. */
export const AMUX_REPEATED_FAILURE_REASON = "repeated_failure";

/** One run's result failure as the repeat check compares it. */
export const amuxResultFailureSignature = (outcome: string | null, reason: string | null) =>
  `${outcome ?? "unknown"}:${reason ?? "unknown"}`;

/**
 * Whether the newest runs (newest first, the settling one included) are the
 * same result failure AMUX_REPEATED_FAILURE_RUNS times in a row.
 */
export function amuxRepeatedResultFailure(signatures: readonly string[]): boolean {
  if (signatures.length < AMUX_REPEATED_FAILURE_RUNS) return false;
  const newest = signatures.slice(0, AMUX_REPEATED_FAILURE_RUNS);
  return newest.every((signature) => signature === newest[0]);
}

export type AmuxAttemptBudgetDecision =
  | {
      allowed: true;
      next_attempt_number: number;
      max_attempts: number;
    }
  | {
      allowed: false;
      exhausted_limit: "attempts" | "infra_attempts";
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
 * card's attempts. They have their own, larger bound, which counts
 * `infra_window_rows`: those since a person last sent the card back with
 * `retry` (infraFailureStore.ts). A person's retry is the decision that the
 * platform may be tried again, so it starts that bound over; it is all of
 * `infra_rows` when not given.
 */
export const decideAmuxAttemptBudget = (input: {
  historical_rows: number;
  greatest_attempt_number: number | null;
  max_attempts?: number;
  infra_rows?: number;
  infra_window_rows?: number;
}): AmuxAttemptBudgetDecision => {
  const maxAttempts = Math.max(
    1,
    Math.trunc(input.max_attempts ?? amuxDefaultMaxAttempts()),
  );
  const numbered = Math.max(
    Math.max(0, Math.trunc(input.historical_rows)),
    Math.max(0, Math.trunc(input.greatest_attempt_number ?? 0)),
  );
  const infraRows = Math.max(0, Math.trunc(input.infra_rows ?? 0));
  const infraWindow = Math.min(infraRows,
    Math.max(0, Math.trunc(input.infra_window_rows ?? infraRows)));
  const attemptsUsed = Math.max(0, numbered - infraRows);
  if (attemptsUsed >= maxAttempts) {
    return {
      allowed: false,
      exhausted_limit: "attempts",
      attempts_used: attemptsUsed,
      max_attempts: maxAttempts,
    };
  }
  if (infraWindow >= AMUX_MAX_INFRA_FAILURES_PER_TASK) {
    return {
      allowed: false,
      exhausted_limit: "infra_attempts",
      attempts_used: infraWindow,
      max_attempts: AMUX_MAX_INFRA_FAILURES_PER_TASK,
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
 * the card's attempts; it is bounded only by the infrastructure bound.
 * `infra_attempts_before` are the Task's earlier infrastructure failures,
 * which the attempt number still counts; `infra_window_before` those of them
 * since a person's last retry, which the bound counts (all of them when not
 * given; see decideAmuxAttemptBudget).
 */
export const settlementDestinationForBudget = (input: {
  requested_status: "todo" | "review" | "done" | "blocked";
  attempt_number: number | null;
  max_attempts?: number;
  infra_attempts_before?: number;
  infra_window_before?: number;
  infra_failure?: boolean;
  /** The settling run is the same result failure as the runs before it
   * (`amuxRepeatedResultFailure`): the card goes to a person and the DM. */
  repeated_failure?: boolean;
}) => {
  const maxAttempts = Math.max(
    1,
    Math.trunc(input.max_attempts ?? amuxDefaultMaxAttempts()),
  );
  const infraBefore = Math.max(0, Math.trunc(input.infra_attempts_before ?? 0));
  const infraWindowBefore = Math.min(infraBefore,
    Math.max(0, Math.trunc(input.infra_window_before ?? infraBefore)));
  if (input.requested_status === "todo" && input.infra_failure === true) {
    if (infraWindowBefore + 1 >= AMUX_MAX_INFRA_FAILURES_PER_TASK) {
      return {
        to_status: "blocked" as const,
        exhausted_limit: "infra_attempts" as const,
        max_attempts: AMUX_MAX_INFRA_FAILURES_PER_TASK,
      };
    }
    return { to_status: "todo" as const, exhausted_limit: null, max_attempts: maxAttempts };
  }
  if (input.requested_status === "todo" && input.repeated_failure === true) {
    return {
      to_status: "blocked" as const,
      exhausted_limit: "repeated_failure" as const,
      max_attempts: maxAttempts,
    };
  }
  if (
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
 * The attempt budget above still counts AMUX_MAX_EXECUTION_ATTEMPTS, so an
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
