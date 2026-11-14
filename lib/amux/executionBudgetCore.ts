export const AMUX_MAX_EXECUTION_ATTEMPTS = 5;

export type AmuxAttemptBudgetDecision =
  | {
      allowed: true;
      next_attempt_number: number;
      max_attempts: number;
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
 */
export const decideAmuxAttemptBudget = (input: {
  historical_rows: number;
  greatest_attempt_number: number | null;
  max_attempts?: number;
}): AmuxAttemptBudgetDecision => {
  const maxAttempts = Math.max(
    1,
    Math.trunc(input.max_attempts ?? AMUX_MAX_EXECUTION_ATTEMPTS),
  );
  const attemptsUsed = Math.max(
    Math.max(0, Math.trunc(input.historical_rows)),
    Math.max(0, Math.trunc(input.greatest_attempt_number ?? 0)),
  );
  if (attemptsUsed >= maxAttempts) {
    return {
      allowed: false,
      exhausted_limit: "attempts",
      attempts_used: attemptsUsed,
      max_attempts: maxAttempts,
    };
  }
  return {
    allowed: true,
    next_attempt_number: attemptsUsed + 1,
    max_attempts: maxAttempts,
  };
};

export const settlementDestinationForBudget = (input: {
  requested_status: "todo" | "review" | "done" | "blocked";
  attempt_number: number | null;
  max_attempts?: number;
}) => {
  const maxAttempts = Math.max(
    1,
    Math.trunc(input.max_attempts ?? AMUX_MAX_EXECUTION_ATTEMPTS),
  );
  if (
    input.requested_status === "todo" &&
    input.attempt_number !== null &&
    input.attempt_number >= maxAttempts
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
