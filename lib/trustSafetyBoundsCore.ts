/**
 * The trust-safety observer's approved numbers
 * (docs/policy/trust-safety-compliance-agent.md §12 (1) tables B and C).
 *
 * Derived values are computed here, never typed twice. The policy records why:
 * an earlier revision of §12 carried one formula in its table and another in
 * the test requirement, and no implementation without a literal could satisfy
 * both. So a kind's deadline is its own `C_guarded` by the same expression,
 * and `B` has exactly one derivation.
 *
 * Two numbers are free proposed values, not derived, and are marked as such:
 * the round window and the ping AbortSignal. Everything else in table C falls
 * out of table B or of those two.
 *
 * **None of these are approved yet.** §12 (1) is the operator's signature
 * list, and stage 1 does not start before it is signed; this module is what the
 * code will hold once it is, and the tests hold the two equal in the meantime.
 */

/** Every kind sets the same two database-enforced timers (§12 table B). */
export const STATEMENT_TIMEOUT_MS = 2_000;
export const IDLE_TIMEOUT_MS = 1_000;

/**
 * The margin between computing a transaction_timeout and setting it. Not a
 * table value: it is the arming function's own argument, and the ops-observer
 * precedent fixes it at this figure.
 */
export const ARM_MARGIN_MS = 250;

/** `transaction_timeout` sits this far above the kind's guarded budget (§12 table B). */
const TRANSACTION_TIMEOUT_MARGIN_MS = 3_000;

const bound = (statementCeiling: number, prismaTimeoutMs: number) => {
  const cGuardedMs = statementCeiling * (STATEMENT_TIMEOUT_MS + IDLE_TIMEOUT_MS);
  return {
    /** `A`: the kind's round-trip ceiling. `R = A + 2` adds BEGIN and COMMIT. */
    statementCeiling,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    cGuardedMs,
    /**
     * The kind's commit deadline. §12 table C: the deadline *is* the guarded
     * budget, by the same expression -- not a separate number that could drift
     * from it.
     */
    deadlineMs: cGuardedMs,
    transactionTimeoutMs: cGuardedMs + TRANSACTION_TIMEOUT_MARGIN_MS,
    prismaTimeoutMs,
  };
};

/**
 * The four transaction kinds (§12 table B).
 *
 * `dsr_read` and `run_write` hold the same three figures because `A` is 3 for
 * both. The policy asks for two entries rather than one shared constant: a
 * statement added to the run write must not quietly move the read's budget.
 */
export const TRUST_SAFETY_BOUNDS = {
  /** T0 -- activation read. */
  activation_read: bound(5, 25_000),
  /** Ta -- DSR count read. */
  dsr_read: bound(3, 20_000),
  /** Tr -- run row write. */
  run_write: bound(3, 20_000),
  /** The person's activation write (E3). */
  activation_write: bound(8, 40_000),
} as const;

export type TrustSafetyTransactionKind = keyof typeof TRUST_SAFETY_BOUNDS;

/** The monotonic pre-check between the commit's response and the ping (§8). */
export const MONOTONIC_PRECHECK_MS = 1_000;

/** Free proposed value: the ping's AbortSignal (§12 table C). */
export const PING_ABORT_MS = 3_000;

/**
 * Free proposed value: the round window the database judges as
 * `clock_timestamp() - "observedAt"` (§5.4). Its floor is derived below, and a
 * test holds the proposal at or above it.
 */
export const ROUND_WINDOW_MS = 47_000;

/**
 * The floor under the round window: the earliest point `observedAt` can be
 * minted through the run write's commit, covered conservatively (§12 table C).
 */
export const ROUND_WINDOW_FLOOR_MS =
  TRUST_SAFETY_BOUNDS.activation_read.cGuardedMs +
  TRUST_SAFETY_BOUNDS.dsr_read.cGuardedMs +
  TRUST_SAFETY_BOUNDS.run_write.cGuardedMs +
  MONOTONIC_PRECHECK_MS;

/** The three transactions plus the ping (§12 table C). */
export const GUARDED_TOTAL_MS =
  TRUST_SAFETY_BOUNDS.activation_read.cGuardedMs +
  TRUST_SAFETY_BOUNDS.dsr_read.cGuardedMs +
  TRUST_SAFETY_BOUNDS.run_write.cGuardedMs +
  PING_ABORT_MS;

/**
 * `B`, the route budget, and the one derivation §12 keeps: the round window,
 * the run write's guarded budget and the ping. A second derivation was removed
 * from the policy because no table cell gave its figure.
 */
export const ROUTE_BUDGET_MS =
  ROUND_WINDOW_MS + TRUST_SAFETY_BOUNDS.run_write.cGuardedMs + PING_ABORT_MS;

/** A budget, not a guarantee: the ping claims no arrival inside the window (§8). */
export const PING_FRESHNESS_MS = ROUND_WINDOW_MS + MONOTONIC_PRECHECK_MS + PING_ABORT_MS;

/** The cron service's own two limits, outside the app (§12 table C). */
export const CHILD_TIMEOUT_MS = ROUTE_BUDGET_MS + 10_000;
export const SUPERVISOR_KILL_MS = CHILD_TIMEOUT_MS + 30_000;

/** The declared period `P` and the dead-man window `W = k x P` (§12 table A). */
export const DECLARED_PERIOD_MS = 30 * 60_000;
export const DEAD_MAN_WINDOW_MULTIPLE = 4;
export const DEAD_MAN_WINDOW_MS = DEAD_MAN_WINDOW_MULTIPLE * DECLARED_PERIOD_MS;

type Bound = (typeof TRUST_SAFETY_BOUNDS)[TrustSafetyTransactionKind];

/**
 * The per-kind ordering §5.5 calls a contract, returned as the names of the
 * links that fail.
 *
 * `transaction_timeout > statement_timeout` is asserted on its own because the
 * measurement record's trap is that a transaction_timeout at or below the
 * statement timer turns the per-statement limit off silently, and the guarded
 * budget then rests on nothing.
 */
export const boundViolations = (b: Bound): readonly string[] => {
  const violations: string[] = [];
  if (!(b.prismaTimeoutMs > b.transactionTimeoutMs)) violations.push("prisma_gt_transaction");
  if (!(b.transactionTimeoutMs > b.cGuardedMs)) violations.push("transaction_gt_guarded");
  if (!(b.cGuardedMs > b.statementTimeoutMs)) violations.push("guarded_gt_statement");
  if (!(b.statementTimeoutMs > b.idleTimeoutMs)) violations.push("statement_gt_idle");
  if (!(b.transactionTimeoutMs > b.statementTimeoutMs)) violations.push("transaction_gt_statement");
  if (b.deadlineMs !== b.cGuardedMs) violations.push("deadline_is_guarded");
  return violations;
};

/** The outer ordering and its two gaps (§12 table C). `P` closes it. */
export const outerOrderViolations = (): readonly string[] => {
  const violations: string[] = [];
  if (!(GUARDED_TOTAL_MS < ROUTE_BUDGET_MS)) violations.push("guarded_lt_budget");
  if (!(ROUTE_BUDGET_MS < CHILD_TIMEOUT_MS)) violations.push("budget_lt_child");
  if (!(CHILD_TIMEOUT_MS < SUPERVISOR_KILL_MS)) violations.push("child_lt_supervisor");
  if (!(SUPERVISOR_KILL_MS < DECLARED_PERIOD_MS)) violations.push("supervisor_lt_period");
  if (CHILD_TIMEOUT_MS - ROUTE_BUDGET_MS !== 10_000) violations.push("child_gap_10s");
  if (SUPERVISOR_KILL_MS - CHILD_TIMEOUT_MS !== 30_000) violations.push("supervisor_gap_30s");
  if (!(ROUND_WINDOW_MS >= ROUND_WINDOW_FLOOR_MS)) violations.push("window_above_floor");
  return violations;
};
