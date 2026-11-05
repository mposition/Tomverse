/**
 * The one way a trust-safety observer transaction runs
 * (docs/policy/trust-safety-compliance-agent.md §5.4, §5.5, §5.6 item 3).
 *
 * Every round's transaction opens here, and §5.6 names this the only module
 * allowed to send the setting statements: the two database timers, (on 17)
 * `transaction_timeout`, and the statement that makes §5.4's deadline. The
 * raw-SQL allowlist fixes their shape and count, so a second module sending
 * the same shape is a failure even if it is correct.
 *
 * **The arming function is the ops-observer one, reused rather than copied.**
 * `ops_observer_arm_timeouts()` already does what §5.5 asks and nothing else:
 * it is parameterised per kind, carries no `SET` clause and no `EXCEPTION`
 * clause (both of which silently drop the timers it just set), keeps the
 * version branch inside PL/pgSQL so the app never reads the server version,
 * reads the inherited `transaction_timeout` from `pg_settings` only inside the
 * 17 branch, and refuses a transaction whose remaining budget is too short to
 * start in. A second function with that body would be sixty lines of SQL
 * saying the same thing, and the two would drift. The cost of reuse is a
 * dependency on another agent's function, so a database test pins the contract
 * this module relies on; a change there fails here.
 *
 * What this module adds is §5.5's refusal the ops policy does not make: a
 * session that handed us a positive `transaction_timeout` at or below this
 * kind's guarded budget ends the round before any write.
 *
 * Nothing here retries. §5.5: a timeout or a refusal ends the round with no
 * side effect, because the read transactions only SELECT and a late run row is
 * refused by its own trigger.
 */

import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ARM_MARGIN_MS,
  TRUST_SAFETY_BOUNDS,
  type TrustSafetyTransactionKind,
} from "@/lib/trustSafetyBoundsCore";

/** The arming function's refusal for a budget too short to start in. */
export const BUDGET_INSUFFICIENT_SQLSTATE = "OB001";

/** The round ended before doing anything. Never retried (§5.5). */
export class TrustSafetyRoundRefused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TrustSafetyRoundRefused";
    this.code = code;
  }
}

/**
 * Whether an error is the arming function's budget refusal, judged by
 * SQLSTATE only.
 *
 * Through Prisma's driver adapter a PostgreSQL error arrives as P2010 with the
 * database's code nested under `meta.driverAdapterError.cause`; a pg error
 * carries it as `code`. Message text is never consulted -- matching on prose
 * would hide a change in where the code travels.
 */
export const isBudgetInsufficient = (error: unknown): boolean => {
  if (error === null || typeof error !== "object") return false;
  const e = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } } };
  };
  if (e.code === BUDGET_INSUFFICIENT_SQLSTATE) return true;
  const cause = e.meta?.driverAdapterError?.cause;
  return (
    cause?.code === BUDGET_INSUFFICIENT_SQLSTATE ||
    cause?.originalCode === BUDGET_INSUFFICIENT_SQLSTATE
  );
};

/** What the arming statement reported. */
export type TrustSafetyArmed = {
  readonly serverVersion: number;
  /** NULL on 16, where the GUC does not exist, so there is nothing to inherit. */
  readonly priorTxTimeoutMs: number | null;
  /**
   * The database clock just after the timers were set. The round takes its
   * `observedAt` from this rather than spending a statement on a clock read of
   * its own, and it is the database's clock, not the application's.
   */
  readonly txStart: Date;
  readonly ttArmedMs: number | null;
  readonly ttArmed: boolean;
};

/**
 * The client a round's callback gets: one charged statement at a time.
 *
 * Counting is an application device and §5.5 refuses to call it a database
 * limit -- PostgreSQL has no mechanism that counts statements on any version.
 * Each statement passes through `statement()`, which charges it against the
 * kind's ceiling `A` before sending it.
 */
export type TrustSafetyTx = {
  statement<T>(run: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /** Statements still available to the callback. */
  readonly remaining: () => number;
};

type ArmRow = {
  serverVersion: number;
  priorTxTimeoutMs: number | null;
  txStart: Date;
  ttArmedMs: number | null;
  ttArmed: boolean;
};

/** The GUC each writing kind's deadline goes into; the reading kinds have none. */
const DEADLINE_SETTING: Partial<Record<TrustSafetyTransactionKind, string>> = {
  run_write: "trust_safety.run_deadline",
  activation_write: "trust_safety.activation_deadline",
};

/**
 * Runs `fn` inside one bounded transaction of `kind`.
 *
 * In order, and the order is §5.4's: the two database timers first, then --
 * in a separate statement, because a deadline computed in the statement that
 * arms the timers would be the application's claim about when it ran -- the
 * deadline, computed by the database clock and left in a transaction-local
 * setting for the row's trigger to validate.
 *
 * `runDeadline` is the round's own deadline, which the arming function
 * measures the remaining budget against. It is the caller's claim; the row's
 * deadline is not.
 */
export const withTrustSafetyTransaction = async <T>({
  kind,
  runDeadline,
  fn,
  client = prisma,
}: {
  readonly kind: TrustSafetyTransactionKind;
  readonly runDeadline: Date;
  readonly fn: (tx: TrustSafetyTx, armed: TrustSafetyArmed) => Promise<T>;
  readonly client?: PrismaClient;
}): Promise<T> => {
  const bound = TRUST_SAFETY_BOUNDS[kind];
  const deadlineSetting = DEADLINE_SETTING[kind];
  // The arming statement, and for a writing kind the deadline statement, are
  // spent before the callback sees the ceiling.
  const spentByWrapper = deadlineSetting === undefined ? 1 : 2;

  return client.$transaction(
    async (raw) => {
      let sent = 0;
      const charge = <R>(run: (c: Prisma.TransactionClient) => Promise<R>): Promise<R> => {
        sent += 1;
        if (sent > bound.statementCeiling) {
          throw new TrustSafetyRoundRefused("trust_safety_statement_ceiling");
        }
        return run(raw);
      };

      const rows = await charge(
        (c) => c.$queryRaw<ArmRow[]>`
          SELECT "serverVersion", "priorTxTimeoutMs", "txStart", "ttArmedMs", "ttArmed"
            FROM ops_observer_arm_timeouts(
              ${bound.statementTimeoutMs}::int,
              ${bound.idleTimeoutMs}::int,
              ${bound.transactionTimeoutMs}::int,
              ${bound.cGuardedMs}::int,
              ${ARM_MARGIN_MS}::int,
              ${runDeadline.toISOString()}::timestamptz)`,
      );
      const armed = rows[0];
      if (!armed) throw new TrustSafetyRoundRefused("trust_safety_arm_no_row");

      // §5.5: an inherited positive timer at or below this kind's guarded
      // budget ends the round, before any write and with no row left behind.
      // The inherited value wins over one set inside the transaction, so the
      // budget this module would otherwise claim is not the one in force.
      // Judged on the reported number, never on the server version: 16 has no
      // such setting to inherit and reports null.
      if (
        armed.priorTxTimeoutMs !== null &&
        armed.priorTxTimeoutMs > 0 &&
        armed.priorTxTimeoutMs <= bound.cGuardedMs
      ) {
        throw new TrustSafetyRoundRefused("trust_safety_inherited_transaction_timeout");
      }

      if (deadlineSetting !== undefined) {
        // The database makes the deadline. §5.4 fixes four things about it and
        // this statement is three of them: the clock is the database's, the
        // statement is its own (after the timers, not with them), and the
        // value is transaction-local so nothing outside this transaction can
        // see or reuse it. The fourth -- judgement at COMMIT rather than at
        // statement time -- belongs to the row's deferred trigger.
        //
        // `to_char`, not `::text`. A timestamptz cast to text is rendered in
        // the session's DateStyle, and the deadline's parser requires an
        // explicit offset in one shape: under `SQL, MDY` or `German, DMY` the
        // cast produces `11/05/2026 14:50:38.704203 AEST`, the parser refuses
        // it, and **every round fails** -- verified on a throwaway 17.10
        // cluster. The failure is closed rather than silent, but it is a
        // failure class a session setting can switch on, so the format is
        // pinned here instead. `OF` renders the offset as `+00`, `+10` or
        // `+05:30`, all three of which the parser accepts.
        const seconds = bound.deadlineMs / 1_000;
        await charge(
          (c) => c.$queryRaw<{ armed: string }[]>`
            SELECT set_config(
              ${deadlineSetting},
              to_char(
                clock_timestamp() + make_interval(secs => ${seconds}::double precision),
                'YYYY-MM-DD"T"HH24:MI:SS.MSOF'),
              true) AS armed`,
        );
      }

      const tx: TrustSafetyTx = {
        statement: charge,
        remaining: () => bound.statementCeiling - sent,
      };
      // A statement added to this wrapper without raising `A` would silently
      // take one from the callback; this says so instead.
      if (tx.remaining() !== bound.statementCeiling - spentByWrapper) {
        throw new TrustSafetyRoundRefused("trust_safety_wrapper_statement_drift");
      }
      return fn(tx, armed);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: bound.prismaTimeoutMs,
      maxWait: 2_000,
    },
  );
};
