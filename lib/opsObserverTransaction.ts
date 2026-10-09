/**
 * The one way an ops-observer store transaction runs (docs/policy/sre-ops.md §6).
 *
 * `withOpsObserverTransaction(kind, runDeadline, fn)`:
 *
 *   - opens a READ COMMITTED transaction with the kind's Prisma timeout, which
 *     is above the kind's transaction_timeout so the database ends a run before
 *     the client library gives up on it;
 *   - sends `ops_observer_arm_timeouts()` as statement 1, which sets the
 *     statement and idle timers, refuses a short budget, and on PostgreSQL 17
 *     re-arms transaction_timeout from zero at or before the run deadline;
 *   - logs the transaction_timeout the session inherited, so an operator can
 *     see when this agent replaced one (operator decision N-7);
 *   - gives the callback a client that sends only tagged single-statement
 *     raw queries and `$appendSystemAudit` (the audit chain append as the
 *     `ops-observer` actor, charged its four statements), and refuses
 *     anything past statement A.
 *
 * `assertNotLate(runDeadline)` is the separate short transaction that must pass
 * before a caller reports success, sends, or pings a heartbeat (§6 item 5): the
 * deferred triggers abort a COMMIT evaluated late, but nothing tells a caller
 * that the COMMIT it just saw succeed was not itself the last moment before
 * the deadline.
 *
 * Nothing here retries. A refusal or a timeout ends the run (§3 rule 7).
 */

import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";

import { type AppendedAuditEntry, writeSystemAuditLogEntry } from "@/lib/adminAudit";
import { OPS_OBSERVER_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import {
  TRANSACTION_BOUNDS,
  armArguments,
} from "@/scripts/ops-observer/transaction-bounds-core.mjs";
import {
  AUDIT_APPEND_STATEMENT_COST,
  countingClient,
} from "@/scripts/ops-observer/statement-ceiling-core.mjs";

export type OpsObserverTransactionKind = keyof typeof TRANSACTION_BOUNDS;

/** An audit entry the store appends; the actor is always `ops-observer`. */
export type OpsObserverAuditInput = {
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonObject | null;
};

/** What a store transaction may do: tagged raw statements and the audit append. */
export type OpsObserverClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw"> & {
  $appendSystemAudit(input: OpsObserverAuditInput): Promise<AppendedAuditEntry>;
};

/**
 * A statement-counted helper: a fixed cost, pinned by a test against the
 * statements its function sends, and a function run on the real client. Only
 * lib code registers one -- never a transaction's callback.
 */
export type OpsObserverHelper = {
  cost: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (tx: Prisma.TransactionClient, input: any) => Promise<unknown>;
};

const helpers: Readonly<Record<string, OpsObserverHelper>> = Object.freeze({
  $appendSystemAudit: {
    cost: AUDIT_APPEND_STATEMENT_COST,
    run: (tx: Prisma.TransactionClient, input: OpsObserverAuditInput) =>
      writeSystemAuditLogEntry({ ...input, tx, systemActor: OPS_OBSERVER_SYSTEM_AUDIT_ACTOR }),
  },
});

/** What the arming function reported for this transaction. */
export type OpsObserverArmed = {
  serverVersion: number;
  priorTxTimeoutMs: number | null;
  ttArmedMs: number | null;
  ttArmed: boolean;
};

export class OpsObserverLateError extends Error {
  readonly code = "ops_observer_run_late";

  constructor() {
    super("ops_observer_run_late");
    this.name = "OpsObserverLateError";
  }
}

type ArmRow = {
  serverVersion: number;
  priorTxTimeoutMs: number | null;
  ttArmedMs: number | null;
  ttArmed: boolean;
};

async function arm(tx: Prisma.TransactionClient, kind: OpsObserverTransactionKind, runDeadline: Date) {
  const [st, idle, tt, guarded, margin, deadline] = armArguments(kind, runDeadline);
  const rows = await tx.$queryRaw<ArmRow[]>`
    SELECT "serverVersion", "priorTxTimeoutMs", "ttArmedMs", "ttArmed"
      FROM ops_observer_arm_timeouts(${st}::int, ${idle}::int, ${tt}::int, ${guarded}::int, ${margin}::int, ${deadline}::timestamptz)`;
  const row = rows[0];
  if (!row) throw new Error("ops_observer_arm_no_row");
  return row;
}

/**
 * Arms a transaction this wrapper does not own -- one a shared store opens,
 * whose last write lands in shared tables (the daily digest) -- with the
 * kind's timers and its start-budget refusal, and logs it like the wrapper.
 * The caller's transaction still needs a row of this agent's whose deferred
 * trigger checks the deadline at COMMIT (OpsObserverRunGuard).
 */
export async function armOpsObserverTransaction(
  tx: Prisma.TransactionClient,
  kind: OpsObserverTransactionKind,
  runDeadline: Date,
): Promise<OpsObserverArmed> {
  const armed = await arm(tx, kind, runDeadline);
  logArmed(kind, armed);
  return armed;
}

function logArmed(kind: OpsObserverTransactionKind, armed: OpsObserverArmed) {
  // Structured, value-free apart from the timer figures themselves.
  console.info(
    JSON.stringify({
      event: "ops_observer_transaction_armed",
      kind,
      serverVersion: armed.serverVersion,
      priorTxTimeoutMs: armed.priorTxTimeoutMs,
      ttArmedMs: armed.ttArmedMs,
      ttArmed: armed.ttArmed,
    }),
  );
}

/**
 * Run `fn` inside one bounded ops-observer transaction. `fn` receives a client
 * that may send the kind's statement ceiling minus one (the arming statement)
 * and the arming result.
 */
export async function withOpsObserverTransaction<T>(
  kind: OpsObserverTransactionKind,
  runDeadline: Date,
  fn: (tx: OpsObserverClient, armed: OpsObserverArmed) => Promise<T>,
  client: PrismaClient = prisma,
  extraHelpers: Readonly<Record<string, OpsObserverHelper>> = {},
): Promise<{ result: T; armed: OpsObserverArmed }> {
  const bound = TRANSACTION_BOUNDS[kind];
  if (!bound) throw new Error("ops_observer_transaction_kind_unknown");
  // A caller in lib may add a pinned-cost helper; it may not replace one.
  for (const name of Object.keys(extraHelpers)) {
    if (Object.hasOwn(helpers, name)) throw new Error("ops_observer_helper_name_taken");
  }
  const registered = { ...helpers, ...extraHelpers };
  let armed: OpsObserverArmed | null = null;
  const result = await client.$transaction(
    async (tx) => {
      armed = await arm(tx, kind, runDeadline);
      logArmed(kind, armed);
      const counted = countingClient(tx, bound.statementCeiling - 1, registered);
      return fn(counted.client as OpsObserverClient, armed);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: bound.prismaTimeoutMs,
      maxWait: 2_000,
    },
  );
  return { result, armed: armed! };
}

/**
 * Refuse to proceed when the run is past its deadline by the database clock.
 * Its own short transaction of kind `assert`.
 */
export async function assertNotLate(runDeadline: Date, client: PrismaClient = prisma): Promise<void> {
  let late: boolean;
  try {
    ({ result: late } = await withOpsObserverTransaction(
      "assert",
      runDeadline,
      async (tx) => {
        const rows = await tx.$queryRaw<{ late: boolean }[]>`
          SELECT clock_timestamp() > ${runDeadline.toISOString()}::timestamptz AS late`;
        return rows[0]?.late !== false;
      },
      client,
    ));
  } catch (error) {
    // Too little budget left to even ask is the same answer: not provably on time.
    if (isBudgetInsufficient(error)) throw new OpsObserverLateError();
    throw error;
  }
  if (late) throw new OpsObserverLateError();
}

/** The SQLSTATE the arming function raises for a budget too short to start in. */
export const BUDGET_INSUFFICIENT_SQLSTATE = "OB001";

/**
 * Whether an error is the arming function's budget refusal, by its SQLSTATE
 * only. Through Prisma's driver adapter the PostgreSQL error arrives as P2010
 * with the database's code at meta.driverAdapterError.cause.code (and
 * originalCode); a pg error carries it as `code`. Message text is not
 * consulted: a match on prose would hide a change in where the code travels.
 */
export function isBudgetInsufficient(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } } };
  };
  if (e.code === BUDGET_INSUFFICIENT_SQLSTATE) return true;
  const cause = e.meta?.driverAdapterError?.cause;
  return cause?.code === BUDGET_INSUFFICIENT_SQLSTATE || cause?.originalCode === BUDGET_INSUFFICIENT_SQLSTATE;
}
