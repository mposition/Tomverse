/**
 * The marketing publisher's timing contract, as numbers and the rules between
 * them.
 *
 * Contract: the S2 plan's "S2d1 -- Railway service and deadline that reaches
 * the work", and foundation r13 section 6.2a. No Prisma and no `server-only`,
 * so the ordering rules below are testable with a fixed clock and no database.
 *
 * ## The four limits, from the outside in
 *
 * 1. **The cron period** -- five minutes. Railway starts a run this often.
 * 2. **The run deadline** -- four minutes after the run starts. The service's
 *    supervisor force-kills its worker at this instant. Railway's own
 *    "skip if the previous run is still going" is additional behaviour, not
 *    this mechanism: it decides whether a run starts, not when one stops.
 * 3. **The derived per-transaction maximum** -- 175 seconds. Eighteen statements
 *    at five seconds each, plus seventeen idle gaps between them at five seconds
 *    each. This is an **application figure, not a database bound**: PostgreSQL
 *    has no statement counter in any version, so the thing that stops a
 *    nineteenth statement is the wrapper in lib/marketingPublisherRun.ts.
 * 4. **The per-statement and idle ceilings** -- five seconds each, which
 *    PostgreSQL does enforce.
 *
 * Each must be strictly inside the one before it. `marketingPublisherTimingProblems`
 * says which pair is not, and a test fails if the shipped values have any.
 *
 * ## The ordering trap
 *
 * On PostgreSQL 17, `transaction_timeout` bounds the transaction from the moment
 * it is set. But `statement_timeout` and `idle_in_transaction_session_timeout`
 * only arm while they are **shorter** than `transaction_timeout` (or when it is
 * zero). Setting `transaction_timeout` below either of them switches that
 * ceiling off -- silently, with no error. So the transaction timeout is the
 * derived maximum, which is larger than both, and the rule is checked rather
 * than hoped for.
 *
 * ## What stays unbounded
 *
 * Named, not waved at: the window from `BEGIN` to the `SET LOCAL` that arms
 * `transaction_timeout`, and `COMMIT`'s durable phase. And on PostgreSQL 16
 * there is no `transaction_timeout` at all, so the occupancy bound does not
 * exist there -- which is why the wrapper refuses to run below 17 rather than
 * run with a bound it cannot have.
 */

import { z } from "zod";

// One job key, defined where the scheduled-job catalogue keeps its keys.
import { MARKETING_PUBLISHER_JOB_KEY } from "@/lib/scheduledJobsCore";

export { MARKETING_PUBLISHER_JOB_KEY };

/**
 * What the service sends: exactly these two fields.
 *
 * `runId` is a UUID the service generates per invocation and `deadline` is the
 * instant its supervisor will kill the worker, as a UTC ISO string. Strict, so
 * a service that grew a third field is refused rather than half-understood.
 */
export const marketingPublisherRequestSchema = z
  .object({
    runId: z.string().uuid(),
    deadline: z.string().datetime({ offset: false }),
  })
  .strict();

/** How often Railway starts a run. `*\/5 * * * *` in the cron catalogue. */
export const MARKETING_PUBLISHER_CRON_PERIOD_MS = 5 * 60 * 1000;

/** How long a run may last before its supervisor kills it. */
export const MARKETING_PUBLISHER_RUN_DEADLINE_MS = 4 * 60 * 1000;

export const MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS = 5_000;
export const MARKETING_PUBLISHER_IDLE_TIMEOUT_MS = 5_000;
/**
 * How many statements one publisher transaction may issue.
 *
 * **Measured, not chosen.** It was 12 before the bounded transaction had a
 * caller, and the first caller showed it was too small for the one operation
 * where being too small does the most harm. With the real publish resolver
 * wired in and an audit integrity key configured -- as production always has,
 * and as the first measurement did not, which undercounted every audit append by
 * one -- the store operations the publisher runs issue:
 *
 *   claim 13, or 14 reclaiming an expired lease · dispatch 12, or 15 for an
 *   autonomous post (its scheduling record is verified as chained evidence) ·
 *   published 9 · failed 9 · outcome_unknown 15 · release 6 · poll published 9 ·
 *   poll verified 9 · poll removed 8
 *
 * `outcome_unknown` measured over 12 at the first caller, and it is the safety path -- it writes the
 * unknown outcome and pauses the autonomous account in one transaction. Over
 * budget it throws, the transaction rolls back, and **the account is not paused**:
 * the stop fails silently in exactly the case it exists for. Two audit appends
 * account for most of it, each taking its own chain lock, timestamp and insert.
 *
 * The plan calls these values tunable together under one contract, derived
 * maximum below the run deadline. Eighteen leaves three statements of headroom
 * over the worst case and gives 18 x 5s + 17 x 5s = 175s, inside the four-minute
 * deadline. `tests/marketingPublisherStatementBudget.test.ts` measures every
 * one of these operations against this number, so the next statement added to
 * any of them is noticed by a test rather than by a run that rolls back.
 */
export const MARKETING_PUBLISHER_MAX_STATEMENTS = 18;

/**
 * The longest one transaction can take, as the application counts it.
 *
 * `n` statements and the `n - 1` gaps between them, each at its ceiling. The
 * gap before the first statement and after the last is the unbounded window
 * named above, so it is not in the sum.
 */
export const marketingPublisherDerivedTransactionMaxMs = (input: {
  readonly statementTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxStatements: number;
}): number =>
  input.maxStatements * input.statementTimeoutMs +
  (input.maxStatements - 1) * input.idleTimeoutMs;

export const MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS =
  marketingPublisherDerivedTransactionMaxMs({
    statementTimeoutMs: MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS,
    idleTimeoutMs: MARKETING_PUBLISHER_IDLE_TIMEOUT_MS,
    maxStatements: MARKETING_PUBLISHER_MAX_STATEMENTS,
  });

/**
 * The value `transaction_timeout` is set to.
 *
 * Equal to the derived maximum, which is what keeps the ordering trap shut: it
 * is longer than the statement and idle ceilings, so both stay armed.
 */
export const MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS =
  MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS;

/**
 * How long a running row may go without a heartbeat before it is an incident.
 *
 * Fifteen minutes: three cron periods. A run is killed at four minutes, so a
 * row still `running` with no heartbeat after fifteen is not a slow run -- its
 * worker is gone and nothing closed it.
 */
export const MARKETING_PUBLISHER_SILENCE_THRESHOLD_MS = 15 * 60 * 1000;

/** The lowest server major that has `transaction_timeout`. */
export const MARKETING_PUBLISHER_MIN_SERVER_VERSION_NUM = 170000;

export type MarketingPublisherTiming = {
  readonly cronPeriodMs: number;
  readonly runDeadlineMs: number;
  readonly derivedTransactionMaxMs: number;
  readonly transactionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly silenceThresholdMs: number;
};

export const MARKETING_PUBLISHER_TIMING: MarketingPublisherTiming = Object.freeze({
  cronPeriodMs: MARKETING_PUBLISHER_CRON_PERIOD_MS,
  runDeadlineMs: MARKETING_PUBLISHER_RUN_DEADLINE_MS,
  derivedTransactionMaxMs: MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS,
  transactionTimeoutMs: MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS,
  statementTimeoutMs: MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS,
  idleTimeoutMs: MARKETING_PUBLISHER_IDLE_TIMEOUT_MS,
  silenceThresholdMs: MARKETING_PUBLISHER_SILENCE_THRESHOLD_MS,
});

/**
 * Every pair of limits that is not in the order the contract needs.
 *
 * Empty means sound. Each entry names the pair, so a change that breaks one
 * says which one rather than "the timing is wrong".
 */
export const marketingPublisherTimingProblems = (
  timing: MarketingPublisherTiming,
): string[] => {
  const problems: string[] = [];
  const positive = (name: keyof MarketingPublisherTiming) => {
    if (!(timing[name] > 0)) problems.push(`${name} is not positive`);
  };
  for (const name of Object.keys(timing) as (keyof MarketingPublisherTiming)[]) {
    positive(name);
  }
  if (!(timing.runDeadlineMs < timing.cronPeriodMs)) {
    problems.push("the run deadline is not shorter than the cron period");
  }
  if (!(timing.derivedTransactionMaxMs < timing.runDeadlineMs)) {
    problems.push(
      "the derived per-transaction maximum is not shorter than the run deadline",
    );
  }
  // The ordering trap: either ceiling at or above the transaction timeout is
  // switched off by PostgreSQL without a word.
  if (!(timing.statementTimeoutMs < timing.transactionTimeoutMs)) {
    problems.push(
      "statement_timeout is not shorter than transaction_timeout, so PostgreSQL would not arm it",
    );
  }
  if (!(timing.idleTimeoutMs < timing.transactionTimeoutMs)) {
    problems.push(
      "idle_in_transaction_session_timeout is not shorter than transaction_timeout, so PostgreSQL would not arm it",
    );
  }
  if (!(timing.transactionTimeoutMs <= timing.runDeadlineMs)) {
    problems.push("transaction_timeout outlasts the run deadline");
  }
  if (!(timing.silenceThresholdMs > timing.runDeadlineMs)) {
    problems.push(
      "the silence threshold would report a run that is merely still inside its deadline",
    );
  }
  return problems;
};

/**
 * Whether there is room to start another batch.
 *
 * Not "is the deadline still ahead": a transaction started with less than the
 * derived maximum remaining can be killed half way, and its COMMIT may still
 * land after the deadline. So the question is whether a whole transaction fits.
 */
export const marketingPublisherHasRoomForBatch = (
  now: Date,
  deadlineAt: Date,
  timing: MarketingPublisherTiming = MARKETING_PUBLISHER_TIMING,
): boolean => deadlineAt.getTime() - now.getTime() > timing.derivedTransactionMaxMs;

/**
 * The deadline a start request may carry, or why not.
 *
 * The service computes its own deadline and the route checks it, because the
 * database's "late means not succeeded" rule is only as strong as the deadline
 * it is measured against. A deadline a year out would make every run on time.
 */
export const marketingPublisherDeadlineProblem = (
  now: Date,
  deadlineAt: Date,
  timing: MarketingPublisherTiming = MARKETING_PUBLISHER_TIMING,
): "deadline_unreadable" | "deadline_passed" | "deadline_too_far" | null => {
  const at = deadlineAt.getTime();
  if (!Number.isFinite(at)) return "deadline_unreadable";
  if (at <= now.getTime()) return "deadline_passed";
  // **The bound is the run deadline, not the cron period.**
  //
  // It was the cron period, and that was the hole. A run's deadline is four
  // minutes; the period is five. So a deadline up to five minutes out passed,
  // and once the route began measuring this against the database's clock, a
  // service running thirty seconds ahead of PostgreSQL submitted
  // `db_now + 4m30s` and was accepted. The supervisor then killed the worker at
  // its own four minutes while the database still had thirty seconds to go, so a
  // close asking for `succeeded` at 4m15s was not late by the only clock the
  // trigger consults -- and "a late run is never recorded as a success", the one
  // invariant the plan calls mandatory, did not hold.
  //
  // With the run deadline as the bound, agreeing clocks leave `at - now` just
  // under four minutes because the request itself took time, and any forward
  // skew pushes it over and is refused. Refusing a skewed service is the point:
  // it cannot be given a bound that means what it says.
  if (at - now.getTime() > timing.runDeadlineMs) return "deadline_too_far";
  return null;
};

/** A marketing publisher run that has gone quiet, for the operational monitor. */
export type MarketingPublisherSilentRun = {
  readonly id: string;
  readonly lastSignOfLifeAt: string;
  readonly silentForMs: number;
};

/**
 * Which running rows have been silent too long.
 *
 * Pure, so the monitor's decision is tested on its own. A row's last sign of
 * life is its heartbeat, or its start if it never beat.
 */
export const marketingPublisherSilentRuns = (
  rows: readonly {
    readonly id: string;
    readonly startedAt: Date;
    readonly heartbeatAt: Date | null;
  }[],
  now: Date,
  thresholdMs: number = MARKETING_PUBLISHER_SILENCE_THRESHOLD_MS,
): MarketingPublisherSilentRun[] =>
  rows
    .map((row) => {
      const last = row.heartbeatAt ?? row.startedAt;
      return {
        id: row.id,
        lastSignOfLifeAt: last.toISOString(),
        silentForMs: now.getTime() - last.getTime(),
      };
    })
    .filter((row) => row.silentForMs > thresholdMs);
