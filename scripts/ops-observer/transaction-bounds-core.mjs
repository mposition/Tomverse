// Per-kind transaction bounds for the ops-observer store
// (docs/policy/sre-ops.md §6, operator decision N-2).
//
// Each kind has a statement ceiling A, a statement timeout and an idle timeout;
// C_guarded = A x (statement + idle) is the most one transaction can take while
// every statement and every gap stays under its own database-enforced timer.
// The transaction_timeout constant must be at least C_guarded, and the Prisma
// interactive-transaction timeout must exceed it, so the database ends a run
// before the client library gives up on it. These are figures the database
// enforces only per statement and per gap; transaction occupancy is bounded by
// the database only on PostgreSQL 17 (policy §6 item 4) and is not a bound on
// 16. The values are the policy's table; tests hold the two equal.

/** Arm margin between computing ttArmedMs and setting it (policy §6). */
export const ARM_MARGIN_MS = 250;

/** The supervisor deadline that also serves as every request's run deadline (policy §6). */
export const RUN_DEADLINE_MS = 180_000;

export const TRANSACTION_BOUNDS = Object.freeze({
  advance: bound(28, 2_000, 1_000, 90_000, 120_000),
  confirm: bound(17, 2_000, 1_000, 55_000, 75_000),
  genesis: bound(17, 2_000, 1_000, 55_000, 75_000),
  verify_result: bound(13, 2_000, 1_000, 45_000, 60_000),
  genesis_retirement: bound(20, 2_000, 1_000, 66_000, 85_000),
  digest_submit: bound(11, 2_000, 1_000, 36_000, 55_000),
  state_read: bound(11, 2_000, 1_000, 36_000, 55_000),
  retention_batch: bound(11, 1_000, 500, 18_000, 30_000),
  assert: bound(3, 1_000, 500, 6_000, 10_000),
});

function bound(statementCeiling, statementTimeoutMs, idleTimeoutMs, transactionTimeoutMs, prismaTimeoutMs) {
  return Object.freeze({
    statementCeiling,
    statementTimeoutMs,
    idleTimeoutMs,
    cGuardedMs: statementCeiling * (statementTimeoutMs + idleTimeoutMs),
    transactionTimeoutMs,
    prismaTimeoutMs,
  });
}

/** The ordering every kind must satisfy; returns the names of the violated links. */
export function boundViolations(b) {
  const violations = [];
  if (!(b.prismaTimeoutMs > b.transactionTimeoutMs)) violations.push("prisma_gt_transaction");
  if (!(b.transactionTimeoutMs >= b.cGuardedMs)) violations.push("transaction_ge_guarded");
  if (!(b.cGuardedMs > b.statementTimeoutMs)) violations.push("guarded_gt_statement");
  if (!(b.statementTimeoutMs > b.idleTimeoutMs)) violations.push("statement_gt_idle");
  if (!(b.cGuardedMs + ARM_MARGIN_MS <= RUN_DEADLINE_MS)) violations.push("fits_run_deadline");
  return violations;
}

/** The arguments `ops_observer_arm_timeouts()` takes for one kind, in order. */
export function armArguments(kind, runDeadline) {
  const b = TRANSACTION_BOUNDS[kind];
  if (!b) throw new Error("ops_observer_transaction_kind_unknown");
  if (!(runDeadline instanceof Date) || Number.isNaN(runDeadline.getTime())) {
    throw new Error("ops_observer_run_deadline_invalid");
  }
  return [b.statementTimeoutMs, b.idleTimeoutMs, b.transactionTimeoutMs, b.cGuardedMs, ARM_MARGIN_MS, runDeadline.toISOString()];
}
