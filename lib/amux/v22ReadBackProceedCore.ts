/**
 * "Read back, then proceed" (owner decision 2026-11-14, AMUX process audit
 * bundle 1, Goal-Step AMUXFLOW/B1).
 *
 * A subscription CLI run costs nothing more when its usage is not known, so
 * an unknown usage or an expired lease on a CLI route is recorded and the
 * card goes on within its attempt budget (lib/amux/executionBudgetCore.ts):
 *
 * - the worker usage gate counts only a budget-bound (risk-accepted,
 *   read-only API) recovery attempt, the one route where money is spent;
 * - settlement no longer refuses a CLI run whose receipt is incomplete, and a
 *   CLI run that ended without one goes back to `todo` instead of `blocked`
 *   plus a person (`cli_usage_unreported`);
 * - an expired CLI lease goes back to `todo` instead of a quarantine plus a
 *   person (`lease_expired_retry`), and the lease is 180 s so a slow bridge
 *   round (review helper plus sleep) does not end a live run.
 *
 * The attempt budget still bounds every repeat, and a card that spends it is
 * blocked as before. A paid API route keeps every gate.
 *
 * Always on (owner direction 2026-11-15: "내부 개발용 Flow입니다. 제한을 줄 이유가
 * 없습니다."); its switch was removed 2026-11-16.
 */

/** A CLI run that ended with no complete usage receipt, retried in budget. */
export const AMUX_V22_CLI_USAGE_UNREPORTED_REASON = "cli_usage_unreported";
/** A CLI run whose lease expired, retried in budget. */
export const AMUX_V22_LEASE_EXPIRED_RETRY_REASON = "lease_expired_retry";

export const AMUX_EXECUTION_READ_BACK_LEASE_MS = 180_000;

export function amuxExecutionLeaseMs(): number {
  return AMUX_EXECUTION_READ_BACK_LEASE_MS;
}

/**
 * Whether a run's usage is only recorded. A paid route is a run under a
 * budget-bound recovery (a risk acceptance) or one that carries an API
 * execution receipt; every other v22 route is a subscription CLI.
 */
export function amuxV22CliUsageRecordOnly(input: {
  budgetBound: boolean;
  apiReceipt: boolean;
}): boolean {
  return !input.budgetBound && !input.apiReceipt;
}
